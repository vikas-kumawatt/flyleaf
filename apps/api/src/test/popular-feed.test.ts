// Audit 15, D-14-1 (owner, 2026-10-10): Popular is public reviews and
// finishes from the last 14 days, scored by the likes and comments on their
// read (never by rating), with a per-card exposure ceiling. Each test names
// the rule it pins. Against Part 14's Popular (recent public activity of
// every verb, ranked by weight and recency only) 6 of 8 fail; the block and
// exactly-once walk tests are guards that held before and must keep holding.

import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activity, readComments, readLikes } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { POPULAR_EXPOSURE_CAP } from '../activity/index.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { freshDrizzle } from './pg.js';
import { block, makeRead, makeUser, makeWork, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let seq = 0;
const name = (p: string) => `${p}${++seq}`.slice(0, 20);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  ({ db } = await freshDrizzle());
  app = await buildApp({ db, identity: new IdentityService(db, unlimited), reading: new ReadingService(db), limiter: unlimited });
  await app.ready();
}, 60_000);

async function reset() {
  await db.execute(sql`DELETE FROM activity`);
  await db.execute(sql`DELETE FROM popular_exposures`);
}

async function popular(as: TestUser | null, query = '', cursor?: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/feed?tab=popular${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    headers: as ? as.auth : {},
  });
  return { status: res.statusCode, body: res.json() as any };
}

/** A read and a card about it: `finished` points at the read, `reviewed` carries it in metadata. */
async function card(actor: TestUser, verb: 'reviewed' | 'finished' | 'dnf' | 'started' | 'shelved', ageMs: number, opts: { rating?: number; work?: string } = {}) {
  const work = opts.work ?? (await makeWork(db, name('w')));
  const readId = await makeRead(db, actor.id, work, { rating: opts.rating != null ? String(opts.rating) : null });
  const [row] = await db.insert(activity).values({
    actorId: actor.id,
    verb,
    workId: work,
    objectType: verb === 'reviewed' ? 'review' : verb === 'shelved' ? 'shelf_item' : 'read',
    objectId: verb === 'reviewed' ? randomUUID() : verb === 'shelved' ? randomUUID() : readId,
    metadata: verb === 'reviewed' ? { readId, snippet: 'x' } : opts.rating != null ? { rating: opts.rating } : {},
    visibility: 'public',
    createdAt: new Date(Date.now() - ageMs),
  }).returning({ id: activity.id });
  return { id: row!.id, readId, work };
}

async function like(readId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const u = await makeUser(db, name('lk'));
    await db.insert(readLikes).values({ readId, userId: u.id });
  }
}

