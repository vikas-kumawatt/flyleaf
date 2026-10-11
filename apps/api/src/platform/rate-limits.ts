// One rate-limit layer (Audit 15, §1). Every limit the API enforces is a row
// in RATE_LIMITS, with the PRD section its number comes from next to it.
//
// Two ways to apply one, both reading this table:
//   - a route declares groups in its config (`config: { limits: ['search'] }`)
//     and `registerRateLimitHook` checks them, plus the Global tier, before the
//     handler runs (keyed by account when signed in, by IP otherwise);
//   - a service calls `limits.enforce(name, key)` where the rule needs to know
//     something only the service knows: whether a follow creates a row, whether
//     an import is a replay of the same upload, whether a review is new.
//
// Two stores, chosen per limit (architecture §4.1):
//   - 'exact': the injected RateLimiter, PgRateLimiter today. One upsert per
//     check, correct across instances and restarts. Auth, comments, follows,
//     reviews, imports, exports, uploads, username changes: low volume, and a
//     limit a second instance silently doubled would be a security weakening.
//   - 'fast': MemoryRateLimiter, in-process fixed windows. Global, search,
//     writes, progress, events: a check on (nearly) every request, where an
//     extra database write per request is the cost to avoid (measured in
//     findings/15-cross-cutting.md) and a per-instance count is acceptable
//     while there is one instance. The day a second instance exists both go
//     to Redis (architecture §4.1, "the trigger"): one implementation of the
//     same interface.
//
// A refusal is 429 `rate_limited` with `Retry-After` (seconds) and the
// X-RateLimit-* headers (architecture §6).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../http.js';
import { PgRateLimiter, type Db, type RateLimiter, type RateLimitHit } from './index.js';

export type LimitStore = 'exact' | 'fast';

export interface LimitRule {
  limit: number;
  windowSeconds: number;
  store: LimitStore;
  /** Where the number comes from. */
  source: string;
  /** What the 429 says. */
  message: string;
}

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

const SLOW_DOWN = 'Too many requests. Try again shortly.';

/**
 * Every limit, in one place. Bucket keys are `<name>:<key>`, so the name is
 * also the prefix of every `rate_limits.bucket` row it writes (and the comment
 * and login buckets keep the names they had before this layer: no behaviour
 * change for them).
 */
