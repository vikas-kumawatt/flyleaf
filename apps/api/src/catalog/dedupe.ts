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
import { ApiError } from '../http.js';

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
  stage: 1 | 2 | 3 | 4;
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

    const priorEditions = await tx.execute<{ id: string }>(sql`
      SELECT id FROM editions WHERE work_id = ${loserId}`);

    const priorAuthors = await tx.execute<{ author_id: string; role: string; position: number }>(sql`
      SELECT author_id, role, position FROM work_authors WHERE work_id = ${loserId}`);

    const priorSubjects = await tx.execute<{ subject_id: string; weight: number | null }>(sql`
      SELECT subject_id, weight FROM work_subjects WHERE work_id = ${loserId}`);

    const priorSeriesEntries = await tx.execute<{ series_id: string; position: number | null }>(sql`
      SELECT series_id, position FROM series_entries WHERE work_id = ${loserId}`);

    const priorRechained = await tx.execute<{ id: string }>(sql`
      SELECT id FROM works WHERE merged_into_id = ${loserId}`);

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
      edition_ids: priorEditions.map((e) => e.id),
      authors: priorAuthors.map((a) => ({
        author_id: a.author_id,
        role: a.role,
        position: Number(a.position),
      })),
      subjects: priorSubjects.map((s) => ({
        subject_id: s.subject_id,
        weight: s.weight != null ? Number(s.weight) : null,
      })),
      series_entries: priorSeriesEntries.map((se) => ({
        series_id: se.series_id,
        position: se.position != null ? Number(se.position) : null,
      })),
      rechained: rechained.length,
      rechained_ids: priorRechained.map((r) => r.id),
    };

    const [merge] = await tx.execute<{ id: string }>(sql`
      INSERT INTO work_merges (survivor_id, loser_id, stage, reason, moved)
      VALUES (${survivorId}, ${loserId}, ${stage}, ${reason}, ${JSON.stringify(moved)}::jsonb)
      RETURNING id`);

    return { mergeId: merge!.id, moved };
  });
}

/**
 * 30-day undo for merged works (FN-51, PRD §40.3).
 *
 * Restores the loser work, repoints its reads back with their original attempt numbers,
 * restores its editions, authors, and subjects, resets chains, and sets `undone_at = now()`.
 * Rejects with an error if the merge was already undone or occurred more than 30 days ago.
 */
