// Search tests.
//
// These exist because of a regression I shipped: replacing the Phase -1
// `ILIKE '%q%'` search with tsvector + trigram broke SEARCH AS YOU TYPE
// completely. `plainto_tsquery('ursu')` seeks the exact lexeme 'ursu' and
// never matches 'ursula', and trigram similarity between a four-character
// prefix and a full name is far below the threshold. So every keystroke
// returned nothing until the word happened to be complete.
//
// It got through because the verification I ran used only WHOLE WORDS
// ("piranesi", "tolkien", "dune"). Those pass on both the broken and the
// fixed query. The cases below are deliberately mostly prefixes, because
// that is what a real query looks like for all but its final keystroke.
//
// They run `SEARCH_SQL` itself, not a copy of it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { SEARCH_SQL, buildSearchParams, searchArgs, MAX_QUERY_CHARS } from '../catalog/index.js';
import { freshDb } from './pg.js';

let db: PGlite;

// log_count is part of the ranking now, so the fixture carries plausible
// popularity. Without it every row scores identically on that term and the
// tests would silently stop exercising it.
const BOOKS: [title: string, author: string, year: number, cover: number | null, logs: number][] = [
  ['A Wizard of Earthsea',      'Ursula K. Le Guin', 1968, 111,  9000],
  ['The Left Hand of Darkness', 'Ursula K. Le Guin', 1969, 112, 12000],
  ['The Dispossessed',          'Ursula K. Le Guin', 1974, null, 8000],
  ['Piranesi',                  'Susanna Clarke',    2020, 114, 48000],
  ['The Hobbit',                'J. R. R. Tolkien',  1937, 115, 52000],
  ['Dune',                      'Frank Herbert',     1965, 116, 44000],
  ['Animal Farm',               'George Orwell',     1945, 117, 39000],
  ['Nineteen Eighty-Four',      'George Orwell',     1949, 118, 41000],
  ['A Brief History of Time',   'Stephen Hawking',   1988, 119, 15000],
  ["The Handmaid's Tale",       'Margaret Atwood',   1985, 120, 33000],
];

async function search(q: string, limit = 5, allowExplicit = false) {
  const { rows } = await db.query<{ title: string; author_name: string; cover_id: number | null }>(
    SEARCH_SQL, searchArgs(q, limit, allowExplicit),
  );
  return rows;
}
const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

beforeAll(async () => {
  db = await freshDb();
  for (const [title, author, year, cover, logs] of BOOKS) {
    const { rows } = await db.query<{ id: string }>(
      `WITH existing AS (SELECT id FROM authors WHERE name = $1 LIMIT 1),
            created  AS (INSERT INTO authors (name)
                         SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM existing) RETURNING id)
       SELECT id FROM existing UNION ALL SELECT id FROM created`, [author]);
    const authorId = rows[0]!.id;

    const w = await db.query<{ id: string }>(
      `INSERT INTO works (title, first_publish_year, log_count) VALUES ($1, $2, $3) RETURNING id`,
      [title, year, logs]);
    const workId = w.rows[0]!.id;

    await db.query(
      `INSERT INTO work_authors (work_id, author_id, role, position) VALUES ($1,$2,'author',0)`,
      [workId, authorId]);
    await db.query(
      `INSERT INTO editions (work_id, ol_cover_id, publish_year, format)
       VALUES ($1,$2,$3,'paperback')`, [workId, cover, year]);
  }
}, 60_000);

afterAll(async () => { await db?.close(); });

// The regression, case by case. Every one of these returned NOTHING.
describe('search as you type', () => {
  it.each([
    ['U',    'A Wizard of Earthsea'],
    ['Ur',   'A Wizard of Earthsea'],
    ['Urs',  'A Wizard of Earthsea'],
    ['ursu', 'A Wizard of Earthsea'],
    ['orw',  'Animal Farm'],
    ['haw',  'A Brief History of Time'],
    ['pir',  'Piranesi'],
    ['hob',  'The Hobbit'],
    ['dun',  'Dune'],
  ])('a growing prefix keeps finding the book: %s', async (q, expected) => {
    expect(titles(await search(q))).toContain(expected);
  });

  it('finds an author by a LATER part of the name', async () => {
    // "Le Guin", not "Ursula".
    expect(titles(await search('guin'))).toContain('A Wizard of Earthsea');
  });

  it('ranks a title prefix above a mere fuzzy match', async () => {
    expect((await search('dun'))[0]!.title).toBe('Dune');
  });

  it('handles a multi-word prefix', async () => {
    expect(titles(await search('left han'))).toContain('The Left Hand of Darkness');
  });
});

