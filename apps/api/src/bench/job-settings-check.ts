// Shows the settings each batch process's connections run under (Audit 15,
// A-03-026), read back from the server, next to the API's.
//
//   npx tsx src/bench/job-settings-check.ts

import { sql } from 'drizzle-orm';
import { closeDb, JOB_DB_SETTINGS, makeDb } from '../platform/index.js';

const show = sql`SELECT current_setting('work_mem') AS work_mem,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('max_parallel_workers_per_gather') AS parallel,
  current_setting('idle_in_transaction_session_timeout') AS idle_in_tx,
  current_setting('pg_trgm.similarity_threshold', true) AS trgm`;

for (const [name, settings] of [['api', undefined], ...Object.entries(JOB_DB_SETTINGS)] as const) {
  const db = makeDb(undefined, { max: 1, settings });
  const [row] = await db.execute(show);
  console.log(name.padEnd(7), JSON.stringify(row));
  await closeDb(db);
}