export async function undoMerge(
  db: Db,
  mergeId: string,
): Promise<{
  undone: true;
  mergeId: string;
  merge_id?: string;
  survivorId: string;
  survivor_id?: string;
  loserId: string;
  loser_id?: string;
  restored: {
    reads: number;
    editions: number;
    authors: number;
    subjects: number;
  };
}> {
  const [merge] = await db.execute<{
    id: string;
    survivor_id: string;
    loser_id: string;
    stage: number;
    reason: string;
    moved: any;
    merged_at: string;
    undone_at: string | null;
  }>(sql`
    SELECT id, survivor_id, loser_id, stage, reason, moved, merged_at, undone_at
    FROM work_merges WHERE id = ${mergeId}
  `);

  if (!merge) throw ApiError.notFound(`Merge record ${mergeId} not found.`);
  if (merge.undone_at) throw ApiError.conflict('merge_already_undone', 'This merge has already been undone.');

  const ageMs = Date.now() - new Date(merge.merged_at).getTime();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  if (ageMs > THIRTY_DAYS_MS) {
    throw ApiError.badRequest('undo_window_expired', 'Merges can only be undone within 30 days.');
  }

  return db.transaction(async (tx) => {
    const moved = (merge.moved || {}) as {
      reads?: { id: string; attempt_no: number }[];
      edition_ids?: string[];
      authors?: { author_id: string; role: string; position: number }[];
      subjects?: { subject_id: string; weight: number | null }[];
      series_entries?: { series_id: string; position: number | null }[];
      rechained_ids?: string[];
    };

    // 1. Untombstone loser
    await tx.execute(sql`
      UPDATE works
      SET merged_into_id = NULL, updated_at = now()
      WHERE id = ${merge.loser_id}
    `);

    // 2. Restore reads to their original work and original attempt number
    let readsRestored = 0;
    if (moved.reads && moved.reads.length > 0) {
      for (const r of moved.reads) {
        await tx.execute(sql`
          UPDATE reads
          SET work_id = ${merge.loser_id}, attempt_no = ${r.attempt_no}, updated_at = now()
          WHERE id = ${r.id}
        `);
      }
      readsRestored = moved.reads.length;
    }

    // 3. Restore editions
    let editionsRestored = 0;
    if (moved.edition_ids && moved.edition_ids.length > 0) {
      for (const eid of moved.edition_ids) {
        await tx.execute(sql`
          UPDATE editions
          SET work_id = ${merge.loser_id}
          WHERE id = ${eid}
        `);
      }
      editionsRestored = moved.edition_ids.length;
    }

    // 4. Restore authors
    let authorsRestored = 0;
    if (moved.authors && moved.authors.length > 0) {
      for (const a of moved.authors) {
        await tx.execute(sql`
          INSERT INTO work_authors (work_id, author_id, role, position)
          VALUES (${merge.loser_id}, ${a.author_id}, ${a.role}, ${a.position})
          ON CONFLICT (work_id, author_id, role) DO NOTHING
        `);
      }
      authorsRestored = moved.authors.length;
    }

    // 5. Restore subjects
    let subjectsRestored = 0;
    if (moved.subjects && moved.subjects.length > 0) {
      for (const s of moved.subjects) {
        await tx.execute(sql`
          INSERT INTO work_subjects (work_id, subject_id, weight)
          VALUES (${merge.loser_id}, ${s.subject_id}, ${s.weight})
          ON CONFLICT (work_id, subject_id) DO NOTHING
        `);
      }
      subjectsRestored = moved.subjects.length;
    }

    // 6. Restore series entries
    if (moved.series_entries && moved.series_entries.length > 0) {
      for (const se of moved.series_entries) {
        await tx.execute(sql`
          INSERT INTO series_entries (series_id, work_id, position)
          VALUES (${se.series_id}, ${merge.loser_id}, ${se.position})
          ON CONFLICT (series_id, work_id) DO NOTHING
        `);
      }
    }

    // 7. Restore rechained works
    if (moved.rechained_ids && moved.rechained_ids.length > 0) {
      for (const wid of moved.rechained_ids) {
        await tx.execute(sql`
          UPDATE works
          SET merged_into_id = ${merge.loser_id}, updated_at = now()
          WHERE id = ${wid}
        `);
      }
    }

    // 8. Mark merge undone
    await tx.execute(sql`
      UPDATE work_merges
      SET undone_at = now()
      WHERE id = ${merge.id}
    `);

    // 9. If a dedupe_queue entry exists for this pair, reset its status to pending
    await tx.execute(sql`
      UPDATE dedupe_queue
      SET status = 'pending', reviewed_at = NULL, reviewed_by_user_id = NULL
      WHERE survivor_id = ${merge.survivor_id} AND loser_id = ${merge.loser_id}
    `);

    return {
      undone: true as const,
      merge_id: merge.id,
      mergeId: merge.id,
      survivor_id: merge.survivor_id,
      survivorId: merge.survivor_id,
      loser_id: merge.loser_id,
      loserId: merge.loser_id,
      restored: {
        reads: readsRestored,
        editions: editionsRestored,
        authors: authorsRestored,
        subjects: subjectsRestored,
      },
    };
  });
}

/**
 * Side-by-side preview of what moving a merge candidate will affect (PRD §3721).
 */
