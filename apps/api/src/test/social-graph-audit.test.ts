// Audit 13 — social graph (SO-01 … SO-06). The follow state machine, block
// and mute edge cases, list paging, aliases and counters. Each test names the
// finding it covers in docs/audit/findings/13-social-graph.md.
//
// Concurrency (A-13-001's lost updates and deadlocks, A-13-006's follow/block
// race) cannot be reproduced on PGlite, which has one connection: the
// evidence for those is `src/bench/social-graph.ts --race` on Postgres.

import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activity, blocks, follows, mutes, profiles, users } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { QUEUES, reconcileFollowsJobHandler } from '../jobs/index.js';
import { block, follow, interactionHarness, makeUser, makeWork, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let seq = 0;
const name = (p: string) => `${p}${++seq}`.slice(0, 20);
const user = (p: string, opts: { isPrivate?: boolean } = {}) => makeUser(db, name(p), opts);

beforeAll(async () => {
  ({ db, app } = await interactionHarness());
}, 60_000);

async function call(method: string, url: string, as?: TestUser) {
  const res = await app.inject({ method: method as 'GET', url, headers: as ? as.auth : {} });
  return { status: res.statusCode, body: res.body, json: () => res.json() };
}

async function counts(id: string) {
  const [p] = await db.select({ followers: profiles.followerCount, following: profiles.followingCount })
    .from(profiles).where(eq(profiles.userId, id));
  return p!;
}

async function followedCards(actor: string, object: string) {
  return db.select().from(activity).where(and(
    eq(activity.actorId, actor), eq(activity.verb, 'followed'), eq(activity.objectId, object)));
}

async function edge(a: string, b: string) {
  const [f] = await db.select().from(follows).where(and(eq(follows.followerId, a), eq(follows.followeeId, b)));
  return f?.state ?? 'none';
}

const softDelete = (id: string) => db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));

