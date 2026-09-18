// Tests for Shelves API & Service (SH-01, SH-02).
// Governed by:
//   - PRD §6.35 (Create / edit shelf)
//   - PRD §15.2–15.6 (Constraints, privacy, unique slug per user, soft delete)
//   - Architecture §4 (Authorization, 404 for forbidden access)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import { users, profiles, follows, shelves, works, authors, workAuthors, shelfSaves } from '../db/schema.js';
import type { Db } from '../platform/index.js';

let app: FastifyInstance;
let db: Db;

const USER_ALICE = '11111111-1111-1111-1111-111111111111';
const USER_BOB = '22222222-2222-2222-2222-222222222222';
const USER_CHARLIE = '33333333-3333-3333-3333-333333333333';

const WORK_1 = '44444444-4444-4444-4444-444444444441';
const WORK_2 = '44444444-4444-4444-4444-444444444442';
const WORK_3 = '44444444-4444-4444-4444-444444444443';
const AUTHOR_1 = '55555555-5555-5555-5555-555555555551';

function authHeader(userId: string) {
  return { authorization: `Bearer test-token-${userId}` };
}

beforeAll(async () => {
  const context = await freshDrizzle();
  db = context.db;

  // Insert mock users
  await db.insert(users).values([
    { id: USER_ALICE, email: 'alice@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
    { id: USER_BOB, email: 'bob@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
    { id: USER_CHARLIE, email: 'charlie@flyleaf.test', passwordHash: 'hash', dateOfBirth: '2000-01-01' },
  ]);

  await db.insert(profiles).values([
    { userId: USER_ALICE, username: 'alice', displayName: 'Alice' },
    { userId: USER_BOB, username: 'bob', displayName: 'Bob' },
    { userId: USER_CHARLIE, username: 'charlie', displayName: 'Charlie' },
  ]);

  // Bob follows Alice (accepted)
  await db.insert(follows).values([
    { followerId: USER_BOB, followeeId: USER_ALICE, state: 'accepted' },
  ]);

  // Seed authors and works for shelf items
  await db.insert(authors).values([
    { id: AUTHOR_1, name: 'Ursula K. Le Guin', olAuthorKey: 'OL123A' },
  ]);

  await db.insert(works).values([
    { id: WORK_1, title: 'The Left Hand of Darkness', olCoverId: 1001, logCount: 50 },
    { id: WORK_2, title: 'The Dispossessed', olCoverId: 1002, logCount: 35 },
    { id: WORK_3, title: 'A Wizard of Earthsea', olCoverId: 1003, logCount: 40 },
  ]);

  await db.insert(workAuthors).values([
    { workId: WORK_1, authorId: AUTHOR_1, position: 1 },
    { workId: WORK_2, authorId: AUTHOR_1, position: 1 },
    { workId: WORK_3, authorId: AUTHOR_1, position: 1 },
  ]);

  // Mock identity lookup for test tokens
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

describe('SH-02: POST /v1/shelves (Create Shelf)', () => {
  it('creates a shelf with name, description, privacy, and ranked toggle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: {
        name: 'Top 10 Sci-Fi Novels',
        description: 'My curated ranking of sci-fi masterpieces.',
        is_ranked: true,
        privacy: 'public',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.shelf).toMatchObject({
      user_id: USER_ALICE,
      name: 'Top 10 Sci-Fi Novels',
      slug: 'top-10-sci-fi-novels',
      description: 'My curated ranking of sci-fi masterpieces.',
      is_ranked: true,
      privacy: 'public',
      item_count: 0,
      save_count: 0,
      owner: {
        id: USER_ALICE,
        username: 'alice',
      },
    });
    expect(body.shelf.id).toBeTruthy();
    expect(body.shelf.cover_work_ids).toEqual([]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      payload: { name: 'Anonymous Shelf' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('validates name constraints (empty or > 60 chars)', async () => {
    const resEmpty = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: '   ' },
    });
    expect(resEmpty.statusCode).toBe(400);

    const resLong = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'A'.repeat(61) },
    });
    expect(resLong.statusCode).toBe(422);
  });

  it('validates privacy enum', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Bad Privacy', privacy: 'secret' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('disambiguates duplicate slugs for the same user', async () => {
    // First shelf
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Best Fantasy' },
    });
    expect(res1.statusCode).toBe(201);
    expect(res1.json().shelf.slug).toBe('best-fantasy');

    // Second shelf with same name by Alice
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Best Fantasy' },
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.json().shelf.slug).toBe('best-fantasy-1');

    // Third shelf with same name by Alice
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Best Fantasy' },
    });
    expect(res3.statusCode).toBe(201);
    expect(res3.json().shelf.slug).toBe('best-fantasy-2');

    // Bob can use 'best-fantasy' without collision
    const resBob = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_BOB),
      payload: { name: 'Best Fantasy' },
    });
    expect(resBob.statusCode).toBe(201);
    expect(resBob.json().shelf.slug).toBe('best-fantasy');
  });
});