export async function previewMerge(
  db: Db,
  survivorId: string,
  loserId: string,
) {
  const fetchWork = async (id: string) => {
    const [row] = await db.execute<{
      id: string;
      title: string;
      first_publish_year: number | null;
      log_count: number;
      cover_id: number | null;
      edition_count: number;
      reads_count: number;
      authors: string | null;
    }>(sql`
      SELECT
        w.id,
        w.title,
        w.first_publish_year,
        w.log_count,
        COALESCE(w.ol_cover_id, (SELECT ol_cover_id FROM editions e WHERE e.work_id = w.id AND ol_cover_id IS NOT NULL LIMIT 1)) AS cover_id,
        (SELECT count(*)::int FROM editions e WHERE e.work_id = w.id) AS edition_count,
        (SELECT count(*)::int FROM reads r WHERE r.work_id = w.id) AS reads_count,
        (SELECT string_agg(a.name, ', ' ORDER BY wa.position)
         FROM work_authors wa JOIN authors a ON a.id = wa.author_id
         WHERE wa.work_id = w.id) AS authors
      FROM works w
      WHERE w.id = ${id}
    `);
    return row;
  };

  const [survivor, loser] = await Promise.all([fetchWork(survivorId), fetchWork(loserId)]);
  if (!survivor) throw ApiError.notFound(`Survivor work ${survivorId} not found.`);
  if (!loser) throw ApiError.notFound(`Loser work ${loserId} not found.`);

  // Colliding reads: users who logged both works
  const [collision] = await db.execute<{ count: number }>(sql`
    SELECT count(DISTINCT r.user_id)::int AS count
    FROM reads r
    WHERE r.work_id = ${loserId}
      AND EXISTS (SELECT 1 FROM reads s WHERE s.work_id = ${survivorId} AND s.user_id = r.user_id)
  `);

  // Authors to add: loser authors not on survivor
  const [authorDiff] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM work_authors wa
    WHERE wa.work_id = ${loserId}
      AND NOT EXISTS (
        SELECT 1 FROM work_authors s
        WHERE s.work_id = ${survivorId} AND s.author_id = wa.author_id AND s.role = wa.role
      )
  `);

  // Subjects to add: loser subjects not on survivor
  const [subjectDiff] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM work_subjects ws
    WHERE ws.work_id = ${loserId}
      AND NOT EXISTS (
        SELECT 1 FROM work_subjects s
        WHERE s.work_id = ${survivorId} AND s.subject_id = ws.subject_id
      )
  `);

  return {
    survivor: {
      id: survivor.id,
      title: survivor.title,
      authors: survivor.authors ? survivor.authors.split(', ') : [],
      first_publish_year: survivor.first_publish_year != null ? Number(survivor.first_publish_year) : null,
      firstPublishYear: survivor.first_publish_year != null ? Number(survivor.first_publish_year) : null,
      log_count: Number(survivor.log_count),
      logCount: Number(survivor.log_count),
      edition_count: Number(survivor.edition_count),
      editionCount: Number(survivor.edition_count),
      reads_count: Number(survivor.reads_count),
      readsCount: Number(survivor.reads_count),
      cover_id: survivor.cover_id != null ? Number(survivor.cover_id) : null,
      coverId: survivor.cover_id != null ? Number(survivor.cover_id) : null,
    },
    loser: {
      id: loser.id,
      title: loser.title,
      authors: loser.authors ? loser.authors.split(', ') : [],
      first_publish_year: loser.first_publish_year != null ? Number(loser.first_publish_year) : null,
      firstPublishYear: loser.first_publish_year != null ? Number(loser.first_publish_year) : null,
      log_count: Number(loser.log_count),
      logCount: Number(loser.log_count),
      edition_count: Number(loser.edition_count),
      editionCount: Number(loser.edition_count),
      reads_count: Number(loser.reads_count),
      readsCount: Number(loser.reads_count),
      cover_id: loser.cover_id != null ? Number(loser.cover_id) : null,
      coverId: loser.cover_id != null ? Number(loser.cover_id) : null,
    },
    preview: {
      reads_to_move: Number(loser.reads_count),
      readsToMove: Number(loser.reads_count),
      colliding_reads: Number(collision?.count ?? 0),
      collidingReads: Number(collision?.count ?? 0),
      editions_to_move: Number(loser.edition_count),
      editionsToMove: Number(loser.edition_count),
      authors_to_add: Number(authorDiff?.count ?? 0),
      authorsToAdd: Number(authorDiff?.count ?? 0),
      subjects_to_add: Number(subjectDiff?.count ?? 0),
      subjectsToAdd: Number(subjectDiff?.count ?? 0),
    },
  };
}