// ---------------------------------------------------------------------------
describe('SO-02 follow state machine', () => {
  it('public: none → accepted; following again is idempotent (one row, one card, counted once)', async () => {
    const [a, b] = [await user('fa'), await user('fb')];
    const r1 = await call('POST', `/v1/users/${b.id}/follow`, a);
    expect(r1.status).toBe(200);
    expect(r1.json().status).toBe('accepted');
    const r2 = await call('POST', `/v1/users/${b.id}/follow`, a);
    expect(r2.json().status).toBe('accepted');
    expect(await counts(b.id)).toEqual({ followers: 1, following: 0 });
    expect(await counts(a.id)).toEqual({ followers: 0, following: 1 });
    expect(await followedCards(a.id, b.id)).toHaveLength(1);
  });

  it('two follows submitted together write one card (A-13-006)', async () => {
    const [a, b] = [await user('da'), await user('db')];
    const [r1, r2] = await Promise.all([
      call('POST', `/v1/users/${b.id}/follow`, a),
      call('POST', `/v1/users/${b.id}/follow`, a),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await followedCards(a.id, b.id)).toHaveLength(1);
    expect((await counts(b.id)).followers).toBe(1);
  });

  it('private: none → pending (not counted, no card); requesting again stays pending', async () => {
    const [a, p] = [await user('pa'), await user('pp', { isPrivate: true })];
    expect((await call('POST', `/v1/users/${p.id}/follow`, a)).json().status).toBe('pending');
    expect((await call('POST', `/v1/users/${p.id}/follow`, a)).json().status).toBe('pending');
    expect(await counts(p.id)).toEqual({ followers: 0, following: 0 });
    expect(await followedCards(a.id, p.id)).toHaveLength(0);
    const reqs = (await call('GET', '/v1/me/follow-requests', p)).json().requests;
    expect(reqs.map((r: { id: string }) => r.id)).toEqual([a.id]);
  });

  it('cancelling a pending request (DELETE) removes it; accepting it afterwards is the random requester 404', async () => {
    const [a, p] = [await user('ca'), await user('cp', { isPrivate: true })];
    await call('POST', `/v1/users/${p.id}/follow`, a);
    const del = await call('DELETE', `/v1/users/${p.id}/follow`, a);
    expect(del.json().status).toBe('none');
    expect(await edge(a.id, p.id)).toBe('none');
    const late = await call('POST', `/v1/me/follow-requests/${a.id}/accept`, p);
    const random = await call('POST', `/v1/me/follow-requests/${randomUUID()}/accept`, p);
    expect(late.status).toBe(404);
    expect(late.body).toBe(random.body);
    expect(await counts(p.id)).toEqual({ followers: 0, following: 0 });
  });

  it('accepting: pending → accepted, counted on both sides; unfollowing: → none, uncounted, card gone', async () => {
    const [a, p] = [await user('aa'), await user('ap', { isPrivate: true })];
    await call('POST', `/v1/users/${p.id}/follow`, a);
    const acc = await call('POST', `/v1/me/follow-requests/${a.id}/accept`, p);
    expect(acc.json()).toMatchObject({ status: 'accepted', follower_id: a.id, followee_id: p.id });
    expect(await counts(p.id)).toEqual({ followers: 1, following: 0 });
    expect(await counts(a.id)).toEqual({ followers: 0, following: 1 });
    // D-13-1 decided (owner, 2026-10-10, built in Part 14): a single accept writes the requester's card.
    expect(await followedCards(a.id, p.id)).toHaveLength(1);
    expect((await call('DELETE', `/v1/users/${p.id}/follow`, a)).json().status).toBe('none');
    expect(await counts(p.id)).toEqual({ followers: 0, following: 0 });
  });

  it('rejecting removes the request; the requester may ask again at once (A-13-008, RL)', async () => {
    const [a, p] = [await user('ra'), await user('rp', { isPrivate: true })];
    await call('POST', `/v1/users/${p.id}/follow`, a);
    expect((await call('POST', `/v1/me/follow-requests/${a.id}/reject`, p)).json().status).toBe('none');
    expect(await edge(a.id, p.id)).toBe('none');
    expect((await call('POST', `/v1/users/${p.id}/follow`, a)).json().status).toBe('pending');
  });

  it('accepting a request from an account deleted since is the random requester 404 (A-13-011)', async () => {
    const [a, p] = [await user('xa'), await user('xp', { isPrivate: true })];
    await call('POST', `/v1/users/${p.id}/follow`, a);
    await softDelete(a.id);
    expect((await call('GET', '/v1/me/follow-requests', p)).json().requests).toEqual([]);
    const res = await call('POST', `/v1/me/follow-requests/${a.id}/accept`, p);
    const random = await call('POST', `/v1/me/follow-requests/${randomUUID()}/accept`, p);
    expect(res.status).toBe(404);
    expect(res.body).toBe(random.body);
    expect(await edge(a.id, p.id)).toBe('pending');
  });

  it('following yourself is 400', async () => {
    const a = await user('sa');
    const res = await call('POST', `/v1/users/${a.id}/follow`, a);
    expect(res.status).toBe(400);
    expect(res.json().error.code).toBe('cannot_follow_self');
  });

  it('follow, unfollow and mute of a user who blocked you, whom you blocked, or who is deleted: the random-id 404 (A-13-005)', async () => {
    const v = await user('bv');
    const blocker = await user('bb');
    const blocked = await user('bd');
    const gone = await user('bg');
    await follow(db, v.id, blocker.id);
    await block(db, blocker.id, v.id); // as an old block that predates the follow sever
    await block(db, v.id, blocked.id);
    await softDelete(gone.id);
    for (const [method, path] of [
      ['POST', 'follow'], ['DELETE', 'follow'], ['POST', 'mute'],
    ] as const) {
      const random = await call(method, `/v1/users/${randomUUID()}/${path}`, v);
      expect(random.status).toBe(404);
      for (const t of [blocker, blocked, gone]) {
        const res = await call(method, `/v1/users/${t.id}/${path}`, v);
        expect({ who: t.username, path, method, status: res.status, body: res.body })
          .toEqual({ who: t.username, path, method, status: 404, body: random.body });
      }
    }
    expect(await db.select().from(mutes).where(eq(mutes.userId, v.id))).toHaveLength(0);
  });

  it('blocking a user who has blocked you is the random-id 404; blocking someone you blocked stays idempotent (A-13-005)', async () => {
    const [v, them] = [await user('kv'), await user('kt')];
    await block(db, them.id, v.id);
    const res = await call('POST', `/v1/users/${them.id}/block`, v);
    const random = await call('POST', `/v1/users/${randomUUID()}/block`, v);
    expect(res.status).toBe(404);
    expect(res.body).toBe(random.body);
    const mine = await user('km');
    expect((await call('POST', `/v1/users/${mine.id}/block`, v)).status).toBe(200);
    expect((await call('POST', `/v1/users/${mine.id}/block`, v)).status).toBe(200);
    expect(await db.select().from(blocks).where(eq(blocks.blockerId, v.id))).toHaveLength(1);
  });

  it('going public accepts pending requests and counts them; going private keeps followers and makes new follows requests', async () => {
    const p = await user('gp', { isPrivate: true });
    const [a, b] = [await user('ga'), await user('gb')];
    await call('POST', `/v1/users/${p.id}/follow`, a);
    await call('POST', `/v1/users/${p.id}/follow`, b);
    const pub = await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: p.auth, payload: { isPrivate: false } });
    expect(pub.statusCode).toBe(200);
    expect([await edge(a.id, p.id), await edge(b.id, p.id)]).toEqual(['accepted', 'accepted']);
    expect(await counts(p.id)).toEqual({ followers: 2, following: 0 });
    // No burst of cards: requests accepted in bulk write none (D-13-1; a single accept writes one).
    expect([...await followedCards(a.id, p.id), ...await followedCards(b.id, p.id)]).toHaveLength(0);

    // While public, p's own follow card is public ...
    const q = await user('gq');
    await call('POST', `/v1/users/${q.id}/follow`, p);
    expect((await followedCards(p.id, q.id))[0]?.visibility).toBe('public');

    await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: p.auth, payload: { isPrivate: true } });
    expect([await edge(a.id, p.id), await edge(b.id, p.id)]).toEqual(['accepted', 'accepted']);
    // ... and going private narrows it to followers retroactively (§16.3, SO-10).
    expect((await followedCards(p.id, q.id))[0]?.visibility).toBe('followers');
    const c = await user('gc');
    expect((await call('POST', `/v1/users/${p.id}/follow`, c)).json().status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
describe('SO-03 block', () => {
  it('severs accepted follows and pending requests in both directions, with counters (§11.4)', async () => {
    const v = await user('sv', { isPrivate: true });
    const t = await user('st', { isPrivate: true });
    await follow(db, v.id, t.id);
    await db.insert(follows).values({ followerId: t.id, followeeId: v.id, state: 'pending' });
    expect(await counts(t.id)).toEqual({ followers: 1, following: 0 });
    expect((await call('POST', `/v1/users/${t.id}/block`, v)).status).toBe(200);
    expect([await edge(v.id, t.id), await edge(t.id, v.id)]).toEqual(['none', 'none']);
    expect(await counts(t.id)).toEqual({ followers: 0, following: 0 });
    expect(await counts(v.id)).toEqual({ followers: 0, following: 0 });
    expect((await call('GET', '/v1/me/follow-requests', v)).json().requests).toEqual([]);
  });

  it("removes the pair's 'followed' cards in both directions, as an unfollow does (A-13-004)", async () => {
    const [v, t] = [await user('cv'), await user('ct')];
    await call('POST', `/v1/users/${t.id}/follow`, v);
    await call('POST', `/v1/users/${v.id}/follow`, t);
    expect(await followedCards(v.id, t.id)).toHaveLength(1);
    expect(await followedCards(t.id, v.id)).toHaveLength(1);
    await call('POST', `/v1/users/${t.id}/block`, v);
    expect(await followedCards(v.id, t.id)).toHaveLength(0);
    expect(await followedCards(t.id, v.id)).toHaveLength(0);
  });

  it('unblock is idempotent and restores no follow; a mute survives a block and an unblock', async () => {
    const [v, t] = [await user('uv'), await user('ut')];
    await call('POST', `/v1/users/${t.id}/follow`, v);
    await call('POST', `/v1/users/${t.id}/mute`, v);
    await call('POST', `/v1/users/${t.id}/block`, v);
    expect((await call('DELETE', `/v1/users/${t.id}/block`, v)).status).toBe(200);
    expect((await call('DELETE', `/v1/users/${t.id}/block`, v)).status).toBe(200);
    expect(await edge(v.id, t.id)).toBe('none');
    expect(await db.select().from(mutes).where(eq(mutes.userId, v.id))).toHaveLength(1);
  });

  it('GET /v1/me/blocks lists only your own blocks, never who blocked you, and no deleted account (A-13-011)', async () => {
    const v = await user('lv');
    const [mine, gone, theirs] = [await user('lm'), await user('lg'), await user('lt')];
    await block(db, v.id, mine.id);
    await block(db, v.id, gone.id);
    await block(db, theirs.id, v.id);
    await softDelete(gone.id);
    const list = (await call('GET', '/v1/me/blocks', v)).json().blocks;
    expect(list.map((b: { id: string }) => b.id)).toEqual([mine.id]);
  });
});

// ---------------------------------------------------------------------------
describe('SO-04 mute', () => {
  it('a user mute is idempotent, a random user or work makes no row, self is 400', async () => {
    const [v, t] = [await user('mv'), await user('mt')];
    expect((await call('POST', `/v1/users/${t.id}/mute`, v)).status).toBe(200);
    expect((await call('POST', `/v1/users/${t.id}/mute`, v)).status).toBe(200);
    expect((await call('POST', `/v1/users/${randomUUID()}/mute`, v)).status).toBe(404);
    expect((await call('POST', `/v1/works/${randomUUID()}/mute`, v)).status).toBe(404);
    expect((await call('POST', `/v1/users/${v.id}/mute`, v)).status).toBe(400);
    expect(await db.select().from(mutes).where(eq(mutes.userId, v.id))).toHaveLength(1);
  });

  it('unmuting removes the mute row, for a user and a work (A-13-014: the old tests passed with the delete removed)', async () => {
    const [v, t] = [await user('nv'), await user('nt')];
    const w = await makeWork(db, 'Unmuted Book');
    await call('POST', `/v1/users/${t.id}/mute`, v);
    await call('POST', `/v1/works/${w}/mute`, v);
    expect((await call('DELETE', `/v1/users/${t.id}/mute`, v)).json().status).toBe('unmuted');
    expect((await call('DELETE', `/v1/works/${w}/mute`, v)).json().status).toBe('unmuted');
    expect(await db.select().from(mutes).where(eq(mutes.userId, v.id))).toHaveLength(0);
  });

  it('is silent: the muted user sees the same profile, counts and lists as before', async () => {
    const [v, t] = [await user('qv'), await user('qt')];
    await follow(db, v.id, t.id);
    await follow(db, t.id, v.id);
    const before = await Promise.all(['', '/followers', '/following'].map((p) => call('GET', `/v1/users/${v.id}${p}`, t)));
    await call('POST', `/v1/users/${t.id}/mute`, v);
    const after = await Promise.all(['', '/followers', '/following'].map((p) => call('GET', `/v1/users/${v.id}${p}`, t)));
    expect(after.map((r) => r.body)).toEqual(before.map((r) => r.body));
    expect(await edge(v.id, t.id)).toBe('accepted');
  });

  it('GET /v1/me/mutes leaves out deleted accounts (A-13-011)', async () => {
    const [v, t, gone] = [await user('ov'), await user('ot'), await user('og')];
    await call('POST', `/v1/users/${t.id}/mute`, v);
    await call('POST', `/v1/users/${gone.id}/mute`, v);
    const w = await makeWork(db, 'Muted Book');
    await call('POST', `/v1/works/${w}/mute`, v);
    await softDelete(gone.id);
    const res = (await call('GET', '/v1/me/mutes', v)).json();
    expect(res.users.map((u: { id: string }) => u.id)).toEqual([t.id]);
    expect(res.works.map((x: { id: string }) => x.id)).toEqual([w]);
  });
});

// ---------------------------------------------------------------------------
describe('SO-05 lists', () => {
  it('pages are newest first with an id tie-break: every follower exactly once, none twice', async () => {
    const star = await user('ls');
    const fans: TestUser[] = [];
    for (let i = 0; i < 7; i++) fans.push(await user('lf'));
    for (const f of fans) await follow(db, f.id, star.id);
    // Five follows in the same instant: order must still be total.
    await db.execute(sql`UPDATE follows SET created_at = '2026-01-01T00:00:00Z' WHERE followee_id = ${star.id}::uuid AND follower_id = ANY(${'{' + fans.slice(0, 5).map((f) => f.id).join(',') + '}'}::uuid[])`);
    const pages: string[][] = [];
    for (let offset = 0; offset < 8; offset += 2) {
      const res = (await call('GET', `/v1/users/${star.id}/followers?limit=2&offset=${offset}`)).json();
      expect(res.total).toBe(7);
      pages.push(res.users.map((u: { id: string }) => u.id));
    }
    const all = pages.flat();
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
    const tied = fans.slice(0, 5).map((f) => f.id).sort().reverse();
    expect(all.slice(2)).toEqual(tied);
  });

  it('pending followers, deleted accounts and anyone blocked either way with the viewer are left out of the page and the total (A-13-011)', async () => {
    const star = await user('ps');
    const v = await user('pv');
    const [ok, pend, gone, iBlocked, blockedMe] = [await user('po'), await user('pn'), await user('pg'), await user('pi'), await user('pb')];
    for (const f of [ok, gone, iBlocked, blockedMe]) await follow(db, f.id, star.id);
    await db.insert(follows).values({ followerId: pend.id, followeeId: star.id, state: 'pending' });
    await softDelete(gone.id);
    await block(db, v.id, iBlocked.id);
    await block(db, blockedMe.id, v.id);
    const res = (await call('GET', `/v1/users/${star.id}/followers`, v)).json();
    expect(res.users.map((u: { id: string }) => u.id)).toEqual([ok.id]);
    expect(res.total).toBe(1);
    const guest = (await call('GET', `/v1/users/${star.id}/followers`)).json();
    expect(guest.users.map((u: { id: string }) => u.id).sort()).toEqual([ok.id, iBlocked.id, blockedMe.id].sort());
    expect(guest.total).toBe(3);
  });

  it("followedByViewer / followsViewer are the viewer's own edges; the viewer's own row has both false", async () => {
    const star = await user('is');
    const v = await user('iv');
    const [mutual, one, other] = [await user('im'), await user('io'), await user('it')];
    for (const f of [mutual, one, other, v]) await follow(db, f.id, star.id);
    await follow(db, v.id, mutual.id);
    await follow(db, mutual.id, v.id);
    await follow(db, v.id, one.id);
    const res = (await call('GET', `/v1/users/${star.id}/followers`, v)).json();
    const by = Object.fromEntries(res.users.map((u: { id: string; followedByViewer: boolean; followsViewer: boolean }) => [u.id, [u.followedByViewer, u.followsViewer]]));
    expect(by[mutual.id]).toEqual([true, true]);
    expect(by[one.id]).toEqual([true, false]);
    expect(by[other.id]).toEqual([false, false]);
    expect(by[v.id]).toEqual([false, false]);
  });

  it("a private account's lists are the random-id 404 to guests, strangers and requesters; its followers see them", async () => {
    const p = await user('vp', { isPrivate: true });
    const [stranger, pending, fan] = [await user('vs'), await user('vq'), await user('vf')];
    await db.insert(follows).values({ followerId: pending.id, followeeId: p.id, state: 'pending' });
    await follow(db, fan.id, p.id);
    for (const list of ['followers', 'following']) {
      for (const who of [undefined, stranger, pending]) {
        const res = await call('GET', `/v1/users/${p.id}/${list}`, who);
        const random = await call('GET', `/v1/users/${randomUUID()}/${list}`, who);
        expect(res.status).toBe(404);
        expect(res.body).toBe(random.body);
      }
      expect((await call('GET', `/v1/users/${p.id}/${list}`, fan)).status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
describe('aliases answer exactly as the canonical routes (A-13-009)', () => {
  it('lists, 404s and paging', async () => {
    const pub = await user('ap');
    const priv = await user('aq', { isPrivate: true });
    const v = await user('av');
    const fans = [await user('af'), await user('ag'), await user('ah')];
    for (const f of fans) await follow(db, f.id, pub.id);
    await follow(db, pub.id, fans[0]!.id);
    const random = randomUUID();
    for (const id of [pub.id, priv.id, random]) {
      for (const qs of ['', '?limit=2&offset=1', '?limit=0', '?offset=-1']) {
        for (const as of [undefined, v]) {
          const [a1, b1] = [await call('GET', `/v1/users/${id}/followers${qs}`, as), await call('GET', `/v1/followers/${id}${qs}`, as)];
          const [a2, b2] = [await call('GET', `/v1/users/${id}/following${qs}`, as), await call('GET', `/v1/following/${id}${qs}`, as)];
          expect([b1.status, b1.body]).toEqual([a1.status, a1.body]);
          expect([b2.status, b2.body]).toEqual([a2.status, a2.body]);
        }
      }
    }
  });

  it('writes: follow, unfollow, block, mute through an alias behave the same', async () => {
    const v = await user('wv');
    const [t1, t2] = [await user('wa'), await user('wb')];
    const r1 = await call('POST', `/v1/follows/${t1.id}`, v);
    const r2 = await call('POST', `/v1/users/${t2.id}/follow`, v);
    expect(r1.json().status).toBe(r2.json().status);
    expect((await call('DELETE', `/v1/follows/${t1.id}`, v)).json().status).toBe('none');
    const bogus = randomUUID();
    for (const [alias, canon] of [
      [`/v1/follows/${bogus}`, `/v1/users/${bogus}/follow`],
      [`/v1/blocks/${bogus}`, `/v1/users/${bogus}/block`],
      [`/v1/mutes/users/${bogus}`, `/v1/users/${bogus}/mute`],
      [`/v1/mutes/works/${bogus}`, `/v1/works/${bogus}/mute`],
    ]) {
      const [a, c] = [await call('POST', alias!, v), await call('POST', canon!, v)];
      expect([a.status, a.body]).toEqual([c.status, c.body]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('SO-01 counters', () => {
  it('follow and unfollow counters follow every state transition, and nothing else', async () => {
    const [a, b] = [await user('ta'), await user('tb')];
    await db.insert(follows).values({ followerId: a.id, followeeId: b.id, state: 'pending' });
    expect(await counts(b.id)).toEqual({ followers: 0, following: 0 });
    await db.update(follows).set({ state: 'accepted' }).where(eq(follows.followerId, a.id));
    expect(await counts(b.id)).toEqual({ followers: 1, following: 0 });
    expect(await counts(a.id)).toEqual({ followers: 0, following: 1 });
    // A no-op update (accepted → accepted) changes nothing.
    await db.update(follows).set({ state: 'accepted' }).where(eq(follows.followerId, a.id));
    expect(await counts(b.id)).toEqual({ followers: 1, following: 0 });
    await db.update(follows).set({ state: 'pending' }).where(eq(follows.followerId, a.id));
    expect(await counts(b.id)).toEqual({ followers: 0, following: 0 });
    await db.delete(follows).where(eq(follows.followerId, a.id));
    expect(await counts(a.id)).toEqual({ followers: 0, following: 0 });
  });

  it('reconcile_follow_counters() repairs drift, touches only drifted rows, and reports how many (A-13-002)', async () => {
    const [a, b, c] = [await user('ra'), await user('rb'), await user('rc')];
    await follow(db, a.id, b.id);
    await follow(db, c.id, b.id);
    // Settle anything earlier tests left behind, then drift one profile.
    await db.execute(sql`SELECT reconcile_follow_counters()`);
    await db.update(profiles).set({ followerCount: 40 }).where(eq(profiles.userId, b.id));
    const [{ xmin: before }] = await db.execute<{ xmin: string }>(sql`SELECT xmin::text FROM profiles WHERE user_id = ${a.id}::uuid`) as unknown as [{ xmin: string }];

    const result = await reconcileFollowsJobHandler([{ id: '1', name: QUEUES.reconcileFollows, data: undefined }] as never, db);
    expect(result).toMatchObject({ reconciled: true, corrected: 1 });
    expect(await counts(b.id)).toEqual({ followers: 2, following: 0 });
    const [{ xmin: after }] = await db.execute<{ xmin: string }>(sql`SELECT xmin::text FROM profiles WHERE user_id = ${a.id}::uuid`) as unknown as [{ xmin: string }];
    expect(after).toBe(before);

    const again = await db.execute<{ n: number }>(sql`SELECT reconcile_follow_counters() AS n`);
    expect(Number(again[0]!.n)).toBe(0);
  });
});
