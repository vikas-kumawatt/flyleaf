// Integration tests for Follow/Unfollow, Private Accounts, and Pending Requests (SO-02).

import { describe, it, expect, beforeEach } from 'vitest';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { SocialService } from '../social/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { blocks } from '../db/schema.js';

describe('SO-02: Follow / Unfollow & Private Accounts', () => {
  let db: any;
  let app: any;
  let identity: IdentityService;
  let social: SocialService;

  let userA: { id: string; token: string; username: string };
  let userB: { id: string; token: string; username: string };
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

    // Register User B (public account)
    const resB = await identity.register(
      'userb@example.com',
      'user_b',
      'a_very_secure_unique_password_123',
      '1996-06-16',
    );
    userB = { id: resB.user.id, token: resB.accessToken, username: resB.user.username };

    // Register User Private (private account)
    const resP = await identity.register(
      'private@example.com',
      'user_private',
      'a_very_secure_unique_password_123',
      '1997-07-17',
    );
    userPrivate = { id: resP.user.id, token: resP.accessToken, username: resP.user.username };

    // Set userPrivate profile to private
    await identity.updateProfile(userPrivate.id, { isPrivate: true });
  });

  it('allows following a public account directly (status: accepted)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${userB.id}/follow`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('accepted');
    expect(body.follower_id).toBe(userA.id);
    expect(body.followee_id).toBe(userB.id);

    // Verify follower counts updated via DB trigger
    const profileB = await identity.getProfile(userA.id, userB.id);
    expect(profileB).not.toBeNull();
    expect(profileB?.followerCount).toBe(1);
    expect(profileB?.followStatus).toBe('accepted');
    expect(profileB?.isRestricted).toBe(false);
  });

  it('unfollowing a public account removes follow and decrements count', async () => {
    await social.followUser(userA.id, userB.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${userB.id}/follow`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('none');

    const profileB = await identity.getProfile(userA.id, userB.id);
    expect(profileB?.followerCount).toBe(0);
    expect(profileB?.followStatus).toBe('none');
  });

  it('following a private account creates pending state and restricts non-follower profile view', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${userPrivate.id}/follow`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('pending');

    // Private profile returns null (404 Not Found) to non-followers per FN-72 & SH-09
    const profilePrivate = await identity.getProfile(userA.id, userPrivate.id);
    expect(profilePrivate).toBeNull();

    // Guest views profile -> returns null (404 Not Found)
    const guestView = await identity.getProfile(null, userPrivate.id);
    expect(guestView).toBeNull();
  });

  it('private account owner can list pending requests and accept them', async () => {
    // User A requests to follow User Private
    await social.followUser(userA.id, userPrivate.id);

    // User Private lists requests
    const resList = await app.inject({
      method: 'GET',
      url: '/v1/me/follow-requests',
      headers: { authorization: `Bearer ${userPrivate.token}` },
    });

    expect(resList.statusCode).toBe(200);
    const listBody = resList.json();
    expect(listBody.requests).toHaveLength(1);
    expect(listBody.requests[0].id).toBe(userA.id);
    expect(listBody.requests[0].username).toBe(userA.username);

    // User Private accepts request
    const resAccept = await app.inject({
      method: 'POST',
      url: `/v1/me/follow-requests/${userA.id}/accept`,
      headers: { authorization: `Bearer ${userPrivate.token}` },
    });

    expect(resAccept.statusCode).toBe(200);
    expect(resAccept.json().status).toBe('accepted');

    // Counts updated and profile view now unrestricted for User A
    const profileAfter = await identity.getProfile(userA.id, userPrivate.id);
    expect(profileAfter?.followerCount).toBe(1);
    expect(profileAfter?.followStatus).toBe('accepted');
    expect(profileAfter?.isRestricted).toBe(false);
  });

  it('private account owner can reject pending requests', async () => {
    await social.followUser(userA.id, userPrivate.id);

    const resReject = await app.inject({
      method: 'POST',
      url: `/v1/me/follow-requests/${userA.id}/reject`,
      headers: { authorization: `Bearer ${userPrivate.token}` },
    });

    expect(resReject.statusCode).toBe(200);
    expect(resReject.json().status).toBe('none');

    // List is now empty
    const requests = await social.getPendingRequests(userPrivate.id);
    expect(requests).toHaveLength(0);
  });

  it('prevents self-follow with 400 Bad Request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${userA.id}/follow`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_follow_self');
  });

  it('blocks prevent follow operations and mask account as 404 Not Found', async () => {
    // Insert block (User B blocks User A)
    await db.insert(blocks).values({
      blockerId: userB.id,
      blockedId: userA.id,
    });

    // User A attempts to follow User B
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${userB.id}/follow`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('toggling profile from private to public auto-accepts pending requests', async () => {
    // User A requests to follow User Private
    await social.followUser(userA.id, userPrivate.id);

    // Verify state is pending
    const statusBefore = await social.getFollowStatus(userA.id, userPrivate.id);
    expect(statusBefore.followStatus).toBe('pending');

    // User Private switches profile to public
    await identity.updateProfile(userPrivate.id, { isPrivate: false });

    // Pending request should be automatically accepted
    const statusAfter = await social.getFollowStatus(userA.id, userPrivate.id);
    expect(statusAfter.followStatus).toBe('accepted');

    const profilePublic = await identity.getProfile(userA.id, userPrivate.id);
    expect(profilePublic?.followerCount).toBe(1);
    expect(profilePublic?.isRestricted).toBe(false);
  });
});
