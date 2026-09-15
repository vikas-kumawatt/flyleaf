// Duplicate detection and merging (FN-50, PRD §40.3).
//
// Open Library contains genuine duplicate works — the same book entered twice
// under slightly different titles, or split across records nobody merged.
// Ranking by usage HIDES duplicates in search but never resolves them: the
// ratings stay split across both records, so **both averages are wrong**.
// That is why this exists even though `log_count` already sorts the popular
// copy to the top.
//
// The four stages from PRD §40.3, and what is possible today:
//
//   1 — Exact     two works whose editions share an ISBN-13   auto-merge
//   2 — Strong    normalised title identical AND shared author auto-merge
//   3 — Probable  trigram title >0.85, author >0.9, years ±2  QUEUE, never auto
//   4 — Reported  from the correction flow                     queue
//
// Stage 1 is written and INERT: ISBNs live on editions and the catalog holds
// 102 of them until the 9.2 GB editions pass runs. It is here rather than
// deferred because the merge machinery is identical and writing it later
// would mean re-deriving all of the collision handling below.
//
// Stages 3 and 4 are FN-51. They are deliberately not auto-merged: that band
// contains reissues, different translations and series entries with nearly
// identical titles, and a wrong merge destroys two books' worth of ratings.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';

/**
 * Title normalisation for stage 2.
 *
 * PRD: "case, punctuation, leading articles and subtitle stripped". Each of
 * those is a real duplicate pattern in the dump — "The Hobbit" vs "Hobbit",
 * "Dune" vs "Dune: A Novel", "Nineteen Eighty-Four" vs "Nineteen Eighty Four".
 *
 * Deliberately NOT accent-folded here: `flyleaf_unaccent` is for search, where
 * a false match costs a slightly wrong result. Here a false match destroys a
 * book. Stripping accents would collide distinct translations.
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    // Subtitle: everything after the first colon. "Dune: A Novel" -> "dune".
    .split(':')[0]!
    .replace(/^(the|a|an)\s+/u, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type MergeCandidate = {
  survivorId: string;
  loserId: string;
  stage: 1 | 2;
  reason: string;
};

/**
 * Survivor selection, from PRD §40.3: more editions, then more Flyleaf logs.
 *
 * Editions first because the record more of the world's metadata hangs off is
 * the one with the better claim to being the canonical work — a record with
 * fourteen editions and no logs is still the real entry.
 *
 * `id` is the final tiebreak so the choice is stable across runs. Without it,
 * two works with identical counts could swap survivor between runs and the
 * merge log would describe a merge that no longer matches the data.
 */
const SURVIVOR_ORDER = sql`
  (SELECT count(*) FROM editions e WHERE e.work_id = w.id) DESC,
  w.log_count DESC,
  w.id ASC`;

/**
 * Stage 2 pairs: identical normalised title AND at least one shared author.
 *
 * The shared author is what makes this safe to auto-merge. Title alone would
 * merge every book called "Poems"; the catalog has hundreds.
 *
 * Normalisation happens in SQL rather than by pulling 3.2M titles into Node,
 * and mirrors `normaliseTitle` above — there is a test asserting the two agree,
 * because two implementations of one rule is exactly how a dedupe pass starts
 * merging the wrong things.
 */
/**
 * `normaliseTitle` as a SQL expression, over a column called `title`.
 *
 * Exported so the test can run THIS against the same inputs it gives the
 * TypeScript version and assert they agree. Two implementations of one rule
 * is exactly how a dedupe pass starts merging the wrong things, and the
 * divergence would only show up as books quietly disappearing.
 */
export const NORMALISED_TITLE_EXPR = `
  btrim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(split_part(title, ':', 1)), '^(the|a|an)\\s+', ''),
      '[[:punct:]]', ' ', 'g'),
    '\\s+', ' ', 'g'))`;

export const STAGE2_SQL = `
  WITH author_works AS (
    SELECT wa.author_id, w.id, w.log_count,
           ${NORMALISED_TITLE_EXPR.replace(/\btitle\b/g, 'w.title')} AS norm
    FROM work_authors wa
    JOIN works w ON w.id = wa.work_id
    WHERE w.merged_into_id IS NULL AND NOT w.is_provisional
  ),
  dup_groups AS (
    SELECT author_id, norm
    FROM author_works
    WHERE norm <> ''
    GROUP BY author_id, norm
    HAVING count(*) > 1
  ),
  candidates AS (
    SELECT DISTINCT aw.id, aw.norm, aw.log_count,
           (SELECT count(*) FROM editions e WHERE e.work_id = aw.id) AS edition_count
    FROM dup_groups dg
    JOIN author_works aw ON aw.author_id = dg.author_id AND aw.norm = dg.norm
  ),
  pairs AS (
    SELECT a.id AS a_id, b.id AS b_id, a.norm
    FROM candidates a
    JOIN candidates b
      ON b.norm = a.norm
     AND b.id <> a.id
     -- Ordered so each pair appears once, with the survivor first.
     AND (a.edition_count, a.log_count, b.id) > (b.edition_count, b.log_count, a.id)
    WHERE EXISTS (
      SELECT 1
      FROM work_authors wa JOIN work_authors wb ON wb.author_id = wa.author_id
      WHERE wa.work_id = a.id AND wb.work_id = b.id
    )
  )
  SELECT a_id AS survivor_id, b_id AS loser_id, norm FROM pairs
  ORDER BY norm
  LIMIT $1`;

