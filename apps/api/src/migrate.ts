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
import { config } from './platform/index.js';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/D:/..."
// with a leading slash, and every path built from it is wrong.
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * pg_trgm's match threshold, raised from the 0.3 default. See the note in
 * PREREQUISITE_SQL. Exported so the test harness can apply the same value --
 * `ALTER DATABASE` only affects NEW connections, and a test's connection is
 * already open, so without this tests would silently run at 0.3 while
 * production runs at 0.45.
 */
export const TRIGRAM_THRESHOLD = 0.45;

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
