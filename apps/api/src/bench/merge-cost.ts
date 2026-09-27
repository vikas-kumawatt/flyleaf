// Audit 08 (A-03-016): what a dedupe merge and its undo cost on THIS database,
// for a work with many reads. Runs mergeWorks + undoMerge inside one
// transaction and rolls it back, so nothing is left behind.
//
//   DATABASE_URL=…/flyleaf_dev npx tsx src/bench/merge-cost.ts [--reads 500]
//
// The loser is the bench work whose read count is closest to --reads; the
// survivor is a live work with no reads, so the merge moves exactly the
// loser's reads.
import { sql } from 'drizzle-orm';
import { makeDb, closeDb } from '../platform/index.js';
import { mergeWorks, undoMerge } from '../catalog/dedupe.js';

class Rollback extends Error {}

async function main() {
  const i = process.argv.indexOf('--reads');
  const target = i === -1 ? 500 : Number(process.argv[i + 1]);
  const db = makeDb();
  try {
    const [loser] = await db.execute<{ work_id: string; n: number }>(sql`
      SELECT work_id, count(*)::int AS n FROM reads GROUP BY work_id
      ORDER BY abs(count(*) - ${target}), work_id LIMIT 1`);
    const [survivor] = await db.execute<{ id: string }>(sql`
      SELECT w.id FROM works w
      WHERE w.merged_into_id IS NULL AND w.id <> ${loser!.work_id}
        AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.work_id = w.id)
      ORDER BY w.id LIMIT 1`);
    console.log(`loser ${loser!.work_id} (${loser!.n} reads) → survivor ${survivor!.id}`);

    let mergeMs = 0;
    let undoMs = 0;
    try {
      await db.transaction(async (tx) => {
        const t0 = performance.now();
        const { mergeId } = await mergeWorks(tx as never, {
          survivorId: survivor!.id, loserId: loser!.work_id, stage: 1, reason: 'bench: merge-cost',
        });
        mergeMs = performance.now() - t0;
        const t1 = performance.now();
        await undoMerge(tx as never, mergeId);
        undoMs = performance.now() - t1;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    console.log(`merge ${mergeMs.toFixed(0)} ms · undo ${undoMs.toFixed(0)} ms · rolled back`);
  } finally {
    await closeDb(db);
  }
}

void main();
