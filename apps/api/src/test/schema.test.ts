// Schema tests. These assert the DECISIONS, not the DDL.
//
// Every case here is a rule the project has committed to somewhere in the PRD
// or architecture doc. If a future migration quietly relaxes one, this file is
// what notices. That matters most for the licensing constraint: it is the one
// rule where the database is the enforcement mechanism and there is no
// application code to review.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, migrationFiles, rejected } from './pg.js';

let db: PGlite;

const USER = '11111111-1111-1111-1111-111111111111';
const WORK = '22222222-2222-2222-2222-222222222222';
const ACCENTED = '33333333-3333-3333-3333-333333333333';

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO users (id, email, password_hash, username)
      VALUES ('${USER}', 'a@b.c', 'x', 'reader');
    INSERT INTO works (id, title) VALUES
      ('${WORK}', 'Piranesi'),
      ('${ACCENTED}', 'Les Misérables');
  `);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('migrations', () => {
  it('has a journal with at least one migration', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  // FN-01's exit criterion, as a test rather than a manual step.
  it('apply clean on an empty database', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(17);
  });

  // Migration 0001 drops and re-adds works.search_vector, which silently
  // drops every index on it. drizzle-kit did NOT recreate the GIN index --
  // search would still have worked, sequential-scanning the whole catalog.
  it('keep the GIN and trigram indexes across a generated-column rewrite', async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'works'`);
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('works_search_idx');
    expect(names).toContain('works_title_trgm_idx');
  });

  // drizzle-kit cannot match a generated-column expression against its own
  // snapshot, so it proposes dropping and re-adding `search_vector` in every
  // migration it generates -- and dropping the column silently drops
  // `works_search_idx` with it, which drizzle does NOT recreate. Search keeps
  // working and sequential-scans the whole catalog.
  //
  // The invariant is not "never drop it": 0001 legitimately rewrote the
  // column to add alternate_titles. It is that a migration which drops the
  // column must also rebuild the index.
  it('any migration that drops search_vector also rebuilds its index', () => {
    // Strip SQL comments first -- these files DISCUSS the hazard at length,
    // and matching the prose instead of the code is a false positive.
    const code = (sql: string) =>
      sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

    const offenders = migrationFiles()
      .map((m) => ({ tag: m.tag, sql: code(m.sql) }))
      .filter((m) => /drop\s+column\s+"?search_vector/i.test(m.sql))
      .filter((m) => !/create\s+index[^;]*"?works_search_idx/i.test(m.sql))
      .map((m) => m.tag);

    expect(offenders, `these drop search_vector without rebuilding works_search_idx: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('are idempotent through the prerequisite step', async () => {
    // Re-running CREATE EXTENSION / CREATE OR REPLACE FUNCTION must be safe,
    // because migrate.ts does exactly that on every boot.
    const fresh = await freshDb();
    await expect(fresh.query('SELECT flyleaf_unaccent($1) AS v', ['Misérables']))
      .resolves.toMatchObject({ rows: [{ v: 'Miserables' }] });
    await fresh.close();
  }, 60_000);
});

// The rule that has no application code behind it. PRD §41, architecture §3.2.
describe('licensing is structural, not documentary', () => {
  it('field_provenance accepts open_library', async () => {
    expect(await rejected(db, `
      INSERT INTO field_provenance (entity_type, entity_id, field_name, provider)
      VALUES ('work', gen_random_uuid(), 'title', 'open_library')`)).toBe(false);
  });

  it('field_provenance REJECTS google_books', async () => {
    // Google Books forbids caching. A stored field therefore cannot name them
    // as its source, and the CHECK is what guarantees it. Do not "tidy" the
    // two provider lists into one shared enum.
    expect(await rejected(db, `
      INSERT INTO field_provenance (entity_type, entity_id, field_name, provider)
      VALUES ('work', gen_random_uuid(), 'title', 'google_books')`)).toBe(true);
  });

  it('external_ids ALLOWS google_books — recording an id is not caching data', async () => {
    expect(await rejected(db, `
      INSERT INTO external_ids (entity_type, entity_id, provider, external_id)
      VALUES ('work', gen_random_uuid(), 'google_books', 'zyTCAlFPjgYC')`)).toBe(false);
  });

  it('raw_payloads retains open_library and nothing else', async () => {
    expect(await rejected(db, `
      INSERT INTO raw_payloads (provider, external_id, entity_type, payload, payload_hash)
      VALUES ('open_library', 'OL1W', 'work', '{}'::jsonb, 'h1')`)).toBe(false);
    expect(await rejected(db, `
      INSERT INTO raw_payloads (provider, external_id, entity_type, payload, payload_hash)
      VALUES ('google_books', 'x', 'work', '{}'::jsonb, 'h2')`)).toBe(true);
  });
});

// Locked in Phase -1 and verified on a device. The database enforces it
// because the API is not the only writer: imports, admin and backfill all
// write here too.
describe('half-star ratings', () => {
  const insert = (rating: string, attempt: number) => `
    INSERT INTO reads (user_id, work_id, status, rating, attempt_no)
    VALUES ('${USER}', '${WORK}', 'finished', ${rating}, ${attempt})`;

  it('accepts a half step', async () => {
    expect(await rejected(db, insert('4.5', 1))).toBe(false);
  });

  it('rejects a quarter step', async () => {
    expect(await rejected(db, insert('4.25', 2))).toBe(true);
  });

  it('rejects zero — unrated is NULL, never 0', async () => {
    expect(await rejected(db, insert('0', 3))).toBe(true);
  });

  it('rejects above 5', async () => {
    expect(await rejected(db, insert('5.5', 4))).toBe(true);
  });

  it('accepts NULL — finishing a book never requires a rating', async () => {
    expect(await rejected(db, insert('NULL', 5))).toBe(false);
  });
});

describe('reads', () => {
  it('allows a second attempt but not a duplicate one', async () => {
    // A re-read is a new row. The unique key is (user, work, attempt).
    expect(await rejected(db, `
      INSERT INTO reads (user_id, work_id, status, attempt_no)
      VALUES ('${USER}', '${WORK}', 'reading', 9)`)).toBe(false);
    expect(await rejected(db, `
      INSERT INTO reads (user_id, work_id, status, attempt_no)
      VALUES ('${USER}', '${WORK}', 'reading', 9)`)).toBe(true);
  });

  it('rejects an unknown status', async () => {
    expect(await rejected(db, `
      INSERT INTO reads (user_id, work_id, status, attempt_no)
      VALUES ('${USER}', '${WORK}', 'skimmed', 10)`)).toBe(true);
  });

  it('rejects finishing before starting', async () => {
    expect(await rejected(db, `
      INSERT INTO reads (user_id, work_id, status, attempt_no, started_at, finished_at)
      VALUES ('${USER}', '${WORK}', 'finished', 11, '2026-05-01', '2026-04-01')`)).toBe(true);
  });
});

describe('progress_events', () => {
  it('rejects a replayed client_event_id — the whole offline guarantee', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO reads (user_id, work_id, status, attempt_no)
       VALUES ('${USER}', '${WORK}', 'reading', 20) RETURNING id`);
    const readId = rows[0]!.id;
    const eventId = '44444444-4444-4444-4444-444444444444';

    expect(await rejected(db, `
      INSERT INTO progress_events (read_id, page, client_event_id)
      VALUES ('${readId}', 100, '${eventId}')`)).toBe(false);
    expect(await rejected(db, `
      INSERT INTO progress_events (read_id, page, client_event_id)
      VALUES ('${readId}', 100, '${eventId}')`)).toBe(true);
  });
});