describe('typos and accents', () => {
  it('absorbs a misspelling', async () => {
    expect(titles(await search('piranese'))).toContain('Piranesi');
  });

  it('absorbs a dropped letter', async () => {
    expect(titles(await search('the hobit'))).toContain('The Hobbit');
  });
});

// to_tsquery is a parser, and LIKE has metacharacters. Raw user input reaches
// both. None of these may throw or return the whole catalog.
describe('hostile input', () => {
  it.each(['%', '_', '%%%', '\\', "o'brien", 'a:b', 'a & b', 'a | b', '!!!', '   ', '((('])(
    'survives %j', async (q) => {
      await expect(search(q)).resolves.toBeDefined();
    });

  it('does not let "%" match the entire catalog', async () => {
    expect(await search('%')).toHaveLength(0);
  });

  it('does not let "_" match the entire catalog', async () => {
    expect(await search('_')).toHaveLength(0);
  });

  it('respects the limit', async () => {
    expect((await search('the', 2)).length).toBeLessThanOrEqual(2);
  });
});

describe('result shape', () => {
  it('carries the author name and the cover id from the edition', async () => {
    const [top] = await search('piranesi');
    expect(top).toMatchObject({ author_name: 'Susanna Clarke', cover_id: 114 });
  });

  it('returns a null cover rather than inventing one', async () => {
    const [top] = await search('dispossessed');
    expect(top?.cover_id).toBeNull();
  });

  it('excludes a merged work', async () => {
    await db.exec(`
      UPDATE works SET merged_into_id = (SELECT id FROM works WHERE title = 'Dune')
      WHERE title = 'Piranesi'`);
    expect(titles(await search('piranesi'))).not.toContain('Piranesi');
    await db.exec(`UPDATE works SET merged_into_id = NULL WHERE title = 'Piranesi'`);
  });

  it('excludes a provisional work until an admin promotes it', async () => {
    await db.exec(`UPDATE works SET is_provisional = true WHERE title = 'Animal Farm'`);
    expect(titles(await search('animal'))).not.toContain('Animal Farm');
    await db.exec(`UPDATE works SET is_provisional = false WHERE title = 'Animal Farm'`);
  });
});

// Audit 02 (FN-40). Everything a user can type reaches buildSearchParams and
// then two parsers (to_tsquery, LIKE) and a trigram operator.
describe('hostile input, exhaustively', () => {
  it.each([
    ':', '&', '|', '!', '(', ')', "'", '\\', '*', '<', '>', '-', ' - ', '!@#$%^&*()',
    '\t\n  ', 'a:*', 'a & !b', '((a|b))', "'; DROP TABLE works; --", '<script>alert(1)</script>',
    '📚🐉', 'שלום עולם', 'مرحبا', 'é', 'Café', '村上', 'Толстой',
    'a\u0000b', '\u0000', 'x'.repeat(1000), 'the '.repeat(300),
  ])('never throws: %j', async (q) => {
    await expect(search(q)).resolves.toBeDefined();
  });

  it('a search for "100%" matches the literal percent sign, not everything', async () => {
    await db.exec(`INSERT INTO works (title, log_count) VALUES ('100% Real', 5)`);
    try {
      const rows = await search('100%', 20);
      expect(titles(rows)).toContain('100% Real');
      for (const t of titles(rows)) expect(t).toContain('100%');
    } finally {
      await db.exec(`DELETE FROM works WHERE title = '100% Real'`);
    }
  });
});

// The per-arm LIMITs run BEFORE the final select. A row the final select
// throws away (merged, provisional, explicit) still used up an arm's slot, so
// enough of them push a live work out of every arm. The filters have to be
// inside each arm.
describe('exclusions apply inside every arm, before its LIMIT', () => {
  it.each([
    ['merged', `merged_into_id = (SELECT id FROM works WHERE title = 'Dune')`],
    ['provisional', `is_provisional = true`],
    ['explicit', `maturity = 'explicit'`],
  ])('320 popular %s works cannot push a live work out', async (_kind, flag) => {
    await db.exec(`
      INSERT INTO works (title, log_count)
      SELECT 'Quasar Chronicle ' || g, 100000 + g FROM generate_series(1, 320) g;
      UPDATE works SET ${flag} WHERE title LIKE 'Quasar Chronicle %';
      INSERT INTO works (title, log_count) VALUES ('The Quasar Omnibus Collected Edition', 1);`);
    try {
      const rows = await search('quasar', 20);
      expect(titles(rows)).toContain('The Quasar Omnibus Collected Edition');
      expect(titles(rows).filter((t) => t.startsWith('Quasar Chronicle'))).toHaveLength(0);
    } finally {
      await db.exec(`DELETE FROM works WHERE title LIKE 'Quasar Chronicle %' OR title LIKE 'The Quasar Omnibus%'`);
    }
  });
});

