// Telemetry, Interaction Budgets & Sentry test suite (SL-80, SL-81, SL-82, PRD §4.4, §28.1).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as jose from 'jose';

import { registerCoreHooks } from '../app.js';
import { telemetryRoutes, getBudgetMetrics, recordEvents } from '../telemetry/index.js';
import { sanitizeContext } from '../telemetry/errors.js';
import { MemoryErrorReporter } from '../providers/errors/index.js';
import { signAccessToken } from '../identity/index.js';
import { config, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { users, profiles, events } from '../db/schema.js';

describe('Telemetry & Interaction Budgets Suite (SL-8x)', () => {
  let db: Db;
  let client: { close: () => Promise<void> };
  let app: FastifyInstance;

  let USER_ID: string;
  let userToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    client = fresh.client;

    USER_ID = randomUUID();

    // Create regular test user
    await db.insert(users).values({
      id: USER_ID,
      email: 'reader@example.com',
      passwordHash: 'dummy',
      dateOfBirth: '1995-03-10',
    });
    await db.insert(profiles).values({
      userId: USER_ID,
      username: 'reader_jane',
      displayName: 'Jane',
      isPrivate: false,
    });

    userToken = await signAccessToken(USER_ID);

    // Create admin token for budget metrics inspection
    const adminId = randomUUID();
    adminToken = await new jose.SignJWT({
      sub: adminId,
      email: 'admin@flyleaf.test',
      role: 'admin',
      scope: 'admin',
    })
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

  describe('Event Ingestion (SL-80)', () => {
    it('accepts anonymous batch telemetry events', async () => {
      const sessionId = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/events',
        payload: {
          events: [
            {
              name: 'app_opened',
              session_id: sessionId,
              platform: 'ios',
              app_version: '1.0.0',
              properties: { cold_start: true },
            },
            {
              name: 'discover_row_impression',
              session_id: sessionId,
              platform: 'ios',
              app_version: '1.0.0',
              properties: { row: 'popular', position: 0 },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(202);
      const json = JSON.parse(res.payload);
      expect(json.accepted).toBe(2);

      // Verify stored in events table
      const stored = await db.select().from(events);
      const matched = stored.filter((e) => e.sessionId === sessionId);
      expect(matched.length).toBe(2);
      expect(matched[0]?.userId).toBeNull();
      expect(matched[0]?.platform).toBe('ios');
    });

    it('attaches authenticated userId when Bearer token is provided', async () => {
      const sessionId = randomUUID();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${userToken}`,
        },
        payload: {
          events: [
            {
              name: 'book_viewed',
              session_id: sessionId,
              platform: 'android',
              properties: { source: 'search' },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(202);
      const json = JSON.parse(res.payload);
      expect(json.accepted).toBe(1);

      const stored = await db.select().from(events);
      const matched = stored.find((e) => e.sessionId === sessionId && e.name === 'book_viewed');
      expect(matched).toBeDefined();
      expect(matched?.userId).toBe(USER_ID);
      expect(matched?.platform).toBe('android');
    });

    it('rejects malformed event batches', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/events',
        payload: {
          events: [
            {
              // missing name
              properties: { foo: 'bar' },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(422);
      const json = JSON.parse(res.payload);
      expect(json.error).toBeDefined();
    });
  });

  describe('PRD §4.4 Interaction Budgets Calculation (SL-81)', () => {
    beforeAll(async () => {
      // Seed budget events
      // 1. progress_updated: p75 < 5s (5000ms)
      await recordEvents(db, [
        { name: 'progress_updated', properties: { duration_ms: 1200, delta_pages: 15 } },
        { name: 'progress_updated', properties: { duration_ms: 2100, delta_pages: 20 } },
        { name: 'progress_updated', properties: { duration_ms: 3200, delta_pages: 10 } },
        { name: 'progress_updated', properties: { duration_ms: 4400, delta_pages: 35 } },
      ]);

      // 2. book_logged: p75 <= 2 taps
      await recordEvents(db, [
        { name: 'book_logged', properties: { tap_count: 1 } },
        { name: 'book_logged', properties: { tap_count: 2 } },
        { name: 'book_logged', properties: { tap_count: 2 } },
        { name: 'book_logged', properties: { tap_count: 2 } },
      ]);

      // 3. finish_completed: p75 < 20s
      await recordEvents(db, [
        { name: 'finish_completed', properties: { duration_seconds: 8 } },
        { name: 'finish_completed', properties: { duration_seconds: 12 } },
        { name: 'finish_completed', properties: { duration_seconds: 15 } },
        { name: 'finish_completed', properties: { duration_seconds: 18 } },
      ]);

      // 4. log_sheet_completed: p75 < 15s (15000ms)
      await recordEvents(db, [
        { name: 'log_sheet_completed', properties: { duration_ms: 4500 } },
        { name: 'log_sheet_completed', properties: { duration_ms: 7000 } },
        { name: 'log_sheet_completed', properties: { duration_ms: 9500 } },
        { name: 'log_sheet_completed', properties: { duration_ms: 11000 } },
      ]);

      // 5. finish_flow_abandoned: < 8% abandonment rate
      // 4 completed (from above) + 0 abandoned so far. Let's add 1 abandonment:
      // total = 1 abandoned + 4 completed = 5 total -> 1/5 = 20% (or let's add 10 completions to test < 8%)
      await recordEvents(db, [
        { name: 'finish_flow_abandoned', properties: { stage: 'stars_picker', time_spent_ms: 3000 } },
        // Add 16 more completions so total = 1 abandoned + 20 completions = 1/21 ~ 4.76% (< 8%)
        ...Array.from({ length: 16 }).map(() => ({
          name: 'finish_completed',
          properties: { duration_seconds: 14 },
        })),
      ]);
    });

    it('computes accurate p75 percentiles and passing flags', async () => {
      const metrics = await getBudgetMetrics(db);

      // 1. progress_updated
      expect(metrics.progress_updated.sample_count).toBeGreaterThanOrEqual(4);
      expect(metrics.progress_updated.budget_ms).toBe(5000);
      expect(metrics.progress_updated.p75_duration_ms).toBeLessThan(5000);
      expect(metrics.progress_updated.passing).toBe(true);

      // 2. book_logged
      expect(metrics.book_logged.sample_count).toBeGreaterThanOrEqual(4);
      expect(metrics.book_logged.budget_taps).toBe(2);
      expect(metrics.book_logged.p75_tap_count).toBeLessThanOrEqual(2);
      expect(metrics.book_logged.passing).toBe(true);

      // 3. finish_completed
      expect(metrics.finish_completed.sample_count).toBeGreaterThanOrEqual(20);
      expect(metrics.finish_completed.budget_seconds).toBe(20);
      expect(metrics.finish_completed.p75_duration_seconds).toBeLessThan(20);
      expect(metrics.finish_completed.passing).toBe(true);

      // 4. log_sheet_completed
      expect(metrics.log_sheet_completed.sample_count).toBeGreaterThanOrEqual(4);
      expect(metrics.log_sheet_completed.budget_ms).toBe(15000);
      expect(metrics.log_sheet_completed.p75_duration_ms).toBeLessThan(15000);
      expect(metrics.log_sheet_completed.passing).toBe(true);

      // 5. finish_flow_abandoned
      expect(metrics.finish_flow_abandoned.abandoned_count).toBe(1);
      expect(metrics.finish_flow_abandoned.completed_count).toBeGreaterThanOrEqual(20);
      expect(metrics.finish_flow_abandoned.abandonment_rate).toBeLessThan(0.08);
      expect(metrics.finish_flow_abandoned.passing).toBe(true);
    });

    it('serves budget metrics via admin endpoint with proper role gating', async () => {
      // Unauthenticated request -> 401
      const unauth = await app.inject({
        method: 'GET',
        url: '/v1/admin/telemetry/budgets',
      });
      expect(unauth.statusCode).toBe(401);

      // Regular user token -> 401 (not admin token)
      const userReq = await app.inject({
        method: 'GET',
        url: '/v1/admin/telemetry/budgets',
        headers: {
          authorization: `Bearer ${userToken}`,
        },
      });
      expect(userReq.statusCode).toBe(401);

      // Admin token -> 200
      const adminReq = await app.inject({
        method: 'GET',
        url: '/v1/admin/telemetry/budgets',
        headers: {
          'x-admin-token': adminToken,
        },
      });
      expect(adminReq.statusCode).toBe(200);
      const json = JSON.parse(adminReq.payload);
      expect(json.progress_updated).toBeDefined();
      expect(json.book_logged).toBeDefined();
      expect(json.finish_completed).toBeDefined();
      expect(json.log_sheet_completed).toBeDefined();
      expect(json.finish_flow_abandoned).toBeDefined();
    });
  });

  describe('Sentry Context Sanitization & Error Reporting (SL-82)', () => {
    it('sanitizes authorization, cookies, and sensitive passwords from error context', () => {
      const rawContext = {
        requestId: 'req-123',
        userId: 'user-456',
        headers: {
          authorization: 'Bearer secret-access-token-jwt',
          cookie: 'flyleaf_admin_session=secret-session-cookie',
          'user-agent': 'Flyleaf-Mobile/1.0',
        },
        body: {
          email: 'reader@example.com',
          password: 'super-secret-password-123',
          totp: '123456',
        },
      };

      const sanitized = sanitizeContext(rawContext);

      expect(sanitized.headers?.authorization).toBe('[REDACTED]');
      expect(sanitized.headers?.cookie).toBe('[REDACTED]');
      expect(sanitized.headers?.['user-agent']).toBe('Flyleaf-Mobile/1.0');

      expect(sanitized.body?.email).toBe('reader@example.com');
      expect(sanitized.body?.password).toBe('[REDACTED]');
      expect(sanitized.body?.totp).toBe('[REDACTED]');
    });

    it('a 500 reaches the configured reporter with a scrubbed context, and the client sees no detail (PV-06)', async () => {
      const reporter = new MemoryErrorReporter();
      const app = Fastify();
      registerCoreHooks(app, { errorReporter: reporter });
      app.post('/boom', async () => {
        throw new Error('database exploded at row 42');
      });

      const res = await app.inject({
        method: 'POST',
        url: '/boom?token=emailed-secret&tab=1',
        headers: { authorization: 'Bearer secret-access-token-jwt' },
        payload: { password: 'hunter2hunter2', title: 'ok' },
      });
      await new Promise((r) => setImmediate(r));

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('exploded');
      expect(reporter.captured).toHaveLength(1);
      const { error, context } = reporter.captured[0]!;
      expect(error.message).toBe('database exploded at row 42');
      expect(context.requestId).toBe(res.headers['x-request-id']);
      expect(context.route).toBe('/boom');
      expect(context.headers?.authorization).toBe('[REDACTED]');
      expect(context.query?.token).toBe('[REDACTED]');
      expect(context.query?.tab).toBe('1');
      expect(context.body?.password).toBe('[REDACTED]');
      await app.close();
    });

    it('with no reporter configured a 500 is still a clean 500', async () => {
      const app = Fastify();
      registerCoreHooks(app);
      app.get('/boom', async () => {
        throw new Error('nope');
      });
      const res = await app.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: 'internal', message: 'Something went wrong.' } });
      await app.close();
    });
  });
});
