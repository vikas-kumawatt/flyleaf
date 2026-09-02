// Things every module may depend on, and that depend on nothing themselves.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://flyleaf:flyleaf@localhost:5432/flyleaf',
  env: process.env.NODE_ENV ?? 'development',
} as const;

export type Db = ReturnType<typeof makeDb>;

export function makeDb(url: string = config.databaseUrl) {
  const client = postgres(url, { max: 10, idle_timeout: 30 });
  return drizzle(client, { schema });
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
