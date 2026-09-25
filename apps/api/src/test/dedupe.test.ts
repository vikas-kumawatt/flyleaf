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
  NORMALISED_TITLE_EXPR,
  mergeWorks,
  undoMerge,
  previewMerge,
  findStage3Candidates,
  queueStage3Candidates,
  queueReportedDuplicate,
  getDedupeQueue,
  resolveQueueItem,
  getRecentMerges,
  normaliseTitle,
  runDedupe,
} from '../catalog/dedupe.js';
import { buildApp } from '../app.js';
import { freshDrizzle } from './pg.js';
import { createAdminUser, loginAdmin } from '../admin/auth.js';
import { generateTotp } from '../admin/totp.js';

// One database for the file, emptied between tests — the same shape as every
// other suite here. A fresh PGlite per test costs ~2s in boot and migrations,
// which turned this file into 89 seconds on its own.
let db: Db;
let client: PGlite;

beforeAll(async () => { ({ db, client } = await freshDrizzle()); }, 60_000);
afterAll(async () => { await client?.close(); });

beforeEach(async () => {
  await client.exec(`TRUNCATE works, authors, editions, reads, users, profiles, refresh_tokens,
    work_authors, work_subjects, series_entries, work_stats, work_merges, dedupe_queue, external_ids,
    field_provenance, progress_events, subjects, series RESTART IDENTITY CASCADE`);
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
      // Audit 03: unicode, typographic punctuation, other languages' articles
      // (kept on both sides — only English ones are stripped), numerals.
      'Le Petit Prince', 'Der Prozess', 'Die Verwandlung', 'The 39 Steps', 'Catch-22',
      'L’Étranger', 'Don Quixote — Part One', '«Война и мир»', '¿Quién?', 'ÉMILE',
      'Salt & Pepper', 'O’Brien’s “Tale”', 'ΟΔΥΣΣΕΙΑ', 'Books 📚 Forever', 'x_y',
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

describe('Stage 3 fuzzy dedupe & Stage 4 reporting (FN-51)', () => {
  it('detects Stage 3 fuzzy pairs and queues them without auto-merging', async () => {
    const a = await author(db, 'Susanna Clarke');
    // "Jonathan Strange & Mr Norrell" and "Jonathan Strange and Mr Norrell" share author and have high trigram similarity > 0.85
    const w1 = await work(db, 'Jonathan Strange & Mr Norrell', 500, a);
    const w2 = await work(db, 'Jonathan Strange and Mr Norrell', 10, a);

    const candidates = await findStage3Candidates(db);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const pair = candidates.find((c) => c.survivorId === w1 && c.loserId === w2);
    expect(pair).toBeDefined();
    expect(pair!.titleSimilarity).toBeGreaterThan(0.85);

    // Running dedupe should queue this pair into dedupe_queue
    const report = await runDedupe(db);
    expect(report.stage3Queued).toBeGreaterThanOrEqual(1);

    // Crucial rule: Stage 3 is NEVER auto-merged!
    const [row] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${w2}`);
    expect(row!.merged_into_id).toBeNull();

    // Check that it's in the review queue
    const queue = await getDedupeQueue(db, { status: 'pending' });
    const item = queue.find((q) => q.survivor.id === w1 && q.loser.id === w2);
    expect(item).toBeDefined();
    expect(item!.stage).toBe(3);
    expect(item!.status).toBe('pending');
  });

  it('allows reporting duplicates (Stage 4) from users/moderators', async () => {
    const a = await author(db, 'Ted Chiang');
    const w1 = await work(db, 'Stories of Your Life and Others', 200, a);
    const w2 = await work(db, 'Stories of Your Life', 50, a);

    const res = await queueReportedDuplicate(db, {
      survivorId: w1,
      loserId: w2,
      reason: 'Same collection published under truncated title',
    });

    expect(res.queued).toBe(true);

    const queue = await getDedupeQueue(db, { stage: 4 });
    expect(queue.some((q) => q.id === res.id && q.stage === 4)).toBe(true);
  });

  it('rejects reporting a work as duplicate of itself', async () => {
    const a = await author(db, 'Ted Chiang');
    const w1 = await work(db, 'Exhalation', 100, a);
    await expect(
      queueReportedDuplicate(db, {
        survivorId: w1,
        loserId: w1,
        reason: 'Duplicate of itself',
      }),
    ).rejects.toThrow(/duplicate of itself/i);
  });
});

describe('Preview and Queue Resolution (FN-51, PRD §3721)', () => {
  it('generates a preview with collision forecasting', async () => {
    const a = await author(db, 'Ursula K. Le Guin');
    const w1 = await work(db, 'The Dispossessed', 300, a);
    const w2 = await work(db, 'The Dispossessed: An Ambiguous Utopia', 20, a);
    await edition(db, w1);
    await edition(db, w2);

    const u = await user(db, 'reader@example.com');
    await read(db, u, w1, 1);
    await read(db, u, w2, 1); // Collision! User logged both

    const preview = await previewMerge(db, w1, w2);
    expect(preview.survivor.id).toBe(w1);
    expect(preview.loser.id).toBe(w2);
    expect(preview.preview.readsToMove).toBe(1);
    expect(preview.preview.collidingReads).toBe(1);
    expect(preview.preview.editionsToMove).toBe(1);
  });

  it('resolves queue items by merging works', async () => {
    const a = await author(db, 'China Miéville');
    const w1 = await work(db, 'The City & The City', 400, a);
    const w2 = await work(db, 'The City and the City', 10, a);

    const { id } = await queueReportedDuplicate(db, {
      survivorId: w1,
      loserId: w2,
      reason: 'Title punctuation variant',
    });

    const result = await resolveQueueItem(db, id, 'merge');
    expect(result.success).toBe(true);
    expect(result.action).toBe('merge');
    expect(result.mergeId).toBeDefined();

    // Verify loser is now merged
    const [row] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${w2}`);
    expect(row!.merged_into_id).toBe(w1);

    // Verify queue item is marked merged
    const [qItem] = await db.execute<{ status: string }>(
      sql`SELECT status FROM dedupe_queue WHERE id = ${id}`);
    expect(qItem!.status).toBe('merged');
  });

  it('resolves queue items by dismissing candidate', async () => {
    const a = await author(db, 'Gene Wolfe');
    const w1 = await work(db, 'The Shadow of the Torturer', 400, a);
    const w2 = await work(db, 'The Claw of the Conciliator', 300, a);

    const { id } = await queueReportedDuplicate(db, {
      survivorId: w1,
      loserId: w2,
      reason: 'Mistakenly queued',
    });

    const result = await resolveQueueItem(db, id, 'dismiss', { reason: 'Distinct books in series' });
    expect(result.success).toBe(true);
    expect(result.action).toBe('dismiss');

    // Loser remains live
    const [row] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${w2}`);
    expect(row!.merged_into_id).toBeNull();

    const [qItem] = await db.execute<{ status: string; dismiss_reason: string }>(
      sql`SELECT status, dismiss_reason FROM dedupe_queue WHERE id = ${id}`);
    expect(qItem!.status).toBe('dismissed');
    expect(qItem!.dismiss_reason).toBe('Distinct books in series');
  });
});

describe('30-Day Reversible Undo (FN-51, PRD §40.3)', () => {
  it('reverses a merge, restoring loser work, editions, and reads with exact attempt numbers', async () => {
    const a = await author(db, 'Neal Stephenson');
    const survivor = await work(db, 'Snow Crash', 1000, a);
    const loser = await work(db, 'Snow Crash (Special Edition)', 10, a);
    const edLoser = await edition(db, loser);

    const u1 = await user(db, 'u1@example.com');
    const u2 = await user(db, 'u2@example.com');

    // u1 read ONLY the loser
    const r1 = await read(db, u1, loser, 1);

    // u2 read BOTH: survivor is attempt 1, loser is attempt 1 -> will renumber to 2 on merge
    const r2Survivor = await read(db, u2, survivor, 1);
    const r2Loser = await read(db, u2, loser, 1);

    // Perform merge
    const { mergeId } = await mergeWorks(db, {
      survivorId: survivor,
      loserId: loser,
      stage: 3,
      reason: 'test merge for undo',
    });

    // Check post-merge state: loser is merged
    const [mergedLoser] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${loser}`);
    expect(mergedLoser!.merged_into_id).toBe(survivor);

    // Edition repointed to survivor
    const [mergedEd] = await db.execute<{ work_id: string }>(
      sql`SELECT work_id FROM editions WHERE id = ${edLoser}`);
    expect(mergedEd!.work_id).toBe(survivor);

    // u2's read on loser became attempt 2 on survivor
    const [renumberedRead] = await db.execute<{ work_id: string; attempt_no: number }>(
      sql`SELECT work_id, attempt_no FROM reads WHERE id = ${r2Loser}`);
    expect(renumberedRead!.work_id).toBe(survivor);
    expect(Number(renumberedRead!.attempt_no)).toBe(2);

    // Now UNDO the merge!
    const undoResult = await undoMerge(db, mergeId);
    expect(undoResult.undone).toBe(true);
    expect(undoResult.survivorId).toBe(survivor);
    expect(undoResult.loserId).toBe(loser);

    // 1. Loser work is untombstoned (merged_into_id is NULL)
    const [restoredLoser] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${loser}`);
    expect(restoredLoser!.merged_into_id).toBeNull();

    // 2. Edition is restored to loser
    const [restoredEd] = await db.execute<{ work_id: string }>(
      sql`SELECT work_id FROM editions WHERE id = ${edLoser}`);
    expect(restoredEd!.work_id).toBe(loser);

    // 3. Reads restored with exact original attempt numbers
    const [restoredR1] = await db.execute<{ work_id: string; attempt_no: number }>(
      sql`SELECT work_id, attempt_no FROM reads WHERE id = ${r1}`);
    expect(restoredR1!.work_id).toBe(loser);
    expect(Number(restoredR1!.attempt_no)).toBe(1);

    const [restoredR2] = await db.execute<{ work_id: string; attempt_no: number }>(
      sql`SELECT work_id, attempt_no FROM reads WHERE id = ${r2Loser}`);
    expect(restoredR2!.work_id).toBe(loser);
    expect(Number(restoredR2!.attempt_no)).toBe(1); // RESTORED to attempt 1!

    // Survivor's read remains untouched
    const [survivorRead] = await db.execute<{ work_id: string; attempt_no: number }>(
      sql`SELECT work_id, attempt_no FROM reads WHERE id = ${r2Survivor}`);
    expect(survivorRead!.work_id).toBe(survivor);
    expect(Number(survivorRead!.attempt_no)).toBe(1);

    // 4. work_merges record is marked undone
    const [mergeRow] = await db.execute<{ undone_at: string | null }>(
      sql`SELECT undone_at FROM work_merges WHERE id = ${mergeId}`);
    expect(mergeRow!.undone_at).not.toBeNull();
  });

  it('rejects undoing an already undone merge', async () => {
    const a = await author(db, 'Octavia Butler');
    const s = await work(db, 'Kindred', 500, a);
    const l = await work(db, 'Kindred 25th Anniv', 20, a);

    const { mergeId } = await mergeWorks(db, { survivorId: s, loserId: l, stage: 2, reason: 'test' });
    await undoMerge(db, mergeId);

    // Second undo must throw
    await expect(undoMerge(db, mergeId)).rejects.toThrow(/already been undone/);
  });

  it('rejects undo after the 30-day window expires (PRD §40.3)', async () => {
    const a = await author(db, 'Octavia Butler');
    const s = await work(db, 'Parable of the Sower', 800, a);
    const l = await work(db, 'Parable of the Sower (Copy)', 10, a);

    const { mergeId } = await mergeWorks(db, { survivorId: s, loserId: l, stage: 2, reason: 'test' });

    // Artificially age the merge to 31 days ago
    await db.execute(sql`
      UPDATE work_merges
      SET merged_at = now() - interval '31 days'
      WHERE id = ${mergeId}
    `);

    await expect(undoMerge(db, mergeId)).rejects.toThrow(/within 30 days/);
  });

  it('lists recent merges with undo eligibility flag', async () => {
    const a = await author(db, 'Shirley Jackson');
    const s = await work(db, 'The Haunting of Hill House', 600, a);
    const l = await work(db, 'Haunting of Hill House', 5, a);

    const { mergeId } = await mergeWorks(db, { survivorId: s, loserId: l, stage: 2, reason: 'test list' });

    const merges = await getRecentMerges(db);
    const item = merges.find((m) => m.id === mergeId);
    expect(item).toBeDefined();
    expect(item!.canUndo).toBe(true);
    expect(item!.survivor.title).toBe('The Haunting of Hill House');

    await undoMerge(db, mergeId);

    const mergesAfter = await getRecentMerges(db);
    const itemAfter = mergesAfter.find((m) => m.id === mergeId);
    expect(itemAfter!.canUndo).toBe(false);
    expect(itemAfter!.undoneAt).not.toBeNull();
  });
});

describe('Admin Dedupe & Merge HTTP Endpoints', () => {
  it('serves dedupe queue, preview, resolve, merges list, and undo via HTTP', async () => {
    const app = await buildApp({ db });
    await app.ready();

    const { secret } = await createAdminUser(db, {
      email: 'dedupe_runner@flyleaf.app',
      password: 'StrongAdminPass123',
      role: 'admin',
    });
    const { token: adminToken } = await loginAdmin(db, {
      email: 'dedupe_runner@flyleaf.app',
      password: 'StrongAdminPass123',
      totpCode: generateTotp(secret),
    });
    const authHeader = { Authorization: `Bearer ${adminToken}` };

    const a = await author(db, 'Italo Calvino');
    const w1 = await work(db, 'Invisible Cities', 350, a);
    const w2 = await work(db, 'Invisible Cities (Annotated)', 15, a);

    // 1. Report duplicate via POST /v1/admin/dedupe/report
    const reportRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/dedupe/report',
      headers: authHeader,
      payload: {
        survivor_id: w1,
        loser_id: w2,
        reason: 'Same translation with minor annotations',
      },
    });
    expect(reportRes.statusCode).toBe(200);
    const { id: queueId } = JSON.parse(reportRes.payload);

    // 2. Query queue via GET /v1/admin/dedupe/queue
    const queueRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/dedupe/queue',
      headers: authHeader,
    });
    expect(queueRes.statusCode).toBe(200);
    const queueData = JSON.parse(queueRes.payload);
    expect(queueData.data.some((d: any) => d.id === queueId)).toBe(true);

    // 3. Preview merge via GET /v1/admin/dedupe/preview/:survivorId/:loserId
    const previewRes = await app.inject({
      method: 'GET',
      url: `/v1/admin/dedupe/preview/${w1}/${w2}`,
      headers: authHeader,
    });
    expect(previewRes.statusCode).toBe(200);
    const previewData = JSON.parse(previewRes.payload);
    expect(previewData.survivor.title).toBe('Invisible Cities');

    // 4. Resolve candidate via POST /v1/admin/dedupe/queue/:id/resolve
    const resolveRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/dedupe/queue/${queueId}/resolve`,
      headers: authHeader,
      payload: { action: 'merge' },
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolveData = JSON.parse(resolveRes.payload);
    expect(resolveData.success).toBe(true);
    expect(resolveData.merge_id).toBeDefined();

    // 5. List merges via GET /v1/admin/merges
    const mergesRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/merges',
      headers: authHeader,
    });
    expect(mergesRes.statusCode).toBe(200);
    const mergesData = JSON.parse(mergesRes.payload);
    expect(mergesData.data.some((m: any) => m.id === resolveData.merge_id)).toBe(true);

    // 6. Undo merge via POST /v1/admin/merges/:id/undo
    const undoRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/merges/${resolveData.merge_id}/undo`,
      headers: authHeader,
    });
    expect(undoRes.statusCode).toBe(200);
    const undoData = JSON.parse(undoRes.payload);
    expect(undoData.undone).toBe(true);

    // 7. Server-rendered HTML review UI via GET /admin/merges
    const htmlRes = await app.inject({
      method: 'GET',
      url: '/admin/merges',
      headers: { cookie: `flyleaf_admin_session=${encodeURIComponent(adminToken)}` },
    });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.headers['content-type']).toContain('text/html');
    expect(htmlRes.payload).toContain('Flyleaf Admin — Catalog Merges');
    expect(htmlRes.payload).toContain('dedupe_runner@flyleaf.app');

    await app.close();
  });
});


// ---------------------------------------------------------------------------
// Audit Part 03: every table that references a work, merged AND undone.
//
// The table list comes from the real database (pg_constraint plus the non-FK
// references: mutes.target_id, profiles.favourite_work_ids,
// shelves.cover_work_ids, external_ids), not from what dedupe.ts happens to
// mention. `snapshot` is the oracle for "undo restores the exact prior state":
// it reads every one of those tables, so a table the undo forgets shows up as
// a diff rather than as a test nobody wrote.
// ---------------------------------------------------------------------------

async function snapshot(db: Db) {
  const q = async (text: string) => db.execute<Record<string, unknown>>(sql.raw(text));
  return {
    works: await q(`SELECT id, merged_into_id, log_count FROM works ORDER BY id`),
    reads: await q(`SELECT id, work_id, attempt_no, like_count, comment_count FROM reads ORDER BY id`),
    reviews: await q(`SELECT id, read_id, work_id FROM reviews ORDER BY id`),
    editions: await q(`SELECT id, work_id FROM editions ORDER BY id`),
    work_authors: await q(`SELECT work_id, author_id, role, position FROM work_authors ORDER BY 1, 2, 3`),
    work_subjects: await q(`SELECT work_id, subject_id FROM work_subjects ORDER BY 1, 2`),
    series_entries: await q(`SELECT series_id, work_id, position FROM series_entries ORDER BY 1, 2`),
    external_ids: await q(`SELECT entity_type, entity_id, provider, external_id FROM external_ids ORDER BY 3, 4`),
    field_provenance: await q(`SELECT entity_id, field_name, provider, is_locked FROM field_provenance ORDER BY 1, 2`),
    work_stats: await q(`SELECT work_id, rating_count, avg_rating, read_count FROM work_stats WHERE rating_count > 0 OR read_count > 0 ORDER BY 1`),
    shelf_items: await q(`SELECT shelf_id, work_id, position, note, added_at::text FROM shelf_items ORDER BY 1, 2`),
    shelves: await q(`SELECT id, item_count, cover_work_ids FROM shelves ORDER BY id`),
    activity: await q(`SELECT id, work_id FROM activity ORDER BY id`),
    mutes: await q(`SELECT user_id, target_type, target_id, created_at::text FROM mutes ORDER BY 1, 2, 3`),
    favourites: await q(`SELECT user_id, favourite_work_ids FROM profiles ORDER BY 1`),
    import_rows: await q(`SELECT import_id, row_no, work_id, edition_id FROM import_rows ORDER BY 1, 2`),
    read_likes: await q(`SELECT read_id, user_id FROM read_likes ORDER BY 1, 2`),
    read_comments: await q(`SELECT id, read_id FROM read_comments ORDER BY 1`),
  };
}

/**
 * Two duplicates that BOTH carry data in every referencing table, with a
 * collision wherever the table has one. `u1` touched both copies; `u2` only
 * the loser.
 */
async function richPair(db: Db) {
  const a = await author(db, 'Susanna Clarke');
  const translator = await author(db, 'A Translator');
  const survivor = await work(db, 'Piranesi', 100, a);
  const loser = await work(db, 'Piranesi', 7, a);
  const other = await work(db, 'Jonathan Strange', 50, a);
  const u1 = await user(db, 'both@example.com');
  const u2 = await user(db, 'loser-only@example.com');

  // catalog side
  await db.execute(sql`INSERT INTO work_authors (work_id, author_id, role, position) VALUES (${loser}, ${translator}, 'translator', 1)`);
  const [s1] = await db.execute<{ id: string }>(sql`INSERT INTO subjects (slug, name, kind) VALUES ('fantasy', 'Fantasy', 'genre') RETURNING id`);
  const [s2] = await db.execute<{ id: string }>(sql`INSERT INTO subjects (slug, name, kind) VALUES ('labyrinths', 'Labyrinths', 'theme') RETURNING id`);
  await db.execute(sql`INSERT INTO work_subjects (work_id, subject_id) VALUES (${survivor}, ${s1!.id}), (${loser}, ${s1!.id}), (${loser}, ${s2!.id})`);
  const [series] = await db.execute<{ id: string }>(sql`INSERT INTO series (name) VALUES ('House books') RETURNING id`);
  await db.execute(sql`INSERT INTO series_entries (series_id, work_id, position) VALUES (${series!.id}, ${loser}, 1)`);
  const loserEdition = await edition(db, loser);
  await db.execute(sql`
    INSERT INTO external_ids (entity_type, entity_id, provider, external_id) VALUES
      ('work', ${survivor}, 'open_library', 'OL1W'), ('work', ${loser}, 'open_library', 'OL2W')`);
  await db.execute(sql`
    INSERT INTO field_provenance (entity_type, entity_id, field_name, provider, is_locked)
    VALUES ('work', ${loser}, 'title', 'user', true)`);

  // reading side
  const u1Survivor = await read(db, u1, survivor, 1, '4.0');
  const u1Loser = await read(db, u1, loser, 1, '5.0');
  const u2Loser = await read(db, u2, loser, 1, '3.0');
  await db.execute(sql`UPDATE reads SET edition_id = ${loserEdition} WHERE id = ${u2Loser}`);
  await db.execute(sql`
    INSERT INTO reviews (read_id, user_id, work_id, body) VALUES
      (${u1Survivor}, ${u1}, ${survivor}, 'first time'),
      (${u1Loser}, ${u1}, ${loser}, 'second time'),
      (${u2Loser}, ${u2}, ${loser}, 'only time')`);
  await db.execute(sql`INSERT INTO read_likes (read_id, user_id) VALUES (${u2Loser}, ${u1})`);
  await db.execute(sql`INSERT INTO read_comments (read_id, user_id, body) VALUES (${u2Loser}, ${u1}, 'agreed')`);

  // shelves: u1 shelved BOTH copies on one shelf (PK collision); u2 only the loser
  const [shelfA] = await db.execute<{ id: string }>(sql`INSERT INTO shelves (user_id, name, slug) VALUES (${u1}, 'Best', 'best') RETURNING id`);
  const [shelfB] = await db.execute<{ id: string }>(sql`INSERT INTO shelves (user_id, name, slug) VALUES (${u2}, 'Mine', 'mine') RETURNING id`);
  await db.execute(sql`
    INSERT INTO shelf_items (shelf_id, work_id, position, note) VALUES
      (${shelfA!.id}, ${survivor}, 0, NULL), (${shelfA!.id}, ${loser}, 1, 'the copy I own'),
      (${shelfB!.id}, ${loser}, 0, NULL), (${shelfB!.id}, ${other}, 1, NULL)`);

  // feed
  await db.execute(sql`
    INSERT INTO activity (actor_id, verb, work_id, object_type, object_id) VALUES
      (${u1}, 'finished', ${survivor}, 'read', ${u1Survivor}),
      (${u2}, 'finished', ${loser}, 'read', ${u2Loser})`);

  // mutes: u1 muted both copies (PK collision); u2 only the loser
  await db.execute(sql`
    INSERT INTO mutes (user_id, target_type, target_id) VALUES
      (${u1}, 'work', ${survivor}), (${u1}, 'work', ${loser}), (${u2}, 'work', ${loser})`);
  // Microsecond timestamps on the rows a merge DROPS, so undo must restore
  // them exactly (a JS Date round trip would keep only milliseconds).
  await db.execute(sql`UPDATE mutes SET created_at = '2026-01-02 03:04:05.123456+00' WHERE user_id = ${u1} AND target_id = ${loser}`);
  await db.execute(sql`UPDATE shelf_items SET added_at = '2026-01-02 03:04:05.654321+00' WHERE shelf_id = ${shelfA!.id} AND work_id = ${loser}`);

  // favourites: u1 has both copies (duplicate slot); u2 has the loser second
  await db.execute(sql`UPDATE profiles SET favourite_work_ids = ARRAY[${loser}, ${survivor}]::uuid[] WHERE user_id = ${u1}`);
  await db.execute(sql`UPDATE profiles SET favourite_work_ids = ARRAY[${other}, ${loser}]::uuid[] WHERE user_id = ${u2}`);

  // imports
  const [imp] = await db.execute<{ id: string }>(sql`INSERT INTO imports (user_id, source) VALUES (${u2}, 'goodreads') RETURNING id`);
  await db.execute(sql`
    INSERT INTO import_rows (import_id, row_no, raw, state, work_id, edition_id)
    VALUES (${imp!.id}, 1, '{}'::jsonb, 'matched', ${loser}, ${loserEdition})`);

  return {
    survivor, loser, other, u1, u2, u1Survivor, u1Loser, u2Loser, loserEdition,
    shelfA: shelfA!.id, shelfB: shelfB!.id, translator, subjectOnlyOnLoser: s2!.id, series: series!.id,
  };
}

describe('merge coverage: every table that references a work (Audit 03)', () => {
  it('reviews follow their read to the survivor', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const rows = await db.execute<{ work_id: string }>(sql`SELECT work_id FROM reviews`);
    expect(rows.map((r) => r.work_id)).toEqual([p.survivor, p.survivor, p.survivor]);
  });

  it('shelf items repoint; a shelf holding both copies keeps one, and its mosaic and count follow', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const items = await db.execute<{ shelf_id: string; work_id: string; position: number }>(sql`
      SELECT shelf_id, work_id, position FROM shelf_items ORDER BY shelf_id = ${p.shelfA} DESC, position`);
    expect(items.map((i) => [i.shelf_id, i.work_id, Number(i.position)])).toEqual([
      [p.shelfA, p.survivor, 0],
      [p.shelfB, p.survivor, 0],
      [p.shelfB, p.other, 1],
    ]);
    const shelves = await db.execute<{ id: string; item_count: number; cover_work_ids: string[] }>(sql`
      SELECT id, item_count, cover_work_ids FROM shelves ORDER BY id = ${p.shelfA} DESC`);
    expect(shelves.map((s) => [Number(s.item_count), s.cover_work_ids])).toEqual([
      [1, [p.survivor]],
      [2, [p.survivor, p.other]],
    ]);
  });

  it('feed activity points at the survivor', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM activity WHERE work_id = ${p.loser}`);
    expect(n!.n).toBe(0);
  });

  it('a muted duplicate stays muted, and muting both copies does not collide', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const rows = await db.execute<{ user_id: string; target_id: string }>(sql`
      SELECT user_id, target_id FROM mutes WHERE target_type = 'work' ORDER BY user_id = ${p.u1} DESC`);
    expect(rows.map((r) => [r.user_id, r.target_id])).toEqual([
      [p.u1, p.survivor],
      [p.u2, p.survivor],
    ]);
  });

  it('favourites swap to the survivor in place, without a duplicate slot', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const rows = await db.execute<{ user_id: string; favourite_work_ids: string[] }>(sql`
      SELECT user_id, favourite_work_ids FROM profiles ORDER BY user_id = ${p.u1} DESC`);
    expect(rows.map((r) => r.favourite_work_ids)).toEqual([[p.survivor], [p.other, p.survivor]]);
  });

  it('import rows point at the survivor', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const [row] = await db.execute<{ work_id: string }>(sql`SELECT work_id FROM import_rows`);
    expect(row!.work_id).toBe(p.survivor);
  });

  it('the survivor gains the loser\'s log count', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const [w] = await db.execute<{ log_count: number }>(sql`SELECT log_count FROM works WHERE id = ${p.survivor}`);
    expect(Number(w!.log_count)).toBe(107);
  });

  it('work_stats is recomputed for the survivor from all moved reads', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const rows = await db.execute<{ work_id: string; rating_count: number; avg_rating: string; read_count: number }>(sql`
      SELECT work_id, rating_count, avg_rating, read_count FROM work_stats`);
    expect(rows.map((r) => [r.work_id, Number(r.rating_count), Number(r.avg_rating), Number(r.read_count)]))
      .toEqual([[p.survivor, 3, 4, 2]]);
  });

  it('likes and comments stay on their read, counters intact', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const [r] = await db.execute<{ work_id: string; like_count: number; comment_count: number }>(sql`
      SELECT work_id, like_count, comment_count FROM reads WHERE id = ${p.u2Loser}`);
    expect([r!.work_id, Number(r!.like_count), Number(r!.comment_count)]).toEqual([p.survivor, 1, 1]);
  });

  it('the loser keeps its own field provenance: a merge never copies field values', async () => {
    const p = await richPair(db);
    await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });

    const rows = await db.execute<{ entity_id: string }>(sql`SELECT entity_id FROM field_provenance`);
    expect(rows.map((r) => r.entity_id)).toEqual([p.loser]);
  });

  it('undo restores the exact prior state of every referencing table', async () => {
    const p = await richPair(db);
    const before = await snapshot(db);

    const { mergeId } = await mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' });
    expect(await snapshot(db)).not.toEqual(before);
    await undoMerge(db, mergeId);

    const after = await snapshot(db);
    for (const table of Object.keys(before) as (keyof typeof before)[]) {
      expect({ table, rows: after[table] }).toEqual({ table, rows: before[table] });
    }
  });
});

