// Bulk writing (FN-23, FN-25).
//
// COPY into an UNLOGGED staging table, then one INSERT ... SELECT ... ON
// CONFLICT to merge. COPY cannot upsert, and a 40-million-row dump cannot be
// inserted row by row -- architecture.md §5.1 calls this "the difference
// between an afternoon and a week", which is not an exaggeration.
//
// DEVIATION from architecture.md §5.1: it specifies `pg-copy-streams`. That
// package is for the `pg` driver; we use postgres.js, which has COPY FROM
// STDIN built in. Using it avoids a dependency that would exist solely to
// duplicate a feature we already have.
//
// Merging on the OL key is what makes the whole thing resumable and
// re-runnable: replaying a batch is a no-op, so an interrupted run can
// restart at a checkpoint without producing duplicates.

import { createHash } from 'node:crypto';
import type { Db } from '../../platform/index.js';
import type { AuthorRow, EditionRow, WorkRow } from './normalise.js';

type Sql = Db['$client'];

/**
 * COPY text format escaping.
 *
 * Tab, newline, carriage return and backslash all terminate or re-interpret a
 * field. Book titles contain all four. `\N` is NULL -- which is why a literal
 * backslash must be escaped first, or the string "\N" in a title would become
 * a null.
 */
export function copyValue(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '\\N';
  if (typeof v === 'number') return String(v);
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Postgres array literal for a text[] column, inside a COPY field.
 *
 * TWO layers of escaping, applied in order, and the order is the whole point:
 *
 *   1. array syntax  -- inside a quoted element, `"` and `\` take a backslash
 *   2. COPY text     -- the finished literal is a field like any other, so
 *                       tab, newline, carriage return and backslash must be
 *                       escaped again
 *
 * Doing only step 1 is a bug I shipped, and it was invisible for exactly as
 * long as no alias contained a tab. Open Library is a wiki: John Maynard
 * Keynes has one. The raw tab ended the COPY field partway through the array,
 * Postgres reported `malformed array literal ... Unexpected end of input`,
 * and because the failure arrived as a destroyed COPY stream the ingest hung
 * instead of reporting it -- see copyIn() below.
 *
 * Composing the literal with SINGLE-backslash escapes and then running the
 * whole thing through copyValue() gets both layers right by construction,
 * rather than by hand-counting backslashes.
 */
export function copyTextArray(values: string[]): string {
  if (values.length === 0) return '{}';
  const literal = '{' + values
    .map((v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')
    .join(',') + '}';
  return copyValue(literal);
}

export const STAGING = {
  authors: `CREATE UNLOGGED TABLE IF NOT EXISTS stage_authors (
    ol_author_key text, name text, alternate_names text[], sort_name text,
    bio text, ol_photo_id int, birth_year int, death_year int)`,
  works: `CREATE UNLOGGED TABLE IF NOT EXISTS stage_works (
    ol_work_key text, title text, subtitle text, description text,
    alternate_titles text[], first_publish_year int, ol_cover_id int, maturity text)`,
  work_authors: `CREATE UNLOGGED TABLE IF NOT EXISTS stage_work_authors (
    work_key text, author_key text, position int)`,
  editions: `CREATE UNLOGGED TABLE IF NOT EXISTS stage_editions (
    ol_edition_key text, work_key text, isbn_13 text, isbn_10 text, title text,
    publisher text, publish_date_raw text, publish_year int, page_count int,
    format text, language text, ol_cover_id int)`,
  raw: `CREATE UNLOGGED TABLE IF NOT EXISTS stage_raw (
    external_id text, entity_type text, payload jsonb, payload_hash text)`,
} as const;


// ---------------------------------------------------------------------------
// The merge statements, exported so ingest.test.ts runs THESE rather than a
// paraphrase of them. Each one is "copy into staging, then reconcile":
// DISTINCT ON de-duplicates within the batch (a dump can carry the same key
// twice), and ON CONFLICT reconciles against what is already stored.
//
// COALESCE on the update side is deliberate: a later, sparser record must not
// blank out a field an earlier, richer one filled in.
// ---------------------------------------------------------------------------

export const MERGE_AUTHORS = `
    INSERT INTO authors (ol_author_key, name, alternate_names, sort_name, bio,
                         ol_photo_id, birth_year, death_year)
    SELECT DISTINCT ON (ol_author_key)
           ol_author_key, name, alternate_names, sort_name, bio,
           ol_photo_id, birth_year, death_year
    FROM stage_authors
    WHERE ol_author_key IS NOT NULL
    ORDER BY ol_author_key
    ON CONFLICT (ol_author_key) DO UPDATE SET
      name = EXCLUDED.name,
      alternate_names = EXCLUDED.alternate_names,
      sort_name = COALESCE(EXCLUDED.sort_name, authors.sort_name),
      bio = COALESCE(EXCLUDED.bio, authors.bio),
      ol_photo_id = COALESCE(EXCLUDED.ol_photo_id, authors.ol_photo_id),
      birth_year = COALESCE(EXCLUDED.birth_year, authors.birth_year),
      death_year = COALESCE(EXCLUDED.death_year, authors.death_year)`;

export const MERGE_WORKS = `
    INSERT INTO works (ol_work_key, title, subtitle, description, alternate_titles,
                       first_publish_year, ol_cover_id, maturity)
    SELECT DISTINCT ON (ol_work_key)
           ol_work_key, title, subtitle, description, alternate_titles,
           first_publish_year, ol_cover_id, maturity
    FROM stage_works
    WHERE ol_work_key IS NOT NULL
    ORDER BY ol_work_key
    ON CONFLICT (ol_work_key) DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = COALESCE(EXCLUDED.subtitle, works.subtitle),
      description = COALESCE(EXCLUDED.description, works.description),
      alternate_titles = EXCLUDED.alternate_titles,
      first_publish_year = COALESCE(EXCLUDED.first_publish_year, works.first_publish_year),
      ol_cover_id = COALESCE(EXCLUDED.ol_cover_id, works.ol_cover_id),
      maturity = EXCLUDED.maturity,
      updated_at = now()`;

export const MERGE_WORK_AUTHORS = `
      INSERT INTO work_authors (work_id, author_id, role, position)
      SELECT DISTINCT ON (w.id, a.id) w.id, a.id, 'author', s.position
      FROM stage_work_authors s
      JOIN works   w ON w.ol_work_key   = s.work_key
      JOIN authors a ON a.ol_author_key = s.author_key
      ORDER BY w.id, a.id, s.position
      ON CONFLICT (work_id, author_id, role) DO NOTHING`;

/**
 * Park the pairs whose author is not in the catalog yet.
 *
 * Without this, an authorship link whose author has not been ingested is
 * simply dropped by the JOIN -- silently, and unrecoverably unless you
 * re-read the entire 2.9 GB works dump. Parking them means `--finalise` can
 * resolve whatever has since arrived, and anything still unresolved is
 * visible in a table rather than absent from one.
 */
export const PARK_UNRESOLVED_WORK_AUTHORS = `
      INSERT INTO pending_work_authors (work_key, author_key, position)
      SELECT DISTINCT ON (s.work_key, s.author_key) s.work_key, s.author_key, s.position
      FROM stage_work_authors s
      LEFT JOIN authors a ON a.ol_author_key = s.author_key
      WHERE a.id IS NULL
      ORDER BY s.work_key, s.author_key
      ON CONFLICT (work_key, author_key) DO NOTHING`;

/**
 * Resolve everything parked that can now be resolved, and forget it.
 *
 * One statement so the insert and the delete cannot disagree: a row leaves
 * `pending_work_authors` only in the same transaction that puts it into
 * `work_authors`.
 */
export const RESOLVE_PENDING_WORK_AUTHORS = `
      WITH resolvable AS (
        SELECT p.work_key, p.author_key, p.position, w.id AS work_id, a.id AS author_id
        FROM pending_work_authors p
        JOIN works   w ON w.ol_work_key   = p.work_key
        JOIN authors a ON a.ol_author_key = p.author_key
      ),
      inserted AS (
        INSERT INTO work_authors (work_id, author_id, role, position)
        SELECT DISTINCT ON (work_id, author_id) work_id, author_id, 'author', position
        FROM resolvable
        ORDER BY work_id, author_id
        ON CONFLICT (work_id, author_id, role) DO NOTHING
      )
      DELETE FROM pending_work_authors p
      USING resolvable r
      WHERE p.work_key = r.work_key AND p.author_key = r.author_key`;

export const MERGE_EDITIONS = `
    INSERT INTO editions (ol_edition_key, work_id, isbn_13, isbn_10, title, publisher,
                          publish_date_raw, publish_year, page_count, format, language, ol_cover_id)
    SELECT DISTINCT ON (s.ol_edition_key)
           s.ol_edition_key, w.id, s.isbn_13, s.isbn_10, s.title, s.publisher,
           s.publish_date_raw, s.publish_year, s.page_count, s.format, s.language, s.ol_cover_id
    FROM stage_editions s
    JOIN works w ON w.ol_work_key = s.work_key
    WHERE s.ol_edition_key IS NOT NULL
    ORDER BY s.ol_edition_key
    ON CONFLICT (ol_edition_key) DO UPDATE SET
      isbn_13 = COALESCE(EXCLUDED.isbn_13, editions.isbn_13),
      isbn_10 = COALESCE(EXCLUDED.isbn_10, editions.isbn_10),
      title = COALESCE(EXCLUDED.title, editions.title),
      publisher = COALESCE(EXCLUDED.publisher, editions.publisher),
      publish_year = COALESCE(EXCLUDED.publish_year, editions.publish_year),
      page_count = COALESCE(EXCLUDED.page_count, editions.page_count),
      format = EXCLUDED.format,
      ol_cover_id = COALESCE(EXCLUDED.ol_cover_id, editions.ol_cover_id)`;

export const MERGE_RAW = `
    INSERT INTO raw_payloads (provider, external_id, entity_type, payload, payload_hash)
    SELECT DISTINCT ON (external_id, entity_type)
           'open_library', external_id, entity_type, payload, payload_hash
    FROM stage_raw
    ORDER BY external_id, entity_type
    ON CONFLICT (provider, external_id, entity_type) DO UPDATE SET
      payload = EXCLUDED.payload,
      payload_hash = EXCLUDED.payload_hash,
      fetched_at = now()
    WHERE raw_payloads.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash`;

export async function createStaging(sql: Sql): Promise<void> {
  for (const ddl of Object.values(STAGING)) await sql.unsafe(ddl);
}

export async function dropStaging(sql: Sql): Promise<void> {
  for (const name of ['stage_authors', 'stage_works', 'stage_work_authors',
                      'stage_editions', 'stage_raw']) {
    await sql.unsafe(`DROP TABLE IF EXISTS ${name}`);
  }
}

async function copyIn(sql: Sql, table: string, columns: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  await sql.unsafe(`TRUNCATE ${table}`);
  const writable = await sql.unsafe(`COPY ${table} (${columns}) FROM STDIN`).writable();
  // One write per batch, not per row: 5,000 small writes cost more in stream
  // bookkeeping than the data itself.
  //
  // `close` is listened for, not just `finish` and `error`.
  //
  // A destroyed stream emits `close` with NO `error` -- so a connection that
  // goes away mid-COPY satisfied none of the two original listeners and this
  // promise was never settled. With the socket gone there was then nothing
  // left holding the event loop open, so Node drained it and exited 0: no
  // error, no output, no summary, and a run row still saying 'running'. That
  // cost four rounds of debugging, because success and total failure looked
  // identical from the outside.
  //
  // `finish` fires before `close` on the happy path, so the guard keeps the
  // normal case resolving.
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    writable.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))));
    writable.on('finish', () => settle());
    writable.on('close', () => settle(
      new Error(`COPY into ${table} ended without finishing — the connection went away ` +
                `mid-copy (${lines.length} rows in flight)`)));
    writable.end(lines.join('\n') + '\n');
  });
}

export async function writeAuthors(sql: Sql, rows: AuthorRow[]): Promise<number> {
  await copyIn(sql, 'stage_authors',
    'ol_author_key, name, alternate_names, sort_name, bio, ol_photo_id, birth_year, death_year',
    rows.map((r) => [
      copyValue(r.olAuthorKey), copyValue(r.name), copyTextArray(r.alternateNames),
      copyValue(r.sortName), copyValue(r.bio), copyValue(r.olPhotoId),
      copyValue(r.birthYear), copyValue(r.deathYear),
    ].join('\t')));

  const result = await sql.unsafe(MERGE_AUTHORS);
  return result.count ?? rows.length;
}

export async function writeWorks(sql: Sql, rows: WorkRow[]): Promise<number> {
  await copyIn(sql, 'stage_works',
    'ol_work_key, title, subtitle, description, alternate_titles, first_publish_year, ol_cover_id, maturity',
    rows.map((r) => [
      copyValue(r.olWorkKey), copyValue(r.title), copyValue(r.subtitle),
      copyValue(r.description), copyTextArray(r.alternateTitles),
      copyValue(r.firstPublishYear), copyValue(r.olCoverId), copyValue(r.maturity),
    ].join('\t')));

  const result = await sql.unsafe(MERGE_WORKS);

  // Authorship. Links whose author is already present land immediately;
  // the rest are parked in pending_work_authors for --finalise to resolve.
  // Ingest order therefore no longer matters.
  const links: string[] = [];
  for (const r of rows) {
    r.authorKeys.forEach((authorKey, i) => {
      links.push([copyValue(r.olWorkKey), copyValue(authorKey), copyValue(i)].join('\t'));
    });
  }
  if (links.length) {
    await copyIn(sql, 'stage_work_authors', 'work_key, author_key, position', links);
    await sql.unsafe(MERGE_WORK_AUTHORS);
    await sql.unsafe(PARK_UNRESOLVED_WORK_AUTHORS);
  }

  return result.count ?? rows.length;
}

export async function writeEditions(sql: Sql, rows: EditionRow[]): Promise<number> {
  await copyIn(sql, 'stage_editions',
    'ol_edition_key, work_key, isbn_13, isbn_10, title, publisher, publish_date_raw, publish_year, page_count, format, language, ol_cover_id',
    rows.map((r) => [
      copyValue(r.olEditionKey), copyValue(r.workKey), copyValue(r.isbn13),
      copyValue(r.isbn10), copyValue(r.title), copyValue(r.publisher),
      copyValue(r.publishDateRaw), copyValue(r.publishYear), copyValue(r.pageCount),
      copyValue(r.format), copyValue(r.language), copyValue(r.olCoverId),
    ].join('\t')));

  // The join to works is also the second half of the filter rule: an edition
  // whose work was filtered out never lands.
  const result = await sql.unsafe(MERGE_EDITIONS);
  return result.count ?? rows.length;
}

/**
 * Raw payload retention (FN-25).
 *
 * Only for records that PASSED the filter, so this mirrors the kept catalog
 * rather than the whole dump. The point is that improving the normaliser or
 * the maturity classifier becomes a reprocess instead of a 12 GB re-download.
 *
 * Hash-skip: an unchanged record is not rewritten, which matters on the
 * monthly re-ingest where most records have not moved.
 */
export async function writeRawPayloads(
  sql: Sql,
  entityType: 'work' | 'edition' | 'author',
  records: { key: string; json: unknown }[],
): Promise<void> {
  if (records.length === 0) return;

  const lines = records.map((r) => {
    const payload = JSON.stringify(r.json);
    const hash = createHash('sha256').update(payload).digest('hex');
    return [copyValue(r.key), copyValue(entityType), copyValue(payload), copyValue(hash)].join('\t');
  });

  await copyIn(sql, 'stage_raw', 'external_id, entity_type, payload, payload_hash', lines);
  await sql.unsafe(MERGE_RAW);
}
