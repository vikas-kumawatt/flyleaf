// SO-52: onboarding follow suggestions (PRD §6.11, §4.1, §11.6). Ranked by
// genre overlap → favourite overlap → active reviewers → most followed; never
// self, followed, requested, blocked either way, muted, private, deleted,
// banned, unverified or suspended; overlap from public reads only.

import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';

import type { Db } from '../platform/index.js';
import { follows, mutes, profiles, reviews, users, works } from '../db/schema.js';
import { block, interactionHarness, makeRead, makeUser, makeWork, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let seq = 0;
const uname = (p: string) => `${p}_${++seq}`;

beforeAll(async () => {
  ({ db, app } = await interactionHarness());
}, 60_000);

async function suggestions(who: TestUser, limit?: number) {
  const res = await app.inject({ method: 'GET', url: `/v1/me/follow-suggestions${limit ? `?limit=${limit}` : ''}`, headers: who.auth });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().users as Array<{ id: string; username: string; reason: string; favourites: { id: string }[] }>;
}

async function genre(name: string) {
  const [s] = await db.execute<{ id: string }>(sql`
    INSERT INTO subjects (slug, name, kind) VALUES (${name.toLowerCase()}, ${name}, 'genre') RETURNING id`);
  return s!.id;
}

async function workIn(subjectId: string, title: string) {
  const w = await makeWork(db, title);
  await db.execute(sql`INSERT INTO work_subjects (work_id, subject_id) VALUES (${w}::uuid, ${subjectId}::uuid)`);
  return w;
}

describe('SO-52 · who is never suggested', () => {
  it('self, followed, requested, blocked either way, muted, private, deleted, banned, unverified and suspended accounts are absent', async () => {
    const me = await makeUser(db, uname('me'));
    const shared = await makeWork(db, 'Shared Book');
    await makeRead(db, me.id, shared);
    const mk = async (tag: string, opts: { isPrivate?: boolean; verified?: boolean } = {}) => {
      const u = await makeUser(db, uname(tag), opts);
      await makeRead(db, u.id, shared); // every one of them is a co-reader: in the pool
      return u;
    };
    const ok = await mk('ok');
    const followed = await mk('followed');
    const requested = await mk('requested');
    const blockedByMe = await mk('blockedbyme');
    const blockedMe = await mk('blockedme');
    const muted = await mk('muted');
    const priv = await mk('private', { isPrivate: true });
    const deleted = await mk('deleted');
    const banned = await mk('banned');
    const unverified = await mk('unverified', { verified: false });
    const suspended = await mk('suspended');
    await db.insert(follows).values([
      { followerId: me.id, followeeId: followed.id, state: 'accepted' },
      { followerId: me.id, followeeId: requested.id, state: 'pending' },
    ]);
    await block(db, me.id, blockedByMe.id);
    await block(db, blockedMe.id, me.id);
    await db.insert(mutes).values({ userId: me.id, targetType: 'user', targetId: muted.id });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted.id));
    await db.update(users).set({ deletedAt: new Date(), bannedAt: new Date() }).where(eq(users.id, banned.id));
    await db.update(users).set({ suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(users.id, suspended.id));

    const ids = new Set((await suggestions(me, 30)).map((u) => u.id));
    expect(ids.has(ok.id)).toBe(true);
    const absent = { me, followed, requested, blockedByMe, blockedMe, muted, priv, deleted, banned, unverified, suspended };
    for (const [label, u] of Object.entries(absent)) expect(ids.has(u.id), label).toBe(false);

    // A suspension that has ended no longer hides the account.
    await db.update(users).set({ suspendedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, suspended.id));
    expect((await suggestions(me, 30)).some((u) => u.id === suspended.id)).toBe(true);
  });

  it('a guest gets 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me/follow-suggestions' })).statusCode).toBe(401);
  });
});

