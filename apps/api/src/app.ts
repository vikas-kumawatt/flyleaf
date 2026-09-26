// Application factory and Fastify hook chain (FN-82, PRD §4.2, §24.2, Architecture §3.3 & §7).
//
// Establishes the standard request lifecycle for both production runtime and test harnesses:
//   1. Guest-safe authentication hook: populates req.viewer from Bearer JWT statelessly,
//      and NEVER rejects unauthenticated or expired callers (PRD §4.2).
//   2. Request correlation and security headers: X-Request-Id, X-Content-Type-Options, X-Frame-Options.
//   3. Standard error envelope mapping: ApiError -> status code, Fastify schema -> 422, unhandled -> 500.
//   4. 404 handler returning standard error envelope.

import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { sql } from 'drizzle-orm';

import { ADMIN_SESSION_COOKIE, ApiError, sendError, type AdminViewer } from './http.js';
import { config, type Db } from './platform/index.js';
import { waitForDb } from './platform/index.js';
import { type IdentityService, identityRoutes } from './identity/index.js';
import { type CatalogService, catalogRoutes } from './catalog/index.js';
import { type ReadingService, readingRoutes } from './reading/index.js';
import { reviewsPlugin, type ReviewService } from './reviews/index.js';
import { adminDedupeRoutes } from './admin/dedupe.js';
import { adminAuthRoutes } from './admin/routes.js';
import { adminCatalogRoutes } from './admin/catalog-routes.js';
import { auditContext, logAdminAction, lookupAdmin, verifyAdminToken } from './admin/auth.js';
import { telemetryRoutes } from './telemetry/index.js';
import { reportApiError } from './telemetry/errors.js';
import { NoopErrorReporter, type ErrorReporter } from './providers/errors/index.js';
import { shelvesPlugin, shelvesWebPlugin } from './shelves/index.js';
import type { PgBoss } from 'pg-boss';
import { importsPlugin } from './imports/index.js';
import { uploadsPlugin } from './uploads/index.js';
import { LocalObjectStorage, localStorageRoutes, type ObjectStorage } from './providers/storage/index.js';
import { exportsPlugin } from './exports/index.js';
import { socialPlugin } from './social/index.js';
import { activityPlugin } from './activity/index.js';
import { interactionsPlugin } from './interactions/index.js';
import type { RateLimiter } from './platform/index.js';
import type { EmailSender } from './providers/email/index.js';
import { queryCountingEnabled, registerQueryCounter } from './bench/query-counter.js';
import { registerSwagger } from './contract/index.js';

/**
 * The URL as logged: secrets in the query string (the export download link's
 * `token`) are replaced. PRD §42.1: never log tokens (Audit 05).
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|access_token|refresh_token)=)[^&#]*/gi, '$1[redacted]');
}

/**
 * HTML that sets no policy of its own may run no script at all. The admin
 * console sets a per-response nonce policy (admin/html.ts); the share pages
 * set their own (Audit 06: 'unsafe-inline' script is gone).
 */
export const HTML_BASELINE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; " +
  "base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** The console (`/admin/…`) and its API (`/v1/admin/…`): the only places admin credentials count. */
