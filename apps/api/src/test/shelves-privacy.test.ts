// Comprehensive tests for Shelf Privacy on every read path (SH-09, Architecture §4, PRD §15.2, §26.1).
// Governed by:
// 1. Strict 3-tier privacy: public / followers / private.
// 2. Private account hierarchy: if profiles.isPrivate = true, non-followers receive 404 and browse excludes them.
// 3. 404, never 403: unauthorized readers receive 404 to eliminate enumeration.
// 4. Soft-delete masking: deleted shelves return 404 to all non-owners.
// 5. Dynamic privacy in saved shelves.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { users, profiles, follows, shelves, works, authors, workAuthors, shelfItems, shelfSaves } from '../db/schema.js';
import type { Db } from '../platform/index.js';

let app: FastifyInstance;
let db: Db;

const USER_ALICE = '11111111-1111-1111-1111-111111111111'; // Public profile owner
const USER_BOB = '22222222-2222-2222-2222-222222222222';   // Accepted follower
const USER_CHARLIE = '33333333-3333-3333-3333-333333333333'; // Stranger (authenticated non-follower)
const USER_DAVE = '44444444-4444-4444-4444-444444444444';   // Private profile owner
const USER_EVE = '55555555-5555-5555-5555-555555555555';    // Pending follower of Dave

const WORK_1 = 'a1111111-1111-1111-1111-111111111111';
const WORK_2 = 'a2222222-2222-2222-2222-222222222222';
const AUTHOR_1 = 'b1111111-1111-1111-1111-111111111111';

let alicePublicShelfId: string;
let aliceFollowersShelfId: string;
let alicePrivateShelfId: string;
let aliceDeletedShelfId: string;

let davePublicShelfId: string;
let daveFollowersShelfId: string;
let davePrivateShelfId: string;

function authHeader(userId: string) {
  return { authorization: `Bearer test-token-${userId}` };
}

