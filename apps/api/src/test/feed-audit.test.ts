// Audit 14 — feed (SO-10 … SO-15). Pagination exactly-once, affinity, the
// 180-day prune, cold-start blending across pages, followed-card privacy,
// D-13-1 and the lifecycle of activity rows. Each test names the finding it
// covers in docs/audit/findings/14-feed.md.

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activity, follows, mutes, readComments, readLikes, users } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { QUEUES, pruneActivityJobHandler } from '../jobs/index.js';
import { rankAndDiversifyFeed, rankWindow } from '../activity/ranking.js';
import type { FeedActivityItem } from '../activity/index.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { freshDrizzle } from './pg.js';
import { block, follow, makeRead, makeUser, makeWork, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let seq = 0;
const name = (p: string) => `${p}${++seq}`.slice(0, 20);
const user = (p: string, opts: { isPrivate?: boolean } = {}) => makeUser(db, name(p), opts);

beforeAll(async () => {
  ({ db } = await freshDrizzle());
  app = await buildApp({ db, identity: new IdentityService(db, unlimited), reading: new ReadingService(db), limiter: unlimited });
  await app.ready();
}, 60_000);

const HOUR = 3_600_000;
const NIL = '00000000-0000-0000-0000-000000000000';

async function feed(as: TestUser | null, query: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/feed?${query}`, headers: as ? as.auth : {} });
  return { status: res.statusCode, body: res.json() as any };
}

/** Every activity id a card stands for: its own, or each id it aggregates. */
function idsOf(item: any): string[] {
  return Array.isArray(item.metadata?.activity_ids) ? item.metadata.activity_ids : [item.id];
}

/** Walks a feed to its end, returning every page. */
async function walk(as: TestUser | null, query: string) {
  const pages: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const { status, body } = await feed(as, `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(status).toBe(200);
    pages.push(body);
    if (!body.has_more) {
      expect(body.next_cursor).toBeNull();
      return pages;
    }
    expect(typeof body.next_cursor).toBe('string');
    cursor = body.next_cursor;
  }
  throw new Error('feed never ended');
}

interface Row {
  actorId: string;
  verb: string;
  workId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  metadata?: Record<string, unknown>;
  visibility?: string;
  createdAt: Date;
}

async function insertActivity(rows: Row[]): Promise<string[]> {
  const out = await db.insert(activity).values(rows.map((r) => ({
    actorId: r.actorId,
    verb: r.verb,
    workId: r.workId ?? null,
    objectType: r.objectType ?? null,
    objectId: r.objectId ?? null,
    metadata: r.metadata ?? {},
    visibility: r.visibility ?? 'public',
    createdAt: r.createdAt,
  }))).returning({ id: activity.id });
  return out.map((r) => r.id);
}

/**
 * A mixed stream of `n` activities by `actors`, newest first from `start`,
 * every verb the feed shows (aggregatable ones included) and pairs of rows
 * that share a timestamp, so the cursor has ties to break.
 */
async function mixedStream(actors: TestUser[], works: string[], n: number, start = Date.now() - 60_000) {
  const shelves = [randomUUID(), randomUUID()];
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const actor = actors[(i * 7) % actors.length]!;
    const work = works[i % works.length]!;
    const at = new Date(start - Math.floor(i / 2) * 9 * 60_000); // pairs share a timestamp
    const kind = i % 6;
    if (kind === 0) rows.push({ actorId: actor.id, verb: 'reviewed', workId: work, objectType: 'review', objectId: randomUUID(), metadata: { snippet: 'x' }, createdAt: at });
    else if (kind === 1) rows.push({ actorId: actor.id, verb: 'finished', workId: work, objectType: 'read', objectId: randomUUID(), metadata: { rating: 4 }, createdAt: at });
    else if (kind === 2) rows.push({ actorId: actor.id, verb: 'shelved', workId: work, objectType: 'shelf_item', objectId: shelves[i % 2]!, metadata: { shelfId: shelves[i % 2], shelfName: `Shelf ${i % 2}` }, createdAt: at });
    else if (kind === 3) rows.push({ actorId: actor.id, verb: 'started', workId: work, objectType: 'read', objectId: randomUUID(), createdAt: at });
    else if (kind === 4) rows.push({ actorId: actor.id, verb: 'dnf', workId: work, objectType: 'read', objectId: randomUUID(), createdAt: at });
    else rows.push({ actorId: actor.id, verb: 'followed', objectType: 'user', objectId: actors[(i + 1) % actors.length]!.id, metadata: { followeeId: actors[(i + 1) % actors.length]!.id }, createdAt: at });
  }
  return insertActivity(rows);
}

