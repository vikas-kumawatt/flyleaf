// Row counts and an md5 fingerprint of every user-owned table's NON-bench
// rows (Audit 15 §6, for docs/audit/15b-laptop.md). READ-ONLY.
//
//   npx tsx src/bench/nonbench-counts.ts > before.txt
//   … npm run bench:seed -- --clean …
//   npx tsx src/bench/nonbench-counts.ts > after.txt && diff before.txt after.txt
//
// A row is a bench row when its user is a bench user, by the same rule as
// `bench:seed --clean` (username `bench_%` AND email `@bench.flyleaf.invalid`).
// Part 01 verified its clean the same way (counts + md5 over rows) but did not
// record the numbers, so the comparison is between two runs of this script.

import { sql } from 'drizzle-orm';
import { closeDb, config, makeDb } from '../platform/index.js';
import { BENCH_EMAIL_DOMAIN } from './seed.js';

/** Table, the column naming its owning user. */
const TABLES: [string, string][] = [
  ['users', 'id'], ['profiles', 'user_id'], ['reads', 'user_id'], ['reviews', 'user_id'],
  ['read_likes', 'user_id'], ['read_comments', 'user_id'], ['follows', 'follower_id'],
  ['blocks', 'blocker_id'], ['mutes', 'user_id'], ['activity', 'actor_id'], ['shelves', 'user_id'],
  ['shelf_saves', 'user_id'], ['imports', 'user_id'], ['exports', 'user_id'], ['refresh_tokens', 'user_id'],
];

const db = makeDb(config.databaseUrl, { max: 1, quiet: true });
console.log(`# database: ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
try {
  for (const [table, col] of TABLES) {
    const t = sql.raw(table);
    const c = sql.raw(col);
    const [r] = await db.execute<{ n: number; md5: string | null }>(sql`
      SELECT count(*)::int AS n, md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))) AS md5
      FROM ${t} x
      WHERE NOT EXISTS (
        SELECT 1 FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.id = x.${c} AND p.username LIKE 'bench\\_%' AND u.email LIKE ${'%@' + BENCH_EMAIL_DOMAIN})`);
    console.log(`${table.padEnd(16)} ${String(r!.n).padStart(10)}  ${r!.md5 ?? '-'}`);
  }
} finally {
  await closeDb(db);
}
