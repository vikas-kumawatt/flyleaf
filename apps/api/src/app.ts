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
import { config, type AppLinks, type Db } from './platform/index.js';
import { waitForDb } from './platform/index.js';
import { type IdentityService, identityRoutes } from './identity/index.js';
import { identityLinkPages } from './identity/link-pages.js';
import { type CatalogService, catalogRoutes } from './catalog/index.js';
import { type ReadingService, readingRoutes } from './reading/index.js';
import { reviewsPlugin, type ReviewService } from './reviews/index.js';
import { adminDedupeRoutes } from './admin/dedupe.js';
import { adminAuthRoutes } from './admin/routes.js';
import { adminCatalogRoutes } from './admin/catalog-routes.js';
import { moderationPlugin } from './moderation/routes.js';
import { adminModerationRoutes } from './moderation/admin-routes.js';
import { appealPages } from './moderation/appeal-pages.js';
import { ModerationService } from './moderation/index.js';
import { auditContext, logAdminAction, lookupAdmin, verifyAdminToken } from './admin/auth.js';
import { telemetryRoutes } from './telemetry/index.js';
import { reportApiError } from './telemetry/errors.js';
import { NoopErrorReporter, type ErrorReporter } from './providers/errors/index.js';
import { shelvesPlugin } from './shelves/index.js';
import { publicPagesPlugin } from './web/public-pages.js';
import { cardsPlugin } from './cards/index.js';
import type { FetchBytes } from './cards/images.js';
import type { CardRenderer } from './cards/render.js';
import type { PgBoss } from 'pg-boss';
import { importsPlugin } from './imports/index.js';
import { uploadsPlugin } from './uploads/index.js';
import { LocalObjectStorage, localStorageRoutes, type ObjectStorage } from './providers/storage/index.js';
import { exportsPlugin } from './exports/index.js';
import { socialPlugin } from './social/index.js';
import { activityPlugin } from './activity/index.js';
import { interactionsPlugin } from './interactions/index.js';
import { Notifier, bossNotifyQueue, notificationsPlugin, type NotifyQueue } from './notify/index.js';
import { PgRateLimiter, type Cache, type RateLimiter } from './platform/index.js';
import { RateLimits, registerRateLimitHook, type LimitGroup } from './platform/rate-limits.js';
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
    // HTML (admin console, public pages) gets a CSP (PRD §42 #9). A route
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
  /** Shared cache for route-level caching (the guest friends-sort ranking, audit 09b). None: nothing cached there. */
  cache?: Cache;
  /** Shared limiter for write throttles (comments). Defaults to Postgres-backed. */
  limiter?: RateLimiter;
  /**
   * The rate-limit policy (Audit 15). Default: the limits that existed before
   * Part 15 only (LEGACY_LIMITS, on the `limiter` above). Production passes
   * one with every limit on (`server-wiring.ts`).
   */
  rateLimits?: RateLimits;
  logger?: FastifyServerOptions['logger'];
  /** Off by default: see `parseTrustProxy` in platform. */
  trustProxy?: FastifyServerOptions['trustProxy'];
  bodyLimit?: number;
  /**
   * Register @fastify/swagger before any route, so app.swagger() describes
   * exactly what this app serves. Used by contract/generate.ts (Audit 05).
   */
  spec?: boolean;
  /** What /.well-known serves for App Links (D-07-1). Default: from the environment. */
  appLinks?: AppLinks;
  /**
   * Where notification pushes are queued (SO-30). Default: pg-boss when
   * `boss` is given, else none (the in-app rows are still written).
   */
  notifyQueue?: NotifyQueue;
  /**
   * Share cards (ST-07): how a cover not yet in storage is fetched (default:
   * the shared outbound client) and the renderer (default: a new one, with
   * its in-memory cache). Tests pass both.
   */
  cards?: { fetchBytes?: FetchBytes; renderer?: CardRenderer; coverBudgetMs?: number };
}

