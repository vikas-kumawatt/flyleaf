// Audit 11: shelves and lists (SH-01 … SH-10). Each test here was written
// before its fix and seen failing; see docs/audit/findings/11-shelves.md.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { interactionHarness, makeUser, makeWork, makeRead, follow, type TestUser } from './interaction-fixtures.js';
import { activity, mutes, shelfItems, shelfSaves, shelves, works } from '../db/schema.js';
import { coverIdsFromRow, slugify } from '../shelves/index.js';
import type { Db } from '../platform/index.js';

let app: FastifyInstance;
let db: Db;
let client: PGlite;

/**
 * Statements sent to PGlite while `fn` runs. Counts every `query`/`exec`,
 * including those inside transactions, which is what an N+1 shows up in.
 */
async function countStatements<T>(fn: () => Promise<T>): Promise<{ n: number; result: T }> {
  const c = client as unknown as Record<string, any>;
  const orig = { query: c.query, exec: c.exec, transaction: c.transaction };
  let n = 0;
  const wrapQ = (target: any, name: 'query' | 'exec') => {
    const f = target[name];
    return (...args: unknown[]) => { n++; return f.apply(target, args); };
  };
  c.query = wrapQ(client, 'query');
  c.exec = wrapQ(client, 'exec');
  c.transaction = (cb: (tx: any) => unknown) =>
    orig.transaction.call(client, (tx: any) => {
      const tq = tx.query; const te = tx.exec;
      tx.query = (...a: unknown[]) => { n++; return tq.apply(tx, a); };
      tx.exec = (...a: unknown[]) => { n++; return te.apply(tx, a); };
      return cb(tx);
    });
  try {
    const result = await fn();
    return { n, result };
  } finally {
    c.query = orig.query; c.exec = orig.exec; c.transaction = orig.transaction;
  }
}

async function createShelf(u: TestUser, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/shelves', headers: u.auth, payload: body });
}