export function isAdminPath(url: string): boolean {
  return /^\/(?:v1\/)?admin(?:[/?#]|$)/.test(url);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for the admin cookie, on top of SameSite=Strict: a state-changing
 * request authenticated by the cookie must carry an Origin naming this host.
 * Browsers send Origin on every cross-origin request and on same-origin
 * POSTs, so an absent Origin is refused too (Audit 06).
 */
function sameOriginRequest(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host === req.host;
  } catch {
    return false;
  }
}

function adminSessionCookie(req: FastifyRequest): string | null {
  const m = req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${ADMIN_SESSION_COOKIE}=([^;]+)`));
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1].trim());
  } catch {
    return null; // a malformed cookie is no session, never a 500
  }
}

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
  /**
   * Resolves an admin token to the admin as the database has them now
   * (`lookupAdmin`). buildApp passes it whenever it has a database; without
   * one (hook-only harnesses) the token's own claims are used.
   */
  adminLookup?: (token: string) => Promise<AdminViewer | null>;
  /** Where unhandled 500s are reported (PV-06). Default: nowhere. */
  errorReporter?: ErrorReporter;
}

/**
 * Registers the core Fastify hook chain onto an existing Fastify instance.
 * Used by buildApp() as well as lightweight test harnesses.
 */
export function registerCoreHooks(app: FastifyInstance, options?: CoreHookOptions) {
  const errorReporter = options?.errorReporter ?? new NoopErrorReporter();
  // 1. Auth hook: populates viewer when a token is valid, leaves null otherwise.
  // Auth NEVER rejects. A guest is a legitimate caller across search, works, editions, and public reads.
  app.decorateRequest('viewer', null);
  app.decorateRequest('admin', null);

  const adminLookup = options?.adminLookup ?? verifyAdminToken;
  const resolveAdmin = async (token: string) => {
    try {
      return (await adminLookup(token)) ?? null;
    } catch {
      return null; // never reject on auth inspection failure
    }
  };

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    const bearer = typeof header === 'string' ? /^bearer\s+(.+)$/i.exec(header)?.[1]?.trim() : undefined;

    if (bearer && options?.identityLookup) {
      try {
        req.viewer = (await options.identityLookup(bearer)) ?? null;
      } catch {
        // Never reject on auth inspection failure. Fall back to guest mode.
        req.viewer = null;
      }
    }

    // Admin credentials count only on admin paths (Audit 06). Elsewhere an
    // admin token or cookie is ignored, so no app route can act on one.
    if (!isAdminPath(req.url)) return;

    const xAdmin = req.headers['x-admin-token'];
    const headerToken = typeof xAdmin === 'string' && xAdmin.trim() ? xAdmin.trim() : bearer;
    if (headerToken) req.admin = await resolveAdmin(headerToken);

    // The cookie is ambient: a browser attaches it to any request, including
    // one a hostile page triggers. Unsafe methods need a same-origin Origin.
    if (!req.admin && (SAFE_METHODS.has(req.method) || sameOriginRequest(req))) {
      const cookieToken = adminSessionCookie(req);
      if (cookieToken) req.admin = await resolveAdmin(cookieToken);
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

    // A body type no route parses (multipart since PV-02: files go to object
    // storage, never here). Was an unhandled 500.
    if (e?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(415).send({
        error: { code: 'unsupported_media_type', message: 'Send a JSON body (Content-Type: application/json).' },
      });
    }

    // A JSON body over bodyLimit is not an upload: say so (Audit 05).
    if (e?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: { code: 'body_too_large', message: 'Request body is too large.' },
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
    void reportApiError(errorReporter, err, {
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
  /**
   * Object storage (PV-01). Without it the upload and export routes are not
   * served: nothing may fall back to a local disk behind the wiring's back
   * (L-03). Imports need none; they take a completed upload.
   */
  storage?: ObjectStorage;
  mailer?: EmailSender;
  errorReporter?: ErrorReporter;
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

  // Only the configured browser origins (A-05-022). The native app sends no
  // Origin; the admin console is same-origin.
  await app.register(cors, { origin: [...config.corsOrigins] });

  // Audit bench only; registers nothing unless BENCH_COUNT_QUERIES=1. First,
  // so the auth hook's queries are counted.
  if (queryCountingEnabled) registerQueryCounter(app);

  registerCoreHooks(app, {
    identityLookup: options.identity ? (token) => options.identity!.lookup(token) : undefined,
    adminLookup: options.db ? (token) => lookupAdmin(options.db!, token) : undefined,
    errorReporter: options.errorReporter,
  });

  if (options.db) {
    const db = options.db;
    // A staff member refused an action is audited (FN-93: denied attempts
    // matter most). After the response, so it costs the request nothing; a
    // failed audit write is logged, it cannot change a sent response.
    app.addHook('onResponse', async (req, reply) => {
      if (!req.admin || reply.statusCode !== 403 || !isAdminPath(req.url)) return;
      await logAdminAction(db, {
        actorId: req.admin.id,
        action: 'admin.denied',
        payload: { method: req.method, route: req.routeOptions?.url ?? null, role: req.admin.role },
        ...auditContext(req),
      }).catch((err) => req.log.error({ err }, 'admin.denied audit write failed'));
    });
  }

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
    await app.register(importsPlugin, { prefix: '/v1', db: options.db, boss: options.boss });
    if (options.storage) {
      const storage = options.storage;
      // disk/memory only: the signed route that stands in for a provider.
      if (storage instanceof LocalObjectStorage) await app.register(localStorageRoutes(storage));
      await app.register(uploadsPlugin, { prefix: '/v1', db: options.db, storage });
      await app.register(exportsPlugin, {
        prefix: '/v1',
        db: options.db,
        boss: options.boss,
        storage,
        mailer: options.mailer,
      });
    }
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
