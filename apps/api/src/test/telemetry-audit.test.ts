// Audit 10: POST /v1/events is unauthenticated, so what it stores is bounded
// by shape, not by who sends it (the rate limit is Part 15, A-10 RL). And the
// §4.4 budget report must not be a false green: a window, no "passing" without
// samples, and one malformed event must not break it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { sql } from 'drizzle-orm';

import { registerCoreHooks } from '../app.js';
import { getBudgetMetrics, telemetryRoutes } from '../telemetry/index.js';
import { sanitizeContext } from '../telemetry/errors.js';
import { signAccessToken } from '../identity/index.js';
import { config, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { events, profiles, users } from '../db/schema.js';

let db: Db;
let client: { close: () => Promise<void> };
let app: FastifyInstance;
let userId: string;
let userToken: string;
let adminToken: string;

beforeAll(async () => {
  ({ db, client } = await freshDrizzle());
  userId = randomUUID();
  await db.insert(users).values({ id: userId, email: 't@example.com', passwordHash: 'x', dateOfBirth: '1990-01-01' });
  await db.insert(profiles).values({ userId, username: 'telemetry_user' });
  userToken = await signAccessToken(userId);
  adminToken = await new jose.SignJWT({ sub: randomUUID(), email: 'a@flyleaf.test', role: 'admin', scope: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('flyleaf')
    .setAudience('flyleaf-admin')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(config.jwtSecret));
  app = Fastify();
  registerCoreHooks(app);
  await app.register(telemetryRoutes(db), { prefix: '/v1' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await client.close();
});
beforeEach(async () => {
  await db.delete(events);
});

const post = (evs: unknown[], headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/v1/events', headers, payload: { events: evs } });
const stored = () => db.select().from(events);

describe('POST /v1/events: shape caps', () => {
  it('stores only names from the PRD §28.2 taxonomy (and the app\'s own), and says how many it dropped', async () => {
    const res = await post([
      { name: 'app_opened', properties: { cold_start: true } },
      { name: 'free_advertising_here', properties: {} },
      { name: 'x'.repeat(100), properties: {} },
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, rejected: 2 });
    expect((await stored()).map((e) => e.name)).toEqual(['app_opened']);
  });

  it('refuses properties that are nested, too many, too long, or too big', async () => {
    const res = await post([
      { name: 'app_opened', properties: { nested: { a: 1 } } },
      { name: 'app_opened', properties: { list: [1, 2, 3] } },
      { name: 'app_opened', properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) },
      { name: 'app_opened', properties: { text: 'y'.repeat(201) } },
      { name: 'app_opened', properties: { ['k'.repeat(65)]: 1 } },
      { name: 'app_opened', properties: { ok: 'fine', n: 3, b: false, z: null } },
    ]);
    expect(res.json()).toEqual({ accepted: 1, rejected: 5 });
    expect((await stored())[0]!.properties).toEqual({ ok: 'fine', n: 3, b: false, z: null });
  });

  it('refuses timestamps from before the queue could hold them or from the future', async () => {
    const now = Date.now();
    const res = await post([
      { name: 'app_opened', at: new Date(now - 8 * 86_400_000).toISOString() },
      { name: 'app_opened', at: new Date(now + 60 * 60_000).toISOString() },
      { name: 'app_opened', at: '1970-01-01T00:00:00Z' },
      { name: 'app_opened', at: new Date(now - 3_600_000).toISOString() },
    ]);
    expect(res.json()).toEqual({ accepted: 1, rejected: 3 });
  });

  it('budget events must carry their measurement as a number in range', async () => {
    const res = await post([
      { name: 'progress_updated', properties: { duration_ms: 'fast' } },
      { name: 'progress_updated', properties: { duration_ms: -5 } },
      { name: 'progress_updated', properties: {} },
      { name: 'book_logged', properties: { tap_count: 2.5 } },
      { name: 'finish_completed', properties: { duration_seconds: 1e9 } },
      { name: 'progress_updated', properties: { duration_ms: 2400, method: 'slider' } },
    ]);
    expect(res.json()).toEqual({ accepted: 1, rejected: 5 });
  });

  it('the user comes from the token only: a user id in the body is ignored', async () => {
    const other = randomUUID();
    await post([{ name: 'app_opened', user_id: other, userId: other, properties: {} }]);
    await post([{ name: 'app_opened', user_id: other, userId: other, properties: {} }], { authorization: `Bearer ${userToken}` });
    const rows = await stored();
    expect(rows.map((r) => r.userId).sort()).toEqual([null, userId].sort());
  });

  it('a batch over 100 events is refused whole', async () => {
    const res = await post(Array.from({ length: 101 }, () => ({ name: 'app_opened' })));
    expect(res.statusCode).toBe(422);
    expect(await stored()).toHaveLength(0);
  });
});

describe('GET /admin/telemetry/budgets: no false greens', () => {
  const report = async (query = '') =>
    app.inject({ method: 'GET', url: `/v1/admin/telemetry/budgets${query}`, headers: { authorization: `Bearer ${adminToken}` } });

  it('with no samples a budget is not "passing": it is unknown', async () => {
    const res = await report();
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.progress_updated).toMatchObject({ sample_count: 0, p75_duration_ms: null, passing: null });
    expect(m.finish_flow_abandoned).toMatchObject({ abandoned_count: 0, completed_count: 0, passing: null });
  });

  it('p75 is exact, and only the window counts (default 28 days)', async () => {
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    await db.insert(events).values([
      ...[1200, 2100, 3200, 4400].map((ms) => ({ name: 'progress_updated', properties: { duration_ms: ms }, at: at(1) })),
      // A slow month long ago must not keep the budget red, or green, today.
      ...Array.from({ length: 10 }, () => ({ name: 'progress_updated', properties: { duration_ms: 60_000 }, at: at(60) })),
    ]);
    const now = (await report()).json();
    expect(now.progress_updated).toMatchObject({ sample_count: 4, p75_duration_ms: 3500, passing: true });
    const wide = (await report('?days=90')).json();
    expect(wide.progress_updated.sample_count).toBe(14);
    expect(wide.progress_updated.passing).toBe(false);
    expect((await report('?days=0')).statusCode).toBe(422);
  });

  it('a malformed row already in the table (written before the caps) does not break the report', async () => {
    await db.execute(sql`INSERT INTO events (name, properties) VALUES ('progress_updated', '{"duration_ms":"abc"}'::jsonb)`);
    await db.insert(events).values({ name: 'progress_updated', properties: { duration_ms: 1000 } });
    const res = await report();
    expect(res.statusCode).toBe(200);
    expect(res.json().progress_updated.sample_count).toBe(1);
    expect((await getBudgetMetrics(db)).progress_updated.p75_duration_ms).toBe(1000);
  });
});

describe('error-report scrubbing (SL-82)', () => {
  it('redacts secrets at any depth, in snake and camel case, in body, query and headers', () => {
    const out = sanitizeContext({
      headers: { authorization: 'Bearer abc', 'x-api-key': 'k', accept: 'json' },
      query: { token: 't', page: '2' },
      body: {
        refresh_token: 'r1',
        refreshToken: 'r2',
        code: '123456',
        profile: { password: 'p', nested: [{ totp: '654321', ok: 1 }] },
        new_password: 'n',
        backup_code: 'b',
        email: 'reader@example.com',
        keep: 'visible',
      },
    });
    expect(out.headers).toEqual({ authorization: '[REDACTED]', 'x-api-key': '[REDACTED]', accept: 'json' });
    expect(out.query).toEqual({ token: '[REDACTED]', page: '2' });
    expect(out.body).toEqual({
      refresh_token: '[REDACTED]',
      refreshToken: '[REDACTED]',
      code: '[REDACTED]',
      profile: { password: '[REDACTED]', nested: [{ totp: '[REDACTED]', ok: 1 }] },
      new_password: '[REDACTED]',
      backup_code: '[REDACTED]',
      email: '[REDACTED]',
      keep: 'visible',
    });
  });
});
