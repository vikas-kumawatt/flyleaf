// Audit 03c: does the backlog's author walk find exactly the pairs the full
// stage 1-2 pass would auto-merge, on THIS database? Read-only.
//
//   DATABASE_URL=…/flyleaf_dev npx tsx src/bench/backlog-parity.ts
//
// Runs detectStage12 (one whole-catalog statement: do NOT run this on the
// full catalog on an 8 GB machine, that is the statement the OOM killer
// took) and detectBacklogPairs with no effective limit, and diffs them.
import { makeDb, closeDb } from '../platform/index.js';
import { detectBacklogPairs, detectStage12 } from '../catalog/dedupe.js';

async function main() {
  const db = makeDb(undefined, { max: 1, quiet: true });
  try {
    const shape = (p: { survivorId: string; loserId: string; stage: number; reason: string }) =>
      `${p.survivorId}>${p.loserId}|${p.stage}|${p.reason}`;
    let t = Date.now();
    const full = await detectStage12(db);
    const fullAuto = new Set(full.pairs.filter((p) => p.auto).map(shape));
    const fullMs = Date.now() - t;
    t = Date.now();
    const walked = await detectBacklogPairs(db, { limit: Number.MAX_SAFE_INTEGER - 1 });
    const walkMs = Date.now() - t;
    const walkedSet = new Set(walked.pairs.map(shape));
    const onlyFull = [...fullAuto].filter((x) => !walkedSet.has(x));
    const onlyWalk = [...walkedSet].filter((x) => !fullAuto.has(x));
    console.log(`full pass: ${fullAuto.size} auto pairs in ${Math.round(fullMs / 1000)} s; held ${JSON.stringify(full.held)}`);
    console.log(`author walk: ${walkedSet.size} auto pairs in ${Math.round(walkMs / 1000)} s over ${walked.authorsScanned} authors; held ${JSON.stringify(walked.held)}`);
    console.log(`only in the full pass: ${onlyFull.length}; only in the walk: ${onlyWalk.length}`);
    for (const x of [...onlyFull.slice(0, 10), ...onlyWalk.slice(0, 10)]) console.log(`  ${x}`);
  } finally {
    await closeDb(db);
  }
}

void main();
