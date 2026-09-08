// Ingest tests (FN-20 -> FN-25).
//
// The fixture in fixtures/ol-records.json is TEN REAL Open Library records,
// fetched from the live API and frozen. That matters more than it sounds:
// Open Library is a wiki, and the interesting failures come from what the
// data actually looks like rather than from what a schema says it should.
// One of these authors is named "OBE"; another is "(John Ronald Reuel)".
//
// The dump reader is exercised against a genuine gzipped 5-column TSV built
// from those records, including a line that is not a dump row and a line
// whose JSON is broken -- both of which occur in the real 45 GB file and
// neither of which may end a run.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';

import { readDump } from '../catalog/ingest/dump.js';
import {
  classifyMaturity, normaliseAuthor, normaliseEdition, normaliseWork, parseYear,
  type AuthorRow, type EditionRow, type WorkRow,
} from '../catalog/ingest/normalise.js';
import {
  copyTextArray, copyValue, STAGING,
  MERGE_AUTHORS, MERGE_EDITIONS, MERGE_RAW, MERGE_WORKS, MERGE_WORK_AUTHORS,
  PARK_UNRESOLVED_WORK_AUTHORS, RESOLVE_PENDING_WORK_AUTHORS,
} from '../catalog/ingest/writer.js';
import { freshDb } from './pg.js';

type Sample = { key: string; json: Record<string, unknown> };

const FIXTURE = fileURLToPath(new URL('./fixtures/ol-records.json', import.meta.url));
const samples = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Sample[];

const tsvLine = (type: string, key: string, json: unknown) =>
  [type, key, '1', '2026-01-01T00:00:00', JSON.stringify(json)].join('\t');

let dumpPath: string;
let db: PGlite;
let records: { key: string; json: Record<string, unknown>; line: number }[] = [];
let malformed = 0;

beforeAll(async () => {
  const lines = samples.map((s) => tsvLine(
    s.key.startsWith('/works/') ? '/type/work'
      : s.key.startsWith('/authors/') ? '/type/author' : '/type/edition',
    s.key, s.json,
  ));

  // A title containing every character that terminates a COPY field.
  lines.push(tsvLine('/type/work', '/works/OLTABW', {
    title: 'Tab\there and \\ back \\N end',
    authors: [{ author: { key: '/authors/OL34184A' } }],
    covers: [9],
  }));
  lines.push(tsvLine('/type/work', '/works/OLNOAUTHW', { title: 'Orphan With No Author', covers: [1] }));
  lines.push(tsvLine('/type/work', '/works/OLNOTITLEW', { authors: [{ author: { key: '/authors/OL34184A' } }] }));
  lines.push('this line is not a dump row');
  lines.push(['/type/work', '/works/OLBADJSONW', '1', 'x', '{not json'].join('\t'));

  dumpPath = path.join(os.tmpdir(), `flyleaf-ingest-test-${process.pid}.txt.gz`);
  fs.writeFileSync(dumpPath, zlib.gzipSync(lines.join('\n') + '\n'));

  for await (const r of readDump(dumpPath, { onMalformed: () => { malformed++; } })) {
    records.push(r);
  }

  db = await freshDb();
  for (const ddl of Object.values(STAGING)) await db.exec(ddl.replace('UNLOGGED ', ''));
}, 60_000);

afterAll(async () => {
  await db?.close();
  fs.rmSync(dumpPath, { force: true });
});

const works = () => records.filter((r) => r.key.startsWith('/works/'));
const authors = () => records.filter((r) => r.key.startsWith('/authors/'));
const editions = () => records.filter((r) => r.key.startsWith('/books/'));

describe('dump reader', () => {
  it('skips a line that is not a dump row, and counts broken JSON', () => {
    expect(records.length).toBe(samples.length + 3);
    expect(malformed).toBe(1);
  });

  it('does not split the JSON column on tabs inside string values', () => {
    const tabbed = records.find((r) => r.key === '/works/OLTABW');
    expect(tabbed?.json.title).toBe('Tab\there and \\ back \\N end');
  });

  it('resumes from a checkpoint at the right line', async () => {
    const resumed: number[] = [];
    for await (const r of readDump(dumpPath, { skipLines: 5 })) resumed.push(r.line);
    expect(resumed[0]).toBe(6);
  });
});

