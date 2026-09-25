// Application factory and Fastify hook chain (FN-82, PRD §4.2, §24.2, Architecture §3.3 & §7).
//
// Establishes the standard request lifecycle for both production runtime and test harnesses:
//   1. Guest-safe authentication hook: populates req.viewer from Bearer JWT statelessly,
//      and NEVER rejects unauthenticated or expired callers (PRD §4.2).
//   2. Request correlation and security headers: X-Request-Id, X-Content-Type-Options, X-Frame-Options.
//   3. Standard error envelope mapping: ApiError -> status code, Fastify schema -> 422, unhandled -> 500.
//   4. 404 handler returning standard error envelope.

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { sql } from 'drizzle-orm';

import { ApiError, sendError } from './http.js';
import type { Db } from './platform/index.js';
import { waitForDb } from './platform/index.js';
import { type IdentityService, identityRoutes } from './identity/index.js';
import { type CatalogService, catalogRoutes } from './catalog/index.js';
import { type ReadingService, readingRoutes } from './reading/index.js';
import { reviewsPlugin, type ReviewService } from './reviews/index.js';
import { adminDedupeRoutes } from './admin/dedupe.js';
import { adminAuthRoutes } from './admin/routes.js';
import { adminCatalogRoutes } from './admin/catalog-routes.js';
import { verifyAdminToken } from './admin/auth.js';
import { telemetryRoutes } from './telemetry/index.js';
import { captureApiException } from './telemetry/sentry.js';
import { shelvesPlugin, shelvesWebPlugin } from './shelves/index.js';
import fastifyMultipart from '@fastify/multipart';
import type { PgBoss } from 'pg-boss';
import { importsPlugin, type FileStorage } from './imports/index.js';
import { exportsPlugin } from './exports/index.js';
import { socialPlugin } from './social/index.js';
import { activityPlugin } from './activity/index.js';
import { interactionsPlugin } from './interactions/index.js';
import type { EmailSender, RateLimiter } from './platform/index.js';
import { queryCountingEnabled, registerQueryCounter } from './bench/query-counter.js';
import { registerSwagger } from './contract/index.js';

/**
 * The URL as logged: secrets in the query string (the export download link's
 * `token`) are replaced. PRD §42.1: never log tokens (Audit 05).
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|access_token|refresh_token)=)[^&#]*/gi, '$1[redacted]');
}

export const HTML_BASELINE_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** SQLSTATEs that mean "bad input", and what the client sees for each. */
const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'conflict', message: 'That already exists.' },
  '23503': { status: 422, code: 'invalid_reference', message: 'Something this refers to does not exist.' },
  '23514': { status: 422, code: 'invalid_field', message: 'A value is out of range.' },
  '23502': { status: 422, code: 'invalid_field', message: 'A required value is missing.' },
  '22003': { status: 422, code: 'invalid_field', message: 'A number is out of range.' },
  '22P02': { status: 422, code: 'invalid_field', message: 'A value has the wrong format.' },
  '22007': { status: 422, code: 'invalid_field', message: 'A date has the wrong format.' },
  '22008': { status: 422, code: 'invalid_field', message: 'A date is out of range.' },
  '22001': { status: 422, code: 'invalid_field', message: 'A value is too long.' },
};

/** The SQLSTATE of a Postgres error, through Drizzle's wrapping (`cause`). */
export function postgresErrorCode(err: unknown): string | null {
  let node: unknown = err;
  for (let depth = 0; depth < 5 && node; depth++) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}

export interface CoreHookOptions {
  identityLookup?: (token: string) => Promise<string | null>;
}

/**
 * Registers the core Fastify hook chain onto an existing Fastify instance.
 * Used by buildApp() as well as lightweight test harnesses.
 */
