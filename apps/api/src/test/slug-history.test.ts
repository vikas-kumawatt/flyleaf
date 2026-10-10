// D-11-2 (audit 13, A-11-028): renaming a shelf or changing a username keeps
// share links working, and a freed slug or name never opens someone else's
// content. Old slugs stay with their shelf and old usernames with their
// account; every slug route answers 301 to the current address, but only to
// a viewer who may see the shelf (anyone else gets the random slug's 404).

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { users } from '../db/schema.js';
import { block, follow, interactionHarness, makeUser, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let seq = 0;
const name = (p: string) => `${p}_${++seq}`;
const user = (p: string, opts: { isPrivate?: boolean } = {}) => makeUser(db, name(p), opts);

beforeAll(async () => {
  ({ db, app } = await interactionHarness());
}, 60_000);

/** The three slug routes, each as the path for (username, slug). */
const ROUTES = [
  (u: string, s: string) => `/v1/users/${u}/shelves/slug/${s}`,
  (u: string, s: string) => `/v1/shelves/by-slug/${u}/${s}`,
  (u: string, s: string) => `/u/${u}/shelves/${s}`,
];

async function get(url: string, as?: TestUser) {
  const res = await app.inject({ method: 'GET', url, headers: { ...(as?.auth ?? {}), accept: 'application/json' } });
  return { status: res.statusCode, location: res.headers.location, cache: res.headers['cache-control'], body: res.body };
}

async function createShelf(owner: TestUser, shelfName: string, privacy = 'public') {
  const res = await app.inject({ method: 'POST', url: '/v1/shelves', headers: owner.auth, payload: { name: shelfName, privacy } });
  expect(res.statusCode).toBe(201);
  return res.json().shelf as { id: string; slug: string };
}

async function rename(owner: TestUser, id: string, shelfName: string) {
  const res = await app.inject({ method: 'PATCH', url: `/v1/shelves/${id}`, headers: owner.auth, payload: { name: shelfName } });
  expect(res.statusCode).toBe(200);
  return res.json().shelf as { id: string; slug: string };
}

async function changeUsername(who: TestUser, username: string) {
  return app.inject({ method: 'PATCH', url: '/v1/me/username', headers: who.auth, payload: { username } });
}

describe('shelf slugs (D-11-2)', () => {
  it('a renamed shelf answers its old slug with a 301 to the current one, on every slug route', async () => {
    const o = await user('ren');
    const s = await createShelf(o, 'Summer Reads');
    const r = await rename(o, s.id, 'Beach Books');
    expect(r.slug).toBe('beach-books');
    for (const route of ROUTES) {
      const old = await get(route(o.username, 'summer-reads'));
      expect(old.status).toBe(301);
      expect(old.location).toBe(route(o.username, 'beach-books'));
      expect(old.cache).toBe('no-store');
      expect(old.body).toBe('');
      expect((await get(route(o.username, 'beach-books'))).status).toBe(200);
    }
  });

  it("the owner's next shelf with the old name gets a new slug; the old link still reaches the renamed shelf", async () => {
    const o = await user('nxt');
    const s = await createShelf(o, 'Classics');
    await rename(o, s.id, 'Old Classics');
    const again = await createShelf(o, 'Classics');
    expect(again.slug).toBe('classics-1');
    const old = await get(ROUTES[0]!(o.username, 'classics'));
    expect(old.status).toBe(301);
    expect(old.location).toBe(ROUTES[0]!(o.username, 'old-classics'));
  });

  it('a shelf may take back its own old slug; the slug it leaves redirects to it', async () => {
    const o = await user('back');
    const s = await createShelf(o, 'Alpha');
    await rename(o, s.id, 'Beta');
    const back = await rename(o, s.id, 'Alpha');
    expect(back.slug).toBe('alpha');
    expect((await get(ROUTES[0]!(o.username, 'alpha'))).status).toBe(200);
    const beta = await get(ROUTES[0]!(o.username, 'beta'));
    expect([beta.status, beta.location]).toEqual([301, ROUTES[0]!(o.username, 'alpha')]);
  });

  it("another user's shelf of the same name is unaffected (slugs are per owner)", async () => {
    const [a, b] = [await user('pa'), await user('pb')];
    const s = await createShelf(a, 'Horror');
    await rename(a, s.id, 'Scary');
    const theirs = await createShelf(b, 'Horror');
    expect(theirs.slug).toBe('horror');
    expect((await get(ROUTES[0]!(b.username, 'horror'))).status).toBe(200);
  });

  it('a deleted shelf: current and old slugs are the random 404, and come back on restore', async () => {
    const o = await user('del');
    const s = await createShelf(o, 'First Name');
    await rename(o, s.id, 'Second Name');
    const random = await get(ROUTES[0]!(o.username, 'no-such-shelf'));
    expect(random.status).toBe(404);
    await app.inject({ method: 'DELETE', url: `/v1/shelves/${s.id}`, headers: o.auth });
    for (const slug of ['first-name', 'second-name']) {
      const res = await get(ROUTES[0]!(o.username, slug));
      expect([res.status, res.body]).toEqual([404, random.body]);
    }
    // Still reserved while deleted: a new shelf does not take either slug.
    expect((await createShelf(o, 'First Name')).slug).toBe('first-name-1');
    const restored = await app.inject({ method: 'POST', url: `/v1/shelves/${s.id}/restore`, headers: o.auth });
    expect(restored.statusCode).toBe(200);
    expect((await get(ROUTES[0]!(o.username, 'second-name'))).status).toBe(200);
    expect((await get(ROUTES[0]!(o.username, 'first-name'))).location).toBe(ROUTES[0]!(o.username, 'second-name'));
  });

  it('privacy: an old slug of a shelf the viewer may not see is the random 404, never a redirect', async () => {
    const o = await user('prv');
    const fan = await user('fan');
    const stranger = await user('str');
    const blocked = await user('blk');
    await follow(db, fan.id, o.id);
    await block(db, o.id, blocked.id);
    const priv = await createShelf(o, 'Diary', 'private');
    await rename(o, priv.id, 'Secret Diary');
    const fol = await createShelf(o, 'Friends Only', 'followers');
    await rename(o, fol.id, 'Close Friends');
    const pub = await createShelf(o, 'Open List');
    await rename(o, pub.id, 'Open List Two');
    for (const route of ROUTES) {
      const random = await get(route(o.username, 'nothing-here'));
      for (const [slug, who] of [
        ['diary', undefined], ['diary', stranger], ['diary', fan],
        ['friends-only', undefined], ['friends-only', stranger],
        ['open-list', blocked],
      ] as const) {
        const res = await get(route(o.username, slug), who);
        expect({ slug, who: who?.username, status: res.status, location: res.location, body: res.body })
          .toEqual({ slug, who: who?.username, status: 404, location: undefined, body: random.body });
      }
      expect((await get(route(o.username, 'friends-only'), fan)).status).toBe(301);
      expect((await get(route(o.username, 'diary'), o)).status).toBe(301);
    }
  });
});

describe('usernames (D-11-2)', () => {
  it('PATCH /v1/me/username changes it; links with the old name 301 to the new one in one hop, slug changes included', async () => {
    const o = await user('old');
    const s = await createShelf(o, 'Picks');
    await rename(o, s.id, 'Best Picks');
    const res = await changeUsername(o, `new_${seq}`);
    expect(res.statusCode).toBe(200);
    const fresh = res.json().username as string;
    for (const route of ROUTES) {
      const hop = await get(route(o.username, 'picks'));
      expect([hop.status, hop.location]).toEqual([301, route(fresh, 'best-picks')]);
      const same = await get(route(o.username, 'best-picks'));
      expect([same.status, same.location]).toEqual([301, route(fresh, 'best-picks')]);
      expect((await get(route(fresh, 'best-picks'))).status).toBe(200);
    }
  });

  it('an old username stays with its account: not registrable, not offered, not takeable by a change; its owner may take it back', async () => {
    const o = await user('keep');
    const oldName = o.username;
    expect((await changeUsername(o, `kept_${seq}`)).statusCode).toBe(200);

    const identity = new IdentityService(db, new PgRateLimiter(db));
    await expect(identity.register(`x${seq}@example.com`, oldName, 'a_very_secure_unique_password_123', '1990-01-01'))
      .rejects.toMatchObject({ status: 409, code: 'username_taken' });
    const avail = await app.inject({ method: 'GET', url: `/v1/auth/username-available?username=${oldName}` });
    expect(avail.json()).toMatchObject({ available: false, reason: 'taken' });

    const other = await user('oth');
    const steal = await changeUsername(other, oldName);
    expect(steal.statusCode).toBe(409);
    expect(steal.json().error.code).toBe('username_taken');

    const back = await changeUsername(o, oldName);
    expect(back.statusCode).toBe(200);
    expect(back.json().username).toBe(oldName);
  });

  it('a current username is taken; an invalid one is 422; the same one is a no-op', async () => {
    const [a, b] = [await user('ca'), await user('cb')];
    expect((await changeUsername(a, b.username)).statusCode).toBe(409);
    for (const bad of ['ab', 'has space', 'UPPER!', 'admin', 'x'.repeat(21)]) {
      const res = await changeUsername(a, bad);
      expect({ bad, status: res.statusCode }).toEqual({ bad, status: 422 });
    }
    expect((await changeUsername(a, `  ${a.username.toUpperCase()} `)).json().username).toBe(a.username);
  });

  it("a private or deleted account's old username is the random 404 to anyone who may not see it", async () => {
    const p = await user('hid', { isPrivate: true });
    const fan = await user('hfan');
    await follow(db, fan.id, p.id);
    await createShelf(p, 'Hidden');
    const oldName = p.username;
    await changeUsername(p, `hid2_${seq}`);
    const random = await get(ROUTES[0]!('nobody_here_xyz', 'hidden'));
    expect(random.status).toBe(404);
    for (const who of [undefined, await user('hs')]) {
      const res = await get(ROUTES[0]!(oldName, 'hidden'), who);
      expect([res.status, res.location, res.body]).toEqual([404, undefined, random.body]);
    }
    expect((await get(ROUTES[0]!(oldName, 'hidden'), fan)).status).toBe(301);

    const gone = await user('gone');
    await createShelf(gone, 'Left');
    const goneName = gone.username;
    await changeUsername(gone, `gone2_${seq}`);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, gone.id));
    const res = await get(ROUTES[0]!(goneName, 'left'), fan);
    expect([res.status, res.location, res.body]).toEqual([404, undefined, random.body]);
  });
});
