// Integration tests for Blocking (SO-03).
//
// Rules verified:
// 1. Block is bidirectional, complete, silent, and severs follows in both directions.
// 2. Profile and follow requests targeting blocked accounts return 404 Not Found (never 403).
// 3. Counter triggers decrement follower/following counts on severed follows.
// 4. Cannot block self (400 Bad Request).
// 5. Unblocking restores visibility but does not restore severed follows.
// 6. List blocked users endpoint GET /v1/me/blocks returns blocked accounts.

import { describe, it, expect, beforeEach } from 'vitest';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { SocialService } from '../social/index.js';
import { PgRateLimiter } from '../platform/index.js';
import { verifyAllUsers } from './interaction-fixtures.js';

describe('SO-03: Blocking Semantics (Bidirectional, Complete, Silent, Severs Follows)', () => {
  let db: any;
  let app: any;
  let identity: IdentityService;
  let social: SocialService;

  let userA: { id: string; token: string; username: string };
  let userB: { id: string; token: string; username: string };

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
    // Reviews, comments and follows need a verified email (D-04-1); the gate has its own tests.
    await verifyAllUsers(db);
  });

  it('rejects self-blocking with HTTP 400 Bad Request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${userA.id}/block`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_block_self');
  });

  it('blocks target user, severs follows in BOTH directions, and updates counters', async () => {
    // Establish mutual follow relationship
    await social.followUser(userA.id, userB.id); // A follows B
    await social.followUser(userB.id, userA.id); // B follows A

    // Verify initial follow counts
    let profileA = await identity.getProfile(userA.id, userA.id);
    let profileB = await identity.getProfile(userB.id, userB.id);
    expect(profileA?.followerCount).toBe(1);
    expect(profileA?.followingCount).toBe(1);
    expect(profileB?.followerCount).toBe(1);
    expect(profileB?.followingCount).toBe(1);

    // User A blocks User B
    const blockRes = await app.inject({
      method: 'POST',
      url: `/v1/users/${userB.id}/block`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(blockRes.statusCode).toBe(200);
    const body = blockRes.json();
    expect(body.status).toBe('blocked');
    expect(body.blocker_id).toBe(userA.id);
    expect(body.blocked_id).toBe(userB.id);

    // Verify follows in BOTH directions were severed and counters decremented to 0
    profileA = await identity.getProfile(userA.id, userA.id);
    profileB = await identity.getProfile(userB.id, userB.id);
    expect(profileA?.followerCount).toBe(0);
    expect(profileA?.followingCount).toBe(0);
    expect(profileB?.followerCount).toBe(0);
    expect(profileB?.followingCount).toBe(0);
  });

  it('enforces complete bidirectional invisibility: profile lookup returns 404 for both parties', async () => {
    // User A blocks User B
    await social.blockUser(userA.id, userB.id);

    // User A viewing User B profile -> 404 Not Found (never 403)
    const viewBRes = await app.inject({
      method: 'GET',
      url: `/v1/users/${userB.id}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(viewBRes.statusCode).toBe(404);

    // User B viewing User A profile -> 404 Not Found (indistinguishable from non-existent account)
    const viewARes = await app.inject({
      method: 'GET',
      url: `/v1/users/${userA.id}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    expect(viewARes.statusCode).toBe(404);
  });

  it('prevents follow attempts targeting a blocked user, returning 404 Not Found', async () => {
    await social.blockUser(userA.id, userB.id);

    // User B attempts to follow User A -> 404 Not Found
    const followRes = await app.inject({
      method: 'POST',
      url: `/v1/users/${userA.id}/follow`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    expect(followRes.statusCode).toBe(404);

    // User A attempts to follow User B -> 404 Not Found
    const followARes = await app.inject({
      method: 'POST',
      url: `/v1/users/${userB.id}/follow`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    expect(followARes.statusCode).toBe(404);
  });

  it('lists blocked users on GET /v1/me/blocks', async () => {
    await social.blockUser(userA.id, userB.id);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/blocks',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0].id).toBe(userB.id);
    expect(body.blocks[0].username).toBe(userB.username);
  });

  it('unblocking restores profile visibility but does not restore severed follows', async () => {
    await social.followUser(userA.id, userB.id);
    await social.blockUser(userA.id, userB.id);

    // Unblock User B
    const unblockRes = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${userB.id}/block`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(unblockRes.statusCode).toBe(200);
    expect(unblockRes.json().status).toBe('unblocked');

    // Profile lookup works again
    const profileB = await identity.getProfile(userA.id, userB.id);
    expect(profileB).not.toBeNull();
    expect(profileB?.username).toBe(userB.username);

    // Follow remains severed ('none')
    expect(profileB?.followStatus).toBe('none');
    expect(profileB?.followerCount).toBe(0);
  });
});