// FN-12. The reason the immutable wrapper exists.
describe('search', () => {
  it('populates search_vector automatically, with title weighted A', async () => {
    const { rows } = await db.query<{ v: string }>(
      `SELECT search_vector::text AS v FROM works WHERE id = '${ACCENTED}'`);
    expect(rows[0]!.v).toContain('miserables');
    expect(rows[0]!.v).toContain(':2A');   // weight survives
  });

  it('is accent-insensitive: "Miserables" finds "Les Misérables"', async () => {
    const { rows } = await db.query<{ title: string }>(
      `SELECT title FROM works
        WHERE search_vector @@ plainto_tsquery('simple', flyleaf_unaccent($1))`,
      ['Miserables']);
    expect(rows.map((r: { title: string }) => r.title)).toEqual(['Les Misérables']);
  });

  it('does not stem — "simple", not "english"', async () => {
    // 'english' would stem "Piranesi" and mangle proper nouns (§14.2).
    const { rows } = await db.query<{ v: string }>(
      `SELECT search_vector::text AS v FROM works WHERE id = '${WORK}'`);
    expect(rows[0]!.v).toBe(`'piranesi':1A`);
  });

  it('matches a misspelling through the trigram index', async () => {
    const { rows } = await db.query<{ title: string }>(
      `SELECT title FROM works WHERE title % $1
        ORDER BY similarity(title, $1) DESC`, ['Piranese']);
    expect(rows[0]?.title).toBe('Piranesi');
  });
});

describe('catalog CHECK constraints', () => {
  it('rejects an unknown maturity — an unclassified catalog is unshippable', async () => {
    expect(await rejected(db, `INSERT INTO works (title, maturity) VALUES ('x', 'spicy')`)).toBe(true);
  });

  it('defaults maturity to unclassified rather than guessing', async () => {
    const { rows } = await db.query<{ maturity: string }>(
      `SELECT maturity FROM works WHERE id = '${WORK}'`);
    expect(rows[0]!.maturity).toBe('unclassified');
  });

  it('rejects an unknown edition format', async () => {
    expect(await rejected(db, `
      INSERT INTO editions (work_id, format) VALUES ('${WORK}', 'scroll')`)).toBe(true);
  });

  it('sorts a 2.5 novella between 2 and 3', async () => {
    // numeric position, not int. Series order is the reason.
    await db.exec(`
      INSERT INTO series (id, name) VALUES ('55555555-5555-5555-5555-555555555555', 'Test Cycle');
      INSERT INTO series_entries (series_id, work_id, position)
        VALUES ('55555555-5555-5555-5555-555555555555', '${WORK}', 2.5);`);
    const { rows } = await db.query<{ position: string }>(
      `SELECT position FROM series_entries WHERE work_id = '${WORK}'`);
    expect(Number(rows[0]!.position)).toBe(2.5);
  });
});
