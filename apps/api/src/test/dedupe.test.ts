// Duplicate detection and merging (FN-50).
//
// A wrong merge destroys two books' worth of ratings at once and is the most
// destructive operation in the catalog, so these tests are mostly about the
// ways a merge can go wrong rather than the happy path.
//
// The one that matters most: `reads` has UNIQUE (user_id, work_id, attempt_no).
// A user who logged BOTH duplicates collides the moment their reads repoint,
// and the naive `UPDATE reads SET work_id = survivor` throws. Renumbering is
// also the semantically correct answer — they did read it twice.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import type { Db } from '../platform/index.js';
import {
  NORMALISED_TITLE_EXPR, mergeWorks, normaliseTitle, runDedupe,
} from '../catalog/dedupe.js';
import { freshDrizzle } from './pg.js';

// One database for the file, emptied between tests — the same shape as every
// other suite here. A fresh PGlite per test costs ~2s in boot and migrations,
// which turned this file into 89 seconds on its own.
let db: Db;
let client: PGlite;

beforeAll(async () => { ({ db, client } = await freshDrizzle()); }, 60_000);
afterAll(async () => { await client?.close(); });

beforeEach(async () => {
  await client.exec(`TRUNCATE works, authors, editions, reads, users, profiles, refresh_tokens,
    work_authors, work_subjects, series_entries, work_stats, work_merges, external_ids,
    field_provenance, progress_events RESTART IDENTITY CASCADE`);
});

const author = async (db: Db, name: string) =>
  (await db.execute<{ id: string }>(
    sql`INSERT INTO authors (name) VALUES (${name}) RETURNING id`))[0]!.id;

const work = async (db: Db, title: string, logs = 0, authorId?: string) => {
  const [w] = await db.execute<{ id: string }>(
    sql`INSERT INTO works (title, log_count) VALUES (${title}, ${logs}) RETURNING id`);
  if (authorId) {
    await db.execute(sql`
      INSERT INTO work_authors (work_id, author_id, role, position)
      VALUES (${w!.id}, ${authorId}, 'author', 0)`);
  }
  return w!.id;
};

const edition = async (db: Db, workId: string, isbn13: string | null = null) =>
  (await db.execute<{ id: string }>(sql`
    INSERT INTO editions (work_id, isbn_13, format, language)
    VALUES (${workId}, ${isbn13}, 'paperback', 'eng') RETURNING id`))[0]!.id;

const user = async (db: Db, email: string) => {
  const [u] = await db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, date_of_birth)
    VALUES (${email}, 'x', '2000-01-01') RETURNING id`);
  await db.execute(sql`
    INSERT INTO profiles (user_id, username)
    VALUES (${u!.id}, ${email.split('@')[0]})`);
  return u!.id;
};

const read = async (db: Db, userId: string, workId: string, attempt = 1, rating?: string) =>
  (await db.execute<{ id: string }>(sql`
    INSERT INTO reads (user_id, work_id, status, attempt_no, rating)
    VALUES (${userId}, ${workId}, 'finished', ${attempt}, ${rating ?? null}) RETURNING id`))[0]!.id;

describe('title normalisation', () => {
  it.each([
    ['The Hobbit',            'hobbit'],
    ['the hobbit',            'hobbit'],
    ['Dune: A Novel',         'dune'],
    ['Nineteen Eighty-Four',  'nineteen eighty four'],
    ['A Wizard of Earthsea',  'wizard of earthsea'],
    ['An Absolutely Remarkable Thing', 'absolutely remarkable thing'],
    ["Piranesi's Dream",      'piranesi s dream'],
    ['  Spaced   Out  ',      'spaced out'],
  ])('%j -> %j', (input, expected) => {
    expect(normaliseTitle(input)).toBe(expected);
  });

  it('does not strip "the" from the middle of a title', () => {
    expect(normaliseTitle('Under the Volcano')).toBe('under the volcano');
  });

  it('does not fold accents — that would merge distinct translations', () => {
    expect(normaliseTitle('Les Misérables')).toBe('les misérables');
  });

  // Two implementations of one rule is how a dedupe pass starts merging the
  // wrong things, and the divergence would show up as books disappearing.
  it('the SQL expression agrees with the TypeScript one', async () => {
    const titles = [
      'The Hobbit', 'Dune: A Novel', 'Nineteen Eighty-Four', 'A Wizard of Earthsea',
      'Under the Volcano', "Piranesi's Dream", 'An Absolutely Remarkable Thing',
      'Spaced   Out', 'THE  GREAT   GATSBY', 'Hard-Boiled Wonderland: and the End',
      'Les Misérables', '1984', 'A', 'The', 'the the the',
    ];
    // One query, not one per title: a round trip each was 40 seconds.
    const values = titles.map((t) => `('${t.replace(/'/g, "''")}')`).join(',');
    const rows = await db.execute<{ title: string; norm: string }>(sql.raw(`
      SELECT title, ${NORMALISED_TITLE_EXPR} AS norm FROM (VALUES ${values}) AS v(title)`));

    expect(rows.map((r) => [r.title, r.norm]))
      .toEqual(titles.map((t) => [t, normaliseTitle(t)]));
  });
});

