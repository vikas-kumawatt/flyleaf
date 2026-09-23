import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { profiles, follows, works } from '../db/schema.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { PgRateLimiter } from '../platform/index.js';
import type { FastifyInstance } from 'fastify';

describe('SO-14: Feed Cold Start & Blending (Never Empty)', () => {
  let db: any;
  let app: FastifyInstance;
  let identity: IdentityService;
  let reading: ReadingService;

  beforeEach(async () => {
    const res = await freshDrizzle();
    db = res.db;
    const limiter = new PgRateLimiter(db);
    identity = new IdentityService(db, limiter);
    reading = new ReadingService(db);
    app = await buildApp({ db, identity });
  });

  async function createTestUser(username: string, isPrivate = false) {
    const email = `${username}@example.com`;
    const password = 'Password123!';
    const reg = await identity.register(email, username, password, '2000-01-01');
    if (isPrivate) {
      await db.update(profiles).set({ isPrivate: true }).where(eq(profiles.userId, reg.user.id));
    }
    return { ...reg.user, token: reg.accessToken };
  }

  it('Scenario 1 (0 follows): auto-switches to Popular feed with cold start metadata', async () => {
    const userA = await createTestUser(`usera_${Date.now()}`);
    const userB = await createTestUser(`userb_${Date.now()}`);

    // User B creates a public review so popular feed has content
    const [w] = await db.insert(works).values({ title: 'Popular Novel' }).returning();
    await reading.upsert(userB.id, w.id, 'finished', 5);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tab).toBe('popular');
    expect(body.is_cold_start).toBe(true);
    expect(body.following_count).toBe(0);
    expect(body.cold_start_reason).toBe('no_follows');
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('Scenario 2 (1-3 follows): returns Friends tab blended with Popular content', async () => {
    const userA = await createTestUser(`usera_${Date.now()}`);
    const userB = await createTestUser(`userb_${Date.now()}`);
    const userC = await createTestUser(`userc_${Date.now()}`);

    // User A follows User B (1 follow)
    await db.insert(follows).values({
      followerId: userA.id,
      followeeId: userB.id,
      state: 'accepted',
    });

    // User B posts 1 activity
    const [w1] = await db.insert(works).values({ title: 'Friend Book' }).returning();
    await reading.upsert(userB.id, w1.id, 'finished', 5);

    // User C (unfollowed) posts popular activity
    const [w2] = await db.insert(works).values({ title: 'Popular Trend' }).returning();
    await reading.upsert(userC.id, w2.id, 'finished', 4.5);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tab).toBe('friends');
    expect(body.is_cold_start).toBe(true);
    expect(body.following_count).toBe(1);
    expect(body.cold_start_reason).toBe('sparse_follows');

    // Verify blended popular content is present and tagged
    const blendedItem = body.items.find((i: any) => i.metadata?.is_blended_popular === true);
    expect(blendedItem).toBeTruthy();
    expect(blendedItem.metadata.label).toBe('Popular on Flyleaf');
  });

  it('Scenario 3 (>3 follows, no recent activity): backfills with Popular content so feed is NEVER empty', async () => {
    const userA = await createTestUser(`usera_${Date.now()}`);
    const popularAuthor = await createTestUser(`popular_${Date.now()}`);

    // User A follows 4 users (who have zero recent activity)
    for (let i = 1; i <= 4; i++) {
      const friend = await createTestUser(`friend${i}_${Date.now()}`);
      await db.insert(follows).values({
        followerId: userA.id,
        followeeId: friend.id,
        state: 'accepted',
      });
    }

    // Popular user creates public content
    const [w] = await db.insert(works).values({ title: 'Trending Book' }).returning();
    await reading.upsert(popularAuthor.id, w.id, 'finished', 5);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tab).toBe('friends');
    expect(body.is_cold_start).toBe(true);
    expect(body.following_count).toBe(4);
    expect(body.cold_start_reason).toBe('no_activity');
    expect(body.items.length).toBeGreaterThan(0);

    const backfillItem = body.items.find((i: any) => i.metadata?.is_blended_popular === true);
    expect(backfillItem).toBeTruthy();
    expect(backfillItem.metadata.label).toBe('While you wait');
  });

  it('Guarantee (Never Empty Feed): returns editorial welcome card on fresh database', async () => {
    const userA = await createTestUser(`userfresh_${Date.now()}`);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].metadata?.is_editorial).toBe(true);
  });
});
