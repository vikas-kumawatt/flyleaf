// Things every module may depend on, and that depend on nothing themselves.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { countQuery, queryCountingEnabled } from '../bench/query-counter.js';

const DEV_JWT_SECRET = 'flyleaf-dev-secret-do-not-use-in-production-must-be-at-least-32-chars!';

/**
 * Where the emailed links point in production. The mobile app's App Links
 * (apps/mobile/app.json) name the same host at build time (D-07b-2).
 */
export const PRODUCTION_APP_BASE_URL = 'https://flyleaf.app';

const APP_BASE_URL = (
  process.env.APP_BASE_URL ??
  (process.env.NODE_ENV === 'production' ? PRODUCTION_APP_BASE_URL : 'http://localhost:8081')
).replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://flyleaf:flyleaf@localhost:5432/flyleaf',
  env: process.env.NODE_ENV ?? 'development',
  logLevel: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  jwtSecret: resolveJwtSecret(process.env.NODE_ENV, process.env.JWT_SECRET),
  rateLimitMode: resolveRateLimitMode(process.env.NODE_ENV, process.env.BENCH_RATE_LIMITS),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Base of the links in verification and reset emails.
  appBaseUrl: APP_BASE_URL,
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS, APP_BASE_URL),
  appLinks: parseAppLinks(process.env),
} as const;

/** What /.well-known serves so the emailed links open the app (D-07-1). Null: that file 404s. */
export interface AppLinks {
  android: { packageName: string; sha256Fingerprints: string[] } | null;
  ios: { appId: string } | null;
}

/**
 * ANDROID_APP_PACKAGE + ANDROID_CERT_SHA256 (comma-separated, the signing
 * certificates' SHA-256 as `AA:BB:…`), and IOS_TEAM_ID + IOS_BUNDLE_ID. Each
 * platform is on only when both of its values are set. A malformed value stops
 * the process: a wrong fingerprint would silently fail verification on phones.
 */
export function parseAppLinks(env: Record<string, string | undefined>): AppLinks {
  const pkg = env.ANDROID_APP_PACKAGE?.trim();
  const certs = env.ANDROID_CERT_SHA256?.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean) ?? [];
  const team = env.IOS_TEAM_ID?.trim();
  const bundle = env.IOS_BUNDLE_ID?.trim();
  const bundleId = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/;

  let android: AppLinks['android'] = null;
  if (pkg && certs.length > 0) {
    if (!bundleId.test(pkg)) throw new Error(`ANDROID_APP_PACKAGE is not a package name: ${pkg}`);
    for (const c of certs) {
      if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(c)) {
        throw new Error(`ANDROID_CERT_SHA256 must be colon-separated SHA-256 fingerprints (AA:BB:…, 32 bytes): ${c}`);
      }
    }
    android = { packageName: pkg, sha256Fingerprints: certs };
  }

  let ios: AppLinks['ios'] = null;
  if (team && bundle) {
    if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`IOS_TEAM_ID must be 10 letters or digits: ${team}`);
    if (!bundleId.test(bundle)) throw new Error(`IOS_BUNDLE_ID is not a bundle identifier: ${bundle}`);
    ios = { appId: `${team}.${bundle}` };
  }
  return { android, ios };
}

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
 * Which rate limits the API server enforces (Audit 15). 'all' unless
 * BENCH_RATE_LIMITS=legacy, which keeps only the limits that existed when the
 * Part 01 baseline was measured, so a bench "after" compares like with like
 * (the bench's 10 connections would otherwise meet the Global tier within
 * seconds). Refused when NODE_ENV=production: production enforces every limit.
 */