describe('merge and undo safety (Audit 03)', () => {
  it('a failure part-way through a merge leaves nothing changed', async () => {
    const p = await richPair(db);
    const before = await snapshot(db);
    // Fires on the LAST step (tombstoning the loser), after every repoint.
    await client.exec(`
      CREATE FUNCTION fail_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.merged_into_id IS NOT NULL THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_tombstone BEFORE UPDATE ON works FOR EACH ROW EXECUTE FUNCTION fail_tombstone();`);
    try {
      await expect(mergeWorks(db, { survivorId: p.survivor, loserId: p.loser, stage: 2, reason: 'test' }))
        .rejects.toThrow();
    } finally {
      await client.exec(`DROP TRIGGER fail_tombstone ON works; DROP FUNCTION fail_tombstone();`);
    }
    expect(await snapshot(db)).toEqual(before);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM work_merges`);
    expect(n!.n).toBe(0);
  });

  it('refuses to merge into a work that has itself been merged away', async () => {
    const a = await author(db, 'Susanna Clarke');
    const x = await work(db, 'Piranesi', 10, a);
    const y = await work(db, 'Piranesi', 20, a);
    const z = await work(db, 'Piranesi', 30, a);
    await mergeWorks(db, { survivorId: z, loserId: y, stage: 2, reason: 'test' });

    // y is a tombstone now; moving x's reads onto it would hide them.
    await expect(mergeWorks(db, { survivorId: y, loserId: x, stage: 2, reason: 'test' }))
      .rejects.toMatchObject({ status: 409, code: 'work_merged' });
  });

  it('undo is allowed just inside 30 days and refused just outside', async () => {
    const a = await author(db, 'Octavia Butler');
    const s1 = await work(db, 'Kindred', 500, a);
    const l1 = await work(db, 'Kindred', 5, a);
    const s2 = await work(db, 'Dawn', 500, a);
    const l2 = await work(db, 'Dawn', 5, a);
    const inside = await mergeWorks(db, { survivorId: s1, loserId: l1, stage: 2, reason: 'test' });
    const outside = await mergeWorks(db, { survivorId: s2, loserId: l2, stage: 2, reason: 'test' });
    await db.execute(sql`UPDATE work_merges SET merged_at = now() - interval '30 days' + interval '1 minute' WHERE id = ${inside.mergeId}`);
    await db.execute(sql`UPDATE work_merges SET merged_at = now() - interval '30 days' - interval '1 minute' WHERE id = ${outside.mergeId}`);

    await expect(undoMerge(db, inside.mergeId)).resolves.toMatchObject({ undone: true });
    await expect(undoMerge(db, outside.mergeId)).rejects.toThrow(/within 30 days/);
  });

  it('a chain undoes newest-first: the older merge is refused until the newer one is undone', async () => {
    const a = await author(db, 'Susanna Clarke');
    const b = await work(db, 'Piranesi', 10, a);
    const x = await work(db, 'Piranesi', 20, a);
    const c = await work(db, 'Piranesi', 30, a);
    const u = await user(db, 'reader@example.com');
    await read(db, u, b, 1);
    await read(db, u, x, 1);
    await read(db, u, c, 1);
    const before = await snapshot(db);

    const first = await mergeWorks(db, { survivorId: x, loserId: b, stage: 2, reason: 'test' });
    const second = await mergeWorks(db, { survivorId: c, loserId: x, stage: 2, reason: 'test' });

    // x is merged into c: restoring b "into" x would un-tombstone b while its
    // reads sit on c, and x's later undo would then re-chain b onto x.
    await expect(undoMerge(db, first.mergeId)).rejects.toMatchObject({ status: 409, code: 'survivor_merged' });

    await undoMerge(db, second.mergeId);
    await undoMerge(db, first.mergeId);
    expect(await snapshot(db)).toEqual(before);
  });

  it('refuses undo when the loser has gained reads since the merge, instead of a unique-violation 500', async () => {
    const a = await author(db, 'Susanna Clarke');
    const s = await work(db, 'Piranesi', 10, a);
    const l = await work(db, 'Piranesi', 5, a);
    const u = await user(db, 'reader@example.com');
    await read(db, u, l, 1);
    const { mergeId } = await mergeWorks(db, { survivorId: s, loserId: l, stage: 2, reason: 'test' });
    // A stale client id logged straight onto the tombstone (A-03-008).
    await read(db, u, l, 1);

    await expect(undoMerge(db, mergeId)).rejects.toMatchObject({ status: 409, code: 'loser_modified' });
  });

  it('resolving the same queue item twice merges once', async () => {
    const a = await author(db, 'China Miéville');
    const w1 = await work(db, 'The City & The City', 400, a);
    const w2 = await work(db, 'The City and the City', 10, a);
    const { id } = await queueReportedDuplicate(db, { survivorId: w1, loserId: w2, reason: 'variant' });

    const results = await Promise.allSettled([
      resolveQueueItem(db, id, 'merge'),
      resolveQueueItem(db, id, 'merge'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // The loser must be a clean 4xx, not a raw constraint error that surfaces as a 500.
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected!.reason).toMatchObject({ status: 400, code: 'already_resolved' });
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM work_merges`);
    expect(n!.n).toBe(1);
  });
});