// The filter rule, architecture.md §5.1. Unfiltered the dumps need ~250 GB
// and are mostly catalog stubs.
describe('filter rule', () => {
  it('rejects a work with no author', () => {
    const r = works().find((w) => w.key === '/works/OLNOAUTHW')!;
    expect(normaliseWork(r.key, r.json)).toBeNull();
  });

  it('rejects a work with no title', () => {
    const r = works().find((w) => w.key === '/works/OLNOTITLEW')!;
    expect(normaliseWork(r.key, r.json)).toBeNull();
  });

  it('rejects an edition with neither ISBN nor cover', () => {
    expect(normaliseEdition('/books/OLX', { works: [{ key: '/works/OL1W' }] })).toBeNull();
  });

  it('rejects an edition belonging to no work', () => {
    expect(normaliseEdition('/books/OLX', { isbn_13: ['9780140328721'] })).toBeNull();
  });

  it('keeps the real records', () => {
    const kept = works().map((r) => normaliseWork(r.key, r.json)).filter(Boolean);
    expect(kept.length).toBe(works().length - 2);
    expect(kept.map((w) => w!.title)).toContain('The Lord of the Rings');
  });
});

describe('normaliser against real records', () => {
  it('reads a cover id off a work', () => {
    const r = works().find((w) => w.key === '/works/OL27448W')!;
    expect(normaliseWork(r.key, r.json)!.olCoverId).toBeGreaterThan(0);
  });

  it('normalises every author in the fixture, messy names included', () => {
    const rows = authors().map((r) => normaliseAuthor(r.key, r.json));
    expect(rows.every((x) => x !== null)).toBe(true);
  });

  it('cleans a hyphenated ISBN down to digits', () => {
    const e = normaliseEdition('/books/OLX', {
      works: [{ key: '/works/OL1W' }], isbn_13: ['978-0-14-032872-1'],
    });
    expect(e!.isbn13).toBe('9780140328721');
  });

  it('rejects an OCR page count', () => {
    const e = normaliseEdition('/books/OLX', {
      works: [{ key: '/works/OL1W' }], covers: [1], number_of_pages: 99_999,
    });
    expect(e!.pageCount).toBeNull();
  });

  it.each([
    ['Hardcover', 'hardcover'], ['Mass Market Paperback', 'paperback'],
    ['Audio CD', 'audiobook'], ['Kindle Edition', 'ebook'], ['', 'unknown'],
  ])('maps physical_format %j to %s', (physical, expected) => {
    const e = normaliseEdition('/books/OLX', {
      works: [{ key: '/works/OL1W' }], covers: [1], physical_format: physical,
    });
    expect(e!.format).toBe(expected);
  });
});

// The fix for the author-name gap. Open Library files Haruki Murakami's
// novels under a record named 村上春樹, so `name ILIKE '%murakami%'` is false
// and Norwegian Wood -- 1,351 logs on the real catalog -- was unreachable by
// searching its author. `sort_name` is empty there. Aliases are the bridge.
describe('author aliases', () => {
  it('captures the Latin alias of a non-Latin primary name', () => {
    const a = normaliseAuthor('/authors/OL382524A', {
      name: '村上春樹',
      alternate_names: ['Haruki Murakami', 'Murakami Haruki'],
    })!;
    expect(a.name).toBe('村上春樹');                       // primary name untouched
    expect(a.alternateNames).toContain('Haruki Murakami');
  });

  it('does not repeat the primary name among the aliases', () => {
    const a = normaliseAuthor('/authors/OLX', {
      name: 'Roald Dahl', alternate_names: ['roald dahl', 'Roald Dalh'],
    })!;
    expect(a.alternateNames).not.toContain('roald dahl');   // case-insensitive
    expect(a.alternateNames).toContain('Roald Dalh');
  });

  it('folds in personal_name and fuller_name, which sometimes hold the only Latin spelling', () => {
    const a = normaliseAuthor('/authors/OLY', {
      name: 'J.R.R. Tolkien', personal_name: 'J. R. R. Tolkien',
      fuller_name: 'John Ronald Reuel Tolkien',
    })!;
    expect(a.alternateNames).toEqual(
      expect.arrayContaining(['J. R. R. Tolkien', 'John Ronald Reuel Tolkien']));
  });

  it('caps a runaway alias list', () => {
    const a = normaliseAuthor('/authors/OLZ', {
      name: 'Prolific', alternate_names: Array.from({ length: 200 }, (_, i) => `alias ${i}`),
    })!;
    expect(a.alternateNames.length).toBeLessThanOrEqual(40);
  });

  it('reads them off the real fixture records', () => {
    const rows = authors().map((r) => normaliseAuthor(r.key, r.json)!);
    // Tolkien and Dahl both carry aliases in the frozen OL data.
    expect(rows.some((a) => a.alternateNames.length > 0)).toBe(true);
  });
});