export function registerCoreHooks(app: FastifyInstance, options?: CoreHookOptions) {
  // 1. Auth hook: populates viewer when a token is valid, leaves null otherwise.
  // Auth NEVER rejects. A guest is a legitimate caller across search, works, editions, and public reads.
  app.decorateRequest('viewer', null);
  app.decorateRequest('admin', null);

  app.addHook('onRequest', async (req) => {
    const xAdmin = req.headers['x-admin-token'];
    const cookie = req.headers.cookie;
    let adminCandidate: string | null = null;
    if (typeof xAdmin === 'string' && xAdmin.trim()) {
      adminCandidate = xAdmin.trim();
    } else if (cookie && typeof cookie === 'string') {
      const m = cookie.match(/(?:^|;\s*)flyleaf_admin_session=([^;]+)/);
      if (m && m[1]) adminCandidate = decodeURIComponent(m[1].trim());
    }

    const header = req.headers.authorization;
    if (header && typeof header === 'string') {
      const match = header.match(/^bearer\s+(.+)$/i);
      if (match && match[1]) {
        const raw = match[1].trim();
        if (!adminCandidate) {
          try {
            const adminVerified = await verifyAdminToken(raw);
            if (adminVerified) req.admin = adminVerified;
          } catch {
            // not an admin token
          }
        }
        if (options?.identityLookup) {
          try {
            req.viewer = (await options.identityLookup(raw)) ?? null;
          } catch {
            // Never reject on auth inspection failure. Fall back to guest mode.
            req.viewer = null;
          }
        }
      }
    }

    if (adminCandidate && !req.admin) {
      try {
        req.admin = (await verifyAdminToken(adminCandidate)) ?? null;
      } catch {
        req.admin = null;
      }
    }
  });

  // 2. Correlation and defensive security headers on all responses
  app.addHook('onSend', async (req, reply) => {
    if (req.id) {
      reply.header('x-request-id', req.id);
    }
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    // HTML (admin console, shelf share pages) gets a CSP (PRD §42 #9). A route
    // that sets a stricter one keeps it. The baseline allows inline script
    // and style because the admin pages use both; Part 06 moves them to nonces.
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.startsWith('text/html') && !reply.hasHeader('content-security-policy')) {
      reply.header('content-security-policy', HTML_BASELINE_CSP);
    }
  });

  // 3. Centralized error handler
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);

    // Fastify schema validation errors
    if ((err as any).validation) {
      const v = (err as any).validation[0];
      const field = v?.params?.missingProperty || v?.instancePath?.replace(/^\//, '') || undefined;
      return reply.status(422).send({
        error: {
          code: 'invalid_field',
          message: (err as Error).message,
          ...(field ? { field } : {}),
        },
      });
    }

    // Malformed JSON body errors
    const e = err as any;
    if (e?.statusCode === 400 && (e?.code?.startsWith('FST_ERR_CTP') || e?.name === 'SyntaxError')) {
      return reply.status(400).send({
        error: {
          code: 'invalid_json',
          message: (err as Error).message,
        },
      });
    }

    // A JSON body over bodyLimit is not an upload: say so (Audit 05).
    if (e?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: { code: 'body_too_large', message: 'Request body is too large.' },
      });
    }

    // File size limit exceeded (PRD §6.8: >10MB)
    if (
      e?.code === 'FST_ERR_FILE_TOO_LARGE' ||
      e?.code === 'FST_REQ_FILE_TOO_LARGE' ||
      e?.statusCode === 413
    ) {
      return reply.status(413).send({
        error: {
          code: 'file_too_large',
          message: 'File exceeds the 10MB limit. Please split your export into smaller files.',
        },
      });
    }

    // A constraint the database enforced is the caller's mistake, not ours:
    // 4xx, with no constraint or column names in the body (Audit 05).
    const pgCode = postgresErrorCode(err);
    const mapped = pgCode ? PG_ERRORS[pgCode] : undefined;
    if (mapped) {
      req.log.warn({ pgCode, route: req.routeOptions?.url }, 'constraint violation mapped to 4xx');
      return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }

    req.log.error({ err }, 'unhandled');
    void captureApiException(err, {
      requestId: req.id,
      userId: req.viewer ?? req.admin?.id ?? undefined,
      route: req.routeOptions?.url,
      method: req.method,
      headers: req.headers,
      query: req.query as any,
      params: req.params as any,
      body: req.body as any,
    });
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

  // 4. Uniform 404 handler
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }),
  );
}

const HEALTHZ_SCHEMA = {
  tags: ['System'],
  summary: 'Liveness probe',
  response: {
    200: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['ok'] } },
      required: ['status'],
    },
  },
} as const;

