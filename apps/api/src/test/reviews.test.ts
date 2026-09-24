// Ratings, Reviews & Social Test Suite (SL-60, SL-61, SL-62, SL-63, SL-64).
//
// Governed by:
//   1. Bayesian weighted average (SL-62, PRD §9.5):
//      weighted_rating = (v / (v + m)) * R + (m / (v + m)) * C
//      Ensures 40,000 ratings at 4.3 outrank a single 5.0 rating.
//   2. PostgreSQL trigger-maintained work_stats (SL-62).
//   3. Review composer: validations, editing, soft deletion (SL-63).
//   4. Review ranking with friends-first social proximity dominance (SL-64, PRD §10.7).
//   5. Read/Review likes (SL-64; idempotent like/unlike since SO-21).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';

import { registerCoreHooks } from '../app.js';
import {
  calculateBayesianRating,
  calculateReviewRankingScore,
  reviewsPlugin,
  ReviewService,
} from '../reviews/index.js';
import { readingRoutes, ReadingService } from '../reading/index.js';
import { interactionsPlugin } from '../interactions/index.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { users, profiles, works, reads, follows, workStats } from '../db/schema.js';

describe('Ratings & Reviews (SL-6x)', () => {
  let db: Db;
  let client: { close: () => Promise<void> };
  let app: FastifyInstance;
  let reviewService: ReviewService;
  let readingService: ReadingService;

  let USER_A: string;
  let USER_B: string;
  let USER_C: string;
  let WORK_PIRANESI: string;
  let WORK_HOBBIT: string;
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    client = fresh.client;

    USER_A = randomUUID();
    USER_B = randomUUID();
    USER_C = randomUUID();

    // Create 3 users
    for (const [id, username, email] of [
      [USER_A, 'alice', 'alice@example.com'],
      [USER_B, 'bob', 'bob@example.com'],
      [USER_C, 'carol', 'carol@example.com'],
    ] as const) {
      await db.insert(users).values({
        id,
        email,
        passwordHash: 'dummy-hash',
        dateOfBirth: '1995-01-01',
      });
      await db.insert(profiles).values({
        userId: id,
        username,
        displayName: username.toUpperCase(),
        isPrivate: false,
      });
    }

    // User A follows User B (for friends-first social proximity tests)
    await db.insert(follows).values({
      followerId: USER_A,
      followeeId: USER_B,
      state: 'accepted',
    });

    // Create works
    const [w1] = await db.insert(works).values({ title: 'Piranesi' }).returning({ id: works.id });
    WORK_PIRANESI = w1!.id;
    const [w2] = await db.insert(works).values({ title: 'The Hobbit' }).returning({ id: works.id });
    WORK_HOBBIT = w2!.id;

    tokenA = await signAccessToken(USER_A);
    tokenB = await signAccessToken(USER_B);
    tokenC = await signAccessToken(USER_C);

    const limiter = new PgRateLimiter(db);
    const identityService = new IdentityService(db, limiter);
    reviewService = new ReviewService(db);
    readingService = new ReadingService(db);

    app = Fastify();
    registerCoreHooks(app, {
      identityLookup: (token) => identityService.lookup(token),
    });
    await app.register(readingRoutes(readingService), { prefix: '/v1' });
    await app.register(reviewsPlugin, { db });
    await app.register(interactionsPlugin, { prefix: '/v1', db });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  // --------------------------------------------------------------------------
  // SL-62: Bayesian Weighted Rating Math
  // --------------------------------------------------------------------------
  describe('SL-62: Bayesian Weighted Rating Calculation (PRD §9.5)', () => {
    it('calculates weighted rating pulling low counts towards catalog mean', () => {
      // 1 rating of 5.0 with C=3.9, m=25
      // (1 / 26) * 5.0 + (25 / 26) * 3.9 = 0.1923 + 3.75 = 3.94
      const singleFive = calculateBayesianRating(1, 5.0, 3.9, 25);
      expect(singleFive).toBe(3.94);

      // 500 ratings of 4.3 with C=3.9, m=25
      // (500 / 525) * 4.3 + (25 / 525) * 3.9 = 4.0952 + 0.1857 = 4.28
      const belovedClassic = calculateBayesianRating(500, 4.3, 3.9, 25);
      expect(belovedClassic).toBe(4.28);

      // Crucial PRD invariant: A single 5-star book CANNOT outrank the 4.3 beloved classic!
      expect(belovedClassic!).toBeGreaterThan(singleFive!);
    });

    it('returns null for zero or non-existent ratings', () => {
      expect(calculateBayesianRating(0, null)).toBeNull();
      expect(calculateBayesianRating(0, 4.5)).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // SL-62: Database Trigger for work_stats
  // --------------------------------------------------------------------------
  describe('SL-62: Trigger-Maintained work_stats', () => {
    it('maintains work_stats automatically on read insert, update, and delete', async () => {
      // 1. Create a finished read with a rating
      const [r1] = await db
        .insert(reads)
        .values({
          userId: USER_A,
          workId: WORK_PIRANESI,
          status: 'finished',
          rating: '5.0',
          hearted: true,
        })
        .returning({ id: reads.id });

      // Check work_stats row created by trigger
      const [stats1] = await db
        .select()
        .from(workStats)
        .where(sql`${workStats.workId} = ${WORK_PIRANESI}`);

      expect(stats1).toBeDefined();
      expect(Number(stats1!.ratingCount)).toBe(1);
      expect(Number(stats1!.ratingSum)).toBe(5.0);
      expect(Number(stats1!.avgRating)).toBe(5.0);
      expect(Number(stats1!.heartCount)).toBe(1);
      expect(Number(stats1!.readCount)).toBe(1);
      expect(Number(stats1!.weightedRating)).toBe(3.94);

      // 2. Add second user with 4.0 rating
      const [r2] = await db
        .insert(reads)
        .values({
          userId: USER_B,
          workId: WORK_PIRANESI,
          status: 'finished',
          rating: '4.0',
          hearted: false,
        })
        .returning({ id: reads.id });

      const [stats2] = await db
        .select()
        .from(workStats)
        .where(sql`${workStats.workId} = ${WORK_PIRANESI}`);

      expect(Number(stats2!.ratingCount)).toBe(2);
      expect(Number(stats2!.ratingSum)).toBe(9.0);
      expect(Number(stats2!.avgRating)).toBe(4.5);
      expect(Number(stats2!.heartCount)).toBe(1);
      expect(Number(stats2!.readCount)).toBe(2);
      // Polarization (stddev of [5.0, 4.0] = 0.707)
      expect(stats2!.polarisation).toBeCloseTo(0.707, 2);

      // 3. Update rating of user A from 5.0 to 4.5
      await db.update(reads).set({ rating: '4.5' }).where(sql`${reads.id} = ${r1!.id}`);

      const [stats3] = await db
        .select()
        .from(workStats)
        .where(sql`${workStats.workId} = ${WORK_PIRANESI}`);

      expect(Number(stats3!.avgRating)).toBe(4.25);
      expect(Number(stats3!.ratingSum)).toBe(8.5);

      // 4. Delete read r2
      await db.delete(reads).where(sql`${reads.id} = ${r2!.id}`);

      const [stats4] = await db
        .select()
        .from(workStats)
        .where(sql`${workStats.workId} = ${WORK_PIRANESI}`);

      expect(Number(stats4!.ratingCount)).toBe(1);
      expect(Number(stats4!.avgRating)).toBe(4.5);
    });
  });

  // --------------------------------------------------------------------------
  // SL-63: Review Composer & API Endpoints
  // --------------------------------------------------------------------------
  describe('SL-63: Review Composer (PRD §6.27, §10.6)', () => {
    let hobbitReadId: string;
    let reviewId: string;

    beforeAll(async () => {
      // Create read for User A on The Hobbit
      const [rd] = await db
        .insert(reads)
        .values({
          userId: USER_A,
          workId: WORK_HOBBIT,
          status: 'finished',
          rating: '4.5',
          hearted: true,
        })
        .returning({ id: reads.id });
      hobbitReadId = rd!.id;
    });

    it('rejects empty review bodies', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/reads/${hobbitReadId}/review`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { body: '   ' },
      });
      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('empty_body');
    });

    it('creates a review with spoiler tags and visibility', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/reads/${hobbitReadId}/review`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          body: 'An extraordinary subterranean adventure that redefines pastoral fantasy.',
          has_spoilers: true,
          spoiler_after_page: 120,
          visibility: 'public',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.id).toBeDefined();
      reviewId = json.id;
      expect(json.read_id).toBe(hobbitReadId);
      expect(json.has_spoilers).toBe(true);
      expect(json.spoiler_after_page).toBe(120);
      expect(json.rating).toBe(4.5);
      expect(json.hearted).toBe(true);
      expect(json.author.username).toBe('alice');
    });

    it('retrieves review detail via GET /v1/reviews/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reviews/${reviewId}`,
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.id).toBe(reviewId);
      expect(json.body).toContain('subterranean adventure');
    });

    it('updates review via PATCH and marks edited_at', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/reviews/${reviewId}`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          body: 'Updated review: Truly unforgettable fantasy with timeless charm.',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.body).toContain('Updated review');
      expect(json.edited_at).not.toBeNull();
    });

    it('forbids another user from editing someone else review', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/reviews/${reviewId}`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { body: 'Malicious overwrite' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('soft deletes review via DELETE /v1/reviews/:id', async () => {
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/reviews/${reviewId}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(deleteRes.statusCode).toBe(204);

      // Now GET returns 404
      const getRes = await app.inject({
        method: 'GET',
        url: `/v1/reviews/${reviewId}`,
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // SL-64: Friends-First Review Ranking & Book Reviews List
  // --------------------------------------------------------------------------
  describe('SL-64: Friends-First Review Ranking & Likes (PRD §10.7)', () => {
    let readB: string;
    let readC: string;

    beforeAll(async () => {
      // User B (friend of A) writes a review with 0 likes
      const [rb] = await db
        .insert(reads)
        .values({
          userId: USER_B,
          workId: WORK_HOBBIT,
          status: 'finished',
          rating: '4.0',
          hearted: false,
          likeCount: 0,
        })
        .returning({ id: reads.id });
      readB = rb!.id;

      await reviewService.upsertReview(USER_B, readB, {
        body: 'A charming story from Bilbos gentle perspective.',
        visibility: 'public',
      });

      // User C (stranger to A) writes a review with 15 likes
      const [rc] = await db
        .insert(reads)
        .values({
          userId: USER_C,
          workId: WORK_HOBBIT,
          status: 'finished',
          rating: '5.0',
          hearted: true,
          likeCount: 15,
        })
        .returning({ id: reads.id });
      readC = rc!.id;

      await reviewService.upsertReview(USER_C, readC, {
        body: 'A classic masterwork of epic high fantasy and courage.',
        visibility: 'public',
      });
    });

    it('ranks friend review higher than stranger viral review under friends-first sort', async () => {
      // User A (who follows B, but not C) queries with sort=friends
      const res = await app.inject({
        method: 'GET',
        url: `/v1/works/${WORK_HOBBIT}/reviews?sort=friends`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.length).toBeGreaterThanOrEqual(2);

      // In friends-first, friend User B must rank first despite having 0 likes!
      expect(json.data[0].author.username).toBe('bob');
      expect(json.data[1].author.username).toBe('carol');
    });

    it('ranks stranger review higher when sorted by likes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/works/${WORK_HOBBIT}/reviews?sort=likes`,
        headers: { authorization: `Bearer ${tokenA}` },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      // Under 'likes' sort, Carol (15 likes) must rank first
      expect(json.data[0].author.username).toBe('carol');
      expect(json.data[1].author.username).toBe('bob');
    });

    it('likes idempotently and unlikes with DELETE (SO-21 replaced the SL-64 toggle)', async () => {
      const like = () =>
        app.inject({
          method: 'POST',
          url: `/v1/reads/${readB}/like`,
          headers: { authorization: `Bearer ${tokenA}` },
        });

      const likeRes1 = await like();
      expect(likeRes1.statusCode).toBe(200);
      expect(JSON.parse(likeRes1.payload)).toEqual({ liked: true, like_count: 1 });

      // A replayed POST (offline queue) must not undo the like.
      const likeRes2 = await like();
      expect(JSON.parse(likeRes2.payload)).toEqual({ liked: true, like_count: 1 });

      const unlike = await app.inject({
        method: 'DELETE',
        url: `/v1/reads/${readB}/like`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(unlike.statusCode).toBe(200);
      expect(JSON.parse(unlike.payload)).toEqual({ liked: false, like_count: 0 });
    });
  });
});