// PRD §7.8 [LOCKED]: explicit works are excluded from search unless the
// viewer is 18+ AND opted in. The SQL takes that decision as a parameter.
describe('maturity (PRD §7.8)', () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO works (title, log_count, maturity) VALUES
        ('Velvet Nights', 900, 'explicit'),
        ('Velvet Revolution', 10, 'mature'),
        ('Velvet Hour', 5, 'unclassified')`);
  });
  afterAll(async () => { await db.exec(`DELETE FROM works WHERE title LIKE 'Velvet %'`); });

  it('excludes explicit works unless explicitly allowed, and nothing else', async () => {
    expect(titles(await search('velvet', 10, false))).toEqual(['Velvet Revolution', 'Velvet Hour']);
    expect(titles(await search('velvet', 10, true))).toContain('Velvet Nights');
  });
});

// Planner behaviour on the real catalog (docs/audit/findings/02-search.md):
// for a query shorter than 4 characters the trigram arm matched ~1.1M of 3.2M
// titles and discarded all but a handful; a 2-character '%q%' pattern has no
// trigram at all, so the substring arms could not use an index. These
// assert the arms are shaped away at PLAN time, which PGlite shows faithfully
// even though its timings mean nothing.
describe('short queries do not run the arms that cannot use an index', () => {
  async function plan(q: string) {
    const { rows } = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) ${SEARCH_SQL}`, searchArgs(q, 20, false));
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  }

  it('skips the trigram arm below 4 characters, keeps it from 4', async () => {
    expect(await plan('pir')).not.toMatch(/title % /);
    expect(await plan('pira')).toMatch(/title % /);
  });

  it('anchors the title substring arm for a 2-character query', async () => {
    const p = await plan('th');
    expect(p).toMatch(/title ~~\* 'th%'/);
    expect(p).not.toMatch(/title ~~\* '%th%'/);
    expect(await plan('the')).toMatch(/title ~~\* '%the%'/);
  });
});

describe('diacritics are stripped on both sides (PRD §14.4)', () => {
  // Query and title differ only in what unaccent folds, so neither ILIKE nor
  // trigram similarity can match them; only the unaccented prefix query can.
  it.each([['łodz', 'Łódź Stories'], ['straße', 'Strasse der Sieger']])(
    '%j finds %j through the prefix arm', async (q, title) => {
      await db.query(`INSERT INTO works (title, log_count) VALUES ($1, 5)`, [title]);
      try {
        expect(titles(await search(q, 10))).toContain(title);
      } finally {
        await db.query(`DELETE FROM works WHERE title = $1`, [title]);
      }
    });
});

describe('buildSearchParams', () => {
  it('keeps letters from every script in the prefix query, not only a-z', () => {
    expect(buildSearchParams('Толстой').tsquery).toBe('толстой:*');
    expect(buildSearchParams('村上').tsquery).toBe('村上:*');
    expect(buildSearchParams('हिन्दी').tsquery).toBe('हिन्दी:*');
    // Composed, and left for flyleaf_unaccent to fold in SQL.
    expect(buildSearchParams('Café').tsquery).toBe('café:*');
  });

  it('splits on punctuation the way the tsvector parser does', () => {
    // to_tsvector('simple', 'O''Brien') is 'o' + 'brien'; 'obrien:*' matched neither.
    expect(buildSearchParams("o'brien").tsquery).toBe('brien:*');
    expect(buildSearchParams('eighty-four').tsquery).toBe('eighty:* & four:*');
  });

  it('drops one-letter prefix terms when a longer term exists', () => {
    // "harry potter and the p": 'p:*' expands to every lexeme starting with p.
    expect(buildSearchParams('harry potter and the p').tsquery).toBe('harry:* & potter:* & and:* & the:*');
    expect(buildSearchParams('a').tsquery).toBe('a:*');
  });

  it('bounds the query length and strips NUL', () => {
    expect(buildSearchParams('x'.repeat(1000)).raw).toHaveLength(MAX_QUERY_CHARS);
    expect(buildSearchParams('a\u0000b').raw).toBe('ab');
  });
});

// Known gap, kept as a failing-in-spirit reminder rather than a silent hole.
describe('known gaps', () => {
  it('cannot find "1984" — the work is titled Nineteen Eighty-Four', async () => {
    // FN-21 must ingest Open Library's alternate_titles; FN-43 carries this
    // as a hard case in the relevance panel. Asserted so that the day it
    // starts working, this test fails and someone deletes it deliberately.
    expect(titles(await search('1984'))).not.toContain('Nineteen Eighty-Four');
  });
});