export const RATE_LIMITS = {
  // ---- PRD §24.4 Auth endpoints: 10/min per account, 30/min per IP; anonymous 20/min per IP.
  login: {
    limit: 10, windowSeconds: MINUTE, store: 'exact',
    source: 'PRD §24.4 Auth endpoints, 10/min per account (keyed by the email: login has no account yet)',
    message: 'Too many attempts. Try again shortly.',
  },
  'admin-login': {
    limit: 10, windowSeconds: MINUTE, store: 'exact',
    source: 'PRD §24.4 Auth endpoints, 10/min per account, for the admin console login (A-06-RL1; keyed by the email)',
    message: 'Too many attempts. Try again shortly.',
  },
  'auth:ip': {
    limit: 30, windowSeconds: MINUTE, store: 'exact',
    source: 'PRD §24.4 Auth endpoints, 30/min per IP (signed in)',
    message: 'Too many attempts from this network. Try again shortly.',
  },
  'auth:anon-ip': {
    limit: 20, windowSeconds: MINUTE, store: 'exact',
    source: 'PRD §24.4 Auth endpoints, anonymous 20/min per IP',
    message: 'Too many attempts from this network. Try again shortly.',
  },
  'auth:account': {
    limit: 10, windowSeconds: MINUTE, store: 'exact',
    source: 'PRD §24.4 Auth endpoints, 10/min per account (signed-in auth calls: DOB, resend, 2FA, username change)',
    message: 'Too many attempts. Try again shortly.',
  },
  resend_verification: {
    limit: 1, windowSeconds: MINUTE, store: 'exact',
    source: 'PRD §6.4 resend verification, 1/60 s (unchanged since FN-65)',
    message: 'Please wait a minute before requesting another verification email.',
  },
  forgot_pwd: {
    limit: 5, windowSeconds: 15 * MINUTE, store: 'exact',
    source: 'PRD §6.5 forgot password, 5 per 15 min per email (unchanged since FN-65)',
    message: 'Too many password reset requests. Please try again later.',
  },
  // ---- PRD §24.4 Search: 60/min signed in, 20/min anonymous.
  'search:account': {
    limit: 60, windowSeconds: MINUTE, store: 'fast', source: 'PRD §24.4 Search, 60/min', message: 'You are searching too quickly. Try again in a minute.',
  },
  'search:ip': {
    limit: 20, windowSeconds: MINUTE, store: 'fast', source: 'PRD §24.4 Search, anonymous 20/min', message: 'You are searching too quickly. Try again in a minute.',
  },
  // ---- PRD §24.4 Writes (reads, reviews, shelves): 120/min, signed in only.
  writes: {
    limit: 120, windowSeconds: MINUTE, store: 'fast', source: 'PRD §24.4 Writes (reads, reviews, shelves), 120/min', message: SLOW_DOWN,
  },
  // ---- PRD §24.4 Progress events: 300/min.
  progress: {
    limit: 300, windowSeconds: MINUTE, store: 'fast', source: 'PRD §24.4 Progress events, 300/min', message: SLOW_DOWN,
  },
  // ---- PRD §24.4 Comments 5/min, §11.7 Comments per minute 5.
  comments: {
    limit: 5, windowSeconds: MINUTE, store: 'exact',
    source: 'PRD §24.4 Comments 5/min; §11.7 Comments per minute 5 (SO-22)',
    message: 'You are commenting too quickly. Try again in a minute.',
  },
  // ---- PRD §10.6 Reviews: 10/hour, 30/day (new or revived reviews; edits are Writes).
  'reviews:hour': {
    limit: 10, windowSeconds: HOUR, store: 'exact', source: 'PRD §10.6 Rate limit, 10 reviews/hour', message: 'You have posted a lot of reviews. Try again later.',
  },
  'reviews:day': {
    limit: 30, windowSeconds: DAY, store: 'exact', source: 'PRD §10.6 Rate limit, 30 reviews/day', message: 'You have posted a lot of reviews today. Try again tomorrow.',
  },
  // ---- PRD §11.7 and §24.4 Follows (each follow or request that creates a row).
  'follow:h': {
    limit: 50, windowSeconds: HOUR, store: 'exact', source: 'PRD §11.7 Follows per hour 50; §24.4 Follows 50/hour', message: 'You are following people too quickly. Try again later.',
  },
  'follow:d': {
    limit: 200, windowSeconds: DAY, store: 'exact', source: 'PRD §11.7 Follows per day 200; §24.4 Follows 200/day', message: 'You have followed a lot of people today. Try again tomorrow.',
  },
  'follow:pair': {
    limit: 3, windowSeconds: DAY, store: 'exact',
    source: 'PRD §11.7 Follow-unfollow-refollow of the same user: blocked after 3 cycles in 24 hours (a re-request after a reject counts, A-13-008)',
    message: 'You have followed this reader too many times today. Try again tomorrow.',
  },
  'follow:new': {
    limit: 20, windowSeconds: DAY, store: 'exact',
    source: 'PRD §11.7 New accounts: cannot follow more than 20 users in the first 24 hours',
    message: 'New accounts can follow 20 readers in their first day. Try again tomorrow.',
  },
  // ---- PRD §24.4 Import 3/day, Export 2/day.
  imports: {
    limit: 3, windowSeconds: DAY, store: 'exact', source: 'PRD §24.4 Import, 3/day', message: 'You can start 3 imports a day. Try again tomorrow.',
  },
  exports: {
    limit: 2, windowSeconds: DAY, store: 'exact', source: 'PRD §24.4 Export, 2/day', message: 'You can request 2 exports a day. Try again tomorrow.',
  },
  uploads: {
    limit: 10, windowSeconds: DAY, store: 'exact',
    source: 'No §24.4 row; A-PV-007. Upload intents (import files and avatars) 10/day: 3 imports a day plus retries of a failed upload and avatar changes. Decision recorded in DECISIONS.md (D-15-2)',
    message: 'Too many uploads today. Try again tomorrow.',
  },
  // ---- Username changes (A-13-021, D-13-3: old names stay reserved for the account's lifetime).
  username: {
    limit: 1, windowSeconds: 30 * DAY, store: 'exact',
    source: 'A-13-021 proposal: 1 change per 30 days, so one account cannot reserve many names (D-13-3)',
    message: 'You can change your username once every 30 days.',
  },
  // ---- Lookups the PRD names without a number get the Search tier.
  'username-check:ip': {
    limit: 20, windowSeconds: MINUTE, store: 'fast',
    source: 'A-07-030: public availability check, anonymous tier of PRD §24.4 (Search numbers: 20/min per IP)',
    message: SLOW_DOWN,
  },
  // ---- Telemetry (A-10-029). No §24.4 row: batches of ≤ 100 events.
  'events:account': {
    limit: 120, windowSeconds: HOUR, store: 'fast',
    source: 'No §24.4 row; A-10-029. 120 batches/hour (the app flushes every 30 s at most: 120/h). D-15-2',
    message: SLOW_DOWN,
  },
  'events:ip': {
    limit: 120, windowSeconds: HOUR, store: 'fast',
    source: 'No §24.4 row; A-10-029. 120 batches/hour per IP for guests. D-15-2',
    message: SLOW_DOWN,
  },
  // ---- PRD §24.4 Global: 1,000/hour signed in, 200/hour anonymous.
  'global:account': {
    limit: 1_000, windowSeconds: HOUR, store: 'fast', source: 'PRD §24.4 Global, 1,000/hour', message: SLOW_DOWN,
  },
  'global:ip': {
    limit: 200, windowSeconds: HOUR, store: 'fast', source: 'PRD §24.4 Global, anonymous 200/hour', message: SLOW_DOWN,
  },
} as const satisfies Record<string, LimitRule>;