export function resolveRateLimitMode(env: string | undefined, value: string | undefined): 'all' | 'legacy' {
  if (value === undefined || value === '' || value === 'all') return 'all';
  if (value !== 'legacy') throw new Error(`BENCH_RATE_LIMITS must be "all" or "legacy", got ${JSON.stringify(value)}.`);
  if (env === 'production') throw new Error('BENCH_RATE_LIMITS=legacy is for bench runs only; it is refused when NODE_ENV=production.');
  return 'legacy';
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

/**
 * Per-process database limits for batch work (Audit 15, A-03-026). A Part 03c
 * dedupe statement was OOM-killed by the kernel; Postgres then dropped every
 * connection and ran crash recovery: an outage caused by one maintenance job.
 * Batch processes now connect with their own `work_mem` (memory per sort or
 * hash, before it spills to disk), `statement_timeout` (nothing runs
 * unbounded), at most one parallel worker per query, and an idle-in-transaction
 * cap, sent in the connection's startup packet. The API keeps the server
 * defaults (work_mem 4 MB), and its requests are short.
 *
 * Memory budget, the arithmetic behind the numbers (docker-compose.yml sets a
 * container limit of 3 GB): shared_buffers 512 MB + API 10 connections × 4 MB
 * × hash_mem_multiplier 2 × ~3 nodes (≈ 240 MB) + worker 4 × 32 MB × 2 × 2
 * workers × ~3 nodes (≈ 1.5 GB worst case, typically one job at a time) +
 * dedupe or ingest (one connection) 64 MB × 2 × 2 × ~3 (≈ 770 MB). A job
 * that needs more spills to disk; it cannot take the server down.
 */
export interface JobDbSettings {
  work_mem: string;
  /** Milliseconds. */
  statement_timeout: number;
  max_parallel_workers_per_gather: string;
  /** Milliseconds. */
  idle_in_transaction_session_timeout: number;
}

export const JOB_DB_SETTINGS = {
  /** The worker's pool: reconciles, prunes, retention, storage cleanup, suggestions, imports and exports. */
  worker: {
    work_mem: '32MB',
    statement_timeout: 600_000,
    max_parallel_workers_per_gather: '1',
    idle_in_transaction_session_timeout: 900_000,
  },
  /** The monthly dedupe pass and the backlog CLI: long, but batched (A-03-025/026). */
  dedupe: {
    work_mem: '64MB',
    statement_timeout: 1_800_000,
    max_parallel_workers_per_gather: '1',
    idle_in_transaction_session_timeout: 1_800_000,
  },
  /** Ingest, its --popularity and --finalise passes, devdb:build. Index builds use maintenance_work_mem. */
  ingest: {
    work_mem: '64MB',
    statement_timeout: 3_600_000,
    max_parallel_workers_per_gather: '1',
    idle_in_transaction_session_timeout: 3_600_000,
  },
} as const satisfies Record<string, JobDbSettings>;

export function makeDb(
  url: string = config.databaseUrl,
  opts: { max?: number; quiet?: boolean; settings?: JobDbSettings } = {},
) {
  const client = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    // Sent in each connection's startup packet, so search never depends on
    // the `ALTER DATABASE` in migrate.ts surviving. A database restored from
    // a dump or recreated loses that setting silently, and at pg_trgm's 0.3
    // default the trigram arm reads ~10x the heap (audit 02, A-02-009).
    // A batch process adds its own memory and time limits the same way
    // (JOB_DB_SETTINGS, Audit 15 A-03-026), so every statement on every
    // connection of its pool runs under them, transactions included.
    connection: { 'pg_trgm.similarity_threshold': String(TRIGRAM_THRESHOLD), ...opts.settings },
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
  /**
   * The same check, with what a 429 needs: the count so far in this window and
   * the seconds until it ends (Retry-After). Optional so a test double can
   * implement `allow` alone (then Retry-After is the whole window).
   */
  hit?(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitHit>;
}

export interface RateLimitHit {
  allowed: boolean;
  /** Attempts counted in the current window, this one included. */
  count: number;
  /** Seconds until the window ends (≥ 1). */
  retryAfterSeconds: number;
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
    return (await this.hit(bucket, limit, windowSeconds)).allowed;
  }

  /**
   * One upsert: a fixed window per bucket, restarted when it has ended.
   * `expires_at` is when the window ends, so the nightly sweep can delete
   * finished buckets whatever their length (Audit 15, A-04-022).
   */
  async hit(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitHit> {
    const rows = await this.db.execute<{ count: number; retry: number }>(sql`
      INSERT INTO rate_limits (bucket, count, window_start, expires_at)
      VALUES (${bucket}, 1, now(), now() + make_interval(secs => ${windowSeconds}))
      ON CONFLICT (bucket) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          THEN 1 ELSE rate_limits.count + 1 END,
        window_start = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          THEN now() ELSE rate_limits.window_start END,
        expires_at = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${windowSeconds})
          THEN now() + make_interval(secs => ${windowSeconds})
          ELSE rate_limits.window_start + make_interval(secs => ${windowSeconds}) END
      RETURNING count,
        greatest(1, ceil(extract(epoch FROM (expires_at - now()))))::int AS retry
    `);
    const count = Number(rows[0]?.count ?? 1);
    return { allowed: count <= limit, count, retryAfterSeconds: Number(rows[0]?.retry ?? windowSeconds) };
  }
}
