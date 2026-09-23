// Integration tests for SO-11: Feed query (cursor-paginated, blocks/mutes excluded).

import { describe, it, expect, beforeEach } from 'vitest';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { ReviewService } from '../reviews/index.js';
import { ShelvesService } from '../shelves/index.js';
import { SocialService } from '../social/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { works } from '../db/schema.js';

describe('SO-11: Feed Query (Cursor-Paginated, Blocks/Mutes Excluded)', () => {
  let db: any;
  let app: any;
  let identity: IdentityService;
  let reading: ReadingService;
  let reviewsSvc: ReviewService;
  let shelvesSvc: ShelvesService;
  let social: SocialService;

  let userA: { id: string; token: string; username: string };
  let userB: { id: string; token: string; username: string };
  let userC: { id: string; token: string; username: string };

  let work1: { id: string; title: string };
  let work2: { id: string; title: string };

  beforeEach(async () => {
    const res = await freshDrizzle();
    db = res.db;
    const limiter = new PgRateLimiter(db);

    identity = new IdentityService(db, limiter);
    reading = new ReadingService(db);
    reviewsSvc = new ReviewService(db);
    shelvesSvc = new ShelvesService(db);
    social = new SocialService(db);

    app = await buildApp({ db, identity });

    // User A (Viewer)
    const resA = await identity.register(
      'usera@example.com',
      'user_a',
      'a_very_secure_password_123',
      '1995-05-15',
    );
    userA = { id: resA.user.id, token: resA.accessToken, username: resA.user.username };

    // User B (Followed by User A)
    const resB = await identity.register(
      'userb@example.com',
      'user_b',
      'a_very_secure_password_123',
      '1995-05-15',
    );
    userB = { id: resB.user.id, token: resB.accessToken, username: resB.user.username };

    // User C (Not followed by User A)
    const resC = await identity.register(
      'userc@example.com',
      'user_c',
      'a_very_secure_password_123',
      '1995-05-15',
    );
    userC = { id: resC.user.id, token: resC.accessToken, username: resC.user.username };

    // Seed works
    const [w1] = await db.insert(works).values({ title: 'Dune Messiah' }).returning();
    const [w2] = await db.insert(works).values({ title: 'Neuromancer' }).returning();
    work1 = { id: w1.id, title: w1.title };
    work2 = { id: w2.id, title: w2.title };

    // User A follows User B
    await social.followUser(userA.id, userB.id);
  });

  it('returns feed activities for followed users in reverse-chronological order', async () => {
    // User B generates activities
    await reading.upsert(userB.id, work1.id, 'reading');
    const read2 = await reading.upsert(userB.id, work2.id, 'finished', 5.0);

    // User C generates activity (not followed)
    await reading.upsert(userC.id, work1.id, 'finished', 4.0);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tab).toBe('friends');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);

    // Verify actor is User B and User C is excluded
    const actorIds = body.items.map((i: any) => i.actor_id);
    expect(actorIds).toContain(userB.id);
    expect(actorIds).not.toContain(userC.id);

    // Verify actor details
    expect(body.items[0].actor.username).toBe('user_b');
  });

  it('supports cursor pagination across activity feed pages', async () => {
    // User B creates 5 activities
    for (let i = 1; i <= 5; i++) {
      const [w] = await db.insert(works).values({ title: `Book ${i}` }).returning();
      await reading.upsert(userB.id, w.id, 'finished', 5);
      // small delay to guarantee distinct created_at timestamps if needed
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Page 1: limit 2
    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends&limit=2',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.items.length).toBe(2);
    expect(body1.has_more).toBe(true);
    expect(body1.next_cursor).toBeTruthy();

    // Page 2: use cursor from page 1
    const res2 = await app.inject({
      method: 'GET',
      url: `/v1/feed?tab=friends&limit=2&cursor=${encodeURIComponent(body1.next_cursor)}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res2.statusCode).toBe(200);
    const body2 = res2.json();
    expect(body2.items.length).toBe(2);
    expect(body2.has_more).toBe(true);

    // Page 3: final page
    const res3 = await app.inject({
      method: 'GET',
      url: `/v1/feed?tab=friends&limit=2&cursor=${encodeURIComponent(body2.next_cursor)}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res3.statusCode).toBe(200);
    const body3 = res3.json();
    expect(body3.items.length).toBe(1);
    expect(body3.has_more).toBe(false);
    expect(body3.next_cursor).toBeNull();
  });

  it('strictly excludes activities from blocked users in either direction', async () => {
    await reading.upsert(userB.id, work1.id, 'reading');

    // Confirm item is present before block
    const resBefore = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(resBefore.json().items.length).toBe(1);

    // User A blocks User B
    await social.blockUser(userA.id, userB.id);

    // Feed query after block
    const resAfter = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(resAfter.statusCode).toBe(200);
    expect(resAfter.json().items.length).toBe(0);
  });

  it('strictly excludes activities from muted users', async () => {
    await reading.upsert(userB.id, work1.id, 'reading');

    // Mute User B
    await social.muteUser(userA.id, userB.id);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.length).toBe(0);
  });

  it('strictly excludes activities from muted books', async () => {
    await reading.upsert(userB.id, work1.id, 'reading');
    await reading.upsert(userB.id, work2.id, 'reading');

    // Mute Work 1
    await social.muteWork(userA.id, work1.id);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().items;
    expect(items.length).toBe(1);
    expect(items[0].work_id).toBe(work2.id);
  });

  it('supports GET /v1/feed?tab=popular returning public activity platform-wide', async () => {
    await reading.upsert(userC.id, work1.id, 'finished', 4.5);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=popular',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tab).toBe('popular');
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.some((i: any) => i.actor_id === userC.id)).toBe(true);
  });

  it('requires authentication for friends feed (returns 401 for guests)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=friends',
    });

    expect(response.statusCode).toBe(401);
  });
});
