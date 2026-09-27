// Migration runner. `npm run migrate`.
//
// Two steps, in this order, and the order is the whole point:
//
//   1. Prerequisites that drizzle-kit cannot express -- extensions and one
//      function. These are idempotent DDL, applied on every run.
//   2. The generated journal in ./drizzle.
//
// Step 1 is not in the journal because the journal's FIRST migration already
// depends on it: `works.search_vector` is a GENERATED column whose expression
// calls `flyleaf_unaccent`, so the function has to exist before the table is
// created. A migration cannot be a prerequisite of itself.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config, TRIGRAM_THRESHOLD } from './platform/index.js';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/..."
// with a leading slash, and every path built from it is wrong.
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * pg_trgm's match threshold, raised from the 0.3 default. See the note in
 * PREREQUISITE_SQL. Re-exported so the test harness can apply the same value
 * -- `ALTER DATABASE` only affects NEW connections, and a test's connection
 * is already open, so without this tests would silently run at 0.3 while
 * production runs at 0.45. Defined in platform/, which also sends it on
 * every pooled connection.
 */
export { TRIGRAM_THRESHOLD };

/**
 * Everything the generated migrations assume already exists.
 *
 * `unaccent(text)` is STABLE, not IMMUTABLE -- it resolves its dictionary
 * through `search_path`, so Postgres refuses it in a generated column or an
 * index expression:
 *
 *     ERROR: generation expression is not immutable
 *
 * The two-argument form `unaccent(regdictionary, text)` IS immutable, because
 * the dictionary is pinned. This wrapper is the standard way to get an
 * immutable unaccent, and every expression that needs one must call it rather
 * than `unaccent` directly.
 *
 * architecture.md §3.8 originally specified bare `unaccent()`. That DDL does
 * not run. This is the correction.
 */
export const PREREQUISITE_SQL: readonly string[] = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  `CREATE OR REPLACE FUNCTION flyleaf_unaccent(text)
     RETURNS text
     LANGUAGE sql
     IMMUTABLE
     STRICT
     PARALLEL SAFE
   AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$`,

  // The same trap a second time. `array_to_string(anyarray, text)` is also
  // STABLE, so joining alternate_titles inside the generated column failed
  // with the identical "generation expression is not immutable".
  //
  // It is STABLE because for an arbitrary element type the output function
  // need not be immutable. Pinning the signature to text[] makes the
  // IMMUTABLE claim here an honest one rather than a promise we cannot keep.
  `CREATE OR REPLACE FUNCTION flyleaf_unaccent_array(text[])
     RETURNS text
     LANGUAGE sql
     IMMUTABLE
     STRICT
     PARALLEL SAFE
   AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, array_to_string($1, ' ')) $$`,

  /**
   * One searchable string per author: their name plus every alias.
   *
   * A FUNCTION rather than an inline expression because the index and the
   * query must be byte-identical or Postgres will not use the index. Two
   * copies of `name || ' ' || array_to_string(...)` drift; one function
   * cannot.
   *
   * IMMUTABLE for the usual reason -- `array_to_string(anyarray, text)` is
   * only STABLE, and an index expression must be immutable. Pinning the
   * signature to (text, text[]) makes the claim honest.
   */
  `CREATE OR REPLACE FUNCTION flyleaf_author_names(text, text[])
     RETURNS text
     LANGUAGE sql
     IMMUTABLE
     STRICT
     PARALLEL SAFE
   AS $$ SELECT $1 || ' ' || array_to_string($2, ' ') $$`,

  // Trigram threshold, raised from the 0.3 default.
  //
  // MEASURED, not guessed. `EXPLAIN (ANALYZE, BUFFERS)` on the real 3.2M-work
  // catalog showed the fuzzy-title arm taking 235ms of a 271ms query:
  //
  //     Bitmap Index Scan on works_title_trgm_idx  rows=13545
  //     Bitmap Heap Scan   Rows Removed by Index Recheck: 13497
  //                        Heap Blocks: exact=12921   read=12956
  //
  // At 0.3, "murakami" matched 13,545 titles in the index; Postgres then read
  // ~100 MB of heap to recheck them and threw away 13,497. On a slow disk
  // that is also where the multi-second cold-cache latency came from.
  //
  // 0.45 keeps every typo case the tests require -- "piranese"/Piranesi is
  // 0.636, "the hobit"/The Hobbit is 0.750 -- while dropping the noise that
  // was reaching real results: Piranha 0.417, Pirate 0.333.
  //
  // Set on the DATABASE so every connection inherits it; a plain SET would
  // apply to one pooled connection out of ten. New connections only, so the
  // API needs a restart after this runs.
  `DO $do$ BEGIN
     EXECUTE format('ALTER DATABASE %I SET pg_trgm.similarity_threshold = ${TRIGRAM_THRESHOLD}',
                    current_database());
   END $do$`,

  // ALTER DATABASE takes effect for NEW connections only, so also set it on
  // this one -- otherwise `npm run migrate && npm run ingest` in the same
  // breath would still be running at the old value.
  `SET pg_trgm.similarity_threshold = ${TRIGRAM_THRESHOLD}`,
];

