// Work counters kept from `reads` (audit 08, migration 0026).
//
//   L-01      work_stats is recomputed per affected work, by statement-level
//             triggers, with the catalog mean C read from a cached row
//             instead of a scan of every read.
//   A-02-013  works.log_count = ol_log_count (Open Library's baseline) +
//             reader_count (distinct Flyleaf users with any read of the
//             work). Each way reads change has a defined effect, pinned here;
//             the dedupe merge and undo are in dedupe.test.ts.
//   works.reconcile repairs both nightly.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import type { Db } from '../platform/index.js';
import { ReadingService } from '../reading/index.js';
import { QUEUES, reconcileWorksJobHandler } from '../jobs/index.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead } from './interaction-fixtures.js';

let db: Db;
let client: { close: () => Promise<void> };

beforeEach(async () => {
  await client?.close();
  ({ db, client } = await freshDrizzle());
});
afterAll(async () => { await client?.close(); });

async function counts(workId: string) {
  const [w] = await db.execute<{ ol_log_count: number; reader_count: number; log_count: number }>(sql`
    SELECT ol_log_count, reader_count, log_count FROM works WHERE id = ${workId}`);
  return { ol: Number(w!.ol_log_count), readers: Number(w!.reader_count), logs: Number(w!.log_count) };
}

async function stats(workId: string) {
  const [s] = await db.execute<{
    rating_count: number; avg_rating: string | null; weighted_rating: string | null;
    read_count: number; updated_at: string;
  }>(sql`
    SELECT rating_count, avg_rating, weighted_rating, read_count, updated_at::text AS updated_at
    FROM work_stats WHERE work_id = ${workId}`);
  return s;
}

const reconcile = () =>
  reconcileWorksJobHandler([{ id: '1', name: QUEUES.reconcileWorks, data: undefined }] as never, db);

describe('works.log_count = ol_log_count + distinct readers (A-02-013)', () => {
  it('is the OL baseline plus the readers', async () => {
    const work = await makeWork(db, 'Piranesi');
    await db.execute(sql`UPDATE works SET ol_log_count = 40 WHERE id = ${work}`);
    const a = await makeUser(db, 'a');
    const b = await makeUser(db, 'b');
    await makeRead(db, a.id, work, { status: 'want' });
    await makeRead(db, b.id, work, { status: 'dnf' });

    expect(await counts(work)).toEqual({ ol: 40, readers: 2, logs: 42 });
  });

  it('a re-read does not count the reader again', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    const reading = new ReadingService(db);
    await reading.upsert(a.id, work, 'finished');
    const again = await reading.upsert(a.id, work, 'reading');

    expect(again.attempt_no).toBe(2);
    expect(await counts(work)).toEqual({ ol: 0, readers: 1, logs: 1 });
  });

  it('an imported read counts', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    await db.execute(sql`
      INSERT INTO reads (user_id, work_id, status, source) VALUES (${a.id}, ${work}, 'finished', 'import')`);

    expect((await counts(work)).readers).toBe(1);
  });

  it('deleting one of two attempts keeps the reader; deleting the last uncounts them', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    const first = await makeRead(db, a.id, work, { attemptNo: 1 });
    const second = await makeRead(db, a.id, work, { attemptNo: 2, status: 'reading' });

    await db.execute(sql`DELETE FROM reads WHERE id = ${first}`);
    expect((await counts(work)).readers).toBe(1);
    await db.execute(sql`DELETE FROM reads WHERE id = ${second}`);
    expect((await counts(work)).readers).toBe(0);
  });

  it('account deletion uncounts the reader and their rating', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    const b = await makeUser(db, 'b');
    await makeRead(db, a.id, work, { rating: '5.0' });
    await makeRead(db, b.id, work, { rating: '3.0' });

    await db.execute(sql`DELETE FROM users WHERE id = ${a.id}`);

    expect((await counts(work)).readers).toBe(1);
    const s = await stats(work);
    expect(Number(s!.rating_count)).toBe(1);
    expect(s!.avg_rating).toBe('3.00');
  });

  it('moving a read to another work moves the reader', async () => {
    const from = await makeWork(db, 'Piranesi');
    const to = await makeWork(db, 'Piranesi (another record)');
    const a = await makeUser(db, 'a');
    const read = await makeRead(db, a.id, from);

    await db.execute(sql`UPDATE reads SET work_id = ${to} WHERE id = ${read}`);

    expect((await counts(from)).readers).toBe(0);
    expect((await counts(to)).readers).toBe(1);
  });
});

