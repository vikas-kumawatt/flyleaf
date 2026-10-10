// Key-range walking for batch jobs (Audit 15, A-03-026).
//
// A nightly job that aggregates a whole table in one statement holds memory
// and time that grow with the table; one such statement took the server down
// in Part 03c. These helpers cut a table's key space into ranges of about
// `batch` rows and hand each [lo, hi) to the job, so every statement is short
// and bounded, and the job's work_mem and statement_timeout (JOB_DB_SETTINGS)
// apply per range. The ranges cover the whole uuid space (lo starts at the
// nil uuid, the last hi is NULL), so a row with no entry in the walked index
// still falls in some range.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';

/** Authors per range for the has_works repair: the table is 15.4M rows on the full catalog. */
export const AUTHOR_REPAIR_BATCH = 20_000;

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A table's uuid key that an index orders, e.g. reads.work_id via reads_work_idx. */
export type RangeKey =
  | { table: 'reads'; column: 'id' | 'work_id' }
  | { table: 'profiles'; column: 'user_id' }
  | { table: 'shelves'; column: 'id' }
  | { table: 'authors'; column: 'id' }
  | { table: 'events'; column: 'id' };

/**
 * Calls `fn(lo, hi)` for consecutive ranges of about `batch` rows of
 * `key`, in key order; `hi` is NULL for the last range. A key shared by more
 * than `batch` rows (a work with many reads) is one range on its own.
 */
export async function walkRanges(
  db: Db,
  key: Exclude<RangeKey, { table: 'events' }>,
  batch: number,
  fn: (lo: string, hi: string | null) => Promise<void>,
): Promise<number> {
  const col = sql.raw(`${key.column}`);
  const tbl = sql.raw(`${key.table}`);
  let lo = NIL_UUID;
  let ranges = 0;
  for (;;) {
    const [b] = await db.execute<{ k: string }>(sql`
      SELECT ${col}::text AS k FROM ${tbl} WHERE ${col} >= ${lo}::uuid
      ORDER BY ${col} OFFSET ${batch} LIMIT 1`);
    let hi = b?.k ?? null;
    if (hi !== null && hi === lo) {
      // Over `batch` rows share this key: take the next key after it.
      const [n] = await db.execute<{ k: string | null }>(sql`
        SELECT ${col}::text AS k FROM ${tbl} WHERE ${col} > ${lo}::uuid ORDER BY ${col} LIMIT 1`);
      hi = n?.k ?? null;
    }
    await fn(lo, hi);
    ranges++;
    if (hi === null) return ranges;
    lo = hi;
  }
}