export type LimitName = keyof typeof RATE_LIMITS;

/**
 * Groups a route can declare. Each maps a viewer kind to the limits checked:
 * `account` when signed in (keyed by account id), `ip` when anonymous (keyed
 * by req.ip, which honours TRUST_PROXY only: A-04-002), `alsoIp` per IP for
 * signed-in callers too.
 */
export const LIMIT_GROUPS = {
  /** Auth endpoints a guest calls (register, login, refresh, forgot, reset, verify, link pages). */
  auth: { account: [] as LimitName[], alsoIp: ['auth:ip'] as LimitName[], ip: ['auth:anon-ip'] as LimitName[] },
  /** Auth endpoints a signed-in caller uses (DOB confirmation, resend, logout, sessions, 2FA). */
  'auth-account': { account: ['auth:account'] as LimitName[], alsoIp: ['auth:ip'] as LimitName[], ip: ['auth:anon-ip'] as LimitName[] },
  search: { account: ['search:account'] as LimitName[], alsoIp: [] as LimitName[], ip: ['search:ip'] as LimitName[] },
  writes: { account: ['writes'] as LimitName[], alsoIp: [] as LimitName[], ip: [] as LimitName[] },
  progress: { account: ['progress'] as LimitName[], alsoIp: [] as LimitName[], ip: [] as LimitName[] },
  events: { account: ['events:account'] as LimitName[], alsoIp: [] as LimitName[], ip: ['events:ip'] as LimitName[] },
  'username-check': { account: ['search:account'] as LimitName[], alsoIp: [] as LimitName[], ip: ['username-check:ip'] as LimitName[] },
} as const;

export type LimitGroup = keyof typeof LIMIT_GROUPS;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Rate-limit groups this route belongs to (Audit 15). The Global tier applies to every route anyway. */
    limits?: readonly LimitGroup[];
    /** Opt out of the Global tier (health probes only). */
    noGlobalLimit?: boolean;
  }
}

