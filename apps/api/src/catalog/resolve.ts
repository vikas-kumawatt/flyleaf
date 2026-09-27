// D3 (audit 08, A-03-008): a merged work's id keeps working, for reads AND
// writes. PRD §40.3 / §34.1: "the old ID redirects permanently".
//
// A dedupe merge tombstones the loser (works.merged_into_id = survivor) and
// flattens chains, so at rest this is one hop. Every read and write that takes
// a work id resolves it here, once, at the service boundary: an old link, a
// shared card or an offline replay queued against the loser lands on the
// survivor instead of on a tombstone that nothing shows.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';

/**
 * The id a work is known by now, or null when the id names no work.
 *
 * Writes pass `lock: true` and call this INSIDE their transaction. FOR KEY
 * SHARE conflicts with the FOR UPDATE that mergeWorks takes on both works, so
 * a write racing a merge either commits first (and the merge moves what it
 * wrote) or waits for the merge and then reads the tombstone and follows it.
 * The survivor is locked the same way, so it cannot itself be merged away
 * between here and the write.
 */
export async function resolveWorkId(db: Db, id: string, opts: { lock?: boolean } = {}): Promise<string | null> {
  let current = id;
  // One hop at rest; a merge of the survivor running concurrently can add one.
  for (let hop = 0; hop < 4; hop++) {
    const [w] = await db.execute<{ merged_into_id: string | null }>(opts.lock
      ? sql`SELECT merged_into_id FROM works WHERE id = ${current} FOR KEY SHARE`
      : sql`SELECT merged_into_id FROM works WHERE id = ${current}`);
    if (!w) return null;
    if (!w.merged_into_id) return current;
    current = w.merged_into_id;
  }
  throw new Error(`work ${id}: merge chain longer than 4 hops (chains are flattened on merge)`);
}
