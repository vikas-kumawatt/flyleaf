// Comprehensive Integration Test Suite for Block Invisibility Equivalence (SO-06, PRD §26.3, §11.4).
//
// Verifies that a blocked user viewing ANY surface, endpoint, or resource of a blocker
// receives IDENTICALLY INDISTINGUISHABLE responses (404 Not Found, identical error payloads)
// from those returned when requesting a non-existent UUID or non-existent resource.

import { describe, it, expect, beforeEach } from 'vitest';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { SocialService } from '../social/index.js';
import { ReadingService } from '../reading/index.js';
import { ShelvesService } from '../shelves/index.js';
import { ReviewService } from '../reviews/index.js';
import { PgRateLimiter } from '../platform/index.js';
import { works, reads } from '../db/schema.js';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('SO-06: Block Invisibility Equivalence (Blocked View ≡ Non-Existent Account)', () => {
  let db: any;
  let app: any;
  let identity: IdentityService;
  let social: SocialService;
  let reading: ReadingService;
  let shelvesService: ShelvesService;
  let reviewsService: ReviewService;

  let blocker: { id: string; token: string; username: string };
  let blocked: { id: string; token: string; username: string };
  let sampleWork: { id: string; title: string };
  let blockerRead: { id: string };
  let blockerShelf: { id: string; slug: string };

  beforeEach(async () => {
    const res = await freshDrizzle();
    db = res.db;
    const limiter = new PgRateLimiter(db);
    identity = new IdentityService(db, limiter);
    social = new SocialService(db);
    reading = new ReadingService(db);
    shelvesService = new ShelvesService(db);
    reviewsService = new ReviewService(db);

    app = await buildApp({ db, identity });

    // Register Blocker (User A)
    const resA = await identity.register(
      'blocker@example.com',
      'blocker_user',
      'a_very_secure_unique_password_123',
      '1995-05-15',
    );
    blocker = { id: resA.user.id, token: resA.accessToken, username: resA.user.username };

    // Register Blocked (User B)
    const resB = await identity.register(
      'blocked@example.com',
      'blocked_user',
      'a_very_secure_unique_password_123',
      '1996-06-16',
    );
    blocked = { id: resB.user.id, token: resB.accessToken, username: resB.user.username };

    // Create a sample work
    const [w] = await db
      .insert(works)
      .values({
        title: 'Equivalence Test Work',
        olWorkKey: 'OL_TEST_EQUIV_1',
      })
      .returning();
    sampleWork = { id: w.id, title: w.title };

    // Blocker logs a public read and review
    blockerRead = await reading.upsert(blocker.id, sampleWork.id, 'finished', 4.5, true, 'public');
    await reviewsService.upsertReview(blocker.id, blockerRead.id, {
      body: 'Amazing book!',
      rating: 4.5,
      visibility: 'public',
    });

    // Blocker creates a public shelf
    blockerShelf = await shelvesService.create(blocker.id, {
      name: 'Blocker Favourites',
      privacy: 'public',
    });

    // Blocker blocks Blocked user (SO-03)
    await social.blockUser(blocker.id, blocked.id);
  });

  it('1. GET /v1/users/:id — blocked profile lookup is identical to non-existent account', async () => {
    // 1a. Blocked user requests Blocker's profile
    const resBlockedView = await app.inject({
      method: 'GET',
      url: `/v1/users/${blocker.id}`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    // 1b. Request non-existent UUID
    const resNonExistentView = await app.inject({
      method: 'GET',
      url: `/v1/users/${NON_EXISTENT_UUID}`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    expect(resBlockedView.statusCode).toBe(404);
    expect(resNonExistentView.statusCode).toBe(404);

    const payloadBlocked = JSON.parse(resBlockedView.payload);
    const payloadNonExistent = JSON.parse(resNonExistentView.payload);

    expect(payloadBlocked).toEqual(payloadNonExistent);
    expect(payloadBlocked.error.code).toBe('not_found');
  });

  it('2. GET /v1/users/:id — bidirectional: blocker requesting blocked user profile receives 404', async () => {
    const resBlockerView = await app.inject({
      method: 'GET',
      url: `/v1/users/${blocked.id}`,
      headers: { authorization: `Bearer ${blocker.token}` },
    });

    expect(resBlockerView.statusCode).toBe(404);
    expect(JSON.parse(resBlockerView.payload).error.code).toBe('not_found');
  });

  it('3. POST /v1/users/:id/follow — follow attempt to blocked user is identical to non-existent user', async () => {
    // 3a. Blocked user attempts to follow Blocker
    const resFollowBlocked = await app.inject({
      method: 'POST',
      url: `/v1/users/${blocker.id}/follow`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    // 3b. Attempt to follow non-existent UUID
    const resFollowNonExistent = await app.inject({
      method: 'POST',
      url: `/v1/users/${NON_EXISTENT_UUID}/follow`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    expect(resFollowBlocked.statusCode).toBe(404);
    expect(resFollowNonExistent.statusCode).toBe(404);

    const payloadBlocked = JSON.parse(resFollowBlocked.payload);
    const payloadNonExistent = JSON.parse(resFollowNonExistent.payload);

    expect(payloadBlocked).toEqual(payloadNonExistent);
    expect(payloadBlocked.error.code).toBe('not_found');
  });

  it('4. GET /v1/reads/:id — blocked user requesting blocker read is identical to non-existent read', async () => {
    // Blocked user requests Blocker's public read
    const resReadBlocked = await app.inject({
      method: 'GET',
      url: `/v1/reads/${blockerRead.id}`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    // Request non-existent read UUID
    const resReadNonExistent = await app.inject({
      method: 'GET',
      url: `/v1/reads/${NON_EXISTENT_UUID}`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    expect(resReadBlocked.statusCode).toBe(404);
    expect(resReadNonExistent.statusCode).toBe(404);

    const payloadBlocked = JSON.parse(resReadBlocked.payload);
    const payloadNonExistent = JSON.parse(resReadNonExistent.payload);

    expect(payloadBlocked).toEqual(payloadNonExistent);
    expect(payloadBlocked.error.code).toBe('not_found');
  });

  it('5. GET /v1/users/:id/stats — blocked user requesting blocker stats is identical to non-existent user stats', async () => {
    const resStatsBlocked = await app.inject({
      method: 'GET',
      url: `/v1/users/${blocker.id}/stats`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    const resStatsNonExistent = await app.inject({
      method: 'GET',
      url: `/v1/users/${NON_EXISTENT_UUID}/stats`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    expect(resStatsBlocked.statusCode).toBe(404);
    expect(resStatsNonExistent.statusCode).toBe(404);

    const payloadBlocked = JSON.parse(resStatsBlocked.payload);
    const payloadNonExistent = JSON.parse(resStatsNonExistent.payload);

    expect(payloadBlocked).toEqual(payloadNonExistent);
    expect(payloadBlocked.error.code).toBe('not_found');
  });

  it('6. GET /v1/shelves/:id — blocked user requesting blocker shelf is identical to non-existent shelf', async () => {
    const resShelfBlocked = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${blockerShelf.id}`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    const resShelfNonExistent = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${NON_EXISTENT_UUID}`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    expect(resShelfBlocked.statusCode).toBe(404);
    expect(resShelfNonExistent.statusCode).toBe(404);

    const payloadBlocked = JSON.parse(resShelfBlocked.payload);
    const payloadNonExistent = JSON.parse(resShelfNonExistent.payload);

    expect(payloadBlocked).toEqual(payloadNonExistent);
    expect(payloadBlocked.error.code).toBe('not_found');
  });

  it('7. GET /v1/users/:id/followers — blocked user requesting blocker followers list receives 404', async () => {
    const resFollowersBlocked = await app.inject({
      method: 'GET',
      url: `/v1/users/${blocker.id}/followers`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    const resFollowersNonExistent = await app.inject({
      method: 'GET',
      url: `/v1/users/${NON_EXISTENT_UUID}/followers`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });

    expect(resFollowersBlocked.statusCode).toBe(404);
    expect(resFollowersNonExistent.statusCode).toBe(404);

    const payloadBlocked = JSON.parse(resFollowersBlocked.payload);
    const payloadNonExistent = JSON.parse(resFollowersNonExistent.payload);

    expect(payloadBlocked).toEqual(payloadNonExistent);
    expect(payloadBlocked.error.code).toBe('not_found');
  });

  it('8. GET /v1/works/:id/reviews — reviews written by blocker are hidden when viewed by blocked user', async () => {
    // Unauthenticated guest sees Blocker's review
    const resGuest = await app.inject({
      method: 'GET',
      url: `/v1/works/${sampleWork.id}/reviews`,
    });
    expect(resGuest.statusCode).toBe(200);
    const dataGuest = JSON.parse(resGuest.payload);
    expect(dataGuest.data).toHaveLength(1);
    expect(dataGuest.data[0].user_id).toBe(blocker.id);

    // Blocked user requests reviews for the work — Blocker's review is omitted
    const resBlocked = await app.inject({
      method: 'GET',
      url: `/v1/works/${sampleWork.id}/reviews`,
      headers: { authorization: `Bearer ${blocked.token}` },
    });
    expect(resBlocked.statusCode).toBe(200);
    const dataBlocked = JSON.parse(resBlocked.payload);
    expect(dataBlocked.data).toHaveLength(0);
  });
});