/**
 * The limits that existed before this layer, enforced everywhere since their
 * tasks shipped (tests included): login per email, resend verification,
 * forgot password, comments. A test app gets exactly these unless it asks for
 * more, so 1,600 tests that log in or comment keep their meaning; production
 * (`server-wiring.ts`) turns every limit on, and `server-wiring.test.ts` says so.
 */
export const LEGACY_LIMITS: ReadonlySet<LimitName> = new Set<LimitName>([
  'login',
  'resend_verification',
  'forgot_pwd',
  'comments',
]);

/**
 * In-process fixed windows. Correct for one API instance only (architecture
 * §4.1: the second instance is the Redis trigger). Expired buckets are swept
 * as the map grows, so memory is bounded by the buckets live in one window.
 */
export class MemoryRateLimiter implements RateLimiter {
  #buckets = new Map<string, { count: number; resetAt: number }>();
  #nextSweep = 0;
  #nextSweepAt = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sweepEvery = 10_000,
  ) {}

  async allow(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    return (await this.hit(bucket, limit, windowSeconds)).allowed;
  }

  async hit(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitHit> {
    return this.hitSync(bucket, limit, windowSeconds);
  }

  /** Synchronous: the hook calls it on every request and needs no promise per check. */
  hitSync(bucket: string, limit: number, windowSeconds: number): RateLimitHit {
    const now = this.now();
    if (this.#buckets.size >= this.#nextSweep || now >= this.#nextSweepAt) this.#sweep(now);
    let b = this.#buckets.get(bucket);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.#buckets.set(bucket, b);
    }
    b.count += 1;
    return {
      allowed: b.count <= limit,
      count: b.count,
      retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }

  /** Buckets held now (tests and the overhead bench). */
  get size(): number {
    return this.#buckets.size;
  }

  #sweep(now: number) {
    for (const [k, b] of this.#buckets) if (b.resetAt <= now) this.#buckets.delete(k);
    this.#nextSweep = this.#buckets.size + this.sweepEvery;
    this.#nextSweepAt = now + 60_000;
  }
}

/** One check's outcome, with what the headers need. */
export interface LimitResult extends RateLimitHit {
  name: LimitName;
  limit: number;
}

/** Calls `hit` when the limiter has it, else `allow` (then Retry-After is the whole window). */
async function hitWith(limiter: RateLimiter, bucket: string, limit: number, windowSeconds: number): Promise<RateLimitHit> {
  if (limiter.hit) return limiter.hit(bucket, limit, windowSeconds);
  const allowed = await limiter.allow(bucket, limit, windowSeconds);
  return { allowed, count: allowed ? 1 : limit + 1, retryAfterSeconds: windowSeconds };
}

/** The 429 for a refused check: a stable code, the rule's message, and Retry-After. */
export function rateLimitedError(name: LimitName, retryAfterSeconds: number): ApiError {
  const err = ApiError.rateLimited(RATE_LIMITS[name].message);
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

/**
 * Checks one limit against a given limiter, whatever the policy says. For the
 * services that always enforced their limit (login, resend, forgot, comments):
 * they keep their injected RateLimiter, and with it their bucket names and
 * numbers, now read from RATE_LIMITS.
 */
export async function enforceWith(limiter: RateLimiter, name: LimitName, key: string): Promise<void> {
  const rule: LimitRule = RATE_LIMITS[name];
  const hit = await hitWith(limiter, `${name}:${key}`, rule.limit, rule.windowSeconds);
  if (!hit.allowed) throw rateLimitedError(name, hit.retryAfterSeconds);
}

export interface RateLimitsOptions {
  /** The exact store (PgRateLimiter in production). */
  exact: RateLimiter;
  /** The in-process store. Default: a new MemoryRateLimiter. */
  fast?: MemoryRateLimiter;
  /** Which limits are on. Default: LEGACY_LIMITS (see there). Production: 'all'. */
  enabled?: 'all' | ReadonlySet<LimitName>;
}

/** The policy the app and the services share. */
export class RateLimits {
  readonly exact: RateLimiter;
  readonly fast: MemoryRateLimiter;
  readonly #enabled: 'all' | ReadonlySet<LimitName>;

  constructor(opts: RateLimitsOptions) {
    this.exact = opts.exact;
    this.fast = opts.fast ?? new MemoryRateLimiter();
    this.#enabled = opts.enabled ?? LEGACY_LIMITS;
  }

  /** Nothing enforced: for test apps and tools with no limiter. */
  static off(): RateLimits {
    return new RateLimits({ exact: { allow: async () => true }, enabled: new Set() });
  }

  isOn(name: LimitName): boolean {
    return this.#enabled === 'all' || this.#enabled.has(name);
  }

  get allOn(): boolean {
    return this.#enabled === 'all';
  }

  /**
   * Counts one attempt; null when the limit is off. `tx`: a service counting
   * inside its own transaction passes it, and an exact Postgres count then
   * commits or rolls back with the write it guards (a follow that fails
   * after the check is not counted). It also keeps a single-connection
   * database (PGlite in tests) from waiting on itself.
   */
  async check(name: LimitName, key: string, tx?: Db): Promise<LimitResult | null> {
    if (!this.isOn(name)) return null;
    const rule: LimitRule = RATE_LIMITS[name];
    const bucket = `${name}:${key}`;
    const exact = tx && this.exact instanceof PgRateLimiter ? new PgRateLimiter(tx) : this.exact;
    const hit =
      rule.store === 'fast'
        ? this.fast.hitSync(bucket, rule.limit, rule.windowSeconds)
        : await hitWith(exact, bucket, rule.limit, rule.windowSeconds);
    return { ...hit, name, limit: rule.limit };
  }

  /** Counts one attempt and throws the 429 when it is over the limit. */
  async enforce(name: LimitName, key: string, tx?: Db): Promise<void> {
    const r = await this.check(name, key, tx);
    if (r && !r.allowed) throw rateLimitedError(name, r.retryAfterSeconds);
  }
}

/** The limits a request is checked against, in order: Global first, then the route's groups. */
export function limitsFor(req: FastifyRequest): Array<{ name: LimitName; key: string }> {
  const out: Array<{ name: LimitName; key: string }> = [];
  const cfg = req.routeOptions?.config;
  const account = req.viewer ?? null;
  const ip = req.ip;
  if (!cfg?.noGlobalLimit) {
    out.push(account ? { name: 'global:account', key: account } : { name: 'global:ip', key: ip });
  }
  for (const group of cfg?.limits ?? []) {
    const g = LIMIT_GROUPS[group];
    if (account) {
      for (const name of g.account) out.push({ name, key: account });
      for (const name of g.alsoIp) out.push({ name, key: ip });
    } else {
      for (const name of g.ip) out.push({ name, key: ip });
    }
  }
  return out;
}

function setHeaders(reply: FastifyReply, tightest: LimitResult) {
  reply.header('x-ratelimit-limit', tightest.limit);
  reply.header('x-ratelimit-remaining', Math.max(0, tightest.limit - tightest.count));
  reply.header('x-ratelimit-reset', tightest.retryAfterSeconds);
}

/**
 * The route-level hook. `preValidation`: after the auth hook (it needs the
 * viewer) and before validation, so malformed floods are counted too.
 * Admin paths are not exempt: the console is behind its own auth but sits on
 * the same server.
 */
export function registerRateLimitHook(app: FastifyInstance, limits: RateLimits) {
  app.addHook('preValidation', async (req, reply) => {
    const checks = limitsFor(req);
    if (checks.length === 0) return;
    let tightest: LimitResult | null = null;
    for (const { name, key } of checks) {
      const r = await limits.check(name, key);
      if (!r) continue;
      if (!r.allowed) {
        setHeaders(reply, r);
        throw rateLimitedError(name, r.retryAfterSeconds);
      }
      if (!tightest || r.limit - r.count < tightest.limit - tightest.count) tightest = r;
    }
    if (tightest) setHeaders(reply, tightest);
  });
}
