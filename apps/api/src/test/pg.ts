// A real Postgres for tests, with no Docker and no shared state.
//
// PGlite is Postgres compiled to WebAssembly. It is the actual engine --
// generated columns, CHECK constraints, GIN indexes, pg_trgm similarity and
// tsvector all behave exactly as they do in production, which a mock or an
// in-memory shim cannot claim. Each call gets its own empty database in
// memory, so tests cannot leak into each other and there is no teardown.
//
// This is what makes FN-01's "migrations run clean on an empty database" a
// test rather than a manual step, and it is why CI needs no services.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { drizzle } from 'drizzle-orm/pglite';
import { PREREQUISITE_SQL, TRIGRAM_THRESHOLD } from '../migrate.js';
import * as schema from '../db/schema.js';
import type { Db } from '../platform/index.js';

const DRIZZLE_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

type JournalEntry = { tag: string };

/** Every migration file, in journal order — not alphabetical order. */
export function migrationFiles(): { tag: string; sql: string }[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };

  return journal.entries.map((entry) => ({
    tag: entry.tag,
    // drizzle-kit separates statements with a marker rather than relying on
    // semicolon splitting, which would break on function bodies.
    sql: fs
      .readFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      .join('\n'),
  }));
}

/** A fresh database with the prerequisites and every migration applied. */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pg_trgm, unaccent } });
  for (const statement of PREREQUISITE_SQL) await db.exec(statement);
  // Production raises this on the DATABASE, which only reaches NEW
  // connections. This one is already open, so set it here too or the tests
  // quietly exercise a different threshold than the app.
  await db.exec(`SET pg_trgm.similarity_threshold = ${TRIGRAM_THRESHOLD}`);
  for (const { sql } of migrationFiles()) await db.exec(sql);
  return db;
}

/**
 * The same fresh database, wrapped in Drizzle.
 *
 * Lets a service that takes a `Db` be tested against real Postgres semantics
 * -- transactions, ON CONFLICT, CHECK constraints -- rather than against a
 * hand-written fake that agrees with whatever the code already does.
 */
export async function freshDrizzle() {
  const client = await freshDb();
  const db = drizzle(client, { schema });
  return { db: asProductionDb(db), client };
}

/**
 * Make the PGlite driver behave like the postgres-js one.
 *
 * They disagree on what `execute` returns: postgres-js gives a plain array of
 * rows, PGlite gives `{ rows, fields, ... }`. Every service in this codebase
 * is written against the production driver and destructures the result --
 * `const [row] = await db.execute(...)` -- which silently yields `undefined`
 * under PGlite.
 *
 * The adaptation belongs HERE, in the harness, not in the services. Bending
 * production code so a test can run is how a test stops proving anything
 * about production.
 */
function asProductionDb(db: unknown): Db {
  const unwrap = (result: unknown) =>
    result && typeof result === 'object' && 'rows' in result
      ? (result as { rows: unknown[] }).rows
      : result;

  return new Proxy(db as object, {
    get(target, prop, receiver) {
      // CatalogService reaches for the raw driver to run SEARCH_SQL with
      // bound parameters, which postgres.js spells `sql.unsafe(text, params)`
      // and PGlite spells `client.query(text, params)` -> { rows }.
      if (prop === '$client') {
        const pglite = Reflect.get(target, '$client', receiver) as {
          query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        };
        return {
          unsafe: async (text: string, params: unknown[] = []) =>
            (await pglite.query(text, params)).rows,
        };
      }

      const value = Reflect.get(target, prop, receiver);

      if (prop === 'execute' && typeof value === 'function') {
        return async (...args: unknown[]) => unwrap(await value.apply(target, args));
      }

      // Transactions hand the callback a fresh session object, which needs
      // exactly the same treatment.
      if (prop === 'transaction' && typeof value === 'function') {
        return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
          value.call(target, (tx: unknown) => fn(asProductionDb(tx)), ...rest);
      }

      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Db;
}

/** True when the statement was rejected by the database. */
export async function rejected(db: PGlite, statement: string): Promise<boolean> {
  try {
    await db.exec(statement);
    return false;
  } catch {
    return true;
  }
}