describe('work_stats (L-01)', () => {
  it('scores with the cached catalog mean, not a live scan of every rating', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    // The cache says C = 3.0. A live AVG over reads would say 5.0 (the only
    // rating is this one), which is what the old per-write scan computed.
    await db.execute(sql`
      INSERT INTO catalog_rating_stats (id, rating_sum, rating_count) VALUES (true, 30, 10)
      ON CONFLICT (id) DO UPDATE SET rating_sum = 30, rating_count = 10`);
    await makeRead(db, a.id, work, { rating: '5.0' });

    // (1/26)·5 + (25/26)·3 = 3.0769
    expect((await stats(work))!.weighted_rating).toBe('3.08');
  });

  it('falls back to C = 3.9 before anything is rated', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    await db.execute(sql`DELETE FROM catalog_rating_stats`);
    await makeRead(db, a.id, work, { rating: '5.0' });

    // (1/26)·5 + (25/26)·3.9 = 3.9423
    expect((await stats(work))!.weighted_rating).toBe('3.94');
  });

  it('a like or comment counter update does not recompute the work', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    const read = await makeRead(db, a.id, work, { rating: '4.0' });
    const before = (await stats(work))!.updated_at;

    await db.execute(sql`UPDATE reads SET like_count = like_count + 1, comment_count = 3 WHERE id = ${read}`);
    expect((await stats(work))!.updated_at).toBe(before);

    await db.execute(sql`UPDATE reads SET rating = 3.5 WHERE id = ${read}`);
    expect((await stats(work))!.avg_rating).toBe('3.50');
  });

  it('one statement touching many reads of a work leaves the right totals', async () => {
    const work = await makeWork(db, 'Piranesi');
    const users = await Promise.all(['a', 'b', 'c', 'd'].map((n) => makeUser(db, n)));
    await db.execute(sql`
      INSERT INTO reads (user_id, work_id, status, rating)
      SELECT u, ${work}::uuid, 'finished', 4.0 FROM unnest(${sql.raw(`ARRAY[${users.map((u) => `'${u.id}'::uuid`).join(',')}]`)}) AS u`);

    const s = await stats(work);
    expect(Number(s!.rating_count)).toBe(4);
    expect(Number(s!.read_count)).toBe(4);
    expect((await counts(work)).readers).toBe(4);
  });
});

describe('works.reconcile', () => {
  it('refreshes the catalog mean and repairs drifted counters, then finds nothing', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    await makeRead(db, a.id, work, { rating: '5.0' });
    // Drift that only a path bypassing the triggers could cause.
    await db.execute(sql`UPDATE works SET reader_count = 99 WHERE id = ${work}`);
    await db.execute(sql`UPDATE work_stats SET rating_count = 42 WHERE work_id = ${work}`);

    const first = await reconcile();
    expect(first.readerCount).toBe(1);
    expect(first.workStats).toBeGreaterThanOrEqual(1);
    expect(first.catalogMean).toBe(5);
    expect((await counts(work)).readers).toBe(1);
    expect(Number((await stats(work))!.rating_count)).toBe(1);
    // C refreshed to 5.0: (1/26)·5 + (25/26)·5 = 5.00
    expect((await stats(work))!.weighted_rating).toBe('5.00');

    const second = await reconcile();
    expect(second.readerCount).toBe(0);
    expect(second.workStats).toBe(0);
  });

  it('creates the row for a work whose reads arrived with triggers off (A-09-035: devdb:build)', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    // What devdb:build's copy does, and what reads written before 0011 look like.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`INSERT INTO reads (user_id, work_id, status, rating) VALUES (${a.id}, ${work}, 'finished', 4.0)`);
    });
    expect(await stats(work)).toBeUndefined();

    await reconcile();
    expect(Number((await stats(work))!.rating_count)).toBe(1);
    expect((await counts(work)).readers).toBe(1);
  });

  it('is scheduled nightly by the worker', async () => {
    const fs = await import('node:fs');
    const worker = fs.readFileSync(new URL('../worker.ts', import.meta.url), 'utf8');
    expect(worker).toMatch(/boss\.schedule\(QUEUES\.reconcileWorks,/);
  });
});