describe('stage 2 detection', () => {
  it('finds the same title by the same author', async () => {
    const clarke = await author(db, 'Susanna Clarke');
    await work(db, 'Piranesi', 561, clarke);
    await work(db, 'Piranesi', 3, clarke);

    expect((await runDedupe(db, { dryRun: true })).stage2).toBe(1);
  });

  it('does NOT merge the same title by a different author', async () => {
    await work(db, 'Piranesi', 561, await author(db, 'Susanna Clarke'));
    await work(db, 'Piranesi', 2, await author(db, 'Nicholas Penny'));

    expect((await runDedupe(db, { dryRun: true })).stage2).toBe(0);
  });

  it('matches across a subtitle and a leading article', async () => {
    const a = await author(db, 'Frank Herbert');
    await work(db, 'Dune', 44000, a);
    await work(db, 'The Dune: A Novel', 4, a);

    expect((await runDedupe(db, { dryRun: true })).stage2).toBe(1);
  });

  it('ignores works already merged away', async () => {
    const a = await author(db, 'Susanna Clarke');
    const keep = await work(db, 'Piranesi', 561, a);
    const gone = await work(db, 'Piranesi', 3, a);
    await mergeWorks(db, { survivorId: keep, loserId: gone, stage: 2, reason: 'test' });

    expect((await runDedupe(db, { dryRun: true })).stage2).toBe(0);
  });
});

describe('survivor selection', () => {
  it('prefers more editions over more logs', async () => {
    const a = await author(db, 'Susanna Clarke');
    const fewEditionsManyLogs = await work(db, 'Piranesi', 5000, a);
    const manyEditions = await work(db, 'Piranesi', 1, a);
    await edition(db, manyEditions);
    await edition(db, manyEditions);

    await runDedupe(db);
    const [loser] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${fewEditionsManyLogs}`);
    expect(loser!.merged_into_id).toBe(manyEditions);
  });

  it('falls back to log count when editions tie', async () => {
    const a = await author(db, 'Susanna Clarke');
    const popular = await work(db, 'Piranesi', 561, a);
    const obscure = await work(db, 'Piranesi', 3, a);

    await runDedupe(db);
    const [row] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${obscure}`);
    expect(row!.merged_into_id).toBe(popular);
  });
});

describe('what a merge moves', () => {
  it('repoints reads and RENUMBERS attempts when a user logged both copies', async () => {
    const a = await author(db, 'Susanna Clarke');
    const keep = await work(db, 'Piranesi', 561, a);
    const gone = await work(db, 'Piranesi', 3, a);
    const u = await user(db, 'both@example.com');

    await read(db, u, keep, 1, '4.5');
    await read(db, u, gone, 1, '5.0');   // same user, same attempt_no, other work

    // The naive `UPDATE reads SET work_id = survivor` throws here.
    await mergeWorks(db, { survivorId: keep, loserId: gone, stage: 2, reason: 'test' });

    const rows = await db.execute<{ attempt_no: number; rating: string }>(sql`
      SELECT attempt_no, rating FROM reads WHERE work_id = ${keep} ORDER BY attempt_no`);
    expect(rows.map((r) => Number(r.attempt_no))).toEqual([1, 2]);
    expect(rows.map((r) => r.rating)).toEqual(['4.5', '5.0']);
  });

  it('leaves a different user\'s attempts numbered from one', async () => {
    const a = await author(db, 'Susanna Clarke');
    const keep = await work(db, 'Piranesi', 561, a);
    const gone = await work(db, 'Piranesi', 3, a);
    const other = await user(db, 'other@example.com');
    await read(db, other, gone, 1);

    await mergeWorks(db, { survivorId: keep, loserId: gone, stage: 2, reason: 'test' });

    const [row] = await db.execute<{ attempt_no: number }>(
      sql`SELECT attempt_no FROM reads WHERE user_id = ${other}`);
    expect(Number(row!.attempt_no)).toBe(1);
  });

  it('repoints editions and merges authorship without duplicating it', async () => {
    const a = await author(db, 'Susanna Clarke');
    const b = await author(db, 'A Translator');
    const keep = await work(db, 'Piranesi', 561, a);
    const gone = await work(db, 'Piranesi', 3, a);
    await db.execute(sql`
      INSERT INTO work_authors (work_id, author_id, role, position)
      VALUES (${gone}, ${b}, 'translator', 1)`);
    await edition(db, gone);

    await mergeWorks(db, { survivorId: keep, loserId: gone, stage: 2, reason: 'test' });

    const [e] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM editions WHERE work_id = ${keep}`);
    expect(e!.n).toBe(1);
    const links = await db.execute<{ role: string }>(
      sql`SELECT role FROM work_authors WHERE work_id = ${keep} ORDER BY role`);
    expect(links.map((l) => l.role)).toEqual(['author', 'translator']);
    const [left] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM work_authors WHERE work_id = ${gone}`);
    expect(left!.n).toBe(0);
  });

  it('flattens a merge chain instead of leaving two hops', async () => {
    const a = await author(db, 'Susanna Clarke');
    const first = await work(db, 'Piranesi', 10, a);
    const second = await work(db, 'Piranesi', 20, a);
    const third = await work(db, 'Piranesi', 30, a);

    await mergeWorks(db, { survivorId: second, loserId: first, stage: 2, reason: 'test' });
    await mergeWorks(db, { survivorId: third, loserId: second, stage: 2, reason: 'test' });

    // `first` must point at `third`, not at `second`, which is now a tombstone.
    const rows = await db.execute<{ id: string; merged_into_id: string }>(sql`
      SELECT id, merged_into_id FROM works WHERE id IN (${first}, ${second})`);
    expect(rows.every((r) => r.merged_into_id === third)).toBe(true);
  });

  it('refuses to merge a work into itself', async () => {
    const id = await work(db, 'Piranesi', 1, await author(db, 'Susanna Clarke'));
    await expect(mergeWorks(db, { survivorId: id, loserId: id, stage: 2, reason: 'x' }))
      .rejects.toThrow(/into itself/);
  });
});

