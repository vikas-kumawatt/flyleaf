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
import { SEARCH_SQL, buildSearchParams } from '../catalog/index.js';
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

async function search(q: string, limit = 5) {
  const p = buildSearchParams(q);
  const { rows } = await db.query<{ title: string; author_name: string; cover_id: number | null }>(
    SEARCH_SQL, [p.raw, p.tsquery, p.like, p.prefix, limit],
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

// Known gap, kept as a failing-in-spirit reminder rather than a silent hole.
describe('known gaps', () => {
  it('cannot find "1984" — the work is titled Nineteen Eighty-Four', async () => {
    // FN-21 must ingest Open Library's alternate_titles; FN-43 carries this
    // as a hard case in the relevance panel. Asserted so that the day it
    // starts working, this test fails and someone deletes it deliberately.
    expect(titles(await search('1984'))).not.toContain('Nineteen Eighty-Four');
  });
});