/**
 * Stage 1 pairs: two live works whose editions claim the same ISBN-13.
 *
 * INERT until the editions pass runs — with 102 editions this returns nothing.
 * An ISBN identifies one physical edition, so two works claiming it are one
 * work; this is the only stage that needs no title comparison at all.
 */
export const STAGE1_SQL = `
  WITH shared AS (
    SELECT e1.work_id AS a_id, e2.work_id AS b_id, e1.isbn_13
    FROM editions e1
    JOIN editions e2 ON e2.isbn_13 = e1.isbn_13 AND e2.work_id <> e1.work_id
    WHERE e1.isbn_13 IS NOT NULL
  ),
  live AS (
    SELECT s.*,
           (SELECT count(*) FROM editions e WHERE e.work_id = s.a_id) AS a_editions,
           (SELECT count(*) FROM editions e WHERE e.work_id = s.b_id) AS b_editions,
           wa.log_count AS a_logs, wb.log_count AS b_logs
    FROM shared s
    JOIN works wa ON wa.id = s.a_id AND wa.merged_into_id IS NULL AND NOT wa.is_provisional
    JOIN works wb ON wb.id = s.b_id AND wb.merged_into_id IS NULL AND NOT wb.is_provisional
  )
  SELECT DISTINCT a_id AS survivor_id, b_id AS loser_id, isbn_13
  FROM live
  WHERE (a_editions, a_logs, b_id) > (b_editions, b_logs, a_id)
  LIMIT $1`;

/**
 * Move everything that points at the loser, then tombstone it.
 *
 * SEVEN tables reference `works.id`, and four of them can collide on a naive
 * repoint. The collisions are the whole difficulty of a merge; getting one
 * wrong throws a constraint violation at best and silently drops a user's
 * reading history at worst.
 *
 *   reads           UNIQUE (user_id, work_id, attempt_no) — a user who logged
 *                   BOTH duplicates collides. Attempts are renumbered to
 *                   continue after that user's existing attempts, which is
 *                   also the semantically right answer: they did read it twice.
 *   work_authors    PK (work_id, author_id, role)         — ON CONFLICT DO NOTHING
 *   work_subjects   PK (work_id, subject_id)              — ON CONFLICT DO NOTHING
 *   work_stats      PK (work_id)                          — the loser's row is
 *                   dropped, not merged: `stats.workstats` recomputes from
 *                   `reads`, which have just moved.
 *   series_entries  PK (series_id, work_id)               — ON CONFLICT DO NOTHING
 *   editions        no collision                          — plain repoint
 *   external_ids /
 *   field_provenance  PK includes entity_id               — ON CONFLICT DO NOTHING
 *
 * And merge CHAINS: anything already merged into the loser must be repointed
 * at the survivor, or following `merged_into_id` from an old link lands on a
 * tombstone that itself points elsewhere.
 *
 * All of it in ONE transaction. A half-applied merge leaves reads pointing at
 * a work that is about to be tombstoned.
 */