async function insertWorks(n: number, prefix = 'W'): Promise<string[]> {
  const rows = await db.insert(works)
    .values(Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i}` })))
    .returning({ id: works.id });
  return rows.map((r) => r.id);
}

/** A shelf with `ids` already on it at positions 1..n (direct insert, no API cost). */
async function shelfWith(u: TestUser, name: string, ids: string[], privacy: 'public' | 'followers' | 'private' = 'public') {
  const [s] = await db.insert(shelves).values({ userId: u.id, name, slug: slugify(name) + '-' + randomUUID().slice(0, 6), privacy }).returning();
  if (ids.length) {
    await db.insert(shelfItems).values(ids.map((workId, i) => ({ shelfId: s!.id, workId, position: i + 1 })));
  }
  return s!.id;
}

beforeAll(async () => {
  ({ app, db, client } = await interactionHarness());
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('SH-02 · create, slugs, limits', () => {
  it('a create that loses the slug race to a concurrent create retries instead of failing (A-11-005)', async () => {
    const u = await makeUser(db, 'racer');
    // Simulates the other request winning between our slug lookup and our
    // insert: the first insert of 'Summer' finds 'summer' taken by a row that
    // appears inside its own statement. A sequence is not rolled back, so the
    // ghost appears exactly once.
    await client.exec(`
      CREATE SEQUENCE race_seq;
      CREATE FUNCTION race_ghost() RETURNS trigger AS $$
      BEGIN
        IF NEW.name = 'Summer' AND NEW.user_id = '${u.id}' AND nextval('race_seq') = 1 THEN
          INSERT INTO shelves (user_id, name, slug) VALUES (NEW.user_id, 'Ghost', NEW.slug);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER race_ghost BEFORE INSERT ON shelves FOR EACH ROW EXECUTE FUNCTION race_ghost();
    `);
    try {
      const res = await createShelf(u, { name: 'Summer' });
      expect(res.statusCode).toBe(201);
      expect(res.json().shelf.slug).toBe('summer');
      const [{ last_value }] = (await client.query<{ last_value: string }>('SELECT last_value FROM race_seq')).rows as any;
      expect(Number(last_value)).toBe(2); // two attempts: the ghost's and the retry
    } finally {
      await client.exec('DROP TRIGGER race_ghost ON shelves; DROP FUNCTION race_ghost(); DROP SEQUENCE race_seq;');
    }
  });

  it('concurrent creates with the same name all succeed with distinct slugs', async () => {
    const u = await makeUser(db, 'racer2');
    const res = await Promise.all([1, 2, 3].map(() => createShelf(u, { name: 'Winter' })));
    expect(res.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(res.map((r) => r.json().shelf.slug).sort()).toEqual(['winter', 'winter-1', 'winter-2']);
  });

  it('keeps non-Latin letters in slugs instead of dropping them (A-11-006)', () => {
    expect(slugify('Книги 2026')).toBe('книги-2026');
    expect(slugify('本')).toBe('本');
    expect(slugify('Café Crème')).toBe('cafe-creme');
    expect(slugify('📚📚')).toBe('shelf');
    expect(slugify('  --  ')).toBe('shelf');
    expect(slugify('हिन्दी किताबें')).toBe('हिन्दी-किताबें');
  });

  it('counts the 60-character name limit in characters, as the schema and the database do (A-11-007)', async () => {
    const u = await makeUser(db, 'emoji');
    const name = '📚'.repeat(60); // 60 characters, 120 UTF-16 units
    const ok = await createShelf(u, { name });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().shelf.name).toBe(name);
    const tooLong = await createShelf(u, { name: '📚'.repeat(61) });
    expect(tooLong.statusCode).toBe(422); // the request schema's maxLength, in characters
  });

  it('refuses a 201st shelf (PRD §15.6: max 200 per user) (A-11-003)', async () => {
    const u = await makeUser(db, 'hoarder');
    await db.insert(shelves).values(Array.from({ length: 200 }, (_, i) => ({ userId: u.id, name: `S${i}`, slug: `s${i}` })));
    const res = await createShelf(u, { name: 'One more' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('shelf_limit_reached');
    // A deleted shelf no longer counts.
    await db.update(shelves).set({ deletedAt: new Date() }).where(and(eq(shelves.userId, u.id), eq(shelves.slug, 's0')));
    expect((await createShelf(u, { name: 'One more' })).statusCode).toBe(201);
  });
});

describe('SH-02 · privacy changes and deletion reach the feed activity (A-11-001)', () => {
  async function shelvedActivity(shelfId: string) {
    return db.select().from(activity).where(and(eq(activity.objectType, 'shelf_item'), eq(activity.objectId, shelfId)));
  }

  it('making a shelf private removes its shelved activity; followers-only narrows it', async () => {
    const u = await makeUser(db, 'feedowner');
    const w1 = await makeWork(db, 'Feed One');
    const w2 = await makeWork(db, 'Feed Two');
    const s = (await createShelf(u, { name: 'Loud' })).json().shelf.id;
    await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: w1 } });
    await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: w2 } });
    expect((await shelvedActivity(s)).map((a) => a.visibility)).toEqual(['public', 'public']);

    await app.inject({ method: 'PATCH', url: `/v1/shelves/${s}`, headers: u.auth, payload: { privacy: 'followers', name: 'Quieter' } });
    expect((await shelvedActivity(s)).map((a) => a.visibility)).toEqual(['followers', 'followers']);
    // A rename reaches the feed card's shelf name and link too.
    expect((await shelvedActivity(s)).map((a) => [(a.metadata as any).shelfName, (a.metadata as any).shelfSlug])).toEqual([['Quieter', 'quieter'], ['Quieter', 'quieter']]);

    await app.inject({ method: 'PATCH', url: `/v1/shelves/${s}`, headers: u.auth, payload: { privacy: 'private' } });
    expect(await shelvedActivity(s)).toHaveLength(0);
  });

  it('a follower no longer sees the book in their feed once the shelf is private', async () => {
    const owner = await makeUser(db, 'feedowner2');
    const fan = await makeUser(db, 'feedfan');
    await follow(db, fan.id, owner.id);
    const w = await makeWork(db, 'Secret Book');
    const s = (await createShelf(owner, { name: 'Soon private' })).json().shelf.id;
    await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: owner.auth, payload: { work_id: w } });
    const seen = async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/feed?tab=friends', headers: fan.auth });
      return (res.json().items as any[]).filter((i) => i.verb === 'shelved' && i.object_id === s).length;
    };
    expect(await seen()).toBe(1);
    await app.inject({ method: 'PATCH', url: `/v1/shelves/${s}`, headers: owner.auth, payload: { privacy: 'private' } });
    expect(await seen()).toBe(0);
  });

  it('deleting a shelf removes its activity; removing a book removes that book\'s activity', async () => {
    const u = await makeUser(db, 'feedowner3');
    const [w1, w2] = [await makeWork(db, 'R1'), await makeWork(db, 'R2')];
    const s = (await createShelf(u, { name: 'Gone soon' })).json().shelf.id;
    await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: w1 } });
    await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: w2 } });
    await app.inject({ method: 'DELETE', url: `/v1/shelves/${s}/items/${w1}`, headers: u.auth });
    expect((await shelvedActivity(s)).map((a) => a.workId)).toEqual([w2]);
    await app.inject({ method: 'DELETE', url: `/v1/shelves/${s}`, headers: u.auth });
    expect(await shelvedActivity(s)).toHaveLength(0);
  });

  it('on a private account, a shelf made public again is followers-only in the feed', async () => {
    const u = await makeUser(db, 'privfeed', { isPrivate: true });
    const w = await makeWork(db, 'P1');
    const s = (await createShelf(u, { name: 'Priv acct', privacy: 'followers' })).json().shelf.id;
    await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: w } });
    await app.inject({ method: 'PATCH', url: `/v1/shelves/${s}`, headers: u.auth, payload: { privacy: 'public' } });
    expect((await shelvedActivity(s)).map((a) => a.visibility)).toEqual(['followers']);
  });
});

describe('SH-02 · soft delete is recoverable for 30 days (A-11-004)', () => {
  it('lists deleted shelves to the owner and restores one', async () => {
    const u = await makeUser(db, 'restorer');
    const other = await makeUser(db, 'snoop');
    const s = (await createShelf(u, { name: 'Oops' })).json().shelf.id;
    await app.inject({ method: 'DELETE', url: `/v1/shelves/${s}`, headers: u.auth });

    const deleted = await app.inject({ method: 'GET', url: '/v1/shelves/deleted', headers: u.auth });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().shelves.map((x: any) => x.id)).toEqual([s]);
    expect(deleted.json().shelves[0].deleted_at).toBeTruthy();
    expect(deleted.json().shelves[0].purge_after).toBeTruthy();

    // Not someone else's to restore: the same 404 as a random id.
    const snoop = await app.inject({ method: 'POST', url: `/v1/shelves/${s}/restore`, headers: other.auth });
    const random = await app.inject({ method: 'POST', url: `/v1/shelves/${randomUUID()}/restore`, headers: other.auth });
    expect(snoop.statusCode).toBe(404);
    expect(snoop.body).toBe(random.body);

    const restored = await app.inject({ method: 'POST', url: `/v1/shelves/${s}/restore`, headers: u.auth });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().shelf.id).toBe(s);
    const mine = await app.inject({ method: 'GET', url: '/v1/shelves/mine', headers: u.auth });
    expect(mine.json().shelves.map((x: any) => x.id)).toContain(s);
    // Restoring a live shelf is 404 (nothing to restore).
    expect((await app.inject({ method: 'POST', url: `/v1/shelves/${s}/restore`, headers: u.auth })).statusCode).toBe(404);
  });

  it('a shelf deleted more than 30 days ago cannot be restored', async () => {
    const u = await makeUser(db, 'toolate');
    const s = (await createShelf(u, { name: 'Ancient' })).json().shelf.id;
    await db.update(shelves).set({ deletedAt: sql`now() - interval '31 days'` as any }).where(eq(shelves.id, s));
    expect((await app.inject({ method: 'POST', url: `/v1/shelves/${s}/restore`, headers: u.auth })).statusCode).toBe(404);
    const deleted = await app.inject({ method: 'GET', url: '/v1/shelves/deleted', headers: u.auth });
    expect(deleted.json().shelves).toEqual([]);
  });

  it('restoring is refused at the 200-shelf limit', async () => {
    const u = await makeUser(db, 'fullrestore');
    const s = (await createShelf(u, { name: 'Restore me' })).json().shelf.id;
    await app.inject({ method: 'DELETE', url: `/v1/shelves/${s}`, headers: u.auth });
    await db.insert(shelves).values(Array.from({ length: 200 }, (_, i) => ({ userId: u.id, name: `F${i}`, slug: `f${i}` })));
    const res = await app.inject({ method: 'POST', url: `/v1/shelves/${s}/restore`, headers: u.auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('shelf_limit_reached');
  });
});

describe('SH-03/04 · items past the first 100, positions, caps', () => {
  it('adding the 101st book returns the new item instead of a 500 (A-11-002)', async () => {
    const u = await makeUser(db, 'bigadder');
    const ids = await insertWorks(101, 'Big');
    const s = await shelfWith(u, 'Big one', ids.slice(0, 100));
    const res = await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: ids[100] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().item.work_id).toBe(ids[100]);
    expect(res.json().item.position).toBe(101);

    const patched = await app.inject({ method: 'PATCH', url: `/v1/shelves/${s}/items/${ids[100]}`, headers: u.auth, payload: { note: 'last but not least' } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().item.note).toBe('last but not least');
  });

  it('refuses a 1,001st book (PRD §15.6: max 1,000 per shelf) (A-11-003)', async () => {
    const u = await makeUser(db, 'thousand');
    const ids = await insertWorks(1001, 'K');
    const s = await shelfWith(u, 'Thousand', ids.slice(0, 1000));
    const res = await app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: ids[1000] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('shelf_full');
  });

  it('concurrent adds get distinct, consecutive positions (A-11-009)', async () => {
    const u = await makeUser(db, 'paralleladd');
    const ids = await insertWorks(6, 'Par');
    const s = (await createShelf(u, { name: 'Parallel' })).json().shelf.id;
    const res = await Promise.all(ids.map((w) => app.inject({ method: 'POST', url: `/v1/shelves/${s}/items`, headers: u.auth, payload: { work_id: w } })));
    expect(res.map((r) => r.statusCode)).toEqual(ids.map(() => 201));
    const rows = await db.select({ p: shelfItems.position }).from(shelfItems).where(eq(shelfItems.shelfId, s));
    expect(rows.map((r) => r.p).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('an item\'s rating is the work page\'s rating, not an average over every attempt and private read (A-11-013)', async () => {
    const u = await makeUser(db, 'ratingshelf');
    const r1 = await makeUser(db, 'rater1');
    const w = await makeWork(db, 'Rated');
    // One reader re-read it: 1.0 then 5.0. Only the latest counts per reader on the work page.
    await makeRead(db, r1.id, w, { attemptNo: 1, rating: '1.0' });
    await makeRead(db, r1.id, w, { attemptNo: 2, rating: '5.0' });
    const s = await shelfWith(u, 'Rated shelf', [w]);
    const items = await app.inject({ method: 'GET', url: `/v1/shelves/${s}/items` });
    // The work page reads work_stats.avg_rating (CatalogService.getWork).
    const [ws] = await db.execute<{ avg: string | null }>(sql`SELECT avg_rating::text AS avg FROM work_stats WHERE work_id = ${w}`);
    expect(ws?.avg).toBe('5.00');
    expect(items.json().data[0].work.rating).toBe(5);
  });

  it('the items limit is capped at 100: the reorder screen\'s limit=200 is refused (A-11-012)', async () => {
    const u = await makeUser(db, 'limit200');
    const s = await shelfWith(u, 'Lim', []);
    const res = await app.inject({ method: 'GET', url: `/v1/shelves/${s}/items?limit=200`, headers: u.auth });
    expect(res.statusCode).toBe(422);
  });
});

describe('SH-05 · reorder takes exactly the shelf\'s current set (A-11-008)', () => {
  async function setup(name: string) {
    const u = await makeUser(db, name);
    const ids = await insertWorks(4, name);
    const s = await shelfWith(u, name, ids);
    return { u, ids, s };
  }
  const put = (s: string, u: TestUser, work_ids: string[]) =>
    app.inject({ method: 'PUT', url: `/v1/shelves/${s}/order`, headers: u.auth, payload: { work_ids } });

  it('a missing id is refused, and no position changes', async () => {
    const { u, ids, s } = await setup('ordmissing');
    const res = await put(s, u, [ids[3]!, ids[2]!, ids[1]!]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('order_mismatch');
    const rows = await db.select({ w: shelfItems.workId, p: shelfItems.position }).from(shelfItems).where(eq(shelfItems.shelfId, s)).orderBy(shelfItems.position);
    expect(rows.map((r) => r.w)).toEqual(ids);
  });

  it('an id not on the shelf is refused', async () => {
    const { u, ids, s } = await setup('ordextra');
    const extra = await makeWork(db, 'Extra');
    const res = await put(s, u, [...ids, extra]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('order_mismatch');
  });

  it('duplicates are still 400; an empty array is 422; more than 1,000 ids is 422', async () => {
    const { u, ids, s } = await setup('orddup');
    expect((await put(s, u, [ids[0]!, ids[0]!, ids[1]!, ids[2]!])).statusCode).toBe(400);
    expect((await put(s, u, [])).statusCode).toBe(422);
    expect((await put(s, u, Array.from({ length: 1001 }, () => randomUUID()))).statusCode).toBe(422);
  });

  it('the exact set reorders to 1..n and updates the mosaic, in a bounded number of statements', async () => {
    const u = await makeUser(db, 'ordok');
    const ids = await insertWorks(40, 'ordok');
    const s = await shelfWith(u, 'ordok', ids);
    const order = [...ids].reverse();
    const { n, result } = await countStatements(() => put(s, u, order));
    expect(result.statusCode).toBe(200);
    const rows = await db.select({ w: shelfItems.workId, p: shelfItems.position }).from(shelfItems).where(eq(shelfItems.shelfId, s)).orderBy(shelfItems.position);
    expect(rows.map((r) => [r.w, r.p])).toEqual(order.map((w, i) => [w, i + 1]));
    const [sh] = await db.select({ c: shelves.coverWorkIds }).from(shelves).where(eq(shelves.id, s));
    expect(sh!.c).toEqual(order.slice(0, 4));
    // One UPDATE for the whole list, not one per item (40 items: 40+ before).
    expect(n).toBeLessThanOrEqual(12);
  });

  it('a reorder of 1,000 items is one statement-level recount, not 1,000 (A-11-010)', async () => {
    const u = await makeUser(db, 'ordbig');
    const ids = await insertWorks(1000, 'OB');
    const s = await shelfWith(u, 'Order big', ids);
    const reversed = [...ids].reverse();
    const t0 = Date.now();
    const res = await put(s, u, reversed);
    const ms = Date.now() - t0;
    expect(res.statusCode).toBe(200);
    const [sh] = await db.select({ c: shelves.coverWorkIds, n: shelves.itemCount }).from(shelves).where(eq(shelves.id, s));
    expect(sh!.c).toEqual(reversed.slice(0, 4));
    expect(sh!.n).toBe(1000);
    // Row-level triggers recounted the shelf once per moved row (O(n²)): ~40 s on PGlite.
    expect(ms).toBeLessThan(15_000);
  }, 120_000);

  it('moving one item with PATCH position shifts the others, keeping 1..n (A-11-011)', async () => {
    const { u, ids, s } = await setup('ordmove');
    const res = await app.inject({ method: 'PATCH', url: `/v1/shelves/${s}/items/${ids[3]}`, headers: u.auth, payload: { position: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.position).toBe(1);
    const rows = await db.select({ w: shelfItems.workId, p: shelfItems.position }).from(shelfItems).where(eq(shelfItems.shelfId, s)).orderBy(shelfItems.position);
    expect(rows.map((r) => [r.w, r.p])).toEqual([[ids[3], 1], [ids[0], 2], [ids[1], 3], [ids[2], 4]]);
    // Past the end clamps to the end.
    await app.inject({ method: 'PATCH', url: `/v1/shelves/${s}/items/${ids[3]}`, headers: u.auth, payload: { position: 99 } });
    const after = await db.select({ w: shelfItems.workId, p: shelfItems.position }).from(shelfItems).where(eq(shelfItems.shelfId, s)).orderBy(shelfItems.position);
    expect(after.map((r) => [r.w, r.p])).toEqual([[ids[0], 1], [ids[1], 2], [ids[2], 3], [ids[3], 4]]);
  });

  it('removing a book closes the gap so ranked numbers stay 1..n', async () => {
    const { u, ids, s } = await setup('ordgap');
    await app.inject({ method: 'DELETE', url: `/v1/shelves/${s}/items/${ids[1]}`, headers: u.auth });
    const rows = await db.select({ w: shelfItems.workId, p: shelfItems.position }).from(shelfItems).where(eq(shelfItems.shelfId, s)).orderBy(shelfItems.position);
    expect(rows.map((r) => [r.w, r.p])).toEqual([[ids[0], 1], [ids[2], 2], [ids[3], 3]]);
  });

  it('GET /shelves/mine?work_id= with a merged work id reports the survivor\'s membership (A-11-014)', async () => {
    const u = await makeUser(db, 'mergedmember');
    const survivor = await makeWork(db, 'Survivor');
    const loser = await makeWork(db, 'Loser');
    await db.update(works).set({ mergedIntoId: survivor }).where(eq(works.id, loser));
    const s = await shelfWith(u, 'Merged', [survivor]);
    const res = await app.inject({ method: 'GET', url: `/v1/shelves/mine?work_id=${loser}`, headers: u.auth });
    expect(res.json().shelves.find((x: any) => x.id === s).contains_work).toBe(true);
  });
});

describe('SH-07 · saves', () => {
  it('unsaving a shelf you can no longer see is the random-id 404, leaks no count, and drops your save (A-11-015)', async () => {
    const owner = await makeUser(db, 'unsaveowner');
    const saver = await makeUser(db, 'unsaver');
    const s = await shelfWith(owner, 'Hidden later', []);
    await app.inject({ method: 'POST', url: `/v1/shelves/${s}/save`, headers: saver.auth });
    await db.update(shelves).set({ privacy: 'private' }).where(eq(shelves.id, s));
    const res = await app.inject({ method: 'DELETE', url: `/v1/shelves/${s}/save`, headers: saver.auth });
    const random = await app.inject({ method: 'DELETE', url: `/v1/shelves/${randomUUID()}/save`, headers: saver.auth });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(random.body);
    const left = await db.select().from(shelfSaves).where(and(eq(shelfSaves.shelfId, s), eq(shelfSaves.userId, saver.id)));
    expect(left).toHaveLength(0);
  });

  it('GET /shelves/saved costs the same number of statements for 2 owners as for 12 (A-11-016)', async () => {
    const saver = await makeUser(db, 'manysaver');
    const owners: TestUser[] = [];
    for (let i = 0; i < 12; i++) owners.push(await makeUser(db, `savedowner${i}`));
    const shelfIds: string[] = [];
    for (const o of owners) shelfIds.push(await shelfWith(o, `By ${o.username}`, []));
    await db.insert(shelfSaves).values(shelfIds.slice(0, 2).map((shelfId) => ({ shelfId, userId: saver.id })));
    const few = await countStatements(() => app.inject({ method: 'GET', url: '/v1/shelves/saved', headers: saver.auth }));
    await db.insert(shelfSaves).values(shelfIds.slice(2).map((shelfId) => ({ shelfId, userId: saver.id })));
    const many = await countStatements(() => app.inject({ method: 'GET', url: '/v1/shelves/saved', headers: saver.auth }));
    expect(few.result.json().shelves).toHaveLength(2);
    expect(many.result.json().shelves).toHaveLength(12);
    expect(many.result.json().shelves.map((x: any) => x.owner.username).sort()).toEqual(owners.map((o) => o.username).sort());
    expect(many.n).toBe(few.n);
  });

  it('GET /shelves/saved pages with limit and offset and reports the total', async () => {
    const saver = await makeUser(db, 'pagesaver');
    const owner = await makeUser(db, 'pageowner');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await shelfWith(owner, `Saved page ${i}`, []));
    for (const [i, shelfId] of ids.entries()) {
      await db.insert(shelfSaves).values({ shelfId, userId: saver.id, createdAt: new Date(Date.UTC(2026, 0, 1 + i)) });
    }
    const p1 = await app.inject({ method: 'GET', url: '/v1/shelves/saved?limit=2', headers: saver.auth });
    const p2 = await app.inject({ method: 'GET', url: '/v1/shelves/saved?limit=2&offset=2', headers: saver.auth });
    const p3 = await app.inject({ method: 'GET', url: '/v1/shelves/saved?limit=2&offset=4', headers: saver.auth });
    expect(p1.json().total).toBe(5);
    expect([...p1.json().shelves, ...p2.json().shelves, ...p3.json().shelves].map((x: any) => x.id)).toEqual([...ids].reverse());
  });
});

describe('SH-08 · browse', () => {
  it('hides shelves of users the viewer muted (A-11-017)', async () => {
    const viewer = await makeUser(db, 'muter');
    const muted = await makeUser(db, 'mutedcurator');
    const s = await shelfWith(muted, 'Zebra muted list', []);
    const before = await app.inject({ method: 'GET', url: '/v1/shelves/browse?query=Zebra%20muted&limit=50', headers: viewer.auth });
    expect(before.json().shelves.map((x: any) => x.id)).toContain(s);
    await db.insert(mutes).values({ userId: viewer.id, targetType: 'user', targetId: muted.id });
    const after = await app.inject({ method: 'GET', url: '/v1/shelves/browse?query=Zebra%20muted&limit=50', headers: viewer.auth });
    expect(after.json().shelves.map((x: any) => x.id)).not.toContain(s);
    expect(after.json().total).toBe(0);
  });

  it('treats % and _ in the search as literal characters (A-11-018)', async () => {
    const u = await makeUser(db, 'likechars');
    const pct = await shelfWith(u, '100% Fiction', []);
    await shelfWith(u, 'Plain list', []);
    const all = await app.inject({ method: 'GET', url: '/v1/shelves/browse?query=%25&limit=50' });
    expect(all.json().shelves.map((x: any) => x.id)).toEqual([pct]);
    const under = await app.inject({ method: 'GET', url: '/v1/shelves/browse?query=_&limit=50' });
    expect(under.json().total).toBe(0);
  });

  it('costs a constant number of statements however many shelves and owners exist (A-11-019)', async () => {
    const viewer = await makeUser(db, 'browsecount');
    const q = () => countStatements(() => app.inject({ method: 'GET', url: '/v1/shelves/browse?limit=20', headers: viewer.auth }));
    const a = await q();
    for (let i = 0; i < 10; i++) {
      const o = await makeUser(db, `browseowner${i}`);
      await shelfWith(o, `Browse count ${i}`, []);
    }
    const b = await q();
    expect(b.result.statusCode).toBe(200);
    expect(b.n).toBe(a.n);
    expect(b.n).toBeLessThanOrEqual(4);
  });

  it('pages are disjoint and complete under every sort, even when shelves tie on every key (A-11-020)', async () => {
    const u = await makeUser(db, 'tiecurator');
    const at = new Date('2026-03-01T00:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const [s] = await db.insert(shelves).values({ userId: u.id, name: `Tie list ${i}`, slug: `tie-${i}`, createdAt: at }).returning({ id: shelves.id });
      ids.push(s!.id);
    }
    for (const sort of ['ranked', 'popular', 'recent']) {
      const seen: string[] = [];
      for (let offset = 0; offset < 7; offset += 3) {
        const res = await app.inject({ method: 'GET', url: `/v1/shelves/browse?query=Tie%20list&sort=${sort}&limit=3&offset=${offset}` });
        expect(res.json().total).toBe(7);
        seen.push(...res.json().shelves.map((x: any) => x.id));
      }
      expect(seen.length).toBe(7);
      expect(new Set(seen)).toEqual(new Set(ids));
    }
  });
});

describe('SH-01 · reconciliation', () => {
  it('reconcile_shelf_counters returns how many shelves it fixed and writes only drifted rows (A-11-021)', async () => {
    const u = await makeUser(db, 'drifter');
    const ids = await insertWorks(5, 'Drift');
    const s = await shelfWith(u, 'Drift', ids);
    await db.execute(sql`SELECT reconcile_shelf_counters()`); // settle everything else
    await db.update(shelves).set({ itemCount: 99, coverWorkIds: [], saveCount: 7 }).where(eq(shelves.id, s));
    const [r1] = await db.execute<{ fixed: number }>(sql`SELECT reconcile_shelf_counters() AS fixed`);
    expect(Number(r1!.fixed)).toBe(1);
    const [sh] = await db.select().from(shelves).where(eq(shelves.id, s));
    expect([sh!.itemCount, sh!.saveCount, sh!.coverWorkIds]).toEqual([5, 0, ids.slice(0, 4)]);
    const [r2] = await db.execute<{ fixed: number }>(sql`SELECT reconcile_shelf_counters() AS fixed`);
    expect(Number(r2!.fixed)).toBe(0);
  });
});

describe('SH-10 · share pages', () => {
  it('uses the configured base URL, a canonical link, and cache headers by audience (A-11-022)', async () => {
    const u = await makeUser(db, 'sharer');
    const pub = await shelfWith(u, 'Share me', []);
    const [p] = await db.select({ slug: shelves.slug }).from(shelves).where(eq(shelves.id, pub));
    const res = await app.inject({ method: 'GET', url: `/u/sharer/shelves/${p!.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toContain(`<link rel="canonical" href="http://localhost:8081/u/sharer/shelves/${p!.slug}" />`);

    const fol = await shelfWith(u, 'Followers share', [], 'followers');
    const fan = await makeUser(db, 'sharefan');
    await follow(db, fan.id, u.id);
    const asFan = await app.inject({ method: 'GET', url: `/shelf/${fol}`, headers: fan.auth });
    expect(asFan.statusCode).toBe(200);
    expect(asFan.headers['cache-control']).toBe('private, no-store');
  });
});