describe('detection rules on real catalog shapes (Audit 03)', () => {
  // A-03-004: the full catalog has 10,572 stage-2 pairs whose subtitles are
  // BOTH present and differ, and every one of 25 sampled was two different
  // books ("Harry Potter: Diagon Alley" / "Harry Potter: Magical Creatures").
  it('stage 2 holds back two different subtitles instead of auto-merging them', async () => {
    const a = await author(db, 'J. K. Rowling');
    const one = await work(db, 'Harry Potter: Diagon Alley', 50, a);
    const two = await work(db, 'Harry Potter: Magical Creatures', 40, a);

    const report = await runDedupe(db);
    expect(report).toMatchObject({ stage2: 1, held: 1, merged: 0 });
    const rows = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id IN (${one}, ${two})`);
    expect(rows.every((r) => r.merged_into_id === null)).toBe(true);
  });

  it('stage 2 still merges a bare title with its subtitled copy (the case the rule exists for)', async () => {
    const a = await author(db, 'Frank Herbert');
    await work(db, 'Dune', 44000, a);
    const gone = await work(db, 'Dune: A Novel', 4, a);

    expect(await runDedupe(db)).toMatchObject({ stage2: 1, held: 0, merged: 1 });
    const [row] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${gone}`);
    expect(row!.merged_into_id).not.toBeNull();
  });

  // A-03-005: 30,240 stage-1 pairs on the full catalog; among different-title
  // pairs, publishers re-using an ISBN for unrelated books are common.
  it('stage 1 holds back a shared ISBN between works whose titles differ', async () => {
    const x = await work(db, 'Bidirectional Control of DC Motor', 3);
    const y = await work(db, 'Behaviour of Concrete with Groundnut Shell Ash', 2);
    await edition(db, x, '9788193323519');
    await edition(db, y, '9788193323519');

    expect(await runDedupe(db)).toMatchObject({ stage1: 1, held: 1, merged: 0 });
  });

  it('stage 1 merges a shared ISBN between works with the same normalised title', async () => {
    const x = await work(db, 'The Greek Fathers', 3);
    const y = await work(db, 'Greek Fathers', 2);
    await edition(db, x, '9781586170134');
    await edition(db, y, '9781586170134');

    expect(await runDedupe(db)).toMatchObject({ stage1: 1, held: 0, merged: 1 });
  });

  // PRD §40.3: stage 3 is similarity on the NORMALISED title. On the raw
  // titles this pair scores far below 0.85 and is never queued.
  it('stage 3 compares normalised titles, and matches authors by name across author records', async () => {
    const tolkien1 = await author(db, 'J.R.R. Tolkien');
    const tolkien2 = await author(db, 'J. R. R. Tolkien');
    const keep = await work(db, 'The Hobbit: or There and Back Again', 900, tolkien1);
    const dupe = await work(db, 'Hobbit', 3, tolkien2);

    const found = await findStage3Candidates(db);
    expect(found.map((c) => [c.survivorId, c.loserId])).toEqual([[keep, dupe]]);
  });

  it('a failing stage-3 pass does not undo or block the stage 1–2 merges', async () => {
    const a = await author(db, 'Susanna Clarke');
    await work(db, 'Piranesi', 561, a);
    const gone = await work(db, 'Piranesi', 3, a);
    await client.exec(`
      CREATE FUNCTION fail_queue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'queue down'; END $$;
      CREATE TRIGGER fail_queue BEFORE INSERT ON dedupe_queue FOR EACH ROW EXECUTE FUNCTION fail_queue();`);
    await work(db, 'Jonathan Strange & Mr Norrell', 500, a);
    await work(db, 'Jonathan Strange and Mr Norrell', 10, a);
    try {
      await expect(runDedupe(db)).rejects.toThrow();
    } finally {
      await client.exec(`DROP TRIGGER fail_queue ON dedupe_queue; DROP FUNCTION fail_queue();`);
    }
    const [row] = await db.execute<{ merged_into_id: string | null }>(
      sql`SELECT merged_into_id FROM works WHERE id = ${gone}`);
    expect(row!.merged_into_id).not.toBeNull();
  });
});

