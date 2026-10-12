// Audit 15, §1: one rate-limit layer. Table-driven: every row of RATE_LIMITS
// allows exactly its limit, refuses the next attempt with 429 rate_limited
// and Retry-After, and resets when its window ends, on both stores. Then the
// wiring: each group reaches the routes it names, keys are per account or
// per IP, replays do not count, and production turns everything on.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp, routeLimitGroups } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { MemoryCache, PgRateLimiter, resolveRateLimitMode, type Db } from '../platform/index.js';
import {
  LEGACY_LIMITS,
  LIMIT_GROUPS,
  MemoryRateLimiter,
  RATE_LIMITS,
  RateLimits,
  type LimitName,
} from '../platform/rate-limits.js';
import { ReadingService } from '../reading/index.js';
import { MemoryObjectStorage } from '../providers/index.js';
import { serverDependencies } from '../server-wiring.js';
import { createProviders } from '../providers/index.js';
import type { PgBoss } from 'pg-boss';
import { freshDrizzle } from './pg.js';
import { makeRead, makeUser, makeWork } from './interaction-fixtures.js';
import { uploadFile } from './upload-fixtures.js';

const names = Object.keys(RATE_LIMITS) as LimitName[];

describe('RATE_LIMITS: one table, a PRD source next to every number', () => {
  it.each(names)('%s names where its number comes from', (name) => {
    const rule = RATE_LIMITS[name];
    expect(rule.source).toMatch(/PRD §|A-\d|D-\d/);
    expect(rule.limit).toBeGreaterThan(0);
    expect(rule.windowSeconds).toBeGreaterThan(0);
  });

  it('mirrors PRD §24.4, §11.7 and §10.6 exactly', () => {
    const n = (k: LimitName) => [RATE_LIMITS[k].limit, RATE_LIMITS[k].windowSeconds];
    expect(n('login')).toEqual([10, 60]);
    expect(n('auth:ip')).toEqual([30, 60]);
    expect(n('auth:anon-ip')).toEqual([20, 60]);
    expect(n('search:account')).toEqual([60, 60]);
    expect(n('search:ip')).toEqual([20, 60]);
    expect(n('writes')).toEqual([120, 60]);
    expect(n('progress')).toEqual([300, 60]);
    expect(n('follow:h')).toEqual([50, 3600]);
    expect(n('follow:d')).toEqual([200, 86400]);
    expect(n('follow:pair')).toEqual([3, 86400]);
    expect(n('follow:new')).toEqual([20, 86400]);
    expect(n('comments')).toEqual([5, 60]);
    expect(n('reviews:hour')).toEqual([10, 3600]);
    expect(n('reviews:day')).toEqual([30, 86400]);
    expect(n('imports')).toEqual([3, 86400]);
    expect(n('exports')).toEqual([2, 86400]);
    expect(n('global:account')).toEqual([1000, 3600]);
    expect(n('global:ip')).toEqual([200, 3600]);
  });

  it('mirrors PRD §19.2–19.3 push governance, on the rolling store (SO-31)', () => {
    const n = (k: LimitName) => [RATE_LIMITS[k].limit, RATE_LIMITS[k].windowSeconds, RATE_LIMITS[k].store];
    expect(n('push:day')).toEqual([5, 86400, 'rolling']);
    expect(n('push:thread')).toEqual([1, 3600, 'rolling']);
    expect(n('push:follow')).toEqual([3, 3600, 'rolling']);
  });
});

