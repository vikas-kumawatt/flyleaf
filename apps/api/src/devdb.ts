// Build a small, fast development database from the full catalog.
//
//   npm run devdb:build                          # flyleaf -> flyleaf_dev, top 200,000 works
//   npm run devdb:build -- --works 100000        # smaller slice
//   npm run devdb:build -- --replace             # rebuild an existing flyleaf_dev
//   npm run devdb:build -- --with-raw-payloads   # also copy raw OL payloads (large; for reprocessing work)
//
// WHY. The full catalog is ~30 GB and the dev machine has 8 GB of RAM, so its
// hot indexes cannot stay cached and every latency number is dominated by
// disk. A popularity slice of the catalog fits in memory: realistic latencies,
// faster CI-adjacent work, and the benchmark data (Part 01 of the audit) still
// works because every book any user touched is kept.
//
// WHAT IT COPIES
//   - The top N works by log_count, PLUS every work, edition, author and
//     series that any user-owned row references (reads, reviews, shelves,
//     favourites, mutes, activity, imports, merges, ...). Discovered from the
//     database's own foreign keys, so tables added later are covered without
//     editing this file. Nothing a user can see goes missing.
//   - The catalog around those works: editions, authorship, subjects, series,
//     stats, external ids and provenance (raw payloads only on request).
//   - Every user-owned table IN FULL.
//
// HOW. Schema comes from the normal migrations (so it is exactly what the app
// expects, including triggers and the trigram threshold). Rows are pulled
// from the source through postgres_fdw inside the same Postgres server --
// no dump files, no re-ingest, nothing leaves the machine. Id filters are
// sent in chunks as `= ANY($1)`, which postgres_fdw pushes to the source so
// each chunk is an index lookup, not a scan of 3.2M rows.
//
// SAFETY. The source is only ever READ (through foreign tables). The target
// must be a different database whose name ends in `_dev`, and an existing
// target is only dropped with --replace. After copying with triggers and FK
// checks suspended, every foreign key is verified row by row; any orphan
// fails the build loudly instead of leaving a subtly broken database.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { config } from './platform/index.js';
import { runMigrations } from './migrate.js';

type Sql = postgres.Sql;

/** Tables that belong to the catalog and are copied as a SLICE. Everything else is user data and copied in full. */
const CATALOG_TABLES = new Set([
  'works', 'editions', 'authors', 'work_authors', 'pending_work_authors',
  'series', 'series_entries', 'subjects', 'work_subjects', 'work_stats',
  'external_ids', 'field_provenance', 'raw_payloads',
]);

/** Catalog tables whose rows reference the catalog entities we slice on. */
const SLICED_ENTITIES = ['works', 'editions', 'authors', 'series'] as const;
type Entity = (typeof SLICED_ENTITIES)[number];

const CHUNK = 5000;
const SRC = 'devdb_src';