describe('SH-10 · the owner on a shelf carries its avatar URL (A-11-029)', () => {
  it('every shelf response gives owner.avatarUrl, as person objects elsewhere do', async () => {
    const owner = await makeUser(db, 'avatarowner');
    await db.execute(sql`UPDATE profiles SET avatar_key = 'avatars/a11029.webp' WHERE user_id = ${owner.id}`);
    const id = (await createShelf(owner, { name: 'Avatar URL check' })).json().shelf.id;
    const shelf = (await app.inject({ method: 'GET', url: `/v1/shelves/${id}`, headers: owner.auth })).json().shelf;
    const want = '/v1/avatars/avatars/a11029.webp';
    expect(shelf.owner.avatarUrl).toBe(want);
    const slug = (await app.inject({ method: 'GET', url: `/v1/shelves/by-slug/avatarowner/${shelf.slug}` })).json().shelf;
    expect(slug.owner.avatarUrl).toBe(want);
    const browse = (await app.inject({ method: 'GET', url: '/v1/shelves/browse?query=Avatar%20URL%20check&limit=50', headers: owner.auth })).json();
    const card = (browse.shelves ?? browse.data ?? browse.items).find((s: any) => s.id === id);
    expect(card.owner.avatarUrl).toBe(want);
  });
});

describe('SH-08 · a cover-less work in the mosaic (A-15-024)', () => {
  // PGlite decodes {1,NULL,3} as [1, null, 3], so no PGlite test sees this.
  // postgres.js 3.4.9 hands the unquoted NULL to the int4 parser and returns
  // NaN, which the response schema refused: every browse and saved page with
  // such a shelf was a 500 on a real Postgres (15b bench on flyleaf_dev).
  it('decodes what each driver returns for a NULL cover id as null', () => {
    expect(coverIdsFromRow([8315603, NaN, 4202989])).toEqual([8315603, null, 4202989]); // postgres.js
    expect(coverIdsFromRow([8315603, null, 4202989])).toEqual([8315603, null, 4202989]); // PGlite
    expect(coverIdsFromRow('{8315603,NULL,4202989}')).toEqual([8315603, null, 4202989]); // text form
    expect(coverIdsFromRow(null)).toEqual([]);
  });
});
