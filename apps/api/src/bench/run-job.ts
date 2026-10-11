// Runs one batch job once, as the worker would, and reports its result and
// time (Audit 15, A-03-026; for docs/audit/15b-laptop.md):
//
//   npx tsx src/bench/run-job.ts <reconcile.reads|reconcile.follows|reconcile.shelves|reconcile.works|authors.repair>
//
// Uses the worker's pool settings (JOB_DB_SETTINGS.worker: work_mem 32 MB,
// statement_timeout 10 min, one connection), so a range that would exceed
// them fails here exactly as it would at night. These jobs only repair
// counters and flags to their true values; they delete nothing.

import { closeDb, config, JOB_DB_SETTINGS, makeDb } from '../platform/index.js';
import {
  reconcileFollowsJobHandler,
  reconcileReadsJobHandler,
  reconcileShelvesJobHandler,
  reconcileWorksJobHandler,
  repairAuthorsJobHandler,
} from '../jobs/index.js';

const JOBS = {
  'reconcile.reads': reconcileReadsJobHandler,
  'reconcile.follows': reconcileFollowsJobHandler,
  'reconcile.shelves': reconcileShelvesJobHandler,
  'reconcile.works': reconcileWorksJobHandler,
  'authors.repair': repairAuthorsJobHandler,
} as const;

const name = process.argv[2] as keyof typeof JOBS | undefined;
if (!name || !(name in JOBS)) {
  console.error(`usage: run-job.ts <${Object.keys(JOBS).join('|')}>`);
  process.exit(2);
}
const db = makeDb(config.databaseUrl, { max: 1, quiet: true, settings: JOB_DB_SETTINGS.worker });
console.log(`database: ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')} · job ${name}`);
try {
  const t0 = Date.now();
  const result = await JOBS[name]([], db);
  console.log(JSON.stringify(result, null, 2));
  console.log(`took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} finally {
  await closeDb(db);
}