interface Options {
  works: number;
  target: string;
  replace: boolean;
  rawPayloads: boolean;
  sourceUrl: string;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const works = Number(get('works') ?? 200_000);
  if (!Number.isInteger(works) || works < 1) throw new Error('--works must be a positive integer');
  return {
    works,
    target: get('target') ?? 'flyleaf_dev',
    replace: argv.includes('--replace'),
    rawPayloads: argv.includes('--with-raw-payloads'),
    sourceUrl: get('source-url') ?? config.databaseUrl,
  };
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const t0 = Date.now();
function log(msg: string) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[devdb ${s}s] ${msg}`);
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function buildDevDb(opts: Options): Promise<void> {
  const sourceDb = new URL(opts.sourceUrl).pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(opts.target)) throw new Error(`Invalid target name: ${opts.target}`);
  if (!opts.target.endsWith('_dev')) {
    throw new Error(`Refusing: target "${opts.target}" must end in _dev, so a real database can never be overwritten.`);
  }
  if (opts.target === sourceDb) throw new Error('Refusing: target and source are the same database.');

  const targetUrl = withDatabase(opts.sourceUrl, opts.target);
  const admin = postgres(opts.sourceUrl, { max: 1, onnotice: () => {} });

  try {
    // ------------------------------------------------------------------ 0. preflight
    const [role] = await admin<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    if (!role?.rolsuper) {
      throw new Error('The database user must be a superuser (needed for postgres_fdw and to suspend triggers during the copy). The docker-compose user is.');
    }
    const [{ n: sourceWorks } = { n: 0 }] = await admin<{ n: number }[]>`
      SELECT reltuples::bigint AS n FROM pg_class WHERE relname = 'works' AND relkind = 'r'`;
    log(`source "${sourceDb}" has ~${Number(sourceWorks).toLocaleString()} works; slicing top ${opts.works.toLocaleString()} into "${opts.target}"`);

    // ------------------------------------------------------------------ 1. fresh target + schema
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${opts.target}`;
    if (exists) {
      if (!opts.replace) throw new Error(`"${opts.target}" already exists. Re-run with --replace to rebuild it.`);
      log(`dropping existing "${opts.target}"`);
      await admin.unsafe(`DROP DATABASE ${ident(opts.target)} WITH (FORCE)`);
    }
    await admin.unsafe(`CREATE DATABASE ${ident(opts.target)}`);
    log('applying migrations to target');
    await runMigrations(targetUrl);
  } finally {
    await admin.end();
  }

  const sql = postgres(targetUrl, { max: 1, onnotice: () => {}, idle_timeout: 0 });
  try {
    await linkSource(sql, opts.sourceUrl);
    const slice = await computeSlice(sql, opts.works);
    await copyAll(sql, slice, opts);
    await verifyForeignKeys(sql);
    await finish(sql);
  } catch (err) {
    log(`FAILED — "${opts.target}" is incomplete. Fix the error and re-run with --replace.`);
    throw err;
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SRC} CASCADE`).catch(() => {});
    await sql.unsafe(`DROP SERVER IF EXISTS devdb_source CASCADE`).catch(() => {});
    await sql.unsafe(`DROP EXTENSION IF EXISTS postgres_fdw`).catch(() => {});
    await sql.end();
  }

  const report = postgres(targetUrl, { max: 1, onnotice: () => {} });
  try {
    const rows: { t: string; n: number }[] = [];
    for (const t of ['works', 'editions', 'authors', 'reads', 'reviews', 'activity', 'shelves', 'follows']) {
      const [r] = await report.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.${ident(t)}`);
      rows.push({ t, n: r?.n ?? 0 });
    }
    const [sizeRow] = await report<{ size: string }[]>`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
    const size = sizeRow?.size ?? '?';
    log(`done: ${opts.target} is ${size}`);
    for (const r of rows) console.log(`         ${r.t.padEnd(10)} ${Number(r.n).toLocaleString()}`);
    console.log(`\n  Use it:  $env:DATABASE_URL = "${targetUrl}"   (PowerShell)\n`);
  } finally {
    await report.end();
  }
}

/**
 * Expose the source's tables as foreign tables in schema devdb_src. Same
 * server, so it connects to itself over TCP on localhost with the same
 * credentials (the Unix socket often uses `peer` auth, which fails here).
 */
async function linkSource(sql: Sql, sourceUrl: string) {
  const u = new URL(sourceUrl);
  const [portRow] = await sql<{ port: string }[]>`SELECT setting AS port FROM pg_settings WHERE name = 'port'`;
  const port = portRow?.port ?? '5432';
  const q = (v: string) => v.replace(/'/g, "''");
  const user = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');

  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS postgres_fdw`);
  await sql.unsafe(`CREATE SERVER devdb_source FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host 'localhost', port '${port}', dbname '${q(db)}', fetch_size '10000')`);
  await sql.unsafe(`CREATE USER MAPPING FOR CURRENT_USER SERVER devdb_source
    OPTIONS (user '${q(user)}', password '${q(password)}')`);
  await sql.unsafe(`CREATE SCHEMA ${SRC}`);
  await sql.unsafe(`IMPORT FOREIGN SCHEMA public FROM SERVER devdb_source INTO ${SRC}`);
  log('linked source through postgres_fdw');
}

interface ForeignKey {
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  name: string;
}

async function foreignKeys(sql: Sql): Promise<ForeignKey[]> {
  const rows = await sql<{ name: string; table: string; ref_table: string; cols: string[]; ref_cols: string[] }[]>`
    SELECT c.conname AS name,
           cl.relname AS table,
           rf.relname AS ref_table,
           ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, i)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.i)::text[] AS cols,
           ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, i)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.i)::text[] AS ref_cols
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class rf ON rf.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'public'`;
  return rows.map((r) => ({ name: r.name, table: r.table, refTable: r.ref_table, columns: r.cols, refColumns: r.ref_cols }));
}