export async function mergeWorks(
  db: Db,
  { survivorId, loserId, stage, reason }: MergeCandidate,
): Promise<{ mergeId: string; moved: Record<string, unknown> }> {
  if (survivorId === loserId) throw new Error('cannot merge a work into itself');

  return db.transaction(async (tx) => {
    // Recorded BEFORE the update, because afterwards nothing remembers what
    // the attempt numbers were. This is what makes the 30-day undo possible.
    const priorReads = await tx.execute<{ id: string; attempt_no: number }>(sql`
      SELECT id, attempt_no FROM reads WHERE work_id = ${loserId}`);

    const readsMoved = await tx.execute<{ id: string }>(sql`
      WITH base AS (
        SELECT user_id, max(attempt_no) AS n FROM reads
        WHERE work_id = ${survivorId} GROUP BY user_id
      ),
      moving AS (
        SELECT r.id,
               COALESCE(b.n, 0) + row_number() OVER (
                 PARTITION BY r.user_id ORDER BY r.attempt_no, r.created_at
               ) AS new_attempt
        FROM reads r
        LEFT JOIN base b ON b.user_id = r.user_id
        WHERE r.work_id = ${loserId}
      )
      UPDATE reads r
      SET work_id = ${survivorId}, attempt_no = m.new_attempt, updated_at = now()
      FROM moving m
      WHERE r.id = m.id
      RETURNING r.id`);

    const editions = await tx.execute(sql`
      UPDATE editions SET work_id = ${survivorId} WHERE work_id = ${loserId} RETURNING id`);

    // The ON CONFLICT tables. Insert what the survivor lacks, then drop the
    // loser's rows — an UPDATE would fail on the duplicates.
    await tx.execute(sql`
      INSERT INTO work_authors (work_id, author_id, role, position)
      SELECT ${survivorId}, author_id, role, position FROM work_authors WHERE work_id = ${loserId}
      ON CONFLICT (work_id, author_id, role) DO NOTHING`);
    await tx.execute(sql`DELETE FROM work_authors WHERE work_id = ${loserId}`);

    await tx.execute(sql`
      INSERT INTO work_subjects (work_id, subject_id, weight)
      SELECT ${survivorId}, subject_id, weight FROM work_subjects WHERE work_id = ${loserId}
      ON CONFLICT (work_id, subject_id) DO NOTHING`);
    await tx.execute(sql`DELETE FROM work_subjects WHERE work_id = ${loserId}`);

    await tx.execute(sql`
      INSERT INTO series_entries (series_id, work_id, position)
      SELECT series_id, ${survivorId}, position FROM series_entries WHERE work_id = ${loserId}
      ON CONFLICT (series_id, work_id) DO NOTHING`);
    await tx.execute(sql`DELETE FROM series_entries WHERE work_id = ${loserId}`);

    for (const table of ['external_ids', 'field_provenance'] as const) {
      await tx.execute(sql.raw(`
        UPDATE ${table} SET entity_id = '${survivorId}'
        WHERE entity_type = 'work' AND entity_id = '${loserId}'
          AND NOT EXISTS (
            SELECT 1 FROM ${table} t2
            WHERE t2.entity_type = 'work' AND t2.entity_id = '${survivorId}'
              ${table === 'external_ids'
                ? `AND t2.provider = ${table}.provider AND t2.external_id = ${table}.external_id`
                : `AND t2.field_name = ${table}.field_name`}
          )`));
      await tx.execute(sql.raw(
        `DELETE FROM ${table} WHERE entity_type = 'work' AND entity_id = '${loserId}'`));
    }

    // Recomputed from reads, which have just moved. Merging the numbers by
    // hand would double-count anyone who logged both copies.
    await tx.execute(sql`DELETE FROM work_stats WHERE work_id = ${loserId}`);

    // Flatten chains: B was merged into C, now C merges into A, so B must
    // point at A too. Otherwise resolving an old id takes two hops, and the
    // next merge makes it three.
    const rechained = await tx.execute(sql`
      UPDATE works SET merged_into_id = ${survivorId}
      WHERE merged_into_id = ${loserId} RETURNING id`);

    await tx.execute(sql`
      UPDATE works SET merged_into_id = ${survivorId}, updated_at = now()
      WHERE id = ${loserId}`);

    const moved = {
      reads: priorReads.map((r) => ({ id: r.id, attempt_no: Number(r.attempt_no) })),
      reads_count: readsMoved.length,
      editions: editions.length,
      rechained: rechained.length,
    };

    const [merge] = await tx.execute<{ id: string }>(sql`
      INSERT INTO work_merges (survivor_id, loser_id, stage, reason, moved)
      VALUES (${survivorId}, ${loserId}, ${stage}, ${reason}, ${JSON.stringify(moved)}::jsonb)
      RETURNING id`);

    return { mergeId: merge!.id, moved };
  });
}

export type DedupeReport = {
  stage1: number;
  stage2: number;
  merged: number;
  skipped: number;
};

/**
 * One dedupe pass. `dryRun` reports what it would do and changes nothing.
 *
 * Candidates are found up front and then merged one at a time, re-checking
 * liveness: a work can be the loser of an earlier pair in the same batch, and
 * merging an already-merged work would corrupt the chain.
 */
export async function runDedupe(
  db: Db,
  opts: { limit?: number; dryRun?: boolean; onMerge?: (c: MergeCandidate) => void } = {},
): Promise<DedupeReport> {
  const limit = opts.limit ?? 1000;

  const stage1 = await db.execute<{ survivor_id: string; loser_id: string; isbn_13: string }>(
    sql.raw(STAGE1_SQL.replace('$1', String(limit))));
  const stage2 = await db.execute<{ survivor_id: string; loser_id: string; norm: string }>(
    sql.raw(STAGE2_SQL.replace('$1', String(limit))));

  const candidates: MergeCandidate[] = [
    ...stage1.map((r) => ({
      survivorId: r.survivor_id, loserId: r.loser_id, stage: 1 as const,
      reason: `shared ISBN-13 ${r.isbn_13}`,
    })),
    ...stage2.map((r) => ({
      survivorId: r.survivor_id, loserId: r.loser_id, stage: 2 as const,
      reason: `normalised title "${r.norm}" and a shared author`,
    })),
  ];

  const report: DedupeReport = { stage1: stage1.length, stage2: stage2.length, merged: 0, skipped: 0 };
  if (opts.dryRun) return report;

  for (const c of candidates) {
    // Both ends must still be live. An earlier merge in this same batch may
    // have consumed either one.
    const [ok] = await db.execute<{ live: boolean }>(sql`
      SELECT (s.merged_into_id IS NULL AND l.merged_into_id IS NULL) AS live
      FROM works s, works l WHERE s.id = ${c.survivorId} AND l.id = ${c.loserId}`);
    if (!ok?.live) { report.skipped++; continue; }

    await mergeWorks(db, c);
    opts.onMerge?.(c);
    report.merged++;
  }

  return report;
}
