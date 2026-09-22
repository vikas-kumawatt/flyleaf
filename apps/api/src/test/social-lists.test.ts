// Integration tests for Followers and Following Lists (SO-05, PRD §11.1, §25.3, §26.1).
//
// Rules verified:
// 1. GET /v1/users/:id/followers and GET /v1/users/:id/following list accepted relationships.
// 2. Private profile protection: non-followers and guests receive 404 Not Found (never 403 Forbidden).
// 3. Blocked relationships return 404 Not Found when attempting to view blocked user's lists.
// 4. Blocked third-party users are excluded from returned lists.
// 5. Follow relationship indicators (followedByViewer, followsViewer) reflect exact state.

import { describe, it, expect, beforeEach } from 'vitest';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { SocialService } from '../social/index.js';
import { PgRateLimiter } from '../platform/index.js';
import { profiles } from '../db/schema.js';
import { eq } from 'drizzle-orm';

describe('SO-05: Followers and Following Lists', () => {
  let db: any;
  let app: any;
  let identity: IdentityService;
  let social: SocialService;

  let userA: { id: string; token: string; username: string };
  let userB: { id: string; token: string; username: string };
  let userC: { id: string; token: string; username: string };
  let userPrivate: { id: string; token: string; username: string };

  beforeEach(async () => {
    const res = await freshDrizzle();
    db = res.db;
    const limiter = new PgRateLimiter(db);
    identity = new IdentityService(db, limiter);
    social = new SocialService(db);
    app = await buildApp({ db, identity });

    // Register User A
    const resA = await identity.register(
      'usera@example.com',
      'user_a',
      'a_very_secure_unique_password_123',
      '1995-05-15',
    );
    userA = { id: resA.user.id, token: resA.accessToken, username: resA.user.username };

    // Register User B
    const resB = await identity.register(
      'userb@example.com',
      'user_b',
      'a_very_secure_unique_password_123',
      '1996-06-16',
    );
    userB = { id: resB.user.id, token: resB.accessToken, username: resB.user.username };

    // Register User C
    const resC = await identity.register(
      'userc@example.com',
      'user_c',
      'a_very_secure_unique_password_123',
      '1997-07-17',
    );
    userC = { id: resC.user.id, token: resC.accessToken, username: resC.user.username };

    // Register Private User
    const resP = await identity.register(
      'userp@example.com',
      'user_p',
      'a_very_secure_unique_password_123',
      '1998-08-18',
    );
    userPrivate = { id: resP.user.id, token: resP.accessToken, username: resP.user.username };

    // Set userPrivate to private
    await db.update(profiles).set({ isPrivate: true }).where(eq(profiles.userId, userPrivate.id));
  });

  it('1. returns followers and following lists for a public profile', async () => {
    // User A and User B follow User C
    await social.followUser(userA.id, userC.id);
    await social.followUser(userB.id, userC.id);

    // Get followers of User C
    const followersRes = await app.inject({
      method: 'GET',
      url: `/v1/users/${userC.id}/followers`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(followersRes.statusCode).toBe(200);
    const followersData = JSON.parse(followersRes.payload);
    expect(followersData.total).toBe(2);
    expect(followersData.users).toHaveLength(2);
    const followerIds = followersData.users.map((u: any) => u.id);
    expect(followerIds).toContain(userA.id);
    expect(followerIds).toContain(userB.id);

    // Get following list of User A
    const followingRes = await app.inject({
      method: 'GET',
      url: `/v1/users/${userA.id}/following`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(followingRes.statusCode).toBe(200);
    const followingData = JSON.parse(followingRes.payload);
    expect(followingData.total).toBe(1);
    expect(followingData.users[0].id).toBe(userC.id);
    expect(followingData.users[0].followedByViewer).toBe(true);
  });

  it('2. returns 404 Not Found (never 403) for non-followers and guests viewing a private account list', async () => {
    // Non-follower A attempts to view Private user's followers
    const resA = await app.inject({
      method: 'GET',
      url: `/v1/users/${userPrivate.id}/followers`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(resA.statusCode).toBe(404);
    expect(JSON.parse(resA.payload).error.code).toBe('not_found');

    // Guest attempts to view Private user's following list
    const resGuest = await app.inject({
      method: 'GET',
      url: `/v1/users/${userPrivate.id}/following`,
    });
    expect(resGuest.statusCode).toBe(404);
    expect(JSON.parse(resGuest.payload).error.code).toBe('not_found');

    // Owner CAN view their own follower list even if private
    const resOwner = await app.inject({
      method: 'GET',
      url: `/v1/users/${userPrivate.id}/followers`,
      headers: { authorization: `Bearer ${userPrivate.token}` },
    });
    expect(resOwner.statusCode).toBe(200);

    // Approved follower CAN view private account's list
    await social.followUser(userA.id, userPrivate.id); // creates pending
    await social.acceptFollowRequest(userPrivate.id, userA.id); // accepts

    const resAcceptedFollower = await app.inject({
      method: 'GET',
      url: `/v1/users/${userPrivate.id}/followers`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(resAcceptedFollower.statusCode).toBe(200);
    expect(JSON.parse(resAcceptedFollower.payload).total).toBe(1);
  });

  it('3. returns 404 Not Found when requesting lists of a blocked user', async () => {
    await social.followUser(userA.id, userB.id);

    // User B blocks User A
    await social.blockUser(userB.id, userA.id);

    // User A attempts to view User B's followers
    const resFollowers = await app.inject({
      method: 'GET',
      url: `/v1/users/${userB.id}/followers`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(resFollowers.statusCode).toBe(404);

    // User A attempts to view User B's following
    const resFollowing = await app.inject({
      method: 'GET',
      url: `/v1/users/${userB.id}/following`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(resFollowing.statusCode).toBe(404);
  });

  it('4. excludes third-party blocked users from returned followers/following lists', async () => {
    // User A and User B follow User C
    await social.followUser(userA.id, userC.id);
    await social.followUser(userB.id, userC.id);

    // User A blocks User B
    await social.blockUser(userA.id, userB.id);

    // Guest views User C's followers -> sees both User A and User B
    const resGuest = await app.inject({
      method: 'GET',
      url: `/v1/users/${userC.id}/followers`,
    });
    expect(resGuest.statusCode).toBe(200);
    expect(JSON.parse(resGuest.payload).total).toBe(2);

    // User A views User C's followers -> User B is excluded because A blocked B
    const resA = await app.inject({
      method: 'GET',
      url: `/v1/users/${userC.id}/followers`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(resA.statusCode).toBe(200);
    const dataA = JSON.parse(resA.payload);
    expect(dataA.total).toBe(1);
    expect(dataA.users[0].id).toBe(userA.id);
  });

  it('5. accurately resolves mutual follow status indicators in the list items', async () => {
    // User A follows User B, User B follows User A (mutual follow)
    await social.followUser(userA.id, userB.id);
    await social.followUser(userB.id, userA.id);

    // User A inspects User B's followers list (contains User A)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/users/${userB.id}/followers`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload);
    expect(data.users).toHaveLength(1);
    const item = data.users[0];
    expect(item.id).toBe(userA.id);
    expect(item.followedByViewer).toBe(false); // viewer is userA, item is userA
    expect(item.followsViewer).toBe(false);

    // User C inspects User B's followers list (contains User A)
    const resC = await app.inject({
      method: 'GET',
      url: `/v1/users/${userB.id}/followers`,
      headers: { authorization: `Bearer ${userC.token}` },
    });
    expect(resC.statusCode).toBe(200);
    const dataC = JSON.parse(resC.payload);
    const itemForC = dataC.users[0];
    expect(itemForC.id).toBe(userA.id);
    expect(itemForC.followedByViewer).toBe(false);
    expect(itemForC.followsViewer).toBe(false);
  });
});