describe('each limit allows exactly N, refuses N+1 with Retry-After, and resets (in-process store)', () => {
  it.each(names)('%s', async (name) => {
    let now = 1_000_000;
    const limits = new RateLimits({ exact: new MemoryRateLimiter(() => now), fast: new MemoryRateLimiter(() => now), enabled: 'all' });
    const rule = RATE_LIMITS[name];
    for (let i = 1; i <= rule.limit; i++) await expect(limits.enforce(name, 'k')).resolves.toBeUndefined();
    const err = await limits.enforce(name, 'k').then(() => null, (e) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', message: rule.message });
    expect(err.retryAfterSeconds).toBe(rule.windowSeconds);
    // Another key is untouched.
    await expect(limits.enforce(name, 'other')).resolves.toBeUndefined();
    // Half the window later: still refused, and Retry-After counts down.
    now += (rule.windowSeconds * 1000) / 2;
    const later = await limits.enforce(name, 'k').then(() => null, (e) => e);
    expect(later?.retryAfterSeconds).toBe(Math.ceil(rule.windowSeconds / 2));
    // The window ends: allowed again, from 1.
    now += (rule.windowSeconds * 1000) / 2;
    for (let i = 1; i <= rule.limit; i++) await expect(limits.enforce(name, 'k')).resolves.toBeUndefined();
    await expect(limits.enforce(name, 'k')).rejects.toMatchObject({ status: 429 });
  });

  it('sweeps ended buckets, so memory is bounded by live ones', async () => {
    let now = 0;
    const m = new MemoryRateLimiter(() => now, 10);
    for (let i = 0; i < 25; i++) await m.hit(`b${i}`, 5, 60);
    expect(m.size).toBe(25);
    now += 61_000;
    await m.hit('fresh', 5, 60);
    expect(m.size).toBe(1);
  });
});

describe('each exact limit, on Postgres (PgRateLimiter)', () => {
  let db: Db;
  let client: { close(): Promise<void> };
  beforeAll(async () => ({ db, client } = await freshDrizzle()));
  afterAll(async () => client.close());

  const exact = names.filter((n) => RATE_LIMITS[n].store === 'exact');
  it.each(exact)('%s allows exactly N, refuses with Retry-After, resets when the window ends', async (name) => {
    const limits = new RateLimits({ exact: new PgRateLimiter(db), enabled: 'all' });
    const rule = RATE_LIMITS[name];
    const key = randomUUID();
    for (let i = 1; i <= rule.limit; i++) await limits.enforce(name, key);
    const err = await limits.enforce(name, key).then(() => null, (e) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(err.retryAfterSeconds).toBeGreaterThan(rule.windowSeconds - 5);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(rule.windowSeconds);
    const [row] = await db.execute<{ ok: boolean }>(sql`
      SELECT expires_at = window_start + make_interval(secs => ${rule.windowSeconds}) AS ok
      FROM rate_limits WHERE bucket = ${`${name}:${key}`}`);
    expect(row?.ok).toBe(true);
    // Rewind the window past its end: the next attempt starts a new one.
    await db.execute(sql`
      UPDATE rate_limits SET window_start = window_start - make_interval(secs => ${rule.windowSeconds + 1})
      WHERE bucket = ${`${name}:${key}`}`);
    await expect(limits.enforce(name, key)).resolves.toBeUndefined();
  });
});

describe('the policy', () => {
  it('BENCH_RATE_LIMITS=legacy keeps a bench like the baseline, and is refused in production', () => {
    expect(resolveRateLimitMode('development', undefined)).toBe('all');
    expect(resolveRateLimitMode('production', undefined)).toBe('all');
    expect(resolveRateLimitMode('production', 'all')).toBe('all');
    expect(resolveRateLimitMode('development', 'legacy')).toBe('legacy');
    expect(() => resolveRateLimitMode('production', 'legacy')).toThrow(/refused when NODE_ENV=production/);
    expect(() => resolveRateLimitMode('development', 'off')).toThrow(/must be "all" or "legacy"/);
  });

  it('a test app gets only the limits that existed before Part 15; production gets all', async () => {
    const off = new RateLimits({ exact: new MemoryRateLimiter() });
    for (const n of names) expect(off.isOn(n)).toBe(LEGACY_LIMITS.has(n));
    expect([...LEGACY_LIMITS].sort()).toEqual(['comments', 'forgot_pwd', 'login', 'resend_verification']);

    const { db } = await freshDrizzle();
    const boss = { send: async () => 'job' } as unknown as PgBoss;
    const deps = serverDependencies(db, boss, createProviders({ STORAGE_DRIVER: 'memory', EMAIL_DRIVER: 'memory', ERROR_DRIVER: 'memory' }));
    expect(deps.rateLimits.allOn).toBe(true);
    expect(deps.identity.limits).toBe(deps.rateLimits);
    // The exact store is Postgres, shared with the legacy service limits.
    expect(deps.rateLimits.exact).toBe(deps.limiter);
    expect(deps.limiter).toBeInstanceOf(PgRateLimiter);
  });

  it('every state-changing route is in a group; auth routes in the auth tier', () => {
    expect(routeLimitGroups('POST', '/v1/shelves')).toEqual(['writes']);
    expect(routeLimitGroups('DELETE', '/v1/reads/:id')).toEqual(['writes']);
    expect(routeLimitGroups('POST', '/v1/reads/:id/progress')).toEqual(['progress']);
    expect(routeLimitGroups('GET', '/v1/search')).toEqual(['search']);
    expect(routeLimitGroups('GET', '/v1/works/:id')).toEqual([]);
    for (const url of ['register', 'login', 'refresh', 'logout', 'forgot-password', 'reset-password', 'verify-email']) {
      expect(routeLimitGroups('POST', `/v1/auth/${url}`)).toEqual(['auth']);
    }
    for (const r of ['GET /verify-email', 'POST /verify-email', 'GET /reset-password', 'POST /reset-password', 'POST /v1/admin/auth/login', 'POST /admin/login']) {
      const [m, u] = r.split(' ');
      expect(routeLimitGroups(m!, u!)).toEqual(['auth']);
    }
    expect(Object.keys(LIMIT_GROUPS)).toContain('auth');
  });
});

describe('over HTTP, every limit on', () => {
  let db: Db;
  let client: { close(): Promise<void> };
  let app: FastifyInstance;
  let limits: RateLimits;

  const build = async (fast = new MemoryRateLimiter()) => {
    limits = new RateLimits({ exact: new PgRateLimiter(db), fast, enabled: 'all' });
    const identity = new IdentityService(db, new PgRateLimiter(db));
    identity.limits = limits;
    const a = await buildApp({
      db,
      identity,
      catalog: new CatalogService(db, new MemoryCache()),
      reading: new ReadingService(db),
      storage: new MemoryObjectStorage(),
      rateLimits: limits,
    });
    await a.ready();
    return a;
  };

  beforeAll(async () => {
    ({ db, client } = await freshDrizzle());
    app = await build();
  });
  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it('anonymous search: 20 a minute per IP, then 429 rate_limited with Retry-After and X-RateLimit-*', async () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({ method: 'GET', url: '/v1/search?q=nothing', remoteAddress: ip });
      expect(r.statusCode).toBe(200);
      if (i === 0) {
        expect(r.headers['x-ratelimit-limit']).toBe('20');
        expect(r.headers['x-ratelimit-remaining']).toBe('19');
      }
    }
    const r = await app.inject({ method: 'GET', url: '/v1/search?q=nothing', remoteAddress: ip });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
    // Another IP is not affected.
    expect((await app.inject({ method: 'GET', url: '/v1/search?q=nothing', remoteAddress: '203.0.113.8' })).statusCode).toBe(200);
  });

  it('signed-in search is per account (60/min), whatever the IP', async () => {
    const u = await makeUser(db, `search_${Date.now()}`);
    for (let i = 0; i < 60; i++) {
      const r = await app.inject({ method: 'GET', url: '/v1/search?q=x', headers: u.auth, remoteAddress: `198.51.100.${i % 200}` });
      expect(r.statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/search?q=x', headers: u.auth, remoteAddress: '198.51.100.250' })).statusCode).toBe(429);
  });

  it('the Global tier: 200 an hour for one anonymous IP, across routes', async () => {
    const ip = '192.0.2.200';
    for (let i = 0; i < 200; i++) {
      const r = await app.inject({ method: 'GET', url: `/v1/works/${randomUUID()}`, remoteAddress: ip });
      expect(r.statusCode).toBe(404);
    }
    const r = await app.inject({ method: 'GET', url: `/v1/users/${randomUUID()}`, remoteAddress: ip });
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(3500);
    // Health probes are exempt.
    expect((await app.inject({ method: 'GET', url: '/healthz', remoteAddress: ip })).statusCode).toBe(200);
  });

  it('auth endpoints: 20 a minute per anonymous IP across register, login, refresh', async () => {
    const ip = '192.0.2.21';
    const calls = ['/v1/auth/login', '/v1/auth/refresh', '/v1/auth/forgot-password'];
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({ method: 'POST', url: calls[i % 3]!, remoteAddress: ip, payload: {} });
      expect(r.statusCode).toBe(422); // counted before validation
    }
    const r = await app.inject({ method: 'POST', url: '/v1/auth/register', remoteAddress: ip, payload: {} });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('writes: 120 a minute per account, then 429; progress has its own 300', async () => {
    const u = await makeUser(db, `writer_${Date.now()}`);
    for (let i = 0; i < 120; i++) {
      const r = await app.inject({ method: 'DELETE', url: `/v1/reads/${randomUUID()}`, headers: u.auth });
      expect(r.statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'DELETE', url: `/v1/reads/${randomUUID()}`, headers: u.auth })).statusCode).toBe(429);
    // Progress is a separate bucket: still allowed.
    const p = await app.inject({ method: 'POST', url: `/v1/reads/${randomUUID()}/progress`, headers: u.auth, payload: { page: 1, client_event_id: randomUUID() } });
    expect(p.statusCode).not.toBe(429);
  });

  it('§11.7: 50 follows an hour; a replay of an existing follow is not counted', async () => {
    const me = await makeUser(db, `fol_${Date.now()}`);
    await db.execute(sql`UPDATE users SET created_at = now() - interval '2 days' WHERE id = ${me.id}::uuid`);
    const targets = [];
    for (let i = 0; i < 51; i++) targets.push(await makeUser(db, `t${i}_${Date.now()}`));
    for (let i = 0; i < 50; i++) {
      const r = await app.inject({ method: 'POST', url: `/v1/users/${targets[i]!.id}/follow`, headers: me.auth });
      expect(r.statusCode).toBe(200);
    }
    // Replaying a follow that exists costs nothing.
    const replay = await app.inject({ method: 'POST', url: `/v1/users/${targets[0]!.id}/follow`, headers: me.auth });
    expect(replay.statusCode).toBe(200);
    const r = await app.inject({ method: 'POST', url: `/v1/users/${targets[50]!.id}/follow`, headers: me.auth });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toMatch(/following people too quickly/);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(3000);
    // Nothing was written for the refused follow.
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM follows WHERE follower_id = ${me.id}::uuid`);
    expect(row?.n).toBe(50);
  });

  it('§11.7: follow, unfollow, refollow the same reader: the 4th follow in a day is refused', async () => {
    const me = await makeUser(db, `cyc_${Date.now()}`);
    await db.execute(sql`UPDATE users SET created_at = now() - interval '2 days' WHERE id = ${me.id}::uuid`);
    const them = await makeUser(db, `cyct_${Date.now()}`);
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ method: 'POST', url: `/v1/users/${them.id}/follow`, headers: me.auth })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: `/v1/users/${them.id}/follow`, headers: me.auth })).statusCode).toBe(200);
    }
    const r = await app.inject({ method: 'POST', url: `/v1/users/${them.id}/follow`, headers: me.auth });
    expect(r.statusCode).toBe(429);
    // Someone else is still followable.
    const other = await makeUser(db, `cyco_${Date.now()}`);
    expect((await app.inject({ method: 'POST', url: `/v1/users/${other.id}/follow`, headers: me.auth })).statusCode).toBe(200);
  });

  it('§11.7: a new account follows at most 20 readers in its first 24 hours', async () => {
    const me = await makeUser(db, `new_${Date.now()}`);
    for (let i = 0; i < 20; i++) {
      const t = await makeUser(db, `nt${i}_${Date.now()}`);
      expect((await app.inject({ method: 'POST', url: `/v1/users/${t.id}/follow`, headers: me.auth })).statusCode).toBe(200);
    }
    const t = await makeUser(db, `nt_last_${Date.now()}`);
    const r = await app.inject({ method: 'POST', url: `/v1/users/${t.id}/follow`, headers: me.auth });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toMatch(/New accounts/);
  });

  it('§10.6: 10 new reviews an hour; edits are not counted against it', async () => {
    const me = await makeUser(db, `rev_${Date.now()}`);
    const readIds: string[] = [];
    for (let i = 0; i < 11; i++) readIds.push(await makeRead(db, me.id, await makeWork(db, `Book ${i} ${Date.now()}`)));
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: `/v1/reads/${readIds[i]}/review`, headers: me.auth, payload: { body: `Review ${i}` } });
      expect(r.statusCode).toBeLessThan(300);
    }
    // Editing an existing review is a write, not a new review.
    const edit = await app.inject({ method: 'POST', url: `/v1/reads/${readIds[0]}/review`, headers: me.auth, payload: { body: 'Edited' } });
    expect(edit.statusCode).toBeLessThan(300);
    const r = await app.inject({ method: 'POST', url: `/v1/reads/${readIds[10]}/review`, headers: me.auth, payload: { body: 'One too many' } });
    expect(r.statusCode).toBe(429);
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM reviews WHERE read_id = ${readIds[10]}::uuid`);
    expect(row?.n).toBe(0);
  });

  it('§24.4: 3 imports a day; replaying the same upload returns the import and is not counted', async () => {
    const me = await makeUser(db, `imp_${Date.now()}`);
    const csv = (i: number) => `Title,Author,ISBN,My Rating,Exclusive Shelf\nBook ${i},Someone,,4,read\n`;
    for (let i = 0; i < 3; i++) {
      const uploadId = await uploadFile(app, me.auth, csv(i));
      const r = await app.inject({ method: 'POST', url: '/v1/imports', headers: me.auth, payload: { upload_id: uploadId, source: 'goodreads' } });
      expect(r.statusCode).toBe(201);
      if (i === 0) {
        const again = await app.inject({ method: 'POST', url: '/v1/imports', headers: me.auth, payload: { upload_id: uploadId, source: 'goodreads' } });
        expect(again.statusCode).toBe(200);
      }
    }
    const uploadId = await uploadFile(app, me.auth, csv(9));
    const r = await app.inject({ method: 'POST', url: '/v1/imports', headers: me.auth, payload: { upload_id: uploadId, source: 'goodreads' } });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toMatch(/3 imports a day/);
  });

  it('§24.4: 2 exports a day', async () => {
    const me = await makeUser(db, `exp_${Date.now()}`);
    for (let i = 0; i < 2; i++) {
      expect((await app.inject({ method: 'POST', url: '/v1/exports', headers: me.auth, payload: { format: 'csv' } })).statusCode).toBe(201);
    }
    const r = await app.inject({ method: 'POST', url: '/v1/exports', headers: me.auth, payload: { format: 'csv' } });
    expect(r.statusCode).toBe(429);
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM exports WHERE user_id = ${me.id}::uuid`);
    expect(row?.n).toBe(2);
  });

  it('A-PV-007: 10 upload intents a day', async () => {
    const me = await makeUser(db, `upl_${Date.now()}`);
    const intent = () =>
      app.inject({ method: 'POST', url: '/v1/uploads', headers: me.auth, payload: { purpose: 'import', content_type: 'text/csv', size: 100, filename: 'a.csv' } });
    for (let i = 0; i < 10; i++) expect((await intent()).statusCode).toBe(201);
    expect((await intent()).statusCode).toBe(429);
  });

  it('A-13-021: one new username per 30 days; a taken name costs nothing; taking back your own old name is free', async () => {
    const me = await makeUser(db, `un_${Date.now()}`);
    await makeUser(db, `taken_${Date.now()}`.slice(0, 20));
    const taken = (await db.execute<{ username: string }>(sql`SELECT username FROM profiles WHERE username LIKE 'taken_%' LIMIT 1`))[0]!.username;
    const change = (username: string) => app.inject({ method: 'PATCH', url: '/v1/me/username', headers: me.auth, payload: { username } });
    expect((await change(taken)).statusCode).toBe(409);
    const fresh = `n1_${Date.now()}`.slice(0, 20);
    expect((await change(fresh)).statusCode).toBe(200);
    const r = await change(`n2_${Date.now()}`.slice(0, 20));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(29 * 86400);
    // Back to the old name: no new claim, allowed.
    expect((await change(me.username)).statusCode).toBe(200);
  });

  it('A-10-029: telemetry batches, 120 an hour per IP for a guest (at /v1/events, where the app sends them)', async () => {
    const ip = '192.0.2.120';
    const body = { events: [{ name: 'app_opened', session_id: randomUUID(), timestamp: new Date().toISOString(), properties: {} }] };
    for (let i = 0; i < 120; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/events', remoteAddress: ip, payload: body });
      expect(r.statusCode).toBe(202);
    }
    expect((await app.inject({ method: 'POST', url: '/v1/events', remoteAddress: ip, payload: body })).statusCode).toBe(429);
  });

  it('A-06-RL1: admin login, 10 a minute per account whatever the IP; the form login too', async () => {
    const email = `nobody_${Date.now()}@example.com`;
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/admin/auth/login', remoteAddress: `198.18.0.${i}`, payload: { email, password: 'wrong-password-123', totp_code: '000000' } });
      expect(r.statusCode).toBe(401);
    }
    const r = await app.inject({ method: 'POST', url: '/v1/admin/auth/login', remoteAddress: '198.18.0.99', payload: { email, password: 'wrong-password-123', totp_code: '000000' } });
    expect(r.statusCode).toBe(429);
    const form = await app.inject({
      method: 'POST', url: '/admin/login', remoteAddress: '198.18.1.1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `email=${encodeURIComponent(email)}&password=wrong-password-123&totp_code=000000`,
    });
    expect(form.statusCode).toBe(429);
    expect(form.headers['content-type']).toMatch(/text\/html/);
    expect(form.headers['retry-after']).toBeDefined();
  });

  it('comments keep their bucket name and numbers (no behaviour change)', async () => {
    const me = await makeUser(db, `com_${Date.now()}`);
    const readId = await makeRead(db, me.id, await makeWork(db, `Commented ${Date.now()}`));
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: `/v1/reads/${readId}/comments`, headers: me.auth, payload: { body: `c${i}` } });
      expect(r.statusCode).toBe(201);
    }
    const r = await app.inject({ method: 'POST', url: `/v1/reads/${readId}/comments`, headers: me.auth, payload: { body: 'c5' } });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).toBe('You are commenting too quickly. Try again in a minute.');
    expect(r.headers['retry-after']).toBeDefined();
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rate_limits WHERE bucket = ${`comments:${me.id}`}`);
    expect(row?.n).toBe(1);
  });
});

describe('without a policy (test apps), nothing new is enforced', () => {
  it('search past 20 a minute is fine, the global tier is off', async () => {
    const { db, client } = await freshDrizzle();
    const app = await buildApp({ db, catalog: new CatalogService(db, new MemoryCache()) });
    for (let i = 0; i < 25; i++) {
      expect((await app.inject({ method: 'GET', url: '/v1/search?q=x', remoteAddress: '192.0.2.99' })).statusCode).toBe(200);
    }
    await app.close();
    await client.close();
  });
});
