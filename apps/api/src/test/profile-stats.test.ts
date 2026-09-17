// Profile & Reading Stats test suite (SL-72, SL-73, SL-74, PRD §6.18, §6.39, §6.40).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerCoreHooks } from '../app.js';
import { IdentityService, identityRoutes, signAccessToken } from '../identity/index.js';
import { ReadingService, readingRoutes } from '../reading/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { users, profiles, works, reads, progressEvents, authors, workAuthors, editions } from '../db/schema.js';

describe('Profile, Favourites & Stats (SL-7x)', () => {
  let db: Db;
  let client: { close: () => Promise<void> };
  let app: FastifyInstance;
  let identityService: IdentityService;
  let readingService: ReadingService;

  let USER_A: string;
  let USER_B: string;
  let tokenA: string;
  let tokenB: string;

  let WORK_1: string;
  let WORK_2: string;
  let WORK_3: string;
  let WORK_4: string;
  let WORK_5: string;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    client = fresh.client;

    USER_A = randomUUID();
    USER_B = randomUUID();

    // Create User A
    await db.insert(users).values({
      id: USER_A,
      email: 'alice@example.com',
      passwordHash: 'dummy',
      dateOfBirth: '1990-05-15',
    });
    await db.insert(profiles).values({
      userId: USER_A,
      username: 'alice_reader',
      displayName: 'Alice',
      bio: 'Bookworm & tea lover',
      isPrivate: false,
    });

    // Create User B (private)
    await db.insert(users).values({
      id: USER_B,
      email: 'bob@example.com',
      passwordHash: 'dummy',
      dateOfBirth: '1992-08-20',
    });
    await db.insert(profiles).values({
      userId: USER_B,
      username: 'bob_secret',
      displayName: 'Bob',
      bio: 'Private reader',
      isPrivate: true,
    });

    // Create 5 Works
    const [w1] = await db.insert(works).values({ title: 'Piranesi', olCoverId: 101 }).returning({ id: works.id });
    WORK_1 = w1!.id;
    const [w2] = await db.insert(works).values({ title: 'The Left Hand of Darkness', olCoverId: 102 }).returning({ id: works.id });
    WORK_2 = w2!.id;
    const [w3] = await db.insert(works).values({ title: 'Klara and the Sun', olCoverId: 103 }).returning({ id: works.id });
    WORK_3 = w3!.id;
    const [w4] = await db.insert(works).values({ title: 'Invisible Cities', olCoverId: 104 }).returning({ id: works.id });
    WORK_4 = w4!.id;
    const [w5] = await db.insert(works).values({ title: 'War and Peace', olCoverId: 105 }).returning({ id: works.id });
    WORK_5 = w5!.id;

    // Create Authors & WorkAuthors
    const [a1] = await db.insert(authors).values({ name: 'Susanna Clarke' }).returning({ id: authors.id });
    const [a2] = await db.insert(authors).values({ name: 'Ursula K. Le Guin' }).returning({ id: authors.id });
    const [a3] = await db.insert(authors).values({ name: 'Kazuo Ishiguro' }).returning({ id: authors.id });
    const [a4] = await db.insert(authors).values({ name: 'Italo Calvino' }).returning({ id: authors.id });
    const [a5] = await db.insert(authors).values({ name: 'Leo Tolstoy' }).returning({ id: authors.id });

    await db.insert(workAuthors).values([
      { workId: WORK_1, authorId: a1!.id, position: 0 },
      { workId: WORK_2, authorId: a2!.id, position: 0 },
      { workId: WORK_3, authorId: a3!.id, position: 0 },
      { workId: WORK_4, authorId: a4!.id, position: 0 },
      { workId: WORK_5, authorId: a5!.id, position: 0 },
    ]);

    // Create Editions for pages
    await db.insert(editions).values([
      { workId: WORK_1, pageCount: 245, olCoverId: 101 },
      { workId: WORK_2, pageCount: 304, olCoverId: 102 },
      { workId: WORK_3, pageCount: 320, olCoverId: 103 },
      { workId: WORK_4, pageCount: 165, olCoverId: 104 },
      { workId: WORK_5, pageCount: 1225, olCoverId: 105 },
    ]);

    tokenA = await signAccessToken(USER_A);
    tokenB = await signAccessToken(USER_B);

    const limiter = new PgRateLimiter(db);
    identityService = new IdentityService(db, limiter);
    readingService = new ReadingService(db);

    app = Fastify();
    registerCoreHooks(app, {
      identityLookup: (token) => identityService.lookup(token),
    });

    await app.register(identityRoutes(identityService), { prefix: '/v1' });
    await app.register(readingRoutes(readingService), { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  describe('Profile & Favourites (SL-72, SL-73)', () => {
    it('retrieves current viewer profile via GET /v1/me/profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/profile',
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.username).toBe('alice_reader');
      expect(data.displayName).toBe('Alice');
      expect(data.bio).toBe('Bookworm & tea lover');
      expect(data.favourites).toEqual([]);
    });

    it('updates bio, display name, and sets 4 favourite books via PATCH /v1/me/profile', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/me/profile',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          displayName: 'Alice Wonderland',
          bio: 'Always with a book in hand.',
          favouriteWorkIds: [WORK_1, WORK_2, WORK_3, WORK_4],
        },
      });

      if (res.statusCode !== 200) {
        console.log('PATCH /v1/me/profile failed:', res.payload);
      }
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.displayName).toBe('Alice Wonderland');
      expect(data.bio).toBe('Always with a book in hand.');
      expect(data.favourite_work_ids).toEqual([WORK_1, WORK_2, WORK_3, WORK_4]);
      expect(data.favourites).toHaveLength(4);
      expect(data.favourites[0]).toEqual({
        id: WORK_1,
        title: 'Piranesi',
        author_name: 'Susanna Clarke',
        cover_id: 101,
      });
      expect(data.favourites[3]).toEqual({
        id: WORK_4,
        title: 'Invisible Cities',
        author_name: 'Italo Calvino',
        cover_id: 104,
      });
    });

    it('preserves exact custom order of favourites on public lookup GET /v1/users/:id', async () => {
      // Reorder favourites: WORK_4, WORK_1
      await app.inject({
        method: 'PATCH',
        url: '/v1/me/profile',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          favouriteWorkIds: [WORK_4, WORK_1],
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_A}`,
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.favourite_work_ids).toEqual([WORK_4, WORK_1]);
      expect(data.favourites).toHaveLength(2);
      expect(data.favourites[0].title).toBe('Invisible Cities');
      expect(data.favourites[1].title).toBe('Piranesi');
    });

    it('rejects more than 4 favourites with 422', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/me/profile',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          favouriteWorkIds: [WORK_1, WORK_2, WORK_3, WORK_4, WORK_5],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_field');
    });

    it('rejects bio longer than 160 characters with 422', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/me/profile',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          bio: 'A'.repeat(161),
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_field');
    });
  });

  describe('Reading Stats (SL-74, PRD §6.40)', () => {
    it('aggregates volume, pace, rating distribution, and streaks', async () => {
      // Populate reads for Alice:
      // 1. Finished read WORK_1 in 2026 with 5 stars
      const read1 = await readingService.upsert(USER_A, WORK_1, 'reading', null, null, 'public', {
        startedAt: '2026-03-01',
      });
      await readingService.finish(USER_A, read1.id, {
        finishedAt: '2026-03-15',
        rating: 5.0,
        hearted: true,
        formatOverride: 'print',
      });

      // 2. Finished read WORK_2 in 2026 with 4.5 stars
      const read2 = await readingService.upsert(USER_A, WORK_2, 'reading', null, null, 'public', {
        startedAt: '2026-05-01',
      });
      await readingService.finish(USER_A, read2.id, {
        finishedAt: '2026-05-20',
        rating: 4.5,
        hearted: false,
        formatOverride: 'ebook',
      });

      // 3. Finished read WORK_5 in 2026 with 4 stars
      const read3 = await readingService.upsert(USER_A, WORK_5, 'reading', null, null, 'public', {
        startedAt: '2026-05-01',
      });
      await readingService.finish(USER_A, read3.id, {
        finishedAt: '2026-05-21',
        rating: 4.0,
        hearted: false,
        formatOverride: 'audiobook',
      });

      // 4. DNF read WORK_3 in 2026
      const read4 = await readingService.upsert(USER_A, WORK_3, 'reading', null, null, 'public');
      await readingService.dnf(USER_A, read4.id, {
        abandonedPage: 50,
        dnfReason: 'lost_interest',
      });

      // Add audio progress for read3
      await readingService.addProgress(USER_A, read3.id, randomUUID(), null, null, null, null, 7200);

      // Query Alice's stats for 2026
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/stats?year=2026',
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(200);
      const stats = res.json();
      expect(stats.year).toBe('2026');
      expect(stats.books_count).toBe(3);
      // 245 (WORK_1) + 304 (WORK_2) + 1225 (WORK_5) = 1774
      expect(stats.pages_count).toBe(1774);
      expect(stats.audio_hours).toBe(2);

      // Average rating: (5 + 4.5 + 4) / 3 = 4.5
      expect(stats.avg_rating).toBe(4.5);
      expect(stats.rating_distribution['5']).toBe(2); // 5.0 and 4.5 round to 5
      expect(stats.rating_distribution['4']).toBe(1);

      // Format breakdown: 1 print, 1 ebook, 1 audiobook
      expect(stats.format_breakdown).toEqual({
        print: 1,
        ebook: 1,
        audiobook: 1,
      });

      // Monthly pace
      expect(stats.monthly_pace[2].month).toBe(3);
      expect(stats.monthly_pace[2].books).toBe(1);
      expect(stats.monthly_pace[2].pages).toBe(245);
      expect(stats.monthly_pace[4].month).toBe(5);
      expect(stats.monthly_pace[4].books).toBe(2);

      // Extremes
      expect(stats.longest_book.title).toBe('War and Peace');
      expect(stats.longest_book.page_count).toBe(1225);
      expect(stats.shortest_book.title).toBe('Piranesi');
      expect(stats.shortest_book.page_count).toBe(245);

      // DNF
      expect(stats.dnf_count).toBe(1);
      expect(stats.dnf_rate).toBeCloseTo(0.25, 2); // 1 DNF / (3 finished + 1 DNF)
    });

    it('enforces privacy: returns 404 for private user stats to unauthenticated or non-followers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_B}/stats`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('allows private user to access their own stats via GET /v1/me/stats', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/me/stats',
        headers: { authorization: `Bearer ${tokenB}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().books_count).toBe(0);
    });
  });
});
