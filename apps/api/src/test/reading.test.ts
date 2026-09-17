// Reading Core test suite (SL-50, SL-51, SL-54, SL-55, SL-56, Architecture §3.4).
//
// Governed by:
//   1. Append-only progress_events idempotent on client_event_id (SL-51).
//   2. Re-read creates attempt_no + 1 (SL-56).
//   3. Finish flow updates status, finished_at, rating, hearted, format in one call (SL-54).
//   4. DNF records abandoned_at, abandoned_page, dnf_reason respectfully (SL-55).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';

import { registerCoreHooks } from '../app.js';
import { ReadingService, readingRoutes } from '../reading/index.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { users, profiles, works, reads, progressEvents } from '../db/schema.js';

describe('Reading Core (SL-5x)', () => {
  let db: Db;
  let client: { close: () => Promise<void> };
  let app: FastifyInstance;
  let service: ReadingService;

  let USER_ID: string;
  let WORK_A: string;
  let WORK_B: string;
  let authToken: string;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    client = fresh.client;

    USER_ID = randomUUID();
    WORK_A = randomUUID();
    WORK_B = randomUUID();

    // Create user & profile
    await db.insert(users).values({
      id: USER_ID,
      email: 'reader@example.com',
      passwordHash: 'dummy-hash',
      dateOfBirth: '1995-01-01',
    });
    await db.insert(profiles).values({
      userId: USER_ID,
      username: 'reader_one',
      displayName: 'Reader One',
      isPrivate: false,
    });

    // Create test works
    const [wA] = await db.insert(works).values({ title: 'Piranesi' }).returning({ id: works.id });
    WORK_A = wA!.id;
    const [wB] = await db.insert(works).values({ title: 'The Hobbit' }).returning({ id: works.id });
    WORK_B = wB!.id;

    authToken = await signAccessToken(USER_ID);

    const limiter = new PgRateLimiter(db);
    const identityService = new IdentityService(db, limiter);
    service = new ReadingService(db);

    app = Fastify();
    registerCoreHooks(app, {
      identityLookup: (token) => identityService.lookup(token),
    });
    await app.register(readingRoutes(service), { prefix: '/v1' });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  describe('SL-50 & SL-51: Reading Lifecycle & Idempotent Progress', () => {
    let readId: string;

    it('creates a new reading attempt with started_at and format_override', async () => {
      const read = await service.upsert(
        USER_ID,
        WORK_A,
        'reading',
        null,
        false,
        'public',
        { formatOverride: 'print', startedAt: '2026-09-01' },
      );

      expect(read.status).toBe('reading');
      expect(read.attempt_no).toBe(1);
      expect(read.started_at).toBe('2026-09-01');
      expect(read.format_override).toBe('print');
      readId = read.id;
    });

    it('appends progress events with note, minutes, and audio_seconds', async () => {
      const clientEventId = randomUUID();
      const updated = await service.addProgress(
        USER_ID,
        readId,
        clientEventId,
        45,
        null,
        30,
        'A mesmerizing labyrinth.',
        null,
      );

      expect(updated.id).toBe(readId);

      // Verify row in progress_events
      const [event] = await db.execute<{ page: number; minutes: number; note: string; client_event_id: string }>(
        sql`SELECT page, minutes, note, client_event_id FROM progress_events WHERE client_event_id = ${clientEventId}`
      );
      expect(event).toBeDefined();
      expect(event!.page).toBe(45);
      expect(event!.minutes).toBe(30);
      expect(event!.note).toBe('A mesmerizing labyrinth.');
    });

    it('enforces idempotency on client_event_id (SL-51)', async () => {
      const clientEventId = randomUUID();

      // First write
      const first = await service.addProgress(USER_ID, readId, clientEventId, 75, null, 20);
      expect(first.id).toBe(readId);

      // Duplicate write (e.g. offline queue retry)
      const second = await service.addProgress(USER_ID, readId, clientEventId, 75, null, 20);
      expect(second.id).toBe(readId);

      // Verify exactly ONE event was created
      const count = await db.execute<{ count: string }>(
        sql`SELECT count(*) FROM progress_events WHERE client_event_id = ${clientEventId}`
      );
      expect(Number(count[0]!.count)).toBe(1);
    });
  });

  describe('SL-54: Finish Flow', () => {
    let readId: string;

    beforeAll(async () => {
      const read = await service.upsert(USER_ID, WORK_B, 'reading', null, false, 'public', {
        startedAt: '2026-09-10',
      });
      readId = read.id;
    });

    it('validates finished_at cannot be earlier than started_at', async () => {
      await expect(
        service.finish(USER_ID, readId, {
          finishedAt: '2026-09-01', // Earlier than started_at 2026-09-10
          rating: 4.5,
        }),
      ).rejects.toThrow('Finish date cannot be earlier than started date.');
    });

    it('completes finish in one call with rating, heart, format, date', async () => {
      const finished = await service.finish(USER_ID, readId, {
        finishedAt: '2026-09-15',
        rating: 4.5,
        hearted: true,
        formatOverride: 'ebook',
      });

      expect(finished.status).toBe('finished');
      expect(finished.rating).toBe(4.5);
      expect(finished.hearted).toBe(true);
      expect(finished.format_override).toBe('ebook');
      expect(finished.finished_at).toBe('2026-09-15');
    });
  });

  describe('SL-55: Respectful DNF Flow', () => {
    it('records DNF with abandoned_page, dnf_reason, and neutral tone', async () => {
      const [w] = await db.insert(works).values({ title: 'Dense Philosophy' }).returning({ id: works.id });
      const workId = w!.id;

      const read = await service.upsert(USER_ID, workId, 'reading', null, false, 'public');

      const dnfRead = await service.dnf(USER_ID, read.id, {
        abandonedPage: 64,
        dnfReason: 'Not the right time',
      });

      expect(dnfRead.status).toBe('dnf');
      expect(dnfRead.abandoned_page).toBe(64);
      expect(dnfRead.dnf_reason).toBe('Not the right time');
      expect(dnfRead.abandoned_at).toBeDefined();
    });
  });

  describe('SL-56: Re-Read Handling (attempt_no + 1)', () => {
    it('creates attempt_no + 1 when re-reading a finished book', async () => {
      // First attempt on WORK_B is already finished (attempt 1)
      const reread = await service.upsert(USER_ID, WORK_B, 'reading');

      expect(reread.attempt_no).toBe(2);
      expect(reread.status).toBe('reading');

      // Verify two rows exist in database
      const rows = await db.execute<{ attempt_no: number; status: string }>(
        sql`SELECT attempt_no, status FROM reads WHERE user_id = ${USER_ID} AND work_id = ${WORK_B} ORDER BY attempt_no ASC`
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.attempt_no).toBe(1);
      expect(rows[0]!.status).toBe('finished');
      expect(rows[1]!.attempt_no).toBe(2);
      expect(rows[1]!.status).toBe('reading');
    });
  });

  describe('HTTP Endpoints (Fastify Routes)', () => {
    it('POST /v1/reads/:id/progress is idempotent over HTTP', async () => {
      const [w] = await db.insert(works).values({ title: 'Quick Book' }).returning({ id: works.id });
      const workId = w!.id;
      const read = await service.upsert(USER_ID, workId, 'reading');

      const clientEventId = randomUUID();

      const res1 = await app.inject({
        method: 'POST',
        url: `/v1/reads/${read.id}/progress`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          client_event_id: clientEventId,
          page: 25,
          minutes: 15,
          note: 'Starting off strong.',
        },
      });
      expect(res1.statusCode).toBe(200);

      // Replay identical request
      const res2 = await app.inject({
        method: 'POST',
        url: `/v1/reads/${read.id}/progress`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          client_event_id: clientEventId,
          page: 25,
          minutes: 15,
          note: 'Starting off strong.',
        },
      });
      expect(res2.statusCode).toBe(200);

      // Verify only 1 progress row
      const count = await db.execute<{ count: string }>(
        sql`SELECT count(*) FROM progress_events WHERE client_event_id = ${clientEventId}`
      );
      expect(Number(count[0]!.count)).toBe(1);
    });

    it('POST /v1/reads/:id/finish finishes read atomically', async () => {
      const [w] = await db.insert(works).values({ title: 'Novella' }).returning({ id: works.id });
      const workId = w!.id;
      const read = await service.upsert(USER_ID, workId, 'reading');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/reads/${read.id}/finish`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          rating: 5,
          hearted: true,
          format_override: 'print',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('finished');
      expect(body.rating).toBe(5);
      expect(body.hearted).toBe(true);
      expect(body.format_override).toBe('print');
    });

    it('POST /v1/reads/:id/dnf records abandonment atomically', async () => {
      const [w] = await db.insert(works).values({ title: 'Drop Off' }).returning({ id: works.id });
      const workId = w!.id;
      const read = await service.upsert(USER_ID, workId, 'reading');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/reads/${read.id}/dnf`,
        headers: { authorization: `Bearer ${authToken}` },
        payload: {
          abandoned_page: 50,
          dnf_reason: 'Lost interest',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('dnf');
      expect(body.abandoned_page).toBe(50);
      expect(body.dnf_reason).toBe('Lost interest');
    });
  });
});