/**
 * Stage 3 pairs: trigram title > 0.85, author > 0.9, years +-2.
 *
 * QUEUED, never auto-merged (PRD §40.3). This band contains subtle differences
 * like reissues, different translations, or series volumes with nearly identical
 * titles.
 */
export const STAGE3_SQL = `
  WITH live_works AS (
    SELECT
      w.id,
      w.title,
      ${NORMALISED_TITLE_EXPR.replace(/\btitle\b/g, 'w.title')} AS norm,
      w.first_publish_year,
      w.log_count,
      (SELECT count(*) FROM editions e WHERE e.work_id = w.id) AS edition_count,
      (SELECT a.name FROM work_authors wa JOIN authors a ON a.id = wa.author_id WHERE wa.work_id = w.id ORDER BY wa.position LIMIT 1) AS author_name,
      (SELECT a.id FROM work_authors wa JOIN authors a ON a.id = wa.author_id WHERE wa.work_id = w.id ORDER BY wa.position LIMIT 1) AS author_id
    FROM works w
    WHERE w.merged_into_id IS NULL AND NOT w.is_provisional
  ),
  candidates AS (
    SELECT
      a.id AS a_id,
      b.id AS b_id,
      a.title AS a_title,
      b.title AS b_title,
      similarity(a.title, b.title) AS title_sim,
      COALESCE(similarity(a.author_name, b.author_name), 0) AS author_sim,
      a.first_publish_year AS a_year,
      b.first_publish_year AS b_year
    FROM live_works a
    JOIN live_works b
      ON b.id <> a.id
     -- Order so survivor is always first
     AND (a.edition_count, a.log_count, b.id) > (b.edition_count, b.log_count, a.id)
     -- Shared author ID OR author similarity > 0.9
     AND (
       (a.author_id IS NOT NULL AND a.author_id = b.author_id)
       OR (a.author_name IS NOT NULL AND b.author_name IS NOT NULL AND similarity(a.author_name, b.author_name) > 0.9)
     )
     -- Years +-2 if both known
     AND (
       a.first_publish_year IS NULL OR b.first_publish_year IS NULL
       OR abs(a.first_publish_year - b.first_publish_year) <= 2
     )
     -- Trigram title similarity > 0.85
     AND similarity(a.title, b.title) > 0.85
     -- Exclude Stage 2 exact matches: normalized title identical AND shared author ID
     AND NOT (a.norm <> '' AND a.norm = b.norm AND a.author_id IS NOT NULL AND a.author_id = b.author_id)
  )
  SELECT
    c.a_id AS survivor_id,
    c.b_id AS loser_id,
    c.title_sim,
    c.author_sim
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1 FROM dedupe_queue dq
    WHERE dq.survivor_id = c.a_id AND dq.loser_id = c.b_id AND dq.status = 'pending'
  )
  AND NOT EXISTS (
    SELECT 1 FROM work_merges wm
    WHERE wm.survivor_id = c.a_id AND wm.loser_id = c.b_id AND wm.undone_at IS NULL
  )
  ORDER BY c.title_sim DESC
  LIMIT $1`;

export async function findStage3Candidates(
  db: Db,
  limit = 500,
): Promise<{ survivorId: string; loserId: string; titleSimilarity: number; authorSimilarity: number }[]> {
  const rows = await db.execute<{
    survivor_id: string;
    loser_id: string;
    title_sim: number;
    author_sim: number;
  }>(sql.raw(STAGE3_SQL.replace('$1', String(limit))));

  return rows.map((r) => ({
    survivorId: r.survivor_id,
    loserId: r.loser_id,
    titleSimilarity: Number(r.title_sim),
    authorSimilarity: Number(r.author_sim),
  }));
}