// Audit 09b (A-09-027, owner decision 2026-09-30): each reader counts once in
// the rating aggregates, with the rating of their most recent RATED attempt.
// heart_count, read_count and dnf_count already counted distinct readers.
describe('ratings count each reader once, at their latest rated attempt (A-09-027)', () => {
  async function ratingRow(workId: string) {
    const [s] = await db.execute<{ rating_count: number; rating_sum: string; avg_rating: string | null }>(sql`
      SELECT rating_count, rating_sum::text AS rating_sum, avg_rating FROM work_stats WHERE work_id = ${workId}`);
    return { count: Number(s!.rating_count), sum: s!.rating_sum, avg: s!.avg_rating };
  }

  it('a re-reader who rated 5 then 3 counts once, as 3', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    await makeRead(db, a.id, work, { attemptNo: 1, rating: '5.0' });
    await makeRead(db, a.id, work, { attemptNo: 2, rating: '3.0' });

    expect(await ratingRow(work)).toEqual({ count: 1, sum: '3.0', avg: '3.00' });
  });

  it('clearing the newest rating falls back to the earlier rated attempt; an unrated newer attempt changes nothing', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    await makeRead(db, a.id, work, { attemptNo: 1, rating: '5.0' });
    const second = await makeRead(db, a.id, work, { attemptNo: 2, rating: '3.0' });

    await db.execute(sql`UPDATE reads SET rating = NULL WHERE id = ${second}`);
    expect(await ratingRow(work)).toEqual({ count: 1, sum: '5.0', avg: '5.00' });

    await makeRead(db, a.id, work, { attemptNo: 3, status: 'reading' });
    expect(await ratingRow(work)).toEqual({ count: 1, sum: '5.0', avg: '5.00' });
  });

  it('two users count twice', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    const b = await makeUser(db, 'b');
    await makeRead(db, a.id, work, { rating: '4.0' });
    await makeRead(db, b.id, work, { rating: '2.0' });

    expect(await ratingRow(work)).toEqual({ count: 2, sum: '6.0', avg: '3.00' });
  });

  it('the nightly reconcile computes exactly what the trigger stored', async () => {
    const [w1, w2] = [await makeWork(db, 'Piranesi'), await makeWork(db, 'Jonathan Strange')];
    const [a, b, c] = [await makeUser(db, 'a'), await makeUser(db, 'b'), await makeUser(db, 'c')];
    await makeRead(db, a.id, w1, { attemptNo: 1, rating: '5.0' });
    await makeRead(db, a.id, w1, { attemptNo: 2, rating: '1.5' });
    await makeRead(db, a.id, w1, { attemptNo: 3, status: 'reading' });
    await makeRead(db, b.id, w1, { attemptNo: 1, rating: '4.5' });
    const cleared = await makeRead(db, b.id, w1, { attemptNo: 2, rating: '2.0' });
    await db.execute(sql`UPDATE reads SET rating = NULL WHERE id = ${cleared}`);
    await makeRead(db, c.id, w1, { rating: null, status: 'dnf' });
    await makeRead(db, a.id, w2, { attemptNo: 1, rating: '3.5' });
    await makeRead(db, a.id, w2, { attemptNo: 2, rating: '0.5' });
    await makeRead(db, c.id, w2, { rating: '5.0' });

    // Same C for both paths: refresh it, then recompute through the trigger's
    // own function, as a write would have.
    await db.execute(sql`SELECT refresh_catalog_rating_mean()`);
    await db.execute(sql`SELECT recompute_work_stats_for_work(w) FROM unnest(${sql.raw(`ARRAY['${w1}','${w2}']::uuid[]`)}) AS w`);
    expect(await ratingRow(w1)).toEqual({ count: 2, sum: '6.0', avg: '3.00' });
    expect(await ratingRow(w2)).toEqual({ count: 2, sum: '5.5', avg: '2.75' });

    const result = await reconcile();
    expect(result.workStats).toBe(0);
    expect(result.readerCount).toBe(0);
  });

  it('the catalog mean C is taken over the same population', async () => {
    const work = await makeWork(db, 'Piranesi');
    const a = await makeUser(db, 'a');
    const b = await makeUser(db, 'b');
    await makeRead(db, a.id, work, { attemptNo: 1, rating: '5.0' });
    await makeRead(db, a.id, work, { attemptNo: 2, rating: '1.0' });
    await makeRead(db, b.id, work, { rating: '4.0' });

    await db.execute(sql`SELECT refresh_catalog_rating_mean()`);
    const [row] = await db.execute<{ c: string; ws: string }>(sql`
      SELECT (SELECT row(rating_sum, rating_count)::text FROM catalog_rating_stats) AS c,
             (SELECT row(SUM(rating_sum)::numeric(14, 1), SUM(rating_count))::text FROM work_stats) AS ws`);
    expect(row!.c).toBe('(5.0,2)');
    expect(row!.c).toBe(row!.ws);
  });
});