// ---------------------------------------------------------------------------
describe('A-14-001: cursor pagination serves every eligible activity exactly once', () => {
  let viewer: TestUser;
  let expected: string[];

  beforeAll(async () => {
    viewer = await user('pv');
    const actors: TestUser[] = [];
    for (let i = 0; i < 12; i++) {
      const a = await user(`pa${i}`);
      actors.push(a);
      await follow(db, viewer.id, a.id);
    }
    const works: string[] = [];
    for (let i = 0; i < 15; i++) works.push(await makeWork(db, `Paged ${i}`));
    expected = await mixedStream(actors, works, 200);
  }, 60_000);

  for (const limit of [20, 7]) {
    it(`walks a 200-activity friends feed at limit ${limit}: each id once, none missing`, async () => {
      const pages = await walk(viewer, `tab=friends&limit=${limit}`);
      const seen = pages.flatMap((p) => p.items.flatMap(idsOf));
      expect(seen.length).toBe(new Set(seen).size); // no repeats
      expect([...seen].sort()).toEqual([...expected].sort()); // nothing lost
      for (const p of pages) expect(p.items.length).toBeLessThanOrEqual(limit);
      // A visible end (§12.6), never an editorial card on a later page.
      expect(pages.flatMap((p) => p.items).some((i: any) => i.metadata?.is_editorial)).toBe(false);
    });
  }

  it('the same request twice gives the same order (deterministic ranking)', async () => {
    const a = await feed(viewer, 'tab=friends&limit=20');
    const b = await feed(viewer, 'tab=friends&limit=20');
    expect(b.body.items.map((i: any) => i.id)).toEqual(a.body.items.map((i: any) => i.id));
    expect(b.body.next_cursor).toBe(a.body.next_cursor);
  });

  it('walks the popular feed exactly once too (guest)', async () => {
    const pages = await walk(null, 'tab=popular&limit=20');
    const seen = pages.flatMap((p) => p.items.flatMap(idsOf));
    expect(seen.length).toBe(new Set(seen).size);
    for (const id of expected) expect(seen).toContain(id);
  });

  it('a malformed cursor is 400 invalid_cursor, not page 1 again', async () => {
    for (const bad of ['not-a-cursor', '2026-13-45T00:00:00Z', 'eyJ0IjoxfQ']) {
      const res = await feed(viewer, `tab=friends&cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_cursor');
    }
  });
});

// ---------------------------------------------------------------------------
describe('A-14-002: affinity is computed and the low-affinity rule works', () => {
  it('a reader the viewer never engages with gets a card in the first 10', async () => {
    const viewer = await user('av');
    const engaged: TestUser[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await user(`ae${i}`);
      engaged.push(a);
      await follow(db, viewer.id, a.id);
      // The viewer likes and comments on this reader's finishes.
      for (let k = 0; k < 3; k++) {
        const read = await makeRead(db, a.id, await makeWork(db, `Liked ${i}-${k}`));
        await db.insert(readLikes).values({ readId: read, userId: viewer.id });
        if (k === 0) await db.insert(readComments).values({ readId: read, userId: viewer.id, body: 'lovely' });
      }
    }
    const rare = await user('ar');
    await follow(db, viewer.id, rare.id);

    const now = Date.now();
    const rows: Row[] = [];
    for (let i = 0; i < 18; i++) {
      rows.push({ actorId: engaged[i % 5]!.id, verb: 'reviewed', workId: await makeWork(db, `R${i}`), objectType: 'review', objectId: randomUUID(), createdAt: new Date(now - i * 60_000) });
    }
    // The rare reader's cards are older and lower-weight: without affinity they sort last.
    rows.push({ actorId: rare.id, verb: 'dnf', workId: await makeWork(db, 'Rare 1'), objectType: 'read', objectId: randomUUID(), createdAt: new Date(now - 30 * 60_000) });
    rows.push({ actorId: rare.id, verb: 'dnf', workId: await makeWork(db, 'Rare 2'), objectType: 'read', objectId: randomUUID(), createdAt: new Date(now - 31 * 60_000) });
    await insertActivity(rows);

    const { body } = await feed(viewer, 'tab=friends&limit=20');
    expect(body.items).toHaveLength(20);
    expect(body.items.slice(0, 10).some((i: any) => i.actor_id === rare.id)).toBe(true);
  });

  it('engaged and mutual readers outrank a stranger-like follow at equal weight and age', async () => {
    const viewer = await user('mv');
    const [liked, mutual, plain, f1] = [await user('ml'), await user('mm'), await user('mp'), await user('mf')];
    for (const a of [liked, mutual, plain, f1]) await follow(db, viewer.id, a.id);
    await follow(db, mutual.id, viewer.id);
    const read = await makeRead(db, liked.id, await makeWork(db, 'Liked one'));
    await db.insert(readLikes).values({ readId: read, userId: viewer.id });
    const at = new Date(Date.now() - 5 * 60_000);
    await insertActivity([plain, mutual, liked].map((a, i) => ({
      actorId: a.id, verb: 'reviewed', workId: null, objectType: 'review', objectId: randomUUID(), createdAt: at, metadata: { n: i },
    })));
    const { body } = await feed(viewer, 'tab=friends&limit=10');
    const order = body.items.map((i: any) => i.actor_id);
    expect(order.indexOf(liked.id)).toBeLessThan(order.indexOf(plain.id));
    expect(order.indexOf(mutual.id)).toBeLessThan(order.indexOf(plain.id));
  });
});

// ---------------------------------------------------------------------------
describe('A-14-003: cold-start blending holds across pages', () => {
  it('1–3 follows: popular cards appear on page 1 only, never from followed readers, and nothing repeats', async () => {
    const viewer = await user('sv');
    const [f1, f2] = [await user('sf1'), await user('sf2')];
    await follow(db, viewer.id, f1.id);
    await follow(db, viewer.id, f2.id);
    const works: string[] = [];
    for (let i = 0; i < 6; i++) works.push(await makeWork(db, `Sparse ${i}`));
    const friendIds = await mixedStream([f1, f2], works, 40, Date.now() - 2 * 60_000);
    const strangers = [await user('ss1'), await user('ss2'), await user('ss3')];
    await mixedStream(strangers, works, 30, Date.now() - 60_000);

    const pages = await walk(viewer, 'tab=friends&limit=20');
    expect(pages[0].cold_start_reason).toBe('sparse_follows');
    const blended = pages.flatMap((p, n) => p.items.filter((i: any) => i.metadata?.is_blended_popular).map((i: any) => ({ i, n })));
    expect(blended.length).toBeGreaterThan(0);
    expect(blended.every(({ n }) => n === 0)).toBe(true);
    expect(blended.every(({ i }) => i.actor_id !== f1.id && i.actor_id !== f2.id)).toBe(true);
    expect(pages[0].items.length).toBeLessThanOrEqual(20);

    const seen = pages.flatMap((p) => p.items.flatMap(idsOf));
    expect(seen.length).toBe(new Set(seen).size);
    const friendSeen = pages.flatMap((p) => p.items.filter((i: any) => !i.metadata?.is_blended_popular).flatMap(idsOf));
    expect([...friendSeen].sort()).toEqual([...friendIds].sort());
  });

  it('following_count is a live count of accepted follows of live accounts', async () => {
    const viewer = await user('cv');
    const fs4 = [await user('c1'), await user('c2'), await user('c3'), await user('c4')];
    for (const f of fs4) await follow(db, viewer.id, f.id);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, fs4[0]!.id));
    const { body } = await feed(viewer, 'tab=friends');
    expect(body.following_count).toBe(3);
    expect(body.cold_start_reason).toBe('sparse_follows');
  });

  it('the editorial card is page-one only and has no interaction', async () => {
    const viewer = await user('ev');
    for (let i = 0; i < 4; i++) {
      const f = await user(`ef${i}`);
      await follow(db, viewer.id, f.id);
    }
    // Everything in this database is someone's; a viewer who mutes every actor sees nothing.
    const actors = await db.select({ id: users.id }).from(users);
    await db.insert(mutes).values(actors.filter((a) => a.id !== viewer.id).map((a) => ({ userId: viewer.id, targetType: 'user', targetId: a.id })));
    const { body } = await feed(viewer, 'tab=friends');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(NIL);
    expect(body.items[0].metadata.is_editorial).toBe(true);
    expect(body.items[0].interaction).toBeNull();
    expect(body.has_more).toBe(false);
    expect(body.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('A-14-004: followed cards respect the target', () => {
  it('a card about someone in a block with the viewer, or deleted, is not shown; others carry the target', async () => {
    const viewer = await user('tv');
    const actor = await user('ta');
    for (const f of [actor, await user('tx1'), await user('tx2'), await user('tx3')]) await follow(db, viewer.id, f.id);
    const [blocker, blocked, gone, fine] = [await user('tb1'), await user('tb2'), await user('tg'), await user('tf')];
    await block(db, blocker.id, viewer.id);
    await block(db, viewer.id, blocked.id);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, gone.id));
    const at = Date.now() - 60_000;
    // Spaced a day apart so they do not aggregate into one card.
    await insertActivity([blocker, blocked, gone, fine].map((t, i) => ({
      actorId: actor.id, verb: 'followed', objectType: 'user', objectId: t.id, metadata: { followeeId: t.id }, createdAt: new Date(at - i * 25 * HOUR),
    })));
    const { body } = await feed(viewer, 'tab=friends&limit=50');
    const cards = body.items.filter((i: any) => i.verb === 'followed');
    const targets = cards.flatMap((c: any) => c.metadata.targets ? c.metadata.targets.map((t: any) => t.id) : [c.object_id]);
    expect(targets).toEqual([fine.id]);
    expect(cards[0].metadata.target_username).toBe(fine.username);
    expect(JSON.stringify(body)).not.toContain(blocker.id);
    expect(JSON.stringify(body)).not.toContain(blocked.id);
  });

  it('aggregated follows list each target with a username', async () => {
    const viewer = await user('gv');
    const actor = await user('ga');
    for (const f of [actor, await user('gx1'), await user('gx2'), await user('gx3')]) await follow(db, viewer.id, f.id);
    const targets = [await user('gt1'), await user('gt2'), await user('gt3')];
    const ids = await insertActivity(targets.map((t, i) => ({
      actorId: actor.id, verb: 'followed', objectType: 'user', objectId: t.id, metadata: { followeeId: t.id }, createdAt: new Date(Date.now() - (i + 1) * 60_000),
    })));
    const { body } = await feed(viewer, 'tab=friends');
    const card = body.items.find((i: any) => i.verb === 'followed');
    expect(card.metadata.is_aggregated).toBe(true);
    expect(card.metadata.count).toBe(3);
    expect([...card.metadata.activity_ids].sort()).toEqual([...ids].sort());
    expect(card.metadata.targets.map((t: any) => t.username).sort()).toEqual(targets.map((t) => t.username).sort());
  });
});

// ---------------------------------------------------------------------------
describe('A-14-005: aggregated shelf cards name the shelf', () => {
  it('uses the shelfName the shelves service writes', async () => {
    const viewer = await user('hv');
    const actor = await user('ha');
    for (const f of [actor, await user('hx1'), await user('hx2'), await user('hx3')]) await follow(db, viewer.id, f.id);
    const shelf = randomUUID();
    await insertActivity([1, 2, 3].map((i) => ({
      actorId: actor.id, verb: 'shelved', workId: null, objectType: 'shelf_item', objectId: shelf,
      metadata: { shelfId: shelf, shelfName: 'Monsoon Reading', shelfSlug: 'monsoon-reading' }, createdAt: new Date(Date.now() - i * 60_000),
    })));
    const { body } = await feed(viewer, 'tab=friends');
    const card = body.items.find((i: any) => i.verb === 'shelved');
    expect(card.metadata.count).toBe(3);
    expect(card.metadata.shelf_name).toBe('Monsoon Reading');
    expect(card.metadata.shelfId).toBe(shelf);
  });
});

// ---------------------------------------------------------------------------
describe('A-14-006: the 180-day activity prune (§23.5)', () => {
  it('deletes activity older than 180 days in batches and keeps the rest; the worker schedules it', async () => {
    const actor = await user('pr');
    const old = await insertActivity([1, 2, 3, 4, 5].map((i) => ({
      actorId: actor.id, verb: 'followed', objectType: 'user', objectId: randomUUID(), createdAt: new Date(Date.now() - (180 * 24 + i) * HOUR),
    })));
    const kept = await insertActivity([1, 2, 3].map((i) => ({
      actorId: actor.id, verb: 'followed', objectType: 'user', objectId: randomUUID(), createdAt: new Date(Date.now() - (179 * 24 - i) * HOUR),
    })));
    const result = await pruneActivityJobHandler([], db, { batchSize: 2 });
    expect(result.deleted).toBeGreaterThanOrEqual(5);
    expect(result.batches).toBeGreaterThanOrEqual(3);
    expect(await db.select().from(activity).where(inArray(activity.id, old))).toHaveLength(0);
    expect(await db.select().from(activity).where(inArray(activity.id, kept))).toHaveLength(3);
    const worker = fs.readFileSync(new URL('../worker.ts', import.meta.url), 'utf8');
    expect(worker).toMatch(/boss\.schedule\(QUEUES\.pruneActivity,/);
    expect(QUEUES.pruneActivity).toBe('activity.prune');
  });

  it('the feed never shows activity older than 180 days, pruned or not', async () => {
    const viewer = await user('ov');
    const actor = await user('oa');
    for (const f of [actor, await user('ox1'), await user('ox2'), await user('ox3')]) await follow(db, viewer.id, f.id);
    const [stale] = await insertActivity([{ actorId: actor.id, verb: 'reviewed', objectType: 'review', objectId: randomUUID(), createdAt: new Date(Date.now() - 181 * 24 * HOUR) }]);
    const [fresh] = await insertActivity([{ actorId: actor.id, verb: 'reviewed', objectType: 'review', objectId: randomUUID(), createdAt: new Date(Date.now() - 179 * 24 * HOUR) }]);
    const pages = await walk(viewer, 'tab=friends');
    const seen = pages.flatMap((p) => p.items.flatMap(idsOf));
    expect(seen).toContain(fresh);
    expect(seen).not.toContain(stale);
  });
});

// ---------------------------------------------------------------------------
describe('SO-10 lifecycle and SO-11 privacy', () => {
  it('D-13-1: accepting one request writes one followed card; going public writes none', async () => {
    const [a, b, p] = [await user('da'), await user('db'), await user('dp', { isPrivate: true })];
    await app.inject({ method: 'POST', url: `/v1/users/${p.id}/follow`, headers: a.auth });
    await app.inject({ method: 'POST', url: `/v1/users/${p.id}/follow`, headers: b.auth });
    const acc = await app.inject({ method: 'POST', url: `/v1/me/follow-requests/${a.id}/accept`, headers: p.auth });
    expect(acc.statusCode).toBe(200);
    const cards = await db.select().from(activity).where(and(eq(activity.verb, 'followed'), eq(activity.objectId, p.id)));
    expect(cards.map((c) => c.actorId)).toEqual([a.id]);
    expect(cards[0]!.visibility).toBe('public');
    // Accepting again is a 404 and writes nothing more.
    const again = await app.inject({ method: 'POST', url: `/v1/me/follow-requests/${a.id}/accept`, headers: p.auth });
    expect(again.statusCode).toBe(404);
    // The bulk accept on going public writes none for b.
    await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: p.auth, payload: { isPrivate: false } });
    const [edge] = await db.select().from(follows).where(and(eq(follows.followerId, b.id), eq(follows.followeeId, p.id)));
    expect(edge?.state).toBe('accepted');
    const after = await db.select().from(activity).where(and(eq(activity.verb, 'followed'), eq(activity.objectId, p.id)));
    expect(after.map((c) => c.actorId)).toEqual([a.id]);
  });

  it('a private requester\'s accepted-follow card is followers-only', async () => {
    const [a, p] = [await user('qa', { isPrivate: true }), await user('qp', { isPrivate: true })];
    await app.inject({ method: 'POST', url: `/v1/users/${p.id}/follow`, headers: a.auth });
    await app.inject({ method: 'POST', url: `/v1/me/follow-requests/${a.id}/accept`, headers: p.auth });
    const [card] = await db.select().from(activity).where(and(eq(activity.actorId, a.id), eq(activity.verb, 'followed')));
    expect(card?.visibility).toBe('followers');
  });

  it('A-14-007: going public again restores each card to its item\'s own visibility', async () => {
    const owner = await user('rv');
    const work = await makeWork(db, 'Restore');
    const pub = await app.inject({ method: 'POST', url: '/v1/reads', headers: owner.auth, payload: { work_id: work, status: 'finished' } });
    const fol = await app.inject({ method: 'POST', url: '/v1/reads', headers: owner.auth, payload: { work_id: await makeWork(db, 'Restore 2'), status: 'finished', visibility: 'followers' } });
    expect([pub.statusCode, fol.statusCode]).toEqual([200, 200]);
    const vis = async (readId: string) => (await db.select().from(activity).where(eq(activity.objectId, readId)))[0]?.visibility;
    await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: owner.auth, payload: { isPrivate: true } });
    expect([await vis(pub.json().id), await vis(fol.json().id)]).toEqual(['followers', 'followers']);
    await app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: owner.auth, payload: { isPrivate: false } });
    expect([await vis(pub.json().id), await vis(fol.json().id)]).toEqual(['public', 'followers']);
  });

  it('a private actor: followers see their cards, others never (friends or popular)', async () => {
    const priv = await user('xp', { isPrivate: true });
    const [fan, stranger, pending] = [await user('xf'), await user('xs'), await user('xq')];
    await follow(db, fan.id, priv.id);
    await db.insert(follows).values({ followerId: pending.id, followeeId: priv.id, state: 'pending' });
    for (const v of [fan, stranger, pending]) for (let i = 0; i < 3; i++) await follow(db, v.id, (await user(`xo${i}`)).id);
    const res = await app.inject({ method: 'POST', url: '/v1/reads', headers: priv.auth, payload: { work_id: await makeWork(db, 'Private read'), status: 'finished' } });
    const readId = res.json().id;
    const hasCard = (body: any) => body.items.some((i: any) => i.object_id === readId);
    expect(hasCard((await feed(fan, 'tab=friends&limit=50')).body)).toBe(true);
    expect(hasCard((await feed(pending, 'tab=friends&limit=50')).body)).toBe(false);
    expect(hasCard((await feed(stranger, 'tab=friends&limit=50')).body)).toBe(false);
    for (const v of [fan, stranger, pending, null]) {
      const pages = await walk(v, 'tab=popular&limit=50');
      expect(pages.some(hasCard)).toBe(false);
    }
  });

  it('L-14 / lead 5: a want-to-read write records no activity at all', async () => {
    const owner = await user('wv');
    const res = await app.inject({ method: 'POST', url: '/v1/reads', headers: owner.auth, payload: { work_id: await makeWork(db, 'Wanted'), status: 'want' } });
    expect(res.statusCode).toBe(200);
    expect(await db.select().from(activity).where(eq(activity.actorId, owner.id))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('D-11-1: the want-to-read swipe never overwrites a read', () => {
  it('if_absent creates a want read when there is none, and is 409 already_in_library otherwise, writing nothing', async () => {
    const owner = await user('sw');
    const work = await makeWork(db, 'Swiped');
    const first = await app.inject({ method: 'POST', url: '/v1/reads', headers: owner.auth, payload: { work_id: work, status: 'want', if_absent: true } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'want', attempt_no: 1 });
    // A replay of the same swipe changes nothing.
    const replay = await app.inject({ method: 'POST', url: '/v1/reads', headers: owner.auth, payload: { work_id: work, status: 'want', if_absent: true } });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('already_in_library');

    const reading = await makeWork(db, 'Being read');
    const r = await app.inject({ method: 'POST', url: '/v1/reads', headers: owner.auth, payload: { work_id: reading, status: 'reading' } });
    const before = await db.execute(sql`SELECT status, updated_at FROM reads WHERE id = ${r.json().id}`);
    const swipe = await app.inject({ method: 'POST', url: '/v1/reads', headers: owner.auth, payload: { work_id: reading, status: 'want', if_absent: true } });
    expect(swipe.statusCode).toBe(409);
    expect(await db.execute(sql`SELECT status, updated_at FROM reads WHERE id = ${r.json().id}`)).toEqual(before);
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM reads WHERE user_id = ${owner.id} AND work_id = ${reading}`))[0]).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('AC-11 through the API', () => {
  it('40 items today from people I follow: page one obeys all four rules and aggregates shelf adds', async () => {
    const viewer = await user('kv');
    const actors: TestUser[] = [];
    for (let i = 0; i < 5; i++) {
      actors.push(await user(`ka${i}`));
      await follow(db, viewer.id, actors[i]!.id);
    }
    const hot = await makeWork(db, 'Everyone reads this');
    const shelf = randomUUID();
    const rows: Row[] = [];
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      // Bursts of three by one reader, a third of it about one book.
      const actor = actors[Math.floor(i / 3) % 5]!;
      const work = i % 3 === 0 ? hot : await makeWork(db, `K${i}`);
      const at = new Date(now - i * 10 * 60_000);
      if (i % 8 === 1) rows.push({ actorId: actors[1]!.id, verb: 'shelved', workId: work, objectType: 'shelf_item', objectId: shelf, metadata: { shelfId: shelf, shelfName: 'Monsoon' }, createdAt: at });
      else if (i % 4 === 2) rows.push({ actorId: actor.id, verb: 'started', workId: work, objectType: 'read', objectId: randomUUID(), createdAt: at });
      else rows.push({ actorId: actor.id, verb: i % 2 ? 'finished' : 'reviewed', workId: work, objectType: 'read', objectId: randomUUID(), metadata: { rating: 4 }, createdAt: at });
    }
    await insertActivity(rows);

    const { body } = await feed(viewer, 'tab=friends&limit=20');
    const items = body.items as any[];
    // Cards that fit no slot wait for page two (A-14-001); the page keeps most of its slots.
    expect(items.length).toBeGreaterThanOrEqual(15);
    expect(items.length).toBeLessThanOrEqual(20);
    for (let i = 2; i < items.length; i++) {
      expect(items[i].actor_id === items[i - 1].actor_id && items[i].actor_id === items[i - 2].actor_id).toBe(false);
    }
    expect(items.filter((i) => i.work_id === hot).length).toBeLessThanOrEqual(3);
    for (const block of [items.slice(0, 10), items.slice(10, 20)]) {
      expect(block.filter((i) => i.verb === 'started').length).toBeLessThanOrEqual(1);
    }
    const shelfCards = items.filter((i) => i.verb === 'shelved');
    expect(shelfCards.length).toBeLessThanOrEqual(1);
    if (shelfCards[0]) expect(shelfCards[0].metadata.count).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
describe('SO-12 ranking properties', () => {
  const item = (id: string, actor: string, verb: string, work: string | null, ageMin: number): FeedActivityItem => ({
    id, actor_id: actor, actor: { id: actor, username: actor, display_name: null, avatar_url: null },
    verb: verb as any, work_id: work, work: work ? { id: work, title: work, author_name: null, cover_id: null } : null,
    object_type: 'read', object_id: id, metadata: {}, visibility: 'public',
    created_at: new Date(Date.UTC(2026, 9, 10, 12) - ageMin * 60_000).toISOString(),
  });

  it('is deterministic whatever the input order', () => {
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    const xs = Array.from({ length: 30 }, (_, i) => item(`i${String(i).padStart(2, '0')}`, `u${i % 4}`, ['reviewed', 'finished', 'dnf'][i % 3]!, `w${i % 5}`, Math.floor(i / 3)));
    const a = rankAndDiversifyFeed(xs, 30, { now }).map((x) => x.id);
    const b = rankAndDiversifyFeed([...xs].reverse(), 30, { now }).map((x) => x.id);
    const c = rankAndDiversifyFeed(xs, 30, { now: new Date(now.getTime() + 7 * HOUR) }).map((x) => x.id);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('defers what no slot can take instead of dropping it, and places a deferred card on the next page', () => {
    const now = new Date(Date.UTC(2026, 9, 10, 12));
    const xs = Array.from({ length: 5 }, (_, i) => item(`s${i}`, 'solo', 'reviewed', `w${i}`, i));
    const page1 = rankWindow(xs, 5, { now });
    // Rule 1 allows two in a row; the other three wait rather than vanish.
    expect(page1.items.map((x) => x.id)).toEqual(['s0', 's1']);
    expect(page1.deferred.map((x) => x.id)).toEqual(['s2', 's3', 's4']);
    // Next page: they are placed first, even though nothing else separates them.
    const page2 = rankWindow([...page1.deferred, item('n0', 'other', 'started', 'w9', 10)], 5, {
      now, forcedIds: new Set(page1.deferred.map((x) => x.id)),
    });
    expect(page2.items.map((x) => x.id).sort()).toEqual(['n0', 's2', 's3', 's4']);
    expect(page2.deferred).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('A-14-020: the comment thread cursor keeps microseconds', () => {
  it('walks a thread page by page: every comment once', async () => {
    const [owner, other] = [await user('co'), await user('cc')];
    const read = await makeRead(db, owner.id, await makeWork(db, 'Talked about'));
    const posted: string[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({ method: 'POST', url: `/v1/reads/${read}/comments`, headers: (i % 2 ? owner : other).auth, payload: { body: `c${i}` } });
      expect(res.statusCode).toBe(201);
      posted.push(res.json().id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res: any = await app.inject({ method: 'GET', url: `/v1/reads/${read}/comments?limit=2${cursor ? `&cursor=${cursor}` : ''}`, headers: owner.auth });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().comments.map((c: any) => c.id));
      cursor = res.json().next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(posted);
  });
});