describe('D-14-1: what Popular serves', () => {
  it('only public reviews and finishes from the last 14 days', async () => {
    await reset();
    // A different reader per card, so no diversity rule hides one.
    const u = () => makeUser(db, name('pa'));
    const review = await card(await u(), 'reviewed', HOUR);
    const finish = await card(await u(), 'finished', 2 * HOUR);
    const old = await card(await u(), 'reviewed', 15 * DAY);
    const others = [await card(await u(), 'dnf', HOUR), await card(await u(), 'started', HOUR), await card(await u(), 'shelved', HOUR)];
    const { body } = await popular(null);
    const ids = body.items.map((i: any) => i.id);
    expect([...ids].sort()).toEqual([review.id, finish.id].sort());
    expect(ids).not.toContain(old.id);
    for (const o of others) expect(ids).not.toContain(o.id);
  });

  it('ranks by likes and comments: an engaged review beats a newer quiet one', async () => {
    await reset();
    const a = await makeUser(db, name('pe'));
    const b = await makeUser(db, name('pf'));
    const quiet = await card(a, 'reviewed', HOUR);
    const engaged = await card(b, 'reviewed', 30 * HOUR);
    await like(engaged.readId, 6);
    const commenter = await makeUser(db, name('pc'));
    await db.insert(readComments).values({ readId: engaged.readId, userId: commenter.id, body: 'yes' });
    const { body } = await popular(null);
    expect(body.items.map((i: any) => i.id)).toEqual([engaged.id, quiet.id]);
  });

  it('never by rating: a newer 5★ finish does not outrank a 1★ finish with more likes', async () => {
    await reset();
    const a = await makeUser(db, name('pr'));
    const b = await makeUser(db, name('ps'));
    const low = await card(a, 'finished', 3 * HOUR, { rating: 1 });
    const high = await card(b, 'finished', 2 * HOUR, { rating: 5 });
    await like(high.readId, 1);
    await like(low.readId, 3);
    const { body } = await popular(null);
    // The 1★ has more likes and ranks first: the rating itself weighs nothing.
    expect(body.items.map((i: any) => i.id)).toEqual([low.id, high.id]);
  });

  it('one reader cannot fill the page: their third card and on are halved per step (§12.4)', async () => {
    await reset();
    const loud = await makeUser(db, name('pl'));
    const quiet = await makeUser(db, name('pq'));
    for (let i = 0; i < 6; i++) await card(loud, 'reviewed', HOUR + i * 1000);
    const q = await card(quiet, 'reviewed', 3 * HOUR);
    const { body } = await popular(null, '&limit=4');
    const actors = body.items.map((i: any) => i.actor_id);
    expect(actors.filter((x: string) => x === loud.id).length).toBeLessThanOrEqual(3);
    expect(body.items.map((i: any) => i.id)).toContain(q.id);
  });

  it('honours blocks and mutes for a signed-in viewer', async () => {
    await reset();
    const viewer = await makeUser(db, name('pv'));
    const blocked = await makeUser(db, name('pb'));
    const fine = await makeUser(db, name('pn'));
    const hidden = await card(blocked, 'reviewed', HOUR);
    const shown = await card(fine, 'reviewed', HOUR);
    await block(db, blocked.id, viewer.id);
    const { body } = await popular(viewer);
    const ids = body.items.map((i: any) => i.id);
    expect(ids).toContain(shown.id);
    expect(ids).not.toContain(hidden.id);
  });
});

describe('D-14-1: paging and the exposure ceiling', () => {
  it('walks every eligible card exactly once, even when an unserved card gains likes mid-walk', async () => {
    await reset();
    const cards: string[] = [];
    const reads: string[] = [];
    for (let i = 0; i < 30; i++) {
      const u = await makeUser(db, name('pw'));
      const c = await card(u, i % 2 ? 'reviewed' : 'finished', (i + 1) * HOUR);
      cards.push(c.id);
      reads.push(c.readId);
      if (i % 5 === 0) await like(c.readId, i % 3);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const { status, body } = await popular(null, '&limit=7', cursor);
      expect(status).toBe(200);
      seen.push(...body.items.map((i: any) => i.id));
      // After page one, the oldest (lowest-ranked) card suddenly gets popular.
      if (page === 0) await like(reads[29]!, 20);
      if (!body.has_more) break;
      cursor = body.next_cursor;
    }
    expect(seen.length).toBe(new Set(seen).size);
    expect([...seen].sort()).toEqual([...cards].sort());
  });

  it('a card leaves Popular once it has been served POPULAR_EXPOSURE_CAP times; serving counts', async () => {
    await reset();
    const a = await makeUser(db, name('px'));
    const capped = await card(a, 'reviewed', HOUR);
    const fresh = await card(await makeUser(db, name('py')), 'reviewed', HOUR);
    await db.execute(sql`INSERT INTO popular_exposures (activity_id, served) VALUES (${capped.id}::uuid, ${POPULAR_EXPOSURE_CAP})`);
    const first = await popular(null);
    expect(first.body.items.map((i: any) => i.id)).toEqual([fresh.id]);
    await popular(null);
    const [row] = await db.execute<{ served: number }>(sql`SELECT served FROM popular_exposures WHERE activity_id = ${fresh.id}::uuid`);
    expect(Number(row?.served)).toBe(2);
  });

  it('a popular cursor without its score is 400 invalid_cursor; a friends cursor on the popular tab too', async () => {
    const bad = Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: randomUUID(), d: [], s: 'p' })).toString('base64url');
    expect((await popular(null, '', bad)).status).toBe(400);
    const friends = Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: randomUUID(), d: [], s: 'f' })).toString('base64url');
    expect((await popular(null, '', friends)).status).toBe(400);
  });
});