beforeAll(async () => {
  const context = await freshDrizzle();
  db = context.db;

  // Insert users
  await db.insert(users).values([
    { id: USER_ALICE, email: 'alice@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
    { id: USER_BOB, email: 'bob@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
    { id: USER_CHARLIE, email: 'charlie@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
    { id: USER_DAVE, email: 'dave@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
    { id: USER_EVE, email: 'eve@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
  ]);

  // Insert profiles: Alice is public, Dave is private
  await db.insert(profiles).values([
    { userId: USER_ALICE, username: 'alice', displayName: 'Alice', isPrivate: false },
    { userId: USER_BOB, username: 'bob', displayName: 'Bob', isPrivate: false },
    { userId: USER_CHARLIE, username: 'charlie', displayName: 'Charlie', isPrivate: false },
    { userId: USER_DAVE, username: 'dave', displayName: 'Dave', isPrivate: true },
    { userId: USER_EVE, username: 'eve', displayName: 'Eve', isPrivate: false },
  ]);

  // Social graph:
  // Bob follows Alice (accepted)
  // Bob follows Dave (accepted)
  // Eve requested to follow Dave (pending)
  await db.insert(follows).values([
    { followerId: USER_BOB, followeeId: USER_ALICE, state: 'accepted' },
    { followerId: USER_BOB, followeeId: USER_DAVE, state: 'accepted' },
    { followerId: USER_EVE, followeeId: USER_DAVE, state: 'pending' },
  ]);

  // Works and authors
  await db.insert(authors).values([
    { id: AUTHOR_1, name: 'Ursula K. Le Guin', olAuthorKey: 'OL123A' },
  ]);

  await db.insert(works).values([
    { id: WORK_1, title: 'The Left Hand of Darkness', olCoverId: 1001, logCount: 50 },
    { id: WORK_2, title: 'The Dispossessed', olCoverId: 1002, logCount: 35 },
  ]);

  await db.insert(workAuthors).values([
    { workId: WORK_1, authorId: AUTHOR_1, position: 1 },
    { workId: WORK_2, authorId: AUTHOR_1, position: 1 },
  ]);

  // Create Shelves for Alice (public account)
  const [ap] = await db.insert(shelves).values({
    userId: USER_ALICE,
    name: 'Alice Public Shelf',
    slug: 'alice-public',
    privacy: 'public',
    isRanked: false,
    itemCount: 1,
    coverWorkIds: [WORK_1],
  }).returning();
  alicePublicShelfId = ap!.id;

  const [af] = await db.insert(shelves).values({
    userId: USER_ALICE,
    name: 'Alice Followers Shelf',
    slug: 'alice-followers',
    privacy: 'followers',
    isRanked: false,
    itemCount: 1,
    coverWorkIds: [WORK_1],
  }).returning();
  aliceFollowersShelfId = af!.id;

  const [apr] = await db.insert(shelves).values({
    userId: USER_ALICE,
    name: 'Alice Private Shelf',
    slug: 'alice-private',
    privacy: 'private',
    isRanked: false,
    itemCount: 1,
    coverWorkIds: [WORK_1],
  }).returning();
  alicePrivateShelfId = apr!.id;

  const [ad] = await db.insert(shelves).values({
    userId: USER_ALICE,
    name: 'Alice Deleted Shelf',
    slug: 'alice-deleted',
    privacy: 'public',
    isRanked: false,
    itemCount: 0,
    deletedAt: new Date(),
  }).returning();
  aliceDeletedShelfId = ad!.id;

  // Create Shelves for Dave (private account)
  const [dp] = await db.insert(shelves).values({
    userId: USER_DAVE,
    name: 'Dave Public Shelf',
    slug: 'dave-public',
    privacy: 'public',
    isRanked: false,
    itemCount: 1,
    coverWorkIds: [WORK_2],
  }).returning();
  davePublicShelfId = dp!.id;

  const [df] = await db.insert(shelves).values({
    userId: USER_DAVE,
    name: 'Dave Followers Shelf',
    slug: 'dave-followers',
    privacy: 'followers',
    isRanked: false,
    itemCount: 1,
    coverWorkIds: [WORK_2],
  }).returning();
  daveFollowersShelfId = df!.id;

  const [dpr] = await db.insert(shelves).values({
    userId: USER_DAVE,
    name: 'Dave Private Shelf',
    slug: 'dave-private',
    privacy: 'private',
    isRanked: false,
    itemCount: 1,
    coverWorkIds: [WORK_2],
  }).returning();
  davePrivateShelfId = dpr!.id;

  // Seed items into the shelves
  await db.insert(shelfItems).values([
    { shelfId: alicePublicShelfId, workId: WORK_1, position: 1 },
    { shelfId: aliceFollowersShelfId, workId: WORK_1, position: 1 },
    { shelfId: alicePrivateShelfId, workId: WORK_1, position: 1 },
    { shelfId: davePublicShelfId, workId: WORK_2, position: 1 },
    { shelfId: daveFollowersShelfId, workId: WORK_2, position: 1 },
    { shelfId: davePrivateShelfId, workId: WORK_2, position: 1 },
  ]);

  const identityMock = {
    lookup: async (token: string) => {
      if (token.startsWith('test-token-')) {
        return token.replace('test-token-', '');
      }
      return null;
    },
  } as any;

  app = await buildApp({
    db,
    identity: identityMock,
  });
});

afterAll(async () => {
  await app.close();
});

describe('SH-09: Shelf Privacy on GET /v1/shelves/:id (Single Shelf)', () => {
  describe('Public Account (Alice)', () => {
    it('owner (Alice) can view all their shelves (public, followers, private, deleted)', async () => {
      for (const id of [alicePublicShelfId, aliceFollowersShelfId, alicePrivateShelfId, aliceDeletedShelfId]) {
        const res = await app.inject({
          method: 'GET',
          url: `/v1/shelves/${id}`,
          headers: authHeader(USER_ALICE),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().shelf.id).toBe(id);
      }
    });

    it('accepted follower (Bob) can view public and followers shelves, but receives 404 for private and deleted', async () => {
      const pubRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${alicePublicShelfId}`,
        headers: authHeader(USER_BOB),
      });
      expect(pubRes.statusCode).toBe(200);

      const folRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${aliceFollowersShelfId}`,
        headers: authHeader(USER_BOB),
      });
      expect(folRes.statusCode).toBe(200);

      const privRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${alicePrivateShelfId}`,
        headers: authHeader(USER_BOB),
      });
      expect(privRes.statusCode).toBe(404);
      expect(privRes.json().error.code).toBe('not_found');

      const delRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${aliceDeletedShelfId}`,
        headers: authHeader(USER_BOB),
      });
      expect(delRes.statusCode).toBe(404);
    });

    it('stranger (Charlie) can view public shelf, but receives 404 for followers, private, and deleted', async () => {
      const pubRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${alicePublicShelfId}`,
        headers: authHeader(USER_CHARLIE),
      });
      expect(pubRes.statusCode).toBe(200);

      const folRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${aliceFollowersShelfId}`,
        headers: authHeader(USER_CHARLIE),
      });
      expect(folRes.statusCode).toBe(404);

      const privRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${alicePrivateShelfId}`,
        headers: authHeader(USER_CHARLIE),
      });
      expect(privRes.statusCode).toBe(404);

      const delRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${aliceDeletedShelfId}`,
        headers: authHeader(USER_CHARLIE),
      });
      expect(delRes.statusCode).toBe(404);
    });

    it('guest (unauthenticated) can view public shelf, but receives 404 for followers, private, and deleted', async () => {
      const pubRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${alicePublicShelfId}`,
      });
      expect(pubRes.statusCode).toBe(200);

      const folRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${aliceFollowersShelfId}`,
      });
      expect(folRes.statusCode).toBe(404);

      const privRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${alicePrivateShelfId}`,
      });
      expect(privRes.statusCode).toBe(404);

      const delRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${aliceDeletedShelfId}`,
      });
      expect(delRes.statusCode).toBe(404);
    });
  });

  describe('Private Account Hierarchy (Dave, isPrivate = true)', () => {
    it('owner (Dave) can view all their shelves', async () => {
      for (const id of [davePublicShelfId, daveFollowersShelfId, davePrivateShelfId]) {
        const res = await app.inject({
          method: 'GET',
          url: `/v1/shelves/${id}`,
          headers: authHeader(USER_DAVE),
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('accepted follower (Bob) can view public and followers shelves, but receives 404 for private', async () => {
      const pubRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${davePublicShelfId}`,
        headers: authHeader(USER_BOB),
      });
      expect(pubRes.statusCode).toBe(200);

      const folRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${daveFollowersShelfId}`,
        headers: authHeader(USER_BOB),
      });
      expect(folRes.statusCode).toBe(200);

      const privRes = await app.inject({
        method: 'GET',
        url: `/v1/shelves/${davePrivateShelfId}`,
        headers: authHeader(USER_BOB),
      });
      expect(privRes.statusCode).toBe(404);
    });

    it('pending follower (Eve) receives 404 for ALL shelves (even public)', async () => {
      for (const id of [davePublicShelfId, daveFollowersShelfId, davePrivateShelfId]) {
        const res = await app.inject({
          method: 'GET',
          url: `/v1/shelves/${id}`,
          headers: authHeader(USER_EVE),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('not_found');
      }
    });

    it('stranger (Charlie) receives 404 for ALL shelves of private account', async () => {
      for (const id of [davePublicShelfId, daveFollowersShelfId, davePrivateShelfId]) {
        const res = await app.inject({
          method: 'GET',
          url: `/v1/shelves/${id}`,
          headers: authHeader(USER_CHARLIE),
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('not_found');
      }
    });

    it('guest (unauthenticated) receives 404 for ALL shelves of private account', async () => {
      for (const id of [davePublicShelfId, daveFollowersShelfId, davePrivateShelfId]) {
        const res = await app.inject({
          method: 'GET',
          url: `/v1/shelves/${id}`,
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('not_found');
      }
    });
  });
});

describe('SH-09: Shelf Items Privacy on GET /v1/shelves/:id/items', () => {
  it('returns items for authorized readers and 404 for unauthorized viewers', async () => {
    // Alice's followers shelf:
    // Bob (follower) -> 200
    const bobRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${aliceFollowersShelfId}/items`,
      headers: authHeader(USER_BOB),
    });
    expect(bobRes.statusCode).toBe(200);
    expect(bobRes.json().data.length).toBe(1);

    // Charlie (stranger) -> 404
    const charlieRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${aliceFollowersShelfId}/items`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(charlieRes.statusCode).toBe(404);

    // Guest -> 404
    const guestRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${aliceFollowersShelfId}/items`,
    });
    expect(guestRes.statusCode).toBe(404);

    // Dave's public shelf (private account):
    // Stranger (Charlie) -> 404
    const daveCharlieRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${davePublicShelfId}/items`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(daveCharlieRes.statusCode).toBe(404);
  });
});

describe('SH-09: User Shelves on GET /v1/users/:id/shelves', () => {
  describe('Public User (Alice)', () => {
    it('returns all active shelves for owner (Alice)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_ALICE}/shelves`,
        headers: authHeader(USER_ALICE),
      });
      expect(res.statusCode).toBe(200);
      const shelfIds = res.json().shelves.map((s: any) => s.id);
      expect(shelfIds).toContain(alicePublicShelfId);
      expect(shelfIds).toContain(aliceFollowersShelfId);
      expect(shelfIds).toContain(alicePrivateShelfId);
      expect(shelfIds).not.toContain(aliceDeletedShelfId); // Soft-deleted excluded
    });

    it('returns public and followers shelves for follower (Bob)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_ALICE}/shelves`,
        headers: authHeader(USER_BOB),
      });
      expect(res.statusCode).toBe(200);
      const shelfIds = res.json().shelves.map((s: any) => s.id);
      expect(shelfIds).toContain(alicePublicShelfId);
      expect(shelfIds).toContain(aliceFollowersShelfId);
      expect(shelfIds).not.toContain(alicePrivateShelfId);
      expect(shelfIds).not.toContain(aliceDeletedShelfId);
    });

    it('returns public shelves only for stranger (Charlie) and guest', async () => {
      const authRes = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_ALICE}/shelves`,
        headers: authHeader(USER_CHARLIE),
      });
      expect(authRes.statusCode).toBe(200);
      const authShelfIds = authRes.json().shelves.map((s: any) => s.id);
      expect(authShelfIds).toEqual([alicePublicShelfId]);

      const guestRes = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_ALICE}/shelves`,
      });
      expect(guestRes.statusCode).toBe(200);
      const guestShelfIds = guestRes.json().shelves.map((s: any) => s.id);
      expect(guestShelfIds).toEqual([alicePublicShelfId]);
    });
  });

  describe('Private User (Dave)', () => {
    it('returns all active shelves for owner (Dave)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_DAVE}/shelves`,
        headers: authHeader(USER_DAVE),
      });
      expect(res.statusCode).toBe(200);
      const shelfIds = res.json().shelves.map((s: any) => s.id);
      expect(shelfIds).toContain(davePublicShelfId);
      expect(shelfIds).toContain(daveFollowersShelfId);
      expect(shelfIds).toContain(davePrivateShelfId);
    });

    it('returns public and followers shelves for accepted follower (Bob)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_DAVE}/shelves`,
        headers: authHeader(USER_BOB),
      });
      expect(res.statusCode).toBe(200);
      const shelfIds = res.json().shelves.map((s: any) => s.id);
      expect(shelfIds).toContain(davePublicShelfId);
      expect(shelfIds).toContain(daveFollowersShelfId);
      expect(shelfIds).not.toContain(davePrivateShelfId);
    });

    it('returns 404 for pending follower (Eve), stranger (Charlie), and guest', async () => {
      const eveRes = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_DAVE}/shelves`,
        headers: authHeader(USER_EVE),
      });
      expect(eveRes.statusCode).toBe(404);
      expect(eveRes.json().error.code).toBe('not_found');

      const charlieRes = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_DAVE}/shelves`,
        headers: authHeader(USER_CHARLIE),
      });
      expect(charlieRes.statusCode).toBe(404);
      expect(charlieRes.json().error.code).toBe('not_found');

      const guestRes = await app.inject({
        method: 'GET',
        url: `/v1/users/${USER_DAVE}/shelves`,
      });
      expect(guestRes.statusCode).toBe(404);
      expect(guestRes.json().error.code).toBe('not_found');
    });

    it('returns 404 for non-existent user ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/99999999-9999-9999-9999-999999999999/shelves',
        headers: authHeader(USER_BOB),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

describe('SH-09: Discovery Privacy on GET /v1/shelves/browse', () => {
  it('excludes public shelves of private accounts from public discovery', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shelves/browse',
    });
    expect(res.statusCode).toBe(200);
    const shelfIds = res.json().shelves.map((s: any) => s.id);

    // Alice is public account -> Alice Public Shelf MUST be present
    expect(shelfIds).toContain(alicePublicShelfId);

    // Dave is private account -> Dave Public Shelf MUST NOT be in browse
    expect(shelfIds).not.toContain(davePublicShelfId);

    // Followers, private, and deleted shelves MUST NOT be in browse
    expect(shelfIds).not.toContain(aliceFollowersShelfId);
    expect(shelfIds).not.toContain(alicePrivateShelfId);
    expect(shelfIds).not.toContain(aliceDeletedShelfId);
    expect(shelfIds).not.toContain(daveFollowersShelfId);
    expect(shelfIds).not.toContain(davePrivateShelfId);
  });
});