describe('SH-02: GET /v1/shelves/:id (Read Shelf & Authorization)', () => {
  let publicShelfId: string;
  let followersShelfId: string;
  let privateShelfId: string;

  beforeAll(async () => {
    // Create shelves for Alice
    const pRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Public', privacy: 'public' },
    });
    publicShelfId = pRes.json().shelf.id;

    const fRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Followers', privacy: 'followers' },
    });
    followersShelfId = fRes.json().shelf.id;

    const prRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Private', privacy: 'private' },
    });
    privateShelfId = prRes.json().shelf.id;
  });

  it('allows public shelves to be viewed by guest and any user', async () => {
    // Guest (no token)
    const resGuest = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${publicShelfId}`,
    });
    expect(resGuest.statusCode).toBe(200);
    expect(resGuest.json().shelf.name).toBe('Alice Public');

    // Other user (Charlie)
    const resCharlie = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${publicShelfId}`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(resCharlie.statusCode).toBe(200);
  });

  it('enforces followers-only privacy (Bob can view, Charlie/Guest cannot)', async () => {
    // Bob is an accepted follower of Alice
    const resBob = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${followersShelfId}`,
      headers: authHeader(USER_BOB),
    });
    expect(resBob.statusCode).toBe(200);

    // Charlie is not a follower -> 404 (never 403)
    const resCharlie = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${followersShelfId}`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(resCharlie.statusCode).toBe(404);

    // Guest -> 404
    const resGuest = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${followersShelfId}`,
    });
    expect(resGuest.statusCode).toBe(404);
  });

  it('enforces private privacy (Alice can view, others get 404)', async () => {
    // Alice (owner) can view
    const resAlice = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${privateShelfId}`,
      headers: authHeader(USER_ALICE),
    });
    expect(resAlice.statusCode).toBe(200);

    // Bob receives 404
    const resBob = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${privateShelfId}`,
      headers: authHeader(USER_BOB),
    });
    expect(resBob.statusCode).toBe(404);

    // Guest receives 404
    const resGuest = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${privateShelfId}`,
    });
    expect(resGuest.statusCode).toBe(404);
  });
});

describe('SH-02: PATCH /v1/shelves/:id (Update Shelf)', () => {
  it('allows owner to update name, description, privacy, and is_ranked', async () => {
    // Create shelf
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Initial Shelf Name', is_ranked: false, privacy: 'public' },
    });
    const shelfId = createRes.json().shelf.id;

    // Update
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_ALICE),
      payload: {
        name: 'Updated Shelf Name',
        description: 'New description text',
        is_ranked: true,
        privacy: 'followers',
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json().shelf;
    expect(updated.name).toBe('Updated Shelf Name');
    expect(updated.slug).toBe('updated-shelf-name');
    expect(updated.description).toBe('New description text');
    expect(updated.is_ranked).toBe(true);
    expect(updated.privacy).toBe('followers');
  });

  it('forbids non-owner from updating shelf (returns 404)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Protected Shelf' },
    });
    const shelfId = createRes.json().shelf.id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_BOB),
      payload: { name: 'Hacked by Bob' },
    });
    expect(patchRes.statusCode).toBe(404);
  });
});