export async function queueStage3Candidates(
  db: Db,
  limit = 500,
): Promise<number> {
  const candidates = await findStage3Candidates(db, limit);
  let queued = 0;

  for (const c of candidates) {
    const titlePct = Math.round(c.titleSimilarity * 100);
    const authorPct = Math.round(c.authorSimilarity * 100);
    const confidence = Math.round((c.titleSimilarity * 0.6 + c.authorSimilarity * 0.4) * 100) / 100;
    const reason = `trigram title similarity ${titlePct}%, author similarity ${authorPct}% (Stage 3 probable)`;

    const inserted = await db.execute(sql`
      INSERT INTO dedupe_queue (survivor_id, loser_id, stage, status, confidence, reason, metadata)
      VALUES (${c.survivorId}, ${c.loserId}, 3, 'pending', ${confidence}, ${reason}, ${JSON.stringify({
        titleSimilarity: c.titleSimilarity,
        authorSimilarity: c.authorSimilarity,
      })}::jsonb)
      ON CONFLICT (survivor_id, loser_id) WHERE status = 'pending' DO NOTHING
      RETURNING id
    `);
    if (inserted.length > 0) queued++;
  }

  return queued;
}

/**
 * Queue a user or admin reported duplicate work pair (Stage 4, PRD §40.3).
 */
export async function queueReportedDuplicate(
  db: Db,
  data: {
    survivorId: string;
    loserId: string;
    reason: string;
    reporterUserId?: string;
  },
): Promise<{ id: string; queued: true }> {
  if (data.survivorId === data.loserId) {
    throw ApiError.badRequest('same_work', 'Cannot report a work as duplicate of itself.');
  }

  const [survivor] = await db.execute<{ id: string; merged_into_id: string | null }>(sql`
    SELECT id, merged_into_id FROM works WHERE id = ${data.survivorId}
  `);
  if (!survivor) throw ApiError.notFound('Survivor work not found.');
  if (survivor.merged_into_id) throw ApiError.badRequest('work_merged', 'Survivor work is already merged.');

  const [loser] = await db.execute<{ id: string; merged_into_id: string | null }>(sql`
    SELECT id, merged_into_id FROM works WHERE id = ${data.loserId}
  `);
  if (!loser) throw ApiError.notFound('Loser work not found.');
  if (loser.merged_into_id) throw ApiError.badRequest('work_merged', 'Reported duplicate work is already merged.');

  const [existing] = await db.execute<{ id: string }>(sql`
    SELECT id FROM dedupe_queue
    WHERE survivor_id = ${data.survivorId} AND loser_id = ${data.loserId} AND status = 'pending'
  `);
  if (existing) {
    return { id: existing.id, queued: true };
  }

  const [inserted] = await db.execute<{ id: string }>(sql`
    INSERT INTO dedupe_queue (survivor_id, loser_id, stage, status, reason, metadata)
    VALUES (
      ${data.survivorId},
      ${data.loserId},
      4,
      'pending',
      ${data.reason},
      ${JSON.stringify({ reportedByUserId: data.reporterUserId ?? null })}::jsonb
    )
    RETURNING id
  `);

  return { id: inserted!.id, queued: true };
}

/**
 * Returns paginated dedupe queue entries with joined survivor and loser details.
 */
