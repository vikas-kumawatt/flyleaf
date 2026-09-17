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

    req.log.error({ err }, 'unhandled');
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

  // 4. Uniform 404 handler
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }),
  );
}

export interface BuildAppOptions {
  db?: Db;
  identity?: IdentityService;
  catalog?: CatalogService;
  reading?: ReadingService;
  reviews?: ReviewService;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: boolean;
  bodyLimit?: number;
}

/**
 * Builds and wires a complete Fastify application with the standard hook chain and routes.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? true,
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    bodyLimit: options.bodyLimit ?? 1_048_576,
  });

  await app.register(cors, { origin: true });

  registerCoreHooks(app, {
    identityLookup: options.identity ? (token) => options.identity!.lookup(token) : undefined,
  });

  // Liveness and readiness endpoints
  app.get('/healthz', async () => ({ status: 'ok' }));

  if (options.db) {
    const db = options.db;
    app.get('/readyz', async () => {
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
    app.get('/readyz', async () => ({ status: 'ready' }));
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
    await app.register(adminAuthRoutes(options.db));
    await app.register(adminDedupeRoutes(options.db));
    await app.register(adminCatalogRoutes(options.db));
  }

  return app;
}