describe('SH-02: DELETE /v1/shelves/:id (Soft Delete)', () => {
  it('allows owner to soft-delete shelf and hides it from readers', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Shelf to Delete', privacy: 'public' },
    });
    const shelfId = createRes.json().shelf.id;

    // Delete shelf
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_ALICE),
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ deleted: true, id: shelfId });

    // Non-owner and guests now receive 404
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_BOB),
    });
    expect(getRes.statusCode).toBe(404);
  });

  it('forbids non-owner from deleting shelf', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Shelf Cannot Delete' },
    });
    const shelfId = createRes.json().shelf.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(delRes.statusCode).toBe(404);
  });
});

describe('SH-03: Shelf Detail & Items (GET /v1/shelves/:id/items, POST /v1/shelves/:id/items)', () => {
  it('adds items to a shelf with position and note, and triggers counter & cover updates', async () => {
    // Create ranked shelf
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Le Guin Essentials', is_ranked: true, privacy: 'public' },
    });
    const shelfId = createRes.json().shelf.id;

    // Add Work 1 (Position 1) with per-entry note (PRD §15.2)
    const addRes1 = await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: {
        work_id: WORK_1,
        position: 1,
        note: 'Start here. The worldbuilding is unmatched.',
      },
    });
    expect(addRes1.statusCode).toBe(201);
    const item1 = addRes1.json().item;
    expect(item1).toMatchObject({
      shelf_id: shelfId,
      work_id: WORK_1,
      position: 1,
      note: 'Start here. The worldbuilding is unmatched.',
      work: {
        id: WORK_1,
        title: 'The Left Hand of Darkness',
        author_name: 'Ursula K. Le Guin',
        cover_id: 1001,
      },
    });

    // Add Work 2 (Position 2)
    const addRes2 = await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: {
        work_id: WORK_2,
        position: 2,
        note: 'An ambiguous utopia. Brilliant philosophy.',
      },
    });
    expect(addRes2.statusCode).toBe(201);

    // Verify GET /v1/shelves/:id has resolved cover_ids and updated item_count
    const getShelfRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_ALICE),
    });
    expect(getShelfRes.statusCode).toBe(200);
    const shelf = getShelfRes.json().shelf;
    expect(shelf.item_count).toBe(2);
    expect(shelf.cover_ids).toEqual([1001, 1002]);
    expect(shelf.is_saved).toBe(false);

    // Verify GET /v1/shelves/:id/items returns items in sequential position order
    const getItemsRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_BOB),
    });
    expect(getItemsRes.statusCode).toBe(200);
    const itemsBody = getItemsRes.json();
    expect(itemsBody.total).toBe(2);
    expect(itemsBody.data).toHaveLength(2);
    expect(itemsBody.data[0].position).toBe(1);
    expect(itemsBody.data[0].work.title).toBe('The Left Hand of Darkness');
    expect(itemsBody.data[1].position).toBe(2);
    expect(itemsBody.data[1].work.title).toBe('The Dispossessed');
  });

  it('rejects duplicate work on the same shelf (409 conflict)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Single Book Shelf' },
    });
    const shelfId = createRes.json().shelf.id;

    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_1 },
    });

    // Second add of WORK_1
    const dupRes = await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_1 },
    });
    expect(dupRes.statusCode).toBe(409);
  });

  it('validates note length constraint (max 280 chars)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Note Constraint Shelf' },
    });
    const shelfId = createRes.json().shelf.id;

    const longNoteRes = await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: {
        work_id: WORK_1,
        note: 'N'.repeat(281),
      },
    });
    expect(longNoteRes.statusCode).toBe(422);
  });

  it('enforces privacy on GET /v1/shelves/:id/items (returns 404 for forbidden viewer)', async () => {
    // Private shelf
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Private Shelf', privacy: 'private' },
    });
    const shelfId = createRes.json().shelf.id;

    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_1 },
    });

    // Bob tries to read items of private shelf -> 404
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_BOB),
    });
    expect(getRes.statusCode).toBe(404);

    // Guest tries to read items -> 404
    const guestRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}/items`,
    });
    expect(guestRes.statusCode).toBe(404);

    // Alice (owner) can read items
    const ownerRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
    });
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.json().total).toBe(1);
  });

  it('reflects is_saved boolean when reader saves a shelf', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Saveable Shelf', privacy: 'public' },
    });
    const shelfId = createRes.json().shelf.id;

    // Bob has not saved yet
    const getRes1 = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_BOB),
    });
    expect(getRes1.json().shelf.is_saved).toBe(false);

    // Insert save directly into shelf_saves
    await db.insert(shelfSaves).values({
      shelfId,
      userId: USER_BOB,
    });

    // Bob queries again -> is_saved is true
    const getRes2 = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_BOB),
    });
    expect(getRes2.json().shelf.is_saved).toBe(true);

    // Charlie queries -> is_saved is false
    const getResCharlie = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_CHARLIE),
    });
    expect(getResCharlie.json().shelf.is_saved).toBe(false);
  });

  it('retrieves user shelves via GET /v1/shelves/mine with work membership indicators (SH-04)', async () => {
    // Unauthenticated request is rejected
    const unauthRes = await app.inject({
      method: 'GET',
      url: '/v1/shelves/mine',
    });
    expect(unauthRes.statusCode).toBe(401);

    // Create 2 shelves for Alice: one with WORK_1, one empty
    const shelf1Res = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Sci-Fi', privacy: 'public' },
    });
    const shelf1Id = shelf1Res.json().shelf.id;

    const shelf2Res = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Alice Favorites', privacy: 'private' },
    });
    const shelf2Id = shelf2Res.json().shelf.id;

    // Add WORK_1 to shelf 1
    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelf1Id}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_1, note: 'Must read sci-fi masterwork' },
    });

    // Query Alice's shelves with ?work_id=WORK_1
    const mineRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/mine?work_id=${WORK_1}`,
      headers: authHeader(USER_ALICE),
    });
    expect(mineRes.statusCode).toBe(200);
    const shelvesList = mineRes.json().shelves;
    expect(shelvesList.length).toBeGreaterThanOrEqual(2);

    const s1 = shelvesList.find((s: any) => s.id === shelf1Id);
    expect(s1).toBeDefined();
    expect(s1.contains_work).toBe(true);
    expect(s1.item_note).toBe('Must read sci-fi masterwork');

    const s2 = shelvesList.find((s: any) => s.id === shelf2Id);
    expect(s2).toBeDefined();
    expect(s2.contains_work).toBe(false);
    expect(s2.item_note).toBeNull();
  });

  it('removes item from shelf via DELETE /v1/shelves/:id/items/:workId and enforces ownership', async () => {
    // Alice creates shelf and adds WORK_2
    const shelfRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Removable Items Shelf', privacy: 'public' },
    });
    const shelfId = shelfRes.json().shelf.id;

    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_2 },
    });

    // Bob tries to remove item -> 404 (non-owner)
    const bobRemove = await app.inject({
      method: 'DELETE',
      url: `/v1/shelves/${shelfId}/items/${WORK_2}`,
      headers: authHeader(USER_BOB),
    });
    expect(bobRemove.statusCode).toBe(404);

    // Alice removes item -> 200
    const aliceRemove = await app.inject({
      method: 'DELETE',
      url: `/v1/shelves/${shelfId}/items/${WORK_2}`,
      headers: authHeader(USER_ALICE),
    });
    expect(aliceRemove.statusCode).toBe(200);
    expect(aliceRemove.json()).toEqual({
      deleted: true,
      shelf_id: shelfId,
      work_id: WORK_2,
    });

    // Verifying shelf items count decreased to 0
    const getItems = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
    });
    expect(getItems.json().total).toBe(0);
  });

  it('updates shelf item note and position via PATCH /v1/shelves/:id/items/:workId', async () => {
    // Alice creates shelf and adds WORK_1
    const shelfRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Editable Notes Shelf', privacy: 'public' },
    });
    const shelfId = shelfRes.json().shelf.id;

    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_1, note: 'Initial draft note' },
    });

    // Update note and position
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${shelfId}/items/${WORK_1}`,
      headers: authHeader(USER_ALICE),
      payload: { note: 'Revised note with profound insight', position: 5 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().item.note).toBe('Revised note with profound insight');
    expect(patchRes.json().item.position).toBe(5);

    // Reject note > 280 characters
    const longNoteRes = await app.inject({
      method: 'PATCH',
      url: `/v1/shelves/${shelfId}/items/${WORK_1}`,
      headers: authHeader(USER_ALICE),
      payload: { note: 'A'.repeat(281) },
    });
    expect(longNoteRes.statusCode).toBe(422);
  });

  it('reorders shelf items via PUT /v1/shelves/:id/order and updates mosaic covers (SH-05)', async () => {
    // Alice creates a shelf with 3 works: WORK_1, WORK_2, WORK_3
    const shelfRes = await app.inject({
      method: 'POST',
      url: '/v1/shelves',
      headers: authHeader(USER_ALICE),
      payload: { name: 'Reorderable Sci-Fi', is_ranked: true, privacy: 'public' },
    });
    const shelfId = shelfRes.json().shelf.id;

    // Add WORK_1, WORK_2, WORK_3
    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_1, position: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_2, position: 2 },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
      payload: { work_id: WORK_3, position: 3 },
    });

    // Verify initial covers: [1001, 1002, 1003]
    const initialShelf = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_ALICE),
    });
    expect(initialShelf.json().shelf.cover_ids).toEqual([1001, 1002, 1003]);

    // Bob tries to reorder -> 404 (non-owner)
    const bobReorder = await app.inject({
      method: 'PUT',
      url: `/v1/shelves/${shelfId}/order`,
      headers: authHeader(USER_BOB),
      payload: { work_ids: [WORK_3, WORK_1, WORK_2] },
    });
    expect(bobReorder.statusCode).toBe(404);

    // Reorder with duplicates -> 400
    const dupReorder = await app.inject({
      method: 'PUT',
      url: `/v1/shelves/${shelfId}/order`,
      headers: authHeader(USER_ALICE),
      payload: { work_ids: [WORK_3, WORK_3, WORK_1] },
    });
    expect(dupReorder.statusCode).toBe(400);

    // Alice reorders: WORK_3, WORK_1, WORK_2
    const aliceReorder = await app.inject({
      method: 'PUT',
      url: `/v1/shelves/${shelfId}/order`,
      headers: authHeader(USER_ALICE),
      payload: { work_ids: [WORK_3, WORK_1, WORK_2] },
    });
    expect(aliceReorder.statusCode).toBe(200);
    expect(aliceReorder.json()).toEqual({
      reordered: true,
      shelf_id: shelfId,
      count: 3,
    });

    // Check items returned in new order
    const itemsRes = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}/items`,
      headers: authHeader(USER_ALICE),
    });
    const items = itemsRes.json().data;
    expect(items).toHaveLength(3);
    expect(items[0].work_id).toBe(WORK_3);
    expect(items[0].position).toBe(1);
    expect(items[1].work_id).toBe(WORK_1);
    expect(items[1].position).toBe(2);
    expect(items[2].work_id).toBe(WORK_2);
    expect(items[2].position).toBe(3);

    // Verify cover_ids updated to match new positions: [1003, 1001, 1002]
    const updatedShelf = await app.inject({
      method: 'GET',
      url: `/v1/shelves/${shelfId}`,
      headers: authHeader(USER_ALICE),
    });
    expect(updatedShelf.json().shelf.cover_ids).toEqual([1003, 1001, 1002]);
  });
});