export async function getDedupeQueue(
  db: Db,
  opts: {
    status?: 'pending' | 'merged' | 'dismissed';
    stage?: number;
    limit?: number;
    offset?: number;
  } = {},
) {
  const status = opts.status ?? 'pending';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let query = sql`
    SELECT
      dq.id,
      dq.stage,
      dq.status,
      dq.confidence,
      dq.reason,
      dq.dismiss_reason,
      dq.created_at,
      dq.reviewed_at,
      dq.reviewed_by_user_id,
      s.id AS survivor_id,
      s.title AS survivor_title,
      s.first_publish_year AS survivor_year,
      s.log_count AS survivor_log_count,
      COALESCE(s.ol_cover_id, (SELECT ol_cover_id FROM editions e WHERE e.work_id = s.id AND ol_cover_id IS NOT NULL LIMIT 1)) AS survivor_cover_id,
      (SELECT count(*)::int FROM editions e WHERE e.work_id = s.id) AS survivor_edition_count,
      (SELECT string_agg(a.name, ', ' ORDER BY wa.position)
       FROM work_authors wa JOIN authors a ON a.id = wa.author_id
       WHERE wa.work_id = s.id) AS survivor_authors,
      l.id AS loser_id,
      l.title AS loser_title,
      l.first_publish_year AS loser_year,
      l.log_count AS loser_log_count,
      COALESCE(l.ol_cover_id, (SELECT ol_cover_id FROM editions e WHERE e.work_id = l.id AND ol_cover_id IS NOT NULL LIMIT 1)) AS loser_cover_id,
      (SELECT count(*)::int FROM editions e WHERE e.work_id = l.id) AS loser_edition_count,
      (SELECT string_agg(a.name, ', ' ORDER BY wa.position)
       FROM work_authors wa JOIN authors a ON a.id = wa.author_id
       WHERE wa.work_id = l.id) AS loser_authors
    FROM dedupe_queue dq
    JOIN works s ON s.id = dq.survivor_id
    JOIN works l ON l.id = dq.loser_id
    WHERE dq.status = ${status}
  `;

  if (opts.stage != null) {
    query = sql`${query} AND dq.stage = ${opts.stage}`;
  }

  query = sql`${query} ORDER BY dq.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const rows = await db.execute<any>(query);

  return rows.map((r) => ({
    id: r.id,
    stage: Number(r.stage),
    status: r.status,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    reason: r.reason,
    dismiss_reason: r.dismiss_reason,
    dismissReason: r.dismiss_reason,
    created_at: new Date(r.created_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    reviewed_at: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewed_by_user_id: r.reviewed_by_user_id,
    reviewedByUserId: r.reviewed_by_user_id,
    survivor: {
      id: r.survivor_id,
      title: r.survivor_title,
      authors: r.survivor_authors ? r.survivor_authors.split(', ') : [],
      first_publish_year: r.survivor_year != null ? Number(r.survivor_year) : null,
      firstPublishYear: r.survivor_year != null ? Number(r.survivor_year) : null,
      log_count: Number(r.survivor_log_count),
      logCount: Number(r.survivor_log_count),
      edition_count: Number(r.survivor_edition_count),
      editionCount: Number(r.survivor_edition_count),
      cover_id: r.survivor_cover_id != null ? Number(r.survivor_cover_id) : null,
      coverId: r.survivor_cover_id != null ? Number(r.survivor_cover_id) : null,
    },
    loser: {
      id: r.loser_id,
      title: r.loser_title,
      authors: r.loser_authors ? r.loser_authors.split(', ') : [],
      first_publish_year: r.loser_year != null ? Number(r.loser_year) : null,
      firstPublishYear: r.loser_year != null ? Number(r.loser_year) : null,
      log_count: Number(r.loser_log_count),
      logCount: Number(r.loser_log_count),
      edition_count: Number(r.loser_edition_count),
      editionCount: Number(r.loser_edition_count),
      cover_id: r.loser_cover_id != null ? Number(r.loser_cover_id) : null,
      coverId: r.loser_cover_id != null ? Number(r.loser_cover_id) : null,
    },
  }));
}

/**
 * Resolves a dedupe queue item by either merging the works or dismissing the candidate.
 */
export async function resolveQueueItem(
  db: Db,
  queueId: string,
  action: 'merge' | 'dismiss',
  opts: { reviewerUserId?: string; reason?: string } = {},
): Promise<{ success: true; action: 'merge' | 'dismiss'; mergeId?: string; merge_id?: string }> {
  const [item] = await db.execute<{
    id: string;
    survivor_id: string;
    loser_id: string;
    stage: number;
    status: string;
    reason: string;
  }>(sql`
    SELECT id, survivor_id, loser_id, stage, status, reason
    FROM dedupe_queue WHERE id = ${queueId}
  `);

  if (!item) throw ApiError.notFound('Queue item not found.');
  if (item.status !== 'pending') {
    throw ApiError.badRequest('already_resolved', `Queue item is already ${item.status}.`);
  }

  if (action === 'merge') {
    const mergeResult = await mergeWorks(db, {
      survivorId: item.survivor_id,
      loserId: item.loser_id,
      stage: item.stage as 1 | 2 | 3 | 4,
      reason: opts.reason ?? item.reason,
    });

    await db.execute(sql`
      UPDATE dedupe_queue
      SET status = 'merged',
          reviewed_at = now(),
          reviewed_by_user_id = ${opts.reviewerUserId ?? null}
      WHERE id = ${queueId}
    `);

    return {
      success: true,
      action: 'merge',
      merge_id: mergeResult.mergeId,
      mergeId: mergeResult.mergeId,
    };
  } else {
    await db.execute(sql`
      UPDATE dedupe_queue
      SET status = 'dismissed',
          dismiss_reason = ${opts.reason ?? 'Dismissed by reviewer.'},
          reviewed_at = now(),
          reviewed_by_user_id = ${opts.reviewerUserId ?? null}
      WHERE id = ${queueId}
    `);

    return { success: true, action: 'dismiss' };
  }
}

/**
 * Returns recent merges with status and 30-day undo eligibility.
 */
export async function getRecentMerges(
  db: Db,
  opts: { limit?: number; offset?: number } = {},
) {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  const rows = await db.execute<{
    id: string;
    survivor_id: string;
    survivor_title: string;
    loser_id: string;
    loser_title: string;
    stage: number;
    reason: string;
    moved: any;
    merged_at: string;
    undone_at: string | null;
  }>(sql`
    SELECT
      wm.id,
      wm.survivor_id,
      s.title AS survivor_title,
      wm.loser_id,
      l.title AS loser_title,
      wm.stage,
      wm.reason,
      wm.moved,
      wm.merged_at,
      wm.undone_at
    FROM work_merges wm
    JOIN works s ON s.id = wm.survivor_id
    JOIN works l ON l.id = wm.loser_id
    ORDER BY wm.merged_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return rows.map((r) => {
    const ageMs = Date.now() - new Date(r.merged_at).getTime();
    const canUndo = r.undone_at === null && ageMs <= THIRTY_DAYS_MS;
    const moved = r.moved || {};

    const readsCount = moved.reads_count ?? (moved.reads ? moved.reads.length : 0);
    const editionsCount = moved.editions ?? (moved.edition_ids ? moved.edition_ids.length : 0);
    const authorsCount = moved.authors ? moved.authors.length : 0;

    return {
      id: r.id,
      survivor: { id: r.survivor_id, title: r.survivor_title },
      loser: { id: r.loser_id, title: r.loser_title },
      stage: Number(r.stage),
      reason: r.reason,
      merged_at: new Date(r.merged_at).toISOString(),
      mergedAt: new Date(r.merged_at).toISOString(),
      undone_at: r.undone_at ? new Date(r.undone_at).toISOString() : null,
      undoneAt: r.undone_at ? new Date(r.undone_at).toISOString() : null,
      can_undo: canUndo,
      canUndo,
      stats: {
        reads_moved: readsCount,
        readsMoved: readsCount,
        editions_moved: editionsCount,
        editionsMoved: editionsCount,
        authors_moved: authorsCount,
        authorsMoved: authorsCount,
      },
    };
  });
}

export type DedupeReport = {
  stage1: number;
  stage2: number;
  stage3Queued: number;
  merged: number;
  skipped: number;
};

/**
 * One dedupe pass. `dryRun` reports what it would do and changes nothing.
 *
 * Automatically merges Stages 1 & 2, and detects & queues Stage 3 fuzzy duplicates
 * for human review.
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

  let stage3Queued = 0;
  if (!opts.dryRun) {
    stage3Queued = await queueStage3Candidates(db, limit);
  }

  const report: DedupeReport = {
    stage1: stage1.length,
    stage2: stage2.length,
    stage3Queued,
    merged: 0,
    skipped: 0,
  };
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

