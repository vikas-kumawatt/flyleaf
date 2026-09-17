// Cross-user access and authorization test suite (FN-70, FN-71, FN-72, Architecture §4).
//
// The test suite is the actual security control (Architecture §4, PRD §25.3):
//   1. 404, NEVER 403, for another user's private resource (a 403 confirms it exists).
//   2. canView handles public, followers, private, blocked, guest.
//   3. Repository layer viewer enforcement everywhere.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { canView, assertCanView } from '../authorization/index.js';
import { ApiError } from '../http.js';
import { registerCoreHooks } from '../app.js';
import { ReadingService, readingRoutes } from '../reading/index.js';
import { IdentityService, identityRoutes, signAccessToken } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { users, profiles, works, reads } from '../db/schema.js';

describe('canView unit tests (FN-71)', () => {
  const OWNER = 'owner-1111-1111-1111-111111111111';
  const OTHER = 'other-2222-2222-2222-222222222222';
  const GUEST = null;

  describe('blocked accounts (bidirectional complete invisibility)', () => {
    it('returns false for blocked user even on public item and public account', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'public',
        isOwnerPrivate: false,
        isBlocked: true,
      })).toBe(false);
    });

    it('returns false for blocked user even if they are a follower', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'followers',
        isOwnerPrivate: false,
        isBlocked: true,
        isFollower: true,
      })).toBe(false);
    });
  });

  describe('owner access', () => {
    it('owner can always view own private item on private account', () => {
      expect(canView({
        viewer: OWNER,
        ownerId: OWNER,
        visibility: 'private',
        isOwnerPrivate: true,
      })).toBe(true);
    });

    it('owner can always view own followers item on private account', () => {
      expect(canView({
        viewer: OWNER,
        ownerId: OWNER,
        visibility: 'followers',
        isOwnerPrivate: true,
      })).toBe(true);
    });

    it('owner can always view own public item', () => {
      expect(canView({
        viewer: OWNER,
        ownerId: OWNER,
        visibility: 'public',
        isOwnerPrivate: false,
      })).toBe(true);
    });

    it('works with positional arguments', () => {
      expect(canView(OWNER, OWNER, 'private', true, false)).toBe(true);
    });
  });

  describe('private items', () => {
    it('returns false for non-owner even if accepted follower', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'private',
        isFollower: true,
      })).toBe(false);
    });

    it('returns false for guest', () => {
      expect(canView({
        viewer: GUEST,
        ownerId: OWNER,
        visibility: 'private',
      })).toBe(false);
    });
  });

  describe('private accounts', () => {
    it('returns false for guest on public item of private account', () => {
      expect(canView({
        viewer: GUEST,
        ownerId: OWNER,
        visibility: 'public',
        isOwnerPrivate: true,
      })).toBe(false);
    });

    it('returns false for non-follower on public item of private account', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'public',
        isOwnerPrivate: true,
        isFollower: false,
      })).toBe(false);
    });

    it('returns true for approved follower on public item of private account', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'public',
        isOwnerPrivate: true,
        isFollower: true,
      })).toBe(true);
    });

    it('returns true for approved follower on followers item of private account', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'followers',
        isOwnerPrivate: true,
        isFollower: true,
      })).toBe(true);
    });

    it('returns false for approved follower on private item of private account', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'private',
        isOwnerPrivate: true,
        isFollower: true,
      })).toBe(false);
    });
  });

  describe('public accounts', () => {
    it('allows guest to view public item', () => {
      expect(canView({
        viewer: GUEST,
        ownerId: OWNER,
        visibility: 'public',
        isOwnerPrivate: false,
      })).toBe(true);
    });

    it('allows other authenticated user to view public item', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'public',
        isOwnerPrivate: false,
      })).toBe(true);
    });

    it('disallows guest from viewing followers item', () => {
      expect(canView({
        viewer: GUEST,
        ownerId: OWNER,
        visibility: 'followers',
        isOwnerPrivate: false,
      })).toBe(false);
    });

    it('disallows non-follower from viewing followers item', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'followers',
        isOwnerPrivate: false,
        isFollower: false,
      })).toBe(false);
    });

    it('allows approved follower to view followers item', () => {
      expect(canView({
        viewer: OTHER,
        ownerId: OWNER,
        visibility: 'followers',
        isOwnerPrivate: false,
        isFollower: true,
      })).toBe(true);
    });
  });

  describe('assertCanView', () => {
    it('throws 404 not_found (NEVER 403) when canView fails', () => {
      try {
        assertCanView({
          viewer: OTHER,
          ownerId: OWNER,
          visibility: 'private',
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(404);
        expect(apiErr.code).toBe('not_found');
      }
    });
  });
});