/** Drops an index left INVALID by an interrupted CREATE INDEX CONCURRENTLY, which IF NOT EXISTS would otherwise keep forever. */
const dropIfInvalid = (index: string) => `DO $do$ BEGIN
     IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                WHERE c.relname = '${index}' AND NOT i.indisvalid) THEN
       EXECUTE 'DROP INDEX ${index}';
     END IF;
   END $do$`;

/**
 * Steps that cannot run inside drizzle's migration transaction, applied
 * AFTER the journal on every run. Each must be idempotent.
 *
 * `CREATE INDEX CONCURRENTLY` refuses to run in a transaction block, and on
 * a large table the plain form holds a lock that blocks writes for the whole
 * build (the LA-05 lesson from 0019). Plain strings, so the test harness
 * replays the same list against PGlite.
 */
export const ONLINE_SQL: readonly string[] = [
  // Audit 08 (0026): the per-work aggregate in recompute_work_stats_for_work,
  // a work's reads, the dedupe merge and impact scans. user_id second so the
  // distinct-reader count is an index-only scan.
  dropIfInvalid('reads_work_idx'),
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS reads_work_idx ON reads (work_id, user_id)`,
  // Popularity order for search, now that log_count is virtual (0026). The
  // expression must stay ol_log_count + reader_count, byte for byte, or the
  // planner will not match ORDER BY log_count to it.
  dropIfInvalid('works_log_count_idx'),
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS works_log_count_idx ON works ((ol_log_count + reader_count))`,
  `DROP INDEX CONCURRENTLY IF EXISTS works_ol_log_count_idx`,
  // Audit 03c: every merge looks up the works already merged into the loser
  // (chain flattening) and undo re-chains them. Without this, each lookup was
  // a parallel seq scan of all 3.4M works (204k buffers, 2.5-53 s on the full
  // catalog), twice per merge. Partial: only tombstones have the column set.
  dropIfInvalid('works_merged_into_idx'),
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS works_merged_into_idx ON works (merged_into_id) WHERE merged_into_id IS NOT NULL`,
];

/**
 * works.reader_count from `reads`, in batches of works (0026). Only rows that
 * differ are written; on a healthy database this reads the index and writes
 * nothing. Not atomic with concurrent writers: a read logged between a
 * batch's count and its write can be overwritten, and the nightly
 * works.reconcile repairs it.
 */
async function backfillReaderCounts(client: postgres.Sql): Promise<number> {
  let after = '00000000-0000-0000-0000-000000000000';
  let fixed = 0;
  for (;;) {
    const [row] = await client<{ last: string | null; fixed: number }[]>`
      WITH batch AS (
        SELECT work_id, count(DISTINCT user_id)::int AS n FROM reads
        WHERE work_id > ${after}::uuid
        GROUP BY work_id ORDER BY work_id LIMIT 2000
      ),
      upd AS (
        UPDATE works w SET reader_count = b.n FROM batch b
        WHERE w.id = b.work_id AND w.reader_count <> b.n
        RETURNING 1
      )
      SELECT (SELECT work_id FROM batch ORDER BY work_id DESC LIMIT 1) AS last,
             (SELECT count(*) FROM upd)::int AS fixed`;
    if (!row?.last) return fixed;
    after = row.last;
    fixed += row.fixed;
  }
}

export async function runMigrations(url: string = config.databaseUrl): Promise<void> {
  // max: 1 -- migrations are serial by definition, and a pool here just makes
  // advisory locking harder to reason about.
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);

  try {
    // Plain strings, so the schema test can replay the exact same list
    // against PGlite. One source of truth for "what must exist first".
    for (const statement of PREREQUISITE_SQL) {
      await db.execute(sql.raw(statement));
    }
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    for (const statement of ONLINE_SQL) {
      await client.unsafe(statement);
    }
    const fixed = await backfillReaderCounts(client);
    if (fixed) console.log(`reader_count backfilled on ${fixed} works`);
  } finally {
    await client.end();
  }
}

// Run directly: `npm run migrate`
const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error('migration failed:', err);
      process.exit(1);
    });
}