const READYZ_SCHEMA = {
  tags: ['System'],
  summary: 'Readiness probe',
  response: {
    200: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['ready'] } },
      required: ['status'],
    },
    503: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['code', 'message'],
        },
      },
      required: ['error'],
    },
  },
} as const;

export interface BuildAppOptions {
  db?: Db;
  identity?: IdentityService;
  catalog?: CatalogService;
  reading?: ReadingService;
  reviews?: ReviewService;
  boss?: PgBoss;
  storage?: FileStorage;
  mailer?: EmailSender;
  /** Shared limiter for write throttles (comments). Defaults to Postgres-backed. */
  limiter?: RateLimiter;
  logger?: FastifyServerOptions['logger'];
  /** Off by default: see `parseTrustProxy` in platform. */
  trustProxy?: FastifyServerOptions['trustProxy'];
  bodyLimit?: number;
  /**
   * Register @fastify/swagger before any route, so app.swagger() describes
   * exactly what this app serves. Used by contract/generate.ts (Audit 05).
   */
  spec?: boolean;
}

/**
 * A client-sent X-Request-Id is kept only if it is short and plain: it is
 * echoed in a response header and written to every log line for the request,
 * so a newline or a 10 KB value must never get through (Audit 05).
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdFrom(header: unknown): string {
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

/**
 * Builds and wires a complete Fastify application with the standard hook chain and routes.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
    // Read in genReqId instead, which validates it.
    requestIdHeader: false,
    bodyLimit: options.bodyLimit ?? 1_048_576,
  });

  if (options.spec) await registerSwagger(app);

  await app.register(cors, { origin: true });
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB per PRD §6.8
      files: 1,
    },
  });

  // Audit bench only; registers nothing unless BENCH_COUNT_QUERIES=1. First,
  // so the auth hook's queries are counted.
  if (queryCountingEnabled) registerQueryCounter(app);

  registerCoreHooks(app, {
    identityLookup: options.identity ? (token) => options.identity!.lookup(token) : undefined,
  });

  // Liveness and readiness endpoints
  app.get('/healthz', { schema: HEALTHZ_SCHEMA }, async () => ({ status: 'ok' }));

  if (options.db) {
    const db = options.db;
    app.get('/readyz', { schema: READYZ_SCHEMA }, async () => {
      await waitForDb(db, 1);
      const [row] = await db.execute<{ ready: boolean }>(sql`
        SELECT to_regclass('public.works') IS NOT NULL
           AND to_regclass('public.reads') IS NOT NULL AS ready
      `);
      if (!row?.ready) {
        throw new ApiError(503, 'migrations_pending', 'Schema not applied. Run: npm run migrate');
      }
      return { status: 'ready' };
    });
  } else {
    app.get('/readyz', { schema: READYZ_SCHEMA }, async () => ({ status: 'ready' }));
  }

  // Domain routes
  if (options.identity) {
    await app.register(identityRoutes(options.identity), { prefix: '/v1' });
  }
  if (options.catalog) {
    await app.register(catalogRoutes(options.catalog), { prefix: '/v1' });
  }
  if (options.reading) {
    await app.register(readingRoutes(options.reading), { prefix: '/v1' });
  }
  if (options.db) {
    await app.register(reviewsPlugin, { db: options.db });
    await app.register(interactionsPlugin, {
      prefix: '/v1',
      db: options.db,
      limiter: options.limiter,
    });
    await app.register(adminAuthRoutes(options.db));
    await app.register(adminDedupeRoutes(options.db));
    await app.register(adminCatalogRoutes(options.db));
    await app.register(telemetryRoutes(options.db));
    await app.register(shelvesPlugin, { prefix: '/v1', db: options.db });
    await app.register(shelvesWebPlugin, { db: options.db });
    await app.register(importsPlugin, {
      prefix: '/v1',
      db: options.db,
      boss: options.boss,
      storage: options.storage,
    });
    await app.register(exportsPlugin, {
      prefix: '/v1',
      db: options.db,
      boss: options.boss,
      storage: options.storage,
      mailer: options.mailer,
    });
    await app.register(socialPlugin, {
      prefix: '/v1',
      db: options.db,
    });
    await app.register(activityPlugin, {
      prefix: '/v1',
      db: options.db,
    });
  }

  return app;
}