describe('SH-09: Dynamic Saved Shelves Privacy on GET /v1/shelves/saved', () => {
  it('dynamically hides saved shelf when privacy changes or user unfollows', async () => {
    // 1. Bob saves Alice's public shelf
    const saveRes = await app.inject({
      method: 'POST',
      url: `/v1/shelves/${alicePublicShelfId}/save`,
      headers: authHeader(USER_BOB),
    });
    expect(saveRes.statusCode).toBe(200);

    // Verify Bob sees it in saved
    let savedRes = await app.inject({
      method: 'GET',
      url: '/v1/shelves/saved',
      headers: authHeader(USER_BOB),
    });
    expect(savedRes.statusCode).toBe(200);
    expect(savedRes.json().shelves.some((s: any) => s.id === alicePublicShelfId)).toBe(true);

    // 2. Alice updates shelf privacy to 'private'
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${alicePublicShelfId}`,
      headers: authHeader(USER_ALICE),
      payload: { privacy: 'private' },
    });
    expect(patchRes.statusCode).toBe(200);

    // Verify Bob NO LONGER sees it in saved shelves
    savedRes = await app.inject({
      method: 'GET',
      url: '/v1/shelves/saved',
      headers: authHeader(USER_BOB),
    });
    expect(savedRes.statusCode).toBe(200);
    expect(savedRes.json().shelves.some((s: any) => s.id === alicePublicShelfId)).toBe(false);

    // 3. Alice updates shelf privacy back to 'public'
    await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${alicePublicShelfId}`,
      headers: authHeader(USER_ALICE),
      payload: { privacy: 'public' },
    });

    // 4. Bob saves Dave's public shelf (Bob follows Dave)
    const daveSaveRes = await app.inject({
      method: 'POST',
      url: `/v1/shelves/${davePublicShelfId}/save`,
      headers: authHeader(USER_BOB),
    });
    expect(daveSaveRes.statusCode).toBe(200);

    // Bob can see Dave's shelf in saved because Bob is an accepted follower of Dave
    savedRes = await app.inject({
      method: 'GET',
      url: '/v1/shelves/saved',
      headers: authHeader(USER_BOB),
    });
    expect(savedRes.json().shelves.some((s: any) => s.id === davePublicShelfId)).toBe(true);

    // 5. Bob unfollows Dave
    await db.delete(follows).where(
      eq(follows.followerId, USER_BOB),
    );

    // Now Bob is no longer a follower of Dave (private profile), so Dave's shelf MUST disappear
    savedRes = await app.inject({
      method: 'GET',
      url: '/v1/shelves/saved',
      headers: authHeader(USER_BOB),
    });
    expect(savedRes.json().shelves.some((s: any) => s.id === davePublicShelfId)).toBe(false);
  });
});

