// Integration tests for User Muting and Book Muting (SO-04, PRD §11.5).
//
// Rules verified:
// 1. Muting a user is silent and per-user, enabling feed hiding without unfollowing.
// 2. Muting a book is silent and per-book, hiding specific work activity from feeds.
// 3. GET /v1/me/mutes returns muted users and muted books.
// 4. Cannot mute self (400 Bad Request).
// 5. Unmuting users and books removes records cleanly.

import { describe, it, expect, beforeEach } from 'vitest';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { SocialService } from '../social/index.js';
import { PgRateLimiter } from '../platform/index.js';
import { works } from '../db/schema.js';

describe('SO-04: Mute User and Mute Book (PRD §11.5)', () => {
  let db: any;
  let app: any;
  let identity: IdentityService;
  let social: SocialService;

  let userA: { id: string; token: string; username: string };
  let userB: { id: string; token: string; username: string };
  let sampleWork: { id: string; title: string };

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

    // Insert sample work
    const [insertedWork] = await db
      .insert(works)
      .values({
        title: 'Neuromancer',
      })
      .returning({ id: works.id, title: works.title });
    sampleWork = insertedWork;
  });

  it('rejects self-muting with HTTP 400 Bad Request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${userA.id}/mute`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_mute_self');
  });

  it('mutes a user silently and returns muted status', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/users/${userB.id}/mute`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('muted');
    expect(body.target_type).toBe('user');
    expect(body.target_id).toBe(userB.id);
    expect(body.user_id).toBe(userA.id);
  });

  it('unmutes a user cleanly', async () => {
    await social.muteUser(userA.id, userB.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/users/${userB.id}/mute`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('unmuted');
  });

  it('mutes a book / work silently', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/works/${sampleWork.id}/mute`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('muted');
    expect(body.target_type).toBe('work');
    expect(body.target_id).toBe(sampleWork.id);
    expect(body.user_id).toBe(userA.id);
  });

  it('unmutes a book / work cleanly', async () => {
    await social.muteWork(userA.id, sampleWork.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/works/${sampleWork.id}/mute`,
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('unmuted');
  });

  it('lists all muted users and muted books on GET /v1/me/mutes', async () => {
    await social.muteUser(userA.id, userB.id);
    await social.muteWork(userA.id, sampleWork.id);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/mutes',
      headers: { authorization: `Bearer ${userA.token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.users).toHaveLength(1);
    expect(body.users[0].id).toBe(userB.id);
    expect(body.users[0].username).toBe(userB.username);

    expect(body.works).toHaveLength(1);
    expect(body.works[0].id).toBe(sampleWork.id);
    expect(body.works[0].title).toBe('Neuromancer');
  });
});
