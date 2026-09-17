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

    const a = await author(db, 'Italo Calvino');
    const w1 = await work(db, 'Invisible Cities', 350, a);
    const w2 = await work(db, 'Invisible Cities (Annotated)', 15, a);

    // 1. Report duplicate via POST /v1/admin/dedupe/report
    const reportRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/dedupe/report',
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
    });
    expect(queueRes.statusCode).toBe(200);
    const queueData = JSON.parse(queueRes.payload);
    expect(queueData.data.some((d: any) => d.id === queueId)).toBe(true);

    // 3. Preview merge via GET /v1/admin/dedupe/preview/:survivorId/:loserId
    const previewRes = await app.inject({
      method: 'GET',
      url: `/v1/admin/dedupe/preview/${w1}/${w2}`,
    });
    expect(previewRes.statusCode).toBe(200);
    const previewData = JSON.parse(previewRes.payload);
    expect(previewData.survivor.title).toBe('Invisible Cities');

    // 4. Resolve candidate via POST /v1/admin/dedupe/queue/:id/resolve
    const resolveRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/dedupe/queue/${queueId}/resolve`,
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
    });
    expect(mergesRes.statusCode).toBe(200);
    const mergesData = JSON.parse(mergesRes.payload);
    expect(mergesData.data.some((m: any) => m.id === resolveData.merge_id)).toBe(true);

    // 6. Undo merge via POST /v1/admin/merges/:id/undo
    const undoRes = await app.inject({
      method: 'POST',
      url: `/v1/admin/merges/${resolveData.merge_id}/undo`,
    });
    expect(undoRes.statusCode).toBe(200);
    const undoData = JSON.parse(undoRes.payload);
    expect(undoData.undone).toBe(true);

    // 7. Server-rendered HTML review UI via GET /admin/merges
    const htmlRes = await app.inject({
      method: 'GET',
      url: '/admin/merges',
    });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.headers['content-type']).toContain('text/html');
    expect(htmlRes.payload).toContain('Flyleaf Admin — Catalog Merges');

    await app.close();
  });
});