// OL dates are free text written by thousands of volunteers over 20 years.
describe('parseYear', () => {
  it.each([
    ['1999', 1999], ['June 1999', 1999], ['c1999', 1999], ['1999-06-01', 1999],
    ['[1999]', 1999], ['n.d.', null], ['', null], ['0007', null], ['3999', null],
  ])('%j -> %s', (input, expected) => {
    expect(parseYear(input)).toBe(expected);
  });

  it('reads OL\'s {type, value} wrapper', () => {
    expect(parseYear({ type: '/type/datetime', value: '1949-06-08' })).toBe(1949);
  });
});

// FN-24. Runs at ingest because it cannot be bolted on later (App Store §1.2).
describe('maturity classification', () => {
  it.each([
    ['explicit subject',      { subjects: ['Erotic fiction', 'Romance'] }, 'explicit'],
    ['explicit imprint',      { subjects: ['Romance'], publishers: ["Ellora's Cave"] }, 'explicit'],
    ['mature subject',        { subjects: ['True crime', 'Murder'] }, 'mature'],
    ['rich subjects',         { subjects: ['Fiction', 'Fantasy', 'Adventure', 'English literature'] }, 'general'],
    ['no signal',             { subjects: [] }, 'unclassified'],
    ['one subject',           { subjects: ['Fiction'] }, 'unclassified'],
  ])('%s', (_label, input, expected) => {
    expect(classifyMaturity(input)).toBe(expected);
  });

  it("children's classification beats a mature keyword", () => {
    // A picture book about a death is not mature content.
    expect(classifyMaturity({ subjects: ["Children's fiction", 'Suicide'] })).toBe('general');
  });

  it('never guesses "general" from silence', () => {
    // unclassified is NOT a synonym for safe. A surface that must be safe
    // filters to general and accepts a smaller catalog.
    expect(classifyMaturity({})).toBe('unclassified');
  });
});

describe('COPY escaping', () => {
  it.each([
    ['a\tb', 'a\\tb'], ['a\nb', 'a\\nb'], ['a\rb', 'a\\rb'],
  ])('escapes %j', (input, expected) => {
    expect(copyValue(input)).toBe(expected);
  });

  it('escapes the backslash FIRST, so a literal \\N is not read as NULL', () => {
    expect(copyValue('\\N')).toBe('\\\\N');
  });

  it('writes null as \\N', () => {
    expect(copyValue(null)).toBe('\\N');
    expect(copyValue(undefined)).toBe('\\N');
  });

  it('writes an empty array literal', () => {
    expect(copyTextArray([])).toBe('{}');
  });
});

/**
 * COPY a text[] through a real Postgres parser and read it back.
 *
 * The assertions above compare strings to strings, which is precisely how the
 * bug this suite now guards against survived: `copyTextArray` escaped for the
 * ARRAY LITERAL and not for the COPY FIELD, so a tab inside an alias ended the
 * row partway through the array. Postgres said `malformed array literal ...
 * Unexpected end of input`, the ingest died on John Maynard Keynes every
 * single run, and no unit test noticed because none of them ever handed the
 * output to Postgres.
 *
 * A round trip is the only assertion that can catch that class of mistake, so
 * these send the bytes and compare what comes back.
 */
describe('text[] survives a real COPY round trip', () => {
  beforeAll(async () => {
    await db.exec('CREATE TABLE IF NOT EXISTS copy_roundtrip (id int, names text[])');
  });

  const roundTrip = async (values: string[]): Promise<string[]> => {
    await db.exec('TRUNCATE copy_roundtrip');
    const line = `${copyValue(1)}\t${copyTextArray(values)}\n`;
    await db.query(`COPY copy_roundtrip (id, names) FROM '/dev/blob'`, [], {
      blob: new Blob([line]),
    });
    const { rows } = await db.query<{ names: string[] }>('SELECT names FROM copy_roundtrip');
    return rows[0]!.names;
  };

  it.each([
    ['a tab',                 ['John Maynard Keynes', 'Keynes\tJohn']],
    ['a newline',             ['Ursula K. Le Guin', 'Le Guin\nUrsula']],
    ['a carriage return',     ['a\rb']],
    ['a comma',               ['John, Maynard Keynes']],
    ['a double quote',        ['The "Bard"']],
    ['a backslash',           ['A\\B']],
    ['a backslash and quote', ['A\\"B']],
    ['braces',                ['{not an array}']],
    ['the NULL marker',       ['\\N']],
    ['non-Latin script',      ['村上春樹', 'Мураками']],
    ['many aliases',          Array.from({ length: 40 }, (_, i) => `alias\t${i}`)],
  ])('carries %s through unchanged', async (_label, values) => {
    expect(await roundTrip(values)).toEqual(values);
  });

  it('carries an empty array', async () => {
    expect(await roundTrip([])).toEqual([]);
  });
});

