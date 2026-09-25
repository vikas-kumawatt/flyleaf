// Audit Part 02: does the API's own driver path drift onto a generic plan?
// Runs CatalogService.search (no gap-fill) repeatedly on ONE pooled
// connection, timing each call, then reads pg_prepared_statements.
// Usage: DATABASE_URL=... npx tsx src/bench/generic-plan-probe.ts q1 q2 ...
import { sql } from 'drizzle-orm';
import { makeDb, closeDb, MemoryCache } from '../platform/index.js';
import { CatalogService } from '../catalog/index.js';

const db = makeDb(undefined, { max: 1 });
const catalog = new CatalogService(db, new MemoryCache());
const queries = process.argv.slice(2);
await db.execute(sql`SET statement_timeout = 120000`);
for (const q of queries) {
  const t = performance.now();
  try {
    const rows = await catalog.search(null, q);
    console.log(`${q.padEnd(14)} ${(performance.now() - t).toFixed(0).padStart(7)} ms  rows=${rows.length}`);
  } catch (e) {
    console.log(`${q.padEnd(14)} ${(performance.now() - t).toFixed(0).padStart(7)} ms  ERROR ${(e as Error).message}`);
  }
}
const ps = await db.execute<{ generic_plans: number; custom_plans: number; statement: string }>(sql`
  SELECT generic_plans, custom_plans, left(regexp_replace(statement, '\s+', ' ', 'g'), 50) AS statement
  FROM pg_prepared_statements WHERE statement LIKE '%title_fuzzy%'`);
console.log(ps);
await closeDb(db);