describe('SO-52 · ranking (PRD §6.11: genre → favourites → active reviewers → most followed)', () => {
  it('orders candidates by genre overlap, then favourite overlap, then recent reviews, then followers', async () => {
    const me = await makeUser(db, uname('ranker'));
    const fantasy = await genre(uname('Fantasy'));
    const mystery = await genre(uname('Mystery'));
    const myFantasy = await workIn(fantasy, 'My Fantasy');
    const myMystery = await workIn(mystery, 'My Mystery');
    const fav = await makeWork(db, 'My Favourite');
    await makeRead(db, me.id, myFantasy);
    await makeRead(db, me.id, myMystery);
    await db.update(profiles).set({ favouriteWorkIds: [fav] }).where(eq(profiles.userId, me.id));

    // Two genres in common (other books in the same genres).
    const twoGenres = await makeUser(db, uname('twogenres'));
    await makeRead(db, twoGenres.id, myFantasy);
    await makeRead(db, twoGenres.id, await workIn(mystery, 'Their Mystery'));
    // One genre, and my favourite as theirs.
    const oneGenreFav = await makeUser(db, uname('onegenrefav'));
    await makeRead(db, oneGenreFav.id, await workIn(fantasy, 'Their Fantasy'));
    await makeRead(db, oneGenreFav.id, myFantasy);
    await db.update(profiles).set({ favouriteWorkIds: [fav] }).where(eq(profiles.userId, oneGenreFav.id));
    // One genre, no favourite.
    const oneGenre = await makeUser(db, uname('onegenre'));
    await makeRead(db, oneGenre.id, myFantasy);
    // No overlap, but an active reviewer.
    const reviewer = await makeUser(db, uname('reviewer'));
    const rw = await makeWork(db, 'Reviewed elsewhere');
    const rr = await makeRead(db, reviewer.id, rw);
    await db.insert(reviews).values({ readId: rr, userId: reviewer.id, workId: rw, body: 'A recent public review.' });
    // No overlap, no reviews, but followed by many.
    const popular = await makeUser(db, uname('popular'));
    await db.update(profiles).set({ followerCount: 1_000_000 }).where(eq(profiles.userId, popular.id));

    const list = await suggestions(me, 30);
    const order = [twoGenres, oneGenreFav, oneGenre, reviewer, popular].map((u) => list.findIndex((x) => x.id === u.id));
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const reason = (u: TestUser) => list.find((x) => x.id === u.id)!.reason;
    expect(reason(twoGenres)).toBe('genres');
    expect(reason(oneGenreFav)).toBe('favourites');
    expect(reason(reviewer)).toBe('reviewer');
    expect(reason(popular)).toBe('popular');
    // The card carries their favourites (never an explicit book).
    expect(list.find((x) => x.id === oneGenreFav.id)!.favourites.map((f) => f.id)).toEqual([fav]);
  });

  it('a private or followers-only read never makes someone a match', async () => {
    const me = await makeUser(db, uname('privacy'));
    const g = await genre(uname('Horror'));
    const mine = await workIn(g, 'My Horror');
    await makeRead(db, me.id, mine);
    const quiet = await makeUser(db, uname('quiet'));
    await makeRead(db, quiet.id, mine, { visibility: 'private' });
    await makeRead(db, quiet.id, await workIn(g, 'Their Horror'), { visibility: 'followers' });
    await db.update(profiles).set({ followerCount: 1_000_000 }).where(eq(profiles.userId, quiet.id));
    const found = (await suggestions(me, 30)).find((u) => u.id === quiet.id);
    // Reached only as a most-followed account, with no overlap counted.
    expect(found?.reason).toBe('popular');
  });

  it('an explicit favourite is left off the card; the limit is honoured, 15 by default', async () => {
    const me = await makeUser(db, uname('limits'));
    const x = await makeWork(db, 'Explicit Fav');
    await db.update(works).set({ maturity: 'explicit' }).where(eq(works.id, x));
    const u = await makeUser(db, uname('explicitfav'));
    await db.update(profiles).set({ favouriteWorkIds: [x], followerCount: 2_000_000 }).where(eq(profiles.userId, u.id));
    const list = await suggestions(me, 30);
    expect(list.find((s) => s.id === u.id)!.favourites).toEqual([]);
    for (let i = 0; i < 16; i++) await makeUser(db, uname('filler'));
    expect((await suggestions(me)).length).toBe(15);
    expect((await suggestions(me, 3)).length).toBe(3);
    expect((await app.inject({ method: 'GET', url: '/v1/me/follow-suggestions?limit=31', headers: me.auth })).statusCode).toBe(422);
  });
});