describe('Cross-user HTTP access tests — 404 not 403 (FN-70, FN-72)', () => {
  let db: Db;
  let client: import('@electric-sql/pglite').PGlite;
  let app: FastifyInstance;

  const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const WORK_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  let READ_A_PUB: string;
  let READ_A_FOL: string;
  let READ_A_PRIV: string;

  let READ_B_PUB: string;
  let READ_B_FOL: string;
  let READ_B_PRIV: string;

  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    client = fresh.client;

    // Create Work
    await db.insert(works).values({
      id: WORK_ID,
      title: 'Dune',
    });

    // Create User A (Public Profile)
    await db.insert(users).values({
      id: USER_A,
      email: 'user_a@test.com',
      passwordHash: 'dummyhash',
      dateOfBirth: '1995-01-01',
    });
    await db.insert(profiles).values({
      userId: USER_A,
      username: 'user_a_public',
      isPrivate: false,
    });

    // Create User B (Private Profile)
    await db.insert(users).values({
      id: USER_B,
      email: 'user_b@test.com',
      passwordHash: 'dummyhash',
      dateOfBirth: '1996-01-01',
    });
    await db.insert(profiles).values({
      userId: USER_B,
      username: 'user_b_private',
      isPrivate: true,
    });

    // Insert User A reads
    const [rAPub] = await db.insert(reads).values({
      userId: USER_A,
      workId: WORK_ID,
      status: 'finished',
      attemptNo: 1,
      visibility: 'public',
      rating: '4.5',
    }).returning({ id: reads.id });
    READ_A_PUB = rAPub!.id;

    const [rAFol] = await db.insert(reads).values({
      userId: USER_A,
      workId: WORK_ID,
      status: 'reading',
      attemptNo: 2,
      visibility: 'followers',
    }).returning({ id: reads.id });
    READ_A_FOL = rAFol!.id;

    const [rAPriv] = await db.insert(reads).values({
      userId: USER_A,
      workId: WORK_ID,
      status: 'want',
      attemptNo: 3,
      visibility: 'private',
    }).returning({ id: reads.id });
    READ_A_PRIV = rAPriv!.id;

    // Insert User B reads (on private account)
    const [rBPub] = await db.insert(reads).values({
      userId: USER_B,
      workId: WORK_ID,
      status: 'finished',
      attemptNo: 1,
      visibility: 'public',
      rating: '5.0',
    }).returning({ id: reads.id });
    READ_B_PUB = rBPub!.id;

    const [rBFol] = await db.insert(reads).values({
      userId: USER_B,
      workId: WORK_ID,
      status: 'reading',
      attemptNo: 2,
      visibility: 'followers',
    }).returning({ id: reads.id });
    READ_B_FOL = rBFol!.id;

    const [rBPriv] = await db.insert(reads).values({
      userId: USER_B,
      workId: WORK_ID,
      status: 'want',
      attemptNo: 3,
      visibility: 'private',
    }).returning({ id: reads.id });
    READ_B_PRIV = rBPriv!.id;

    // Issue tokens
    tokenA = await signAccessToken(USER_A);
    tokenB = await signAccessToken(USER_B);

    // Build Fastify App
    const limiter = new PgRateLimiter(db);
    const identityService = new IdentityService(db, limiter);
    const readingService = new ReadingService(db);

    app = Fastify();
    registerCoreHooks(app, {
      identityLookup: (token) => identityService.lookup(token),
    });

    await app.register(identityRoutes(identityService), { prefix: '/v1' });
    await app.register(readingRoutes(readingService), { prefix: '/v1' });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  describe('Guest access (no auth header)', () => {
    it('200 for public read on public account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_A_PUB}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(READ_A_PUB);
      expect(body.visibility).toBe('public');
    });

    it('404 (NOT 403) for followers-only read on public account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_A_FOL}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for private read on public account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_A_PRIV}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for public read on private account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_B_PUB}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for followers-only read on private account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_B_FOL}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for private read on private account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_B_PRIV}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('200 for public profile of public user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_A}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().username).toBe('user_a_public');
    });

    it('404 (NOT 403) for private profile to guest', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_B}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('returns only public reads on /users/:id/reads for public user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_A}/reads`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(READ_A_PUB);
    });

    it('returns empty list for private account on /users/:id/reads', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_B}/reads`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(0);
    });
  });

  describe('Authenticated cross-user access (User A viewing User B)', () => {
    it('404 (NOT 403) for User A viewing User B public read (private account, not follower)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_B_PUB}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for User A viewing User B followers read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_B_FOL}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for User A viewing User B private read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_B_PRIV}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for User A viewing User B private profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_B}`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('returns empty list on /users/:id/reads for private account to non-follower', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_B}/reads`,
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(0);
    });

    it('404 (NOT 403) for User A attempting to add progress to User B read', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/reads/${READ_B_PUB}/progress`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          client_event_id: randomUUID(),
          page: 50,
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });
  });

  describe('Authenticated cross-user access (User B viewing User A)', () => {
    it('200 for User B viewing User A public read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_A_PUB}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(READ_A_PUB);
    });

    it('404 (NOT 403) for User B viewing User A followers read (not a follower)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_A_FOL}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('404 (NOT 403) for User B viewing User A private read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reads/${READ_A_PRIV}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });
  });

  describe('Owner access to own resources', () => {
    it('User A can view own public, followers, and private reads', async () => {
      const [rPub, rFol, rPriv] = await Promise.all([
        app.inject({ method: 'GET', url: `/v1/reads/${READ_A_PUB}`, headers: { authorization: `Bearer ${tokenA}` } }),
        app.inject({ method: 'GET', url: `/v1/reads/${READ_A_FOL}`, headers: { authorization: `Bearer ${tokenA}` } }),
        app.inject({ method: 'GET', url: `/v1/reads/${READ_A_PRIV}`, headers: { authorization: `Bearer ${tokenA}` } }),
      ]);

      expect(rPub.statusCode).toBe(200);
      expect(rFol.statusCode).toBe(200);
      expect(rPriv.statusCode).toBe(200);
    });

    it('User B can view own public, followers, and private reads on private account', async () => {
      const [rPub, rFol, rPriv] = await Promise.all([
        app.inject({ method: 'GET', url: `/v1/reads/${READ_B_PUB}`, headers: { authorization: `Bearer ${tokenB}` } }),
        app.inject({ method: 'GET', url: `/v1/reads/${READ_B_FOL}`, headers: { authorization: `Bearer ${tokenB}` } }),
        app.inject({ method: 'GET', url: `/v1/reads/${READ_B_PRIV}`, headers: { authorization: `Bearer ${tokenB}` } }),
      ]);

      expect(rPub.statusCode).toBe(200);
      expect(rFol.statusCode).toBe(200);
      expect(rPriv.statusCode).toBe(200);
    });

    it('User B can view own private profile', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_B}`,
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().username).toBe('user_b_private');
    });

    it('User A GET /v1/reads lists all 3 of User A reads', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/reads',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(3);
    });

    it('User B GET /v1/reads lists all 3 of User B reads', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/reads',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(3);
    });
  });
});