describe('duplicate reports (Audit 03)', () => {
  // Stage 4 comes from signed-in users' correction flow (PRD §6.46) and from
  // staff. A guest could fill the review queue with no identity attached.
  it('refuses a report from a guest with 401', async () => {
    const app = await buildApp({ db });
    await app.ready();
    const a = await author(db, 'Italo Calvino');
    const w1 = await work(db, 'Invisible Cities', 350, a);
    const w2 = await work(db, 'Invisible Cities (Annotated)', 15, a);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dedupe/report',
      payload: { survivor_id: w1, loser_id: w2, reason: 'same book' },
    });
    expect(res.statusCode).toBe(401);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM dedupe_queue`);
    expect(n!.n).toBe(0);
    await app.close();
  });
});

describe('admin review console (Audit 03, FN-51)', () => {
  async function staff(role: 'admin' | 'moderator', email: string) {
    const { secret } = await createAdminUser(db, { email, password: 'StrongAdminPass123', role });
    const { token } = await loginAdmin(db, { email, password: 'StrongAdminPass123', totpCode: generateTotp(secret) });
    return token;
  }

  it('a moderator can review but not merge, dismiss or undo', async () => {
    const app = await buildApp({ db });
    await app.ready();
    const token = await staff('moderator', 'mod@flyleaf.app');
    const auth = { Authorization: `Bearer ${token}` };
    const a = await author(db, 'Italo Calvino');
    const w1 = await work(db, 'Invisible Cities', 350, a);
    const w2 = await work(db, 'Invisible Cities (Annotated)', 15, a);
    const { id } = await queueReportedDuplicate(db, { survivorId: w1, loserId: w2, reason: 'same book' });
    const { mergeId } = await mergeWorks(db, { survivorId: w1, loserId: await work(db, 'Invisible Cities', 1, a), stage: 2, reason: 't' });

    expect((await app.inject({ method: 'GET', url: '/v1/admin/dedupe/queue', headers: auth })).statusCode).toBe(200);
    for (const action of ['merge', 'dismiss']) {
      const res = await app.inject({
        method: 'POST', url: `/v1/admin/dedupe/queue/${id}/resolve`, headers: auth, payload: { action },
      });
      expect(res.statusCode).toBe(403);
    }
    const undo = await app.inject({ method: 'POST', url: `/v1/admin/merges/${mergeId}/undo`, headers: auth });
    expect(undo.statusCode).toBe(403);

    const [q] = await db.execute<{ status: string }>(sql`SELECT status FROM dedupe_queue WHERE id = ${id}`);
    expect(q!.status).toBe('pending');
    await app.close();
  });

  it('writes an audit-log entry for a dismissal', async () => {
    const app = await buildApp({ db });
    await app.ready();
    const token = await staff('admin', 'boss@flyleaf.app');
    const a = await author(db, 'Gene Wolfe');
    const w1 = await work(db, 'The Shadow of the Torturer', 400, a);
    const w2 = await work(db, 'The Claw of the Conciliator', 300, a);
    const { id } = await queueReportedDuplicate(db, { survivorId: w1, loserId: w2, reason: 'mistake' });

    const res = await app.inject({
      method: 'POST', url: `/v1/admin/dedupe/queue/${id}/resolve`,
      headers: { Authorization: `Bearer ${token}` }, payload: { action: 'dismiss', reason: 'different books' },
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.execute<{ action: string; subject_id: string; reason: string }>(sql`
      SELECT action, subject_id, reason FROM admin_audit_log WHERE action = 'catalog.dismiss_duplicate'`);
    expect(rows).toEqual([{ action: 'catalog.dismiss_duplicate', subject_id: id, reason: 'different books' }]);
    await app.close();
  });

  it('escapes catalog text in the review page', async () => {
    const app = await buildApp({ db });
    await app.ready();
    const token = await staff('admin', 'boss@flyleaf.app');
    const a = await author(db, '"><img src=x onerror=alert(1)>');
    const w1 = await work(db, '<script>alert("t")</script>', 400, a);
    const w2 = await work(db, "It's </h3><b>bold</b>", 3, a);
    await queueReportedDuplicate(db, { survivorId: w1, loserId: w2, reason: '<i>why</i>' });
    await mergeWorks(db, { survivorId: w1, loserId: await work(db, 'x', 1, a), stage: 2, reason: 't' });

    const res = await app.inject({
      method: 'GET', url: '/admin/merges',
      headers: { cookie: `flyleaf_admin_session=${encodeURIComponent(token)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('<script>alert');
    expect(res.payload).not.toContain('<img src=x');
    expect(res.payload).not.toContain('<b>bold</b>');
    expect(res.payload).not.toContain('<i>why</i>');
    expect(res.payload).toContain('&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;');
    await app.close();
  });
});