describe('the merge log', () => {
  it('records the attempt numbers a merge overwrote', async () => {
    const a = await author(db, 'Susanna Clarke');
    const keep = await work(db, 'Piranesi', 561, a);
    const gone = await work(db, 'Piranesi', 3, a);
    const u = await user(db, 'both@example.com');
    await read(db, u, keep, 1);
    const moving = await read(db, u, gone, 1);

    const { moved } = await mergeWorks(db, { survivorId: keep, loserId: gone, stage: 2, reason: 'test' });

    // Without this the read is now attempt 2 and nothing remembers it was 1,
    // so the 30-day undo cannot restore it.
    expect(moved.reads).toEqual([{ id: moving, attempt_no: 1 }]);

    const [logged] = await db.execute<{ stage: number; reason: string; moved: { reads: unknown[] } }>(
      sql`SELECT stage, reason, moved FROM work_merges WHERE loser_id = ${gone}`);
    expect(Number(logged!.stage)).toBe(2);
    expect(logged!.moved.reads).toHaveLength(1);
  });

  it('will not record the same loser twice', async () => {
    const a = await author(db, 'Susanna Clarke');
    const keep = await work(db, 'Piranesi', 561, a);
    const other = await work(db, 'Piranesi', 100, a);
    const gone = await work(db, 'Piranesi', 3, a);

    await mergeWorks(db, { survivorId: keep, loserId: gone, stage: 2, reason: 'test' });
    // A second merge of the same loser means it came back from the dead.
    await expect(mergeWorks(db, { survivorId: other, loserId: gone, stage: 2, reason: 'test' }))
      .rejects.toThrow();
  });
});

describe('a full pass', () => {
  it('is idempotent — a second run finds nothing', async () => {
    const a = await author(db, 'Susanna Clarke');
    await work(db, 'Piranesi', 561, a);
    await work(db, 'Piranesi', 3, a);
    await work(db, 'Piranesi', 1, a);

    const first = await runDedupe(db);
    expect(first.merged).toBeGreaterThanOrEqual(1);

    const second = await runDedupe(db);
    expect(second.merged).toBe(0);
  });

  it('dryRun changes nothing', async () => {
    const a = await author(db, 'Susanna Clarke');
    await work(db, 'Piranesi', 561, a);
    const gone = await work(db, 'Piranesi', 3, a);

    const report = await runDedupe(db, { dryRun: true });
    expect(report.stage2).toBe(1);
    expect(report.merged).toBe(0);

    const [row] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${gone}`);
    expect(row!.merged_into_id).toBeNull();
  });

  it('finds nothing on stage 1 today — ISBNs need the editions pass', async () => {
    const a = await author(db, 'Frank Herbert');
    const one = await work(db, 'Dune', 44000, a);
    const two = await work(db, 'Dune Messiah', 900, a);
    await edition(db, one, '9780441013593');
    await edition(db, two, '9780441013593');   // the same ISBN on two works

    // Different titles, so only stage 1 can catch this pair.
    const report = await runDedupe(db, { dryRun: true });
    expect(report.stage1).toBe(1);
    expect(report.stage2).toBe(0);
  });
});