describe('merge statements', () => {
  const insert = async (table: string, cols: string[], rows: unknown[][]) => {
    for (const r of rows) {
      await db.query(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`,
        r as never[],
      );
    }
  };
  const count = async (table: string) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  let authorRows: AuthorRow[];
  let workRows: WorkRow[];
  let editionRows: EditionRow[];

  beforeAll(async () => {
    authorRows = authors().map((r) => normaliseAuthor(r.key, r.json)!).filter(Boolean);
    workRows = works().map((r) => normaliseWork(r.key, r.json)!).filter(Boolean);
    editionRows = editions().map((r) => normaliseEdition(r.key, r.json)!).filter(Boolean);

    await insert('stage_authors',
      ['ol_author_key', 'name', 'alternate_names', 'sort_name', 'bio', 'ol_photo_id', 'birth_year', 'death_year'],
      authorRows.map((a) => [a.olAuthorKey, a.name, a.alternateNames, a.sortName, a.bio,
                             a.olPhotoId, a.birthYear, a.deathYear]));
    await db.exec(MERGE_AUTHORS);

    await insert('stage_works',
      ['ol_work_key', 'title', 'subtitle', 'description', 'alternate_titles', 'first_publish_year', 'ol_cover_id', 'maturity'],
      workRows.map((w) => [w.olWorkKey, w.title, w.subtitle, w.description, w.alternateTitles, w.firstPublishYear, w.olCoverId, w.maturity]));
    await db.exec(MERGE_WORKS);

    await insert('stage_work_authors', ['work_key', 'author_key', 'position'],
      workRows.flatMap((w) => w.authorKeys.map((k, i) => [w.olWorkKey, k, i])));
    await db.exec(MERGE_WORK_AUTHORS);

    await insert('stage_editions',
      ['ol_edition_key', 'work_key', 'isbn_13', 'isbn_10', 'title', 'publisher', 'publish_date_raw', 'publish_year', 'page_count', 'format', 'language', 'ol_cover_id'],
      editionRows.map((e) => [e.olEditionKey, e.workKey, e.isbn13, e.isbn10, e.title, e.publisher, e.publishDateRaw, e.publishYear, e.pageCount, e.format, e.language, e.olCoverId]));
    await db.exec(MERGE_EDITIONS);
  }, 60_000);

  // This is what makes an interrupted run safe to restart.
  it('replaying every merge changes nothing', async () => {
    const before = [await count('authors'), await count('works'), await count('work_authors'), await count('editions')];
    await db.exec(MERGE_AUTHORS);
    await db.exec(MERGE_WORKS);
    await db.exec(MERGE_WORK_AUTHORS);
    await db.exec(MERGE_EDITIONS);
    const after = [await count('authors'), await count('works'), await count('work_authors'), await count('editions')];
    expect(after).toEqual(before);
  });

  it('never invents a placeholder author', async () => {
    const bad = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM authors WHERE name = ''`);
    expect(bad.rows[0]!.n).toBe(0);
  });

  // Ingest order used to matter: a work loaded before its author lost its
  // authorship silently, and the only defence was a comment saying "authors
  // first" -- which means waiting out ~17 million author records before you
  // can load a single book.
  it('parks an authorship whose author has not arrived yet, and resolves it later', async () => {
    await db.exec(`TRUNCATE stage_work_authors`);
    await db.query(
      `INSERT INTO works (ol_work_key, title) VALUES ('/works/OLEARLYW', 'Early Book')
       ON CONFLICT (ol_work_key) DO NOTHING`);
    await db.query(
      `INSERT INTO stage_work_authors VALUES ('/works/OLEARLYW', '/authors/OLLATEA', 0)`);

    await db.exec(MERGE_WORK_AUTHORS);
    await db.exec(PARK_UNRESOLVED_WORK_AUTHORS);

    const parked = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pending_work_authors WHERE author_key = '/authors/OLLATEA'`);
    expect(parked.rows[0]!.n).toBe(1);

    // The author turns up on a later pass.
    await db.query(
      `INSERT INTO authors (ol_author_key, name) VALUES ('/authors/OLLATEA', 'Late Author')`);
    await db.exec(RESOLVE_PENDING_WORK_AUTHORS);

    const linked = await db.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM work_authors wa
      JOIN authors a ON a.id = wa.author_id
      WHERE a.ol_author_key = '/authors/OLLATEA'`);
    expect(linked.rows[0]!.n).toBe(1);

    const left = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pending_work_authors WHERE author_key = '/authors/OLLATEA'`);
    expect(left.rows[0]!.n).toBe(0);

    // Idempotent, because --finalise is run more than once.
    await db.exec(RESOLVE_PENDING_WORK_AUTHORS);
    expect((await db.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM work_authors wa JOIN authors a ON a.id = wa.author_id
      WHERE a.ol_author_key = '/authors/OLLATEA'`)).rows[0]!.n).toBe(1);
  });

  it('does not blank a filled field when a sparser record arrives later', async () => {
    // The monthly re-ingest sees thinner records all the time. COALESCE on
    // the update side is what stops it eroding the catalog.
    await db.exec(`TRUNCATE stage_works`);
    await insert('stage_works',
      ['ol_work_key', 'title', 'subtitle', 'description', 'alternate_titles', 'first_publish_year', 'ol_cover_id', 'maturity'],
      [['/works/OL27448W', 'The Lord of the Rings', null, null, [], null, null, 'unclassified']]);
    await db.exec(MERGE_WORKS);

    const row = await db.query<{ ol_cover_id: number | null }>(
      `SELECT ol_cover_id FROM works WHERE ol_work_key = '/works/OL27448W'`);
    expect(row.rows[0]!.ol_cover_id).not.toBeNull();
  });

  it('only lands editions whose work exists', async () => {
    const orphaned = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM editions WHERE work_id IS NULL`);
    expect(orphaned.rows[0]!.n).toBe(0);
  });
});

// FN-25: the monthly re-ingest must not rewrite forty million unchanged rows.
describe('raw payload hash-skip', () => {
  const hashOf = async (s: string) => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(s).digest('hex');
  };

  it('does not rewrite an unchanged payload, and does rewrite a changed one', async () => {
    const first = JSON.stringify({ a: 1 });
    await db.exec('TRUNCATE stage_raw');
    await db.query(`INSERT INTO stage_raw VALUES ($1,'work',$2,$3)`,
      ['/works/HASHTEST', first, await hashOf(first)]);
    await db.exec(MERGE_RAW);
    const t1 = (await db.query<{ fetched_at: unknown }>(
      `SELECT fetched_at FROM raw_payloads WHERE external_id = '/works/HASHTEST'`)).rows[0]!.fetched_at;

    await new Promise((r) => setTimeout(r, 20));
    await db.exec(MERGE_RAW);                       // identical payload
    const t2 = (await db.query<{ fetched_at: unknown }>(
      `SELECT fetched_at FROM raw_payloads WHERE external_id = '/works/HASHTEST'`)).rows[0]!.fetched_at;
    expect(String(t2)).toBe(String(t1));

    const second = JSON.stringify({ a: 2 });
    await db.exec('TRUNCATE stage_raw');
    await db.query(`INSERT INTO stage_raw VALUES ($1,'work',$2,$3)`,
      ['/works/HASHTEST', second, await hashOf(second)]);
    await db.exec(MERGE_RAW);
    const payload = (await db.query<{ payload: unknown }>(
      `SELECT payload FROM raw_payloads WHERE external_id = '/works/HASHTEST'`)).rows[0]!.payload;
    expect(JSON.stringify(payload)).toBe(second);
  });
});

describe('alternate titles', () => {
  it('feeds the search vector, which is what closes the "1984" gap', async () => {
    await db.query(
      `UPDATE works SET alternate_titles = ARRAY['1984'] WHERE ol_work_key = '/works/OL1168083W'`);
    const hit = await db.query<{ title: string }>(
      `SELECT title FROM works WHERE search_vector @@ plainto_tsquery('simple', flyleaf_unaccent('1984'))`);
    expect(hit.rows.map((r) => r.title)).toContain('Nineteen Eighty-Four');
  });
});