async function hasColumn(sql: Sql, table: string, column: string): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`;
  return Boolean(row);
}

type Slice = Record<Entity, Set<string>>;

/**
 * The slice = top N works, plus everything user data points at, closed under
 * the catalog's own references (an edition's work, a work's default edition,
 * a merged work's survivor), plus authorship and series of every kept work.
 */
async function computeSlice(sql: Sql, topN: number): Promise<Slice> {
  const slice: Slice = { works: new Set(), editions: new Set(), authors: new Set(), series: new Set() };

  const top = await sql<{ id: string }[]>`
    SELECT id FROM ${sql(SRC)}.works ORDER BY log_count DESC, id LIMIT ${topN}`;
  for (const r of top) slice.works.add(r.id);
  log(`top works: ${slice.works.size.toLocaleString()}`);

  // Everything user-owned that points into the catalog, found from the FKs.
  const fks = await foreignKeys(sql);
  let referenced = 0;
  for (const fk of fks) {
    if (CATALOG_TABLES.has(fk.table)) continue;
    if (!(SLICED_ENTITIES as readonly string[]).includes(fk.refTable)) continue;
    if (fk.columns.length !== 1) throw new Error(`Unsupported multi-column FK ${fk.name} into ${fk.refTable}`);
    const col = fk.columns[0]!;
    const rows = await sql.unsafe<{ v: string }[]>(
      `SELECT DISTINCT ${ident(col)} AS v FROM ${SRC}.${ident(fk.table)} WHERE ${ident(col)} IS NOT NULL`,
    );
    for (const r of rows) slice[fk.refTable as Entity].add(r.v);
    referenced += rows.length;
  }
  // References that are not foreign keys (arrays and polymorphic ids).
  const extras: Array<[string, string, string]> = [
    ['profiles', 'favourite_work_ids', `SELECT DISTINCT unnest(favourite_work_ids) AS v FROM ${SRC}.profiles`],
    ['shelves', 'cover_work_ids', `SELECT DISTINCT unnest(cover_work_ids) AS v FROM ${SRC}.shelves`],
    ['mutes', 'target_id', `SELECT DISTINCT target_id AS v FROM ${SRC}.mutes WHERE target_type = 'work'`],
    ['activity', 'work_id', `SELECT DISTINCT work_id AS v FROM ${SRC}.activity WHERE work_id IS NOT NULL`],
  ];
  for (const [table, column, query] of extras) {
    if (!(await hasColumn(sql, table, column))) continue;
    const rows = await sql.unsafe<{ v: string }[]>(query);
    for (const r of rows) if (r.v) slice.works.add(r.v);
    referenced += rows.length;
  }
  log(`user data references ${referenced.toLocaleString()} catalog ids`);

  // Closure: editions <-> works, default editions, merge survivors.
  const seenWorks = new Set<string>();
  const seenEditions = new Set<string>();
  for (let round = 1; round <= 50; round++) {
    const before = slice.works.size + slice.editions.size;

    const newWorks = [...slice.works].filter((id) => !seenWorks.has(id));
    for (const ids of chunks(newWorks)) {
      const rows = await sql<{ id: string; default_edition_id: string | null; merged_into_id: string | null }[]>`
        SELECT id, default_edition_id, merged_into_id FROM ${sql(SRC)}.works WHERE id = ANY(${ids}::uuid[])`;
      for (const r of rows) {
        if (r.default_edition_id) slice.editions.add(r.default_edition_id);
        if (r.merged_into_id) slice.works.add(r.merged_into_id);
      }
      const eds = await sql<{ id: string }[]>`
        SELECT id FROM ${sql(SRC)}.editions WHERE work_id = ANY(${ids}::uuid[])`;
      for (const r of eds) slice.editions.add(r.id);
      for (const id of ids) seenWorks.add(id);
    }

    const newEditions = [...slice.editions].filter((id) => !seenEditions.has(id));
    for (const ids of chunks(newEditions)) {
      const rows = await sql<{ work_id: string }[]>`
        SELECT DISTINCT work_id FROM ${sql(SRC)}.editions WHERE id = ANY(${ids}::uuid[])`;
      for (const r of rows) slice.works.add(r.work_id);
      for (const id of ids) seenEditions.add(id);
    }

    if (slice.works.size + slice.editions.size === before) break;
    if (round === 50) {
      throw new Error('Slice closure did not converge in 50 rounds: some chain of default editions / merges keeps pulling in more works. Inspect works.default_edition_id and merged_into_id.');
    }
  }

  for (const ids of chunks([...slice.works])) {
    const authors = await sql<{ id: string }[]>`
      SELECT DISTINCT author_id AS id FROM ${sql(SRC)}.work_authors WHERE work_id = ANY(${ids}::uuid[])`;
    for (const r of authors) slice.authors.add(r.id);
  }
  // series_entries has no index on work_id; it is small, so read it once.
  const entries = await sql<{ series_id: string; work_id: string }[]>`
    SELECT series_id, work_id FROM ${sql(SRC)}.series_entries`;
  for (const e of entries) if (slice.works.has(e.work_id)) slice.series.add(e.series_id);

  log(`slice: ${slice.works.size.toLocaleString()} works, ${slice.editions.size.toLocaleString()} editions, ` +
    `${slice.authors.size.toLocaleString()} authors, ${slice.series.size.toLocaleString()} series`);
  return slice;
}

/** Columns present in both the target table and the source (foreign) table, excluding generated ones. */
async function copyColumns(sql: Sql, table: string): Promise<string[]> {
  const rows = await sql<{ c: string }[]>`
    SELECT t.column_name AS c
    FROM information_schema.columns t
    JOIN information_schema.columns s
      ON s.table_schema = ${SRC} AND s.table_name = t.table_name AND s.column_name = t.column_name
    WHERE t.table_schema = 'public' AND t.table_name = ${table} AND t.is_generated = 'NEVER'
    ORDER BY t.ordinal_position`;
  return rows.map((r) => r.c);
}

async function copyAll(sql: Sql, slice: Slice, opts: Options) {
  const tables = (await sql<{ t: string }[]>`
    SELECT table_name AS t FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`).map((r) => r.t);
  const sourceTables = new Set((await sql<{ t: string }[]>`
    SELECT foreign_table_name AS t FROM information_schema.foreign_tables WHERE foreign_table_schema = ${SRC}`).map((r) => r.t));

  const works = [...slice.works];
  const editions = [...slice.editions];
  const authors = [...slice.authors];
  const series = [...slice.series];

  await sql.begin(async (tx) => {
    // Triggers and FK checks off for the bulk copy: the source is already
    // consistent, counters are copied as-is, and verifyForeignKeys() proves
    // the result afterwards.
    await tx.unsafe(`SET LOCAL session_replication_role = replica`);

    for (const table of tables) {
      if (!sourceTables.has(table)) {
        log(`skip ${table} (not in source — run migrations on the source first if you need it)`);
        continue;
      }
      const cols = await copyColumns(tx as unknown as Sql, table);
      const colList = cols.map(ident).join(', ');
      const [{ identity } = { identity: false }] = await tx<{ identity: boolean }[]>`
        SELECT bool_or(attidentity <> '') AS identity FROM pg_attribute
        WHERE attrelid = ${`public.${table}`}::regclass AND attnum > 0 AND NOT attisdropped`;
      const insert = `INSERT INTO public.${ident(table)} (${colList}) ${identity ? 'OVERRIDING SYSTEM VALUE ' : ''}` +
        `SELECT ${colList} FROM ${SRC}.${ident(table)}`;

      const byIds = async (where: string, ids: string[], cast = 'uuid') => {
        let n = 0;
        for (const part of chunks(ids)) {
          const r = await tx.unsafe(`${insert} WHERE ${where} = ANY($1::${cast}[])`, [part as never]);
          n += r.count;
        }
        return n;
      };

      let n: number;
      switch (table) {
        case 'works': n = await byIds('id', works); break;
        case 'editions': n = await byIds('id', editions); break;
        case 'authors': n = await byIds('id', authors); break;
        case 'series': n = await byIds('id', series); break;
        case 'work_authors':
        case 'work_subjects':
        case 'work_stats':
          n = await byIds('work_id', works); break;
        case 'series_entries': {
          // A kept series can include books outside the slice; keep only entries whose work was copied.
          n = await byIds('series_id', series);
          const dropped = await tx.unsafe(
            `DELETE FROM public.series_entries se WHERE NOT EXISTS (SELECT 1 FROM public.works w WHERE w.id = se.work_id)`);
          n -= dropped.count;
          break;
        }
        case 'subjects': {
          const ids = new Set<string>();
          for (const part of chunks(works)) {
            const rows = await tx<{ id: string }[]>`
              SELECT DISTINCT subject_id AS id FROM ${tx(SRC)}.work_subjects WHERE work_id = ANY(${part}::uuid[])`;
            for (const r of rows) ids.add(r.id);
          }
          n = await byIds('id', [...ids]);
          break;
        }
        case 'external_ids':
        case 'field_provenance':
          n = 0;
          for (const [type, ids] of [['work', works], ['edition', editions], ['author', authors], ['series', series]] as const) {
            for (const part of chunks(ids)) {
              const r = await tx.unsafe(`${insert} WHERE entity_type = $1 AND entity_id = ANY($2::uuid[])`, [type, part as never]);
              n += r.count;
            }
          }
          break;
        case 'raw_payloads': {
          if (!opts.rawPayloads) { n = 0; log('skip raw_payloads (pass --with-raw-payloads to include)'); break; }
          n = 0;
          const keysOf = async (tableName: string, keyCol: string, ids: string[]) => {
            const out: string[] = [];
            for (const part of chunks(ids)) {
              const rows = await tx.unsafe<{ k: string }[]>(
                `SELECT ${ident(keyCol)} AS k FROM ${SRC}.${ident(tableName)} WHERE id = ANY($1::uuid[]) AND ${ident(keyCol)} IS NOT NULL`,
                [part as never]);
              for (const r of rows) out.push(r.k);
            }
            return out;
          };
          for (const [type, keys] of [
            ['work', await keysOf('works', 'ol_work_key', works)],
            ['edition', await keysOf('editions', 'ol_edition_key', editions)],
            ['author', await keysOf('authors', 'ol_author_key', authors)],
          ] as const) {
            for (const part of chunks(keys)) {
              const r = await tx.unsafe(
                `${insert} WHERE provider = 'open_library' AND entity_type = $1 AND external_id = ANY($2::text[])`,
                [type, part as never]);
              n += r.count;
            }
          }
          break;
        }
        case 'pending_work_authors':
          n = 0; // ingest bookkeeping only; --finalise rebuilds it from the dumps if ever needed
          break;
        default:
          n = (await tx.unsafe(insert)).count; // user data: everything
      }
      log(`copied ${table.padEnd(28)} ${n.toLocaleString()}`);
    }
  });

  // Keep sequences ahead of copied ids (serial/identity columns).
  const seqs = await sql<{ t: string; c: string; s: string }[]>`
    SELECT c.table_name AS t, c.column_name AS c, pg_get_serial_sequence('public.' || quote_ident(c.table_name), c.column_name) AS s
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND pg_get_serial_sequence('public.' || quote_ident(c.table_name), c.column_name) IS NOT NULL`;
  for (const q of seqs) {
    await sql.unsafe(
      `SELECT setval('${q.s}', GREATEST(COALESCE((SELECT max(${ident(q.c)}) FROM public.${ident(q.t)}), 0), 1),
                     (SELECT max(${ident(q.c)}) IS NOT NULL FROM public.${ident(q.t)}))`);
  }
}

/** Every FK, checked row by row. Copying with FK checks off is only acceptable because of this. */
async function verifyForeignKeys(sql: Sql) {
  const fks = await foreignKeys(sql);
  const problems: string[] = [];
  for (const fk of fks) {
    const notNull = fk.columns.map((c) => `c.${ident(c)} IS NOT NULL`).join(' AND ');
    const join = fk.columns.map((c, i) => `p.${ident(fk.refColumns[i]!)} = c.${ident(c)}`).join(' AND ');
    const [row] = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM public.${ident(fk.table)} c
       WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM public.${ident(fk.refTable)} p WHERE ${join})`);
    const n = row?.n ?? 0;
    if (n > 0) problems.push(`${fk.name}: ${n} row(s) in ${fk.table} point at missing ${fk.refTable}`);
  }
  if (problems.length) throw new Error(`Foreign key verification failed:\n  ${problems.join('\n  ')}`);
  log(`verified ${fks.length} foreign keys: no orphans`);
}

async function finish(sql: Sql) {
  // Counters were copied from a consistent source, but reconcile anyway —
  // it is cheap at this size and proves the triggers' view matches the data.
  for (const fn of ['reconcile_read_counters', 'reconcile_follow_counters', 'reconcile_shelf_counters']) {
    const [exists] = await sql`SELECT 1 FROM pg_proc WHERE proname = ${fn}`;
    if (exists) await sql.unsafe(`SELECT ${fn}()`);
  }
  log('analyzing');
  await sql.unsafe('ANALYZE');
}

// Run directly: `npm run devdb:build` (same check as migrate.ts / ingest.ts, which work on Windows).
const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  buildDevDb(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