describe('stage 4 report races (Audit 03)', () => {
  it('two identical reports at once queue one item and both succeed', async () => {
    const a = await author(db, 'Ted Chiang');
    const w1 = await work(db, 'Exhalation', 200, a);
    const w2 = await work(db, 'Exhalation: Stories', 50, a);

    const [r1, r2] = await Promise.all([
      queueReportedDuplicate(db, { survivorId: w1, loserId: w2, reason: 'same book' }),
      queueReportedDuplicate(db, { survivorId: w1, loserId: w2, reason: 'same book' }),
    ]);
    expect(r1.id).toBe(r2.id);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM dedupe_queue`);
    expect(n!.n).toBe(1);
  });
});

describe('undo races (Audit 03)', () => {
  it('two undos of the same merge at once: one succeeds, the other is a clean 409', async () => {
    const a = await author(db, 'Octavia Butler');
    const s = await work(db, 'Kindred', 500, a);
    const l = await work(db, 'Kindred', 20, a);
    const u = await user(db, 'reader@example.com');
    await read(db, u, s, 1);
    await read(db, u, l, 1);
    const { mergeId } = await mergeWorks(db, { survivorId: s, loserId: l, stage: 2, reason: 'test' });

    const results = await Promise.allSettled([undoMerge(db, mergeId), undoMerge(db, mergeId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected!.reason).toMatchObject({ status: 409, code: 'merge_already_undone' });
  });
});