describe('SH-09: Write Operations Return 404 (Never 403) for Unauthorized Users', () => {
  it('returns 404 when non-owner attempts mutations on another user shelf', async () => {
    // Charlie attempts to edit Alice's shelf
    const editRes = await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${alicePublicShelfId}`,
      headers: authHeader(USER_CHARLIE),
      payload: { name: 'Hacked Name' },
    });
    expect(editRes.statusCode).toBe(404);
    expect(editRes.json().error.code).toBe('not_found');

    // Charlie attempts to delete Alice's shelf
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/shelves/${alicePublicShelfId}`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(delRes.statusCode).toBe(404);
    expect(delRes.json().error.code).toBe('not_found');

    // Charlie attempts to add item to Alice's shelf
    const addRes = await app.inject({
      method: 'POST',
      url: `/v1/shelves/${alicePublicShelfId}/items`,
      headers: authHeader(USER_CHARLIE),
      payload: { work_id: WORK_2 },
    });
    expect(addRes.statusCode).toBe(404);
    expect(addRes.json().error.code).toBe('not_found');

    // Charlie attempts to update item on Alice's shelf
    const updateItemRes = await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${alicePublicShelfId}/items/${WORK_1}`,
      headers: authHeader(USER_CHARLIE),
      payload: { note: 'Unauthorized note' },
    });
    expect(updateItemRes.statusCode).toBe(404);
    expect(updateItemRes.json().error.code).toBe('not_found');

    // Charlie attempts to delete item from Alice's shelf
    const deleteItemRes = await app.inject({
      method: 'DELETE',
      url: `/v1/shelves/${alicePublicShelfId}/items/${WORK_1}`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(deleteItemRes.statusCode).toBe(404);
    expect(deleteItemRes.json().error.code).toBe('not_found');

    // Charlie attempts to reorder Alice's shelf
    const reorderRes = await app.inject({
      method: 'PUT',
      url: `/v1/shelves/${alicePublicShelfId}/order`,
      headers: authHeader(USER_CHARLIE),
      payload: { work_ids: [WORK_1] },
    });
    expect(reorderRes.statusCode).toBe(404);
    expect(reorderRes.json().error.code).toBe('not_found');
  });
});
