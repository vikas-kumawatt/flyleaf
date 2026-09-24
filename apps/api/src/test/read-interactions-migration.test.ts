// SO-20: read_likes + read_comments migrations and trigger-maintained counters.
//
// Verified against real Postgres (PGlite), because every claim here is about
// what the DATABASE does — a trigger, a CHECK, a cascade — not what the
// service layer remembers to do.

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { freshDrizzle, rejected } from './pg.js';
import { reads, readLikes, readComments, workStats } from '../db/schema.js';
import { QUEUES, reconcileReadsJobHandler } from '../jobs/index.js';
import type { Db } from '../platform/index.js';
import { makeUser, makeWork, makeRead } from './interaction-fixtures.js';

async function counts(db: Db, readId: string) {
  const [r] = await db
    .select({ likes: reads.likeCount, comments: reads.commentCount, updatedAt: reads.updatedAt })
    .from(reads)
    .where(eq(reads.id, readId));
  return r!;
}

describe('SO-20: read_likes / read_comments schema and counters', () => {
  let db: Db;
  let client: PGlite;
  let owner: string;
  let fans: string[];
  let readId: string;
  let workId: string;

  beforeEach(async () => {
    ({ db, client } = await freshDrizzle());
    owner = (await makeUser(db, 'owner')).id;
    fans = [];
    for (const n of ['fan_a', 'fan_b', 'fan_c']) fans.push((await makeUser(db, n)).id);
    workId = await makeWork(db, 'Piranesi');
    readId = await makeRead(db, owner, workId, { status: 'finished', rating: '4.5' });
  });

  it('creates read_comments with its indexes, and the likers index on read_likes', async () => {
    const { rows } = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('read_comments', 'read_likes')`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining(['read_comments_read_idx', 'read_comments_user_idx', 'read_likes_read_created_idx']),
    );
  });

  it('has no parent_id column: single-level comments are structural, not a rule', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'read_comments'`,
    );
    const cols = rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(['body', 'created_at', 'deleted_at', 'id', 'read_id', 'user_id']);
  });

  it('like_count follows inserts and deletes on read_likes', async () => {
    for (const fan of fans) await db.insert(readLikes).values({ readId, userId: fan });
    expect((await counts(db, readId)).likes).toBe(3);

    await db.delete(readLikes).where(eq(readLikes.userId, fans[0]!));
    expect((await counts(db, readId)).likes).toBe(2);
  });

  it('the composite primary key makes a double like impossible', async () => {
    await db.insert(readLikes).values({ readId, userId: fans[0]! });
    expect(
      await rejected(client, `INSERT INTO read_likes (read_id, user_id) VALUES ('${readId}', '${fans[0]}')`),
    ).toBe(true);
    expect((await counts(db, readId)).likes).toBe(1);
  });

  it('comment_count counts live comments: soft delete decrements, restore increments', async () => {
    const [c1] = await db.insert(readComments).values({ readId, userId: fans[0]!, body: 'Loved this.' }).returning();
    await db.insert(readComments).values({ readId, userId: fans[1]!, body: 'Same!' });
    expect((await counts(db, readId)).comments).toBe(2);

    await db.update(readComments).set({ deletedAt: new Date() }).where(eq(readComments.id, c1!.id));
    expect((await counts(db, readId)).comments).toBe(1);

    // Updating an already-deleted comment's timestamp again must not double-count.
    await db.update(readComments).set({ deletedAt: new Date() }).where(eq(readComments.id, c1!.id));
    expect((await counts(db, readId)).comments).toBe(1);

    await db.update(readComments).set({ deletedAt: null }).where(eq(readComments.id, c1!.id));
    expect((await counts(db, readId)).comments).toBe(2);

    // Hard delete of a live comment decrements; of a deleted one does not.
    await db.update(readComments).set({ deletedAt: new Date() }).where(eq(readComments.id, c1!.id));
    await db.delete(readComments).where(eq(readComments.id, c1!.id));
    expect((await counts(db, readId)).comments).toBe(1);
  });

  it('rejects empty, whitespace-only and over-2,000-character comment bodies', async () => {
    const insert = (body: string) =>
      rejected(
        client,
        `INSERT INTO read_comments (read_id, user_id, body) VALUES ('${readId}', '${fans[0]}', '${body}')`,
      );
    expect(await insert('')).toBe(true);
    expect(await insert('    ')).toBe(true);
    expect(await insert('x'.repeat(2001))).toBe(true);
    expect(await insert('x'.repeat(2000))).toBe(false);
  });

  it('a like does not bump reads.updated_at (it orders the owner\'s Reading tab)', async () => {
    const before = (await counts(db, readId)).updatedAt.getTime();
    await db.insert(readLikes).values({ readId, userId: fans[0]! });
    await db.insert(readComments).values({ readId, userId: fans[1]!, body: 'Hi' });
    expect((await counts(db, readId)).updatedAt.getTime()).toBe(before);
  });

  it('⚠️ a counter change does NOT re-run the work_stats recompute; a rating change does', async () => {
    const stamp = async () => {
      const [s] = await db.select({ at: workStats.updatedAt }).from(workStats).where(eq(workStats.workId, workId));
      return s!.at.getTime();
    };
    const initial = await stamp();

    // PGlite's now() is the transaction start; each statement here is its own
    // transaction, so a recompute would produce a strictly later timestamp.
    await new Promise((r) => setTimeout(r, 15));
    await db.insert(readLikes).values({ readId, userId: fans[0]! });
    await db.insert(readComments).values({ readId, userId: fans[1]!, body: 'Hi' });
    expect(await stamp()).toBe(initial);

    await new Promise((r) => setTimeout(r, 15));
    await db.update(reads).set({ rating: '3.0' }).where(eq(reads.id, readId));
    expect(await stamp()).toBeGreaterThan(initial);
  });

  it('deleting a read cascades to its likes and comments', async () => {
    await db.insert(readLikes).values({ readId, userId: fans[0]! });
    await db.insert(readComments).values({ readId, userId: fans[1]!, body: 'Hi' });
    await db.delete(reads).where(eq(reads.id, readId));
    const { rows: l } = await client.query(`SELECT 1 FROM read_likes WHERE read_id = '${readId}'`);
    const { rows: c } = await client.query(`SELECT 1 FROM read_comments WHERE read_id = '${readId}'`);
    expect(l.length + c.length).toBe(0);
  });

  it('reconcile_read_counters() repairs drift, touches only drifted rows, and reports how many', async () => {
    const other = await makeRead(db, fans[0]!, workId);
    await db.insert(readLikes).values({ readId, userId: fans[0]! });
    await db.insert(readComments).values({ readId, userId: fans[1]!, body: 'Hi' });

    // Simulate drift: somebody wrote the counters directly (as SL-64 did).
    await db.update(reads).set({ likeCount: 40, commentCount: 9 }).where(eq(reads.id, readId));

    const result = await reconcileReadsJobHandler(
      [{ id: '1', name: QUEUES.reconcileReads, data: undefined }] as never,
      db,
    );
    expect(result).toMatchObject({ reconciled: true, corrected: 1 });
    expect(await counts(db, readId)).toMatchObject({ likes: 1, comments: 1 });
    expect(await counts(db, other)).toMatchObject({ likes: 0, comments: 0 });

    // Healthy table: nothing to do.
    const again = await db.execute<{ n: number }>(sql`SELECT reconcile_read_counters() AS n`);
    expect(Number(again[0]!.n)).toBe(0);
  });
});