/** Routes whose group is not the default for their method (Audit 15, §1). */
const ROUTE_LIMIT_GROUPS: Record<string, readonly LimitGroup[]> = {
  // PRD §24.4 Auth endpoints a guest can call.
  'POST /v1/auth/register': ['auth'],
  'POST /v1/auth/login': ['auth'],
  'POST /v1/auth/refresh': ['auth'],
  'POST /v1/auth/logout': ['auth'],
  'POST /v1/auth/forgot-password': ['auth'],
  'POST /v1/auth/reset-password': ['auth'],
  'POST /v1/auth/verify-email': ['auth'],
  'GET /verify-email': ['auth'],
  'POST /verify-email': ['auth'],
  'GET /reset-password': ['auth'],
  'POST /reset-password': ['auth'],
  'GET /appeal': ['auth'],
  'POST /appeal': ['auth'],
  'POST /v1/admin/auth/login': ['auth'],
  'POST /admin/login': ['auth'],
  // Auth endpoints that need a session.
  'POST /v1/auth/logout-all': ['auth-account'],
  'POST /v1/auth/resend-verification': ['auth-account'],
  'GET /v1/auth/sessions': ['auth-account'],
  'DELETE /v1/auth/sessions/:id': ['auth-account'],
  'POST /v1/me/date-of-birth': ['auth-account'],
  'PATCH /v1/me/username': ['auth-account'],
  'POST /v1/admin/auth/2fa/setup': ['auth-account'],
  'POST /v1/admin/auth/2fa/verify': ['auth-account'],
  'POST /v1/admin/auth/logout': ['auth-account'],
  'POST /admin/logout': ['auth-account'],
  'GET /v1/auth/username-available': ['username-check'],
  'GET /v1/search': ['search'],
  'POST /v1/reads/:id/progress': ['progress'],
  'POST /v1/events': ['events'],
  // ST-07 share cards: a render is CPU, not a database read.
  'GET /v1/cards/finish/:id': ['cards'],
  'GET /v1/cards/review/:id': ['cards'],
  'GET /v1/cards/users/:id/stat/:stat': ['cards'],
  'GET /v1/cards/users/:id/profile': ['cards'],
  'GET /v1/cards/users/:id/wall': ['cards'],
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The rate-limit groups of a route: its entry above, else **writes** for any
 * state-changing method (PRD §24.4 "Writes (reads, reviews, shelves)": every
 * POST/PUT/PATCH/DELETE counts, so a route added later is covered without an
 * entry), else none (reads are under the Global tier only).
 */
export function routeLimitGroups(method: string, url: string): readonly LimitGroup[] {
  const explicit = ROUTE_LIMIT_GROUPS[`${method} ${url}`];
  if (explicit) return explicit;
  return UNSAFE_METHODS.has(method) ? ['writes'] : [];
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

  // Rate limits (Audit 15, §1). Every route gets its groups from
  // `routeLimitGroups` unless it declares its own; the hook then checks the
  // Global tier and those groups before validation.
  const limiter = options.limiter ?? (options.db ? new PgRateLimiter(options.db) : { allow: async () => true });
  const rateLimits = options.rateLimits ?? new RateLimits({ exact: limiter });
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    route.config = { ...route.config };
    if (route.url === '/healthz' || route.url === '/readyz') route.config.noGlobalLimit = true;
    if (route.config.limits === undefined) route.config.limits = routeLimitGroups(methods[0] ?? 'GET', route.url);
  });

  registerCoreHooks(app, {
    identityLookup: options.identity ? (token) => options.identity!.lookup(token) : undefined,
    adminLookup: options.db ? (token) => lookupAdmin(options.db!, token) : undefined,
    errorReporter: options.errorReporter,
  });

  // After the auth hook (it needs the viewer), before validation.
  registerRateLimitHook(app, rateLimits);

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
    // The emailed links and /.well-known, at the root like the shelf share pages.
    await app.register(identityLinkPages(options.identity, options.appLinks ?? config.appLinks));
  }
  if (options.catalog) {
    await app.register(catalogRoutes(options.catalog), { prefix: '/v1' });
  }
  if (options.reading) {
    await app.register(readingRoutes(options.reading), { prefix: '/v1' });
  }
  if (options.db) {
    // One Notifier for every write that notifies (SO-30). Pushes go through
    // the job queue in the write's transaction, never from the request.
    const notifier = new Notifier(options.notifyQueue ?? (options.boss ? bossNotifyQueue(options.boss) : undefined));
    await app.register(reviewsPlugin, { db: options.db, cache: options.cache, limits: rateLimits });
    await app.register(interactionsPlugin, {
      prefix: '/v1',
      db: options.db,
      limiter,
      notifier,
    });
    await app.register(notificationsPlugin, { prefix: '/v1', db: options.db });
    // Moderation (SO-40 to SO-42): reports and notices for the app, the queue for the console.
    await app.register(moderationPlugin, { prefix: '/v1', db: options.db, notifier, limits: rateLimits });
    await app.register(adminModerationRoutes(options.db, notifier, { mailer: options.mailer }));
    // A banned account's emailed one-time appeal link (owner decision on SO-4x).
    await app.register(appealPages(new ModerationService(options.db, notifier)));
    await app.register(adminAuthRoutes(options.db, rateLimits));
    await app.register(adminDedupeRoutes(options.db));
    await app.register(adminCatalogRoutes(options.db));
    // Under /v1 like every API route: the app posts to /v1/events and the
    // client reads /v1/admin/telemetry/budgets. Mounted at the root, both
    // were 404 in production, and every test mounted the plugin under /v1
    // itself, so none saw it (Audit 15, A-15-001).
    await app.register(telemetryRoutes(options.db), { prefix: '/v1' });
    await app.register(shelvesPlugin, { prefix: '/v1', db: options.db });
    // Public pages for people without the app (SO-50, SO-51): book, profile, shelf.
    await app.register(publicPagesPlugin({ db: options.db, cache: options.cache }));
    // Share cards (ST-07, ST-08). Covers come from storage; without one, every card draws posters.
    await app.register(cardsPlugin({ db: options.db, storage: options.storage ?? null, ...options.cards }), { prefix: '/v1' });
    await app.register(importsPlugin, { prefix: '/v1', db: options.db, boss: options.boss, limits: rateLimits });
    if (options.storage) {
      const storage = options.storage;
      // disk/memory only: the signed route that stands in for a provider.
      if (storage instanceof LocalObjectStorage) await app.register(localStorageRoutes(storage));
      await app.register(uploadsPlugin, { prefix: '/v1', db: options.db, storage, limits: rateLimits });
      await app.register(exportsPlugin, {
        prefix: '/v1',
        db: options.db,
        boss: options.boss,
        storage,
        mailer: options.mailer,
        limits: rateLimits,
      });
    }
    await app.register(socialPlugin, {
      prefix: '/v1',
      db: options.db,
      limits: rateLimits,
      notifier,
      cache: options.cache,
    });
    await app.register(activityPlugin, {
      prefix: '/v1',
      db: options.db,
    });
  }

  return app;
}
