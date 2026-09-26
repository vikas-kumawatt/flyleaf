// Things every module may depend on, and that depend on nothing themselves.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { countQuery, queryCountingEnabled } from '../bench/query-counter.js';

const DEV_JWT_SECRET = 'flyleaf-dev-secret-do-not-use-in-production-must-be-at-least-32-chars!';

const APP_BASE_URL = (
  process.env.APP_BASE_URL ??
  (process.env.NODE_ENV === 'production' ? 'https://flyleaf.app' : 'http://localhost:8081')
).replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://flyleaf:flyleaf@localhost:5432/flyleaf',
  env: process.env.NODE_ENV ?? 'development',
  logLevel: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  jwtSecret: resolveJwtSecret(process.env.NODE_ENV, process.env.JWT_SECRET),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Base of the links in verification and reset emails.
  appBaseUrl: APP_BASE_URL,
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS, APP_BASE_URL),
} as const;

/**
 * Browser origins allowed to call the API cross-origin, from CORS_ORIGINS
 * (comma-separated). Defaults to APP_BASE_URL's origin only. The native app
 * sends no Origin and is unaffected; the admin console is same-origin and
 * needs no entry (Audit 06; A-05-022: reflecting every origin is gone).
 */
export function parseCorsOrigins(value: string | undefined, appBaseUrl: string): string[] {
  const list = value ? value.split(',').map((o) => o.trim()).filter(Boolean) : [appBaseUrl];
  return list.map((o) => new URL(o).origin);
}

/**
 * The dev fallback is public in this repository, so anyone could mint tokens
 * with it. Production must bring its own secret or the process does not start
 * (audit A-04-001).
 */
export function resolveJwtSecret(env: string | undefined, secret: string | undefined): string {
  if (env !== 'production') return secret ?? DEV_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || secret === DEV_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET must be set to a private value of at least 32 bytes when NODE_ENV=production ' +
        '(generate one with: openssl rand -base64 48).',
    );
  }
  return secret;
}

/**
 * Fastify `trustProxy` from TRUST_PROXY. Off unless set, so a client cannot pick
 * its own req.ip with X-Forwarded-For. Behind Caddy set it to Caddy's address
 * or CIDR, comma-separated (e.g. `127.0.0.1`); `true` trusts every hop (A-04-002).
 */
export function parseTrustProxy(value: string | undefined): boolean | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return value;
}

/** pg_trgm's match threshold. Why 0.45, and how it was measured: migrate.ts. */
export const TRIGRAM_THRESHOLD = 0.45;

export type Db = ReturnType<typeof makeDb>;

export function makeDb(
  url: string = config.databaseUrl,
  opts: { max?: number; quiet?: boolean } = {},
) {
  const client = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    // Sent in each connection's startup packet, so search never depends on
    // the `ALTER DATABASE` in migrate.ts surviving. A database restored from
    // a dump or recreated loses that setting silently, and at pg_trgm's 0.3
    // default the trigram arm reads ~10x the heap (audit 02, A-02-009).
    connection: { 'pg_trgm.similarity_threshold': String(TRIGRAM_THRESHOLD) },
    // Batch jobs run `CREATE TABLE IF NOT EXISTS` on every start, and the
    // resulting NOTICE for each one buries the actual progress output.
    ...(opts.quiet ? { onnotice: () => {} } : {}),
    // Audit bench only; absent unless BENCH_COUNT_QUERIES=1.
    ...(queryCountingEnabled ? { debug: countQuery } : {}),
  });
  return drizzle(client, { schema });
}

/**
 * Close the connection pool.
 *
 * `timeout: 5` gives in-flight queries five seconds to finish before the
 * sockets are destroyed; without it, `end()` waits indefinitely on a query
 * that will never return and the process hangs until it is killed.
 */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end({ timeout: 5 });
}

/** Retry loop, because in `docker compose up` the API wins the race against Postgres. */
export async function waitForDb(db: Db, attempts = 15): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Swap-ready interfaces.
//
// Redis is NOT part of the v1 stack. These three interfaces exist so that
// adding it is one new implementation plus a config line, rather than a hunt
// through call sites during an incident.
//
// Trigger: adopt Redis the day a SECOND API INSTANCE exists — that is the
// moment in-process counters become wrong and an in-process cache stops being
// shared. Not at a user count.
//
// Constraint that keeps the swap clean: nothing here may assume Redis
// semantics (atomic INCR, pub/sub, sorted sets). If those leak into a call
// site, the interface has failed its purpose.
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** Returns true when the action is allowed. */
  allow(bucket: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** In-process LRU-ish cache. For a single instance this beats Redis: no network hop. */
export class MemoryCache implements Cache {
  #entries = new Map<string, { value: unknown; expires: number }>();
  constructor(private max = 1000) {}

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (this.#entries.size >= this.max) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.#entries.delete(key);
  }
}

/**
 * Postgres-backed rate limiter.
 *
 * Used for AUTH endpoints specifically, where correctness matters more than
 * speed and the volume is low. Exact, transactional, survives restarts, and
 * correct across multiple instances — which an in-process counter is not.
 */
export class PgRateLimiter implements RateLimiter {
  constructor(private db: Db) {}

  async allow(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const rows = await this.db.execute<{ count: number }>(sql`
      INSERT INTO rate_limits (bucket, count, window_start)
      VALUES (${bucket}, 1, now())
      ON CONFLICT (bucket) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          THEN 1 ELSE rate_limits.count + 1 END,
        window_start = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          THEN now() ELSE rate_limits.window_start END
      RETURNING count
    `);
    const count = Number(rows[0]?.count ?? 1);
    return count <= limit;
  }
}
