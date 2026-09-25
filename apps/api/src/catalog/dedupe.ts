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
// Stage 1 is live since the editions pass (4.9M ISBN-13s). Stages 1 and 2
// HOLD back the pair shapes the full catalog showed to be distinct books (see
// STAGE1_SQL and SUBTITLE_EXPR) until the product decision in Audit 03.
//
// Stages 3 and 4 are FN-51. They are deliberately not auto-merged: that band
// contains reissues, different translations and series entries with nearly
// identical titles, and a wrong merge destroys two books' worth of ratings.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { ApiError } from '../http.js';

// ---------------------------------------------------------------------------
// Title normalisation, in TypeScript AND in SQL.
//
// The rule exists twice: TypeScript for the import matcher, SQL for the 3.2M
// row scan. Both are built from the SAME explicit character classes below, and
// neither depends on the database's locale (Audit 03b, A-03-014). The first
// version used `[[:punct:]]`, `\s` and `lower()`, whose meaning comes from the
// server's libc: on the real catalog (musl, en_US.utf8) the SQL split
// decomposed accents off their letters ("Omisión" -> "omisio n"), dropped bidi
// marks and lowercased U+0130 differently, so the two disagreed on 50,622 titles
// while PGlite, in another locale, agreed on every test title.
//
//   NFC            composed and decomposed accents are the same title. The
//                  dump has both, and without it they never match.
//   lower          Unicode SIMPLE case mapping, one code point at a time.
//                  SQL: `COLLATE pg_c_utf8` (Postgres' built-in provider, the
//                  same on every platform). TS: per code point, because JS's
//                  whole-string toLowerCase applies the final-sigma rule and
//                  maps U+0130 to two code points.
//   separators     Unicode punctuation and symbols (\p{P}, \p{S}) plus the
//                  invisible bidi/zero-width marks that pasted titles carry.
//                  Combining marks are NOT separators: they belong to their
//                  letter, and removing them would accent-fold (below).
//   whitespace     exactly JavaScript's \s.
// ---------------------------------------------------------------------------

/** Code points matching `re`, as inclusive ranges. Planes 0-3: nothing above is punctuation, a symbol or a space. */
function codePointRanges(re: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  for (let cp = 0; cp <= 0x3ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (!re.test(String.fromCodePoint(cp))) continue;
    const last = ranges.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp;
    else ranges.push([cp, cp]);
  }
  return ranges;
}

const SEPARATOR_RANGES = codePointRanges(/[\p{P}\p{S}\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
const WHITESPACE_RANGES = codePointRanges(/\s/u);

const jsClass = (ranges: [number, number][]) => {
  const cp = (n: number) => `\\u{${n.toString(16)}}`;
  return `[${ranges.map(([a, b]) => (a === b ? cp(a) : `${cp(a)}-${cp(b)}`)).join('')}]`;
};
// Postgres ARE character-entry escapes: \uXXXX, or \UXXXXXXXX above the BMP.
const sqlClass = (ranges: [number, number][]) => {
  const cp = (n: number) =>
    n <= 0xffff ? `\\u${n.toString(16).padStart(4, '0')}` : `\\U${n.toString(16).padStart(8, '0')}`;
  return `[${ranges.map(([a, b]) => (a === b ? cp(a) : `${cp(a)}-${cp(b)}`)).join('')}]`;
};

const SEPARATOR_JS = new RegExp(jsClass(SEPARATOR_RANGES), 'gu');
const WHITESPACE_RUN_JS = new RegExp(`${jsClass(WHITESPACE_RANGES)}+`, 'gu');
const ARTICLE_JS = new RegExp(`^(the|a|an)${jsClass(WHITESPACE_RANGES)}+`, 'u');
const SEPARATOR_SQL = sqlClass(SEPARATOR_RANGES);
const WHITESPACE_SQL = sqlClass(WHITESPACE_RANGES);

/** Unicode simple lowercase, the mapping `lower(… COLLATE pg_c_utf8)` applies. */
function lowerSimple(s: string): string {
  let out = '';
  // U+0130 is the one code point whose full lowercase mapping is two code points.
  for (const ch of s) out += ch === '\u0130' ? 'i' : ch.toLowerCase();
  return out;
}

const tidy = (s: string) => s.replace(SEPARATOR_JS, ' ').replace(WHITESPACE_RUN_JS, ' ').trim();

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
  // Subtitle: everything after the first colon. "Dune: A Novel" -> "dune".
  const main = lowerSimple(title.normalize('NFC')).split(':')[0]!;
  return tidy(main.replace(ARTICLE_JS, ''));
}

/** Everything after the first colon, with the title's case, punctuation and space rules. '' when there is none. */
export function normaliseSubtitle(title: string): string {
  const nfc = title.normalize('NFC');
  const colon = nfc.indexOf(':');
  return colon === -1 ? '' : tidy(lowerSimple(nfc.slice(colon + 1)));
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
      regexp_replace(
        lower(split_part(normalize(title, NFC), ':', 1) COLLATE pg_c_utf8),
        '^(the|a|an)${WHITESPACE_SQL}+', ''),
      '${SEPARATOR_SQL}', ' ', 'g'),
    '${WHITESPACE_SQL}+', ' ', 'g'), ' ')`;

/**
 * `normaliseSubtitle` as a SQL expression: everything after the first colon,
 * with the title's case, punctuation and space rules. Empty when there is no
 * subtitle.
 *
 * Stage 2 strips subtitles so "Dune" meets "Dune: A Novel". But two DIFFERENT
 * subtitles on the same main title are usually two books — on the full
 * catalog, 10,572 stage-2 pairs had both subtitles present and different, and
 * all 25 sampled were distinct ("Harry Potter: Diagon Alley" / "Harry Potter:
 * Magical Creatures", "Forbidden Worlds: Volume 15" / "Volume 8"). And a
 * subtitle on one side only is sometimes the same book ("Dune" / "Dune: A
 * Novel") and sometimes not ("Chicken Soup for the Soul" / "…: Like Mother,
 * Like Daughter"). So stage 2 auto-merges only when the subtitles match, and
 * queues everything else (D1, Audit 03b).
 */
export const SUBTITLE_EXPR = `
  btrim(regexp_replace(
    regexp_replace(
      lower((CASE WHEN strpos(normalize(title, NFC), ':') > 0
                  THEN substr(normalize(title, NFC), strpos(normalize(title, NFC), ':') + 1)
                  ELSE '' END) COLLATE pg_c_utf8),
      '${SEPARATOR_SQL}', ' ', 'g'),
    '${WHITESPACE_SQL}+', ' ', 'g'), ' ')`;

const onColumn = (expr: string, column: string) => expr.replace(/\btitle\b/g, column);

/**
 * Stage 2 pairs: identical normalised main title AND at least one shared
 * author. Every pair, unbounded: runDedupe decides which are unambiguous
 * enough to auto-merge (identical subtitles too) and queues the rest.
 */
export const STAGE2_SQL = `
  WITH author_works AS (
    SELECT wa.author_id, w.id, w.log_count,
           ${onColumn(NORMALISED_TITLE_EXPR, 'w.title')} AS norm
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
  SELECT p.a_id AS survivor_id, p.b_id AS loser_id, p.norm,
         ${onColumn(SUBTITLE_EXPR, 'wa.title')} AS survivor_sub,
         ${onColumn(SUBTITLE_EXPR, 'wb.title')} AS loser_sub
  FROM pairs p
  JOIN works wa ON wa.id = p.a_id
  JOIN works wb ON wb.id = p.b_id`;

/**
 * Stage 1 pairs: two live works whose editions claim the same ISBN-13, one row
 * per pair, with the two facts runDedupe needs to decide whether the pair is
 * unambiguous.
 *
 * PRD §40.3 said an ISBN identifies one edition, so two works claiming it are
 * one work. The dump contradicts that: publishers re-use ISBNs for unrelated
 * books ("Bidirectional Control of DC Motor…" and "Behaviour of Concrete…"
 * share 9788193323519; A-03-005). So a shared ISBN alone is not enough to
 * auto-merge (D1, Audit 03b).
 */
export const STAGE1_SQL = `
  WITH shared AS (
    SELECT e1.work_id AS a_id, e2.work_id AS b_id, min(e1.isbn_13) AS isbn_13
    FROM editions e1
    JOIN editions e2 ON e2.isbn_13 = e1.isbn_13 AND e2.work_id <> e1.work_id
    WHERE e1.isbn_13 IS NOT NULL
    GROUP BY e1.work_id, e2.work_id
  ),
  live AS (
    SELECT s.*,
           (SELECT count(*) FROM editions e WHERE e.work_id = s.a_id) AS a_editions,
           (SELECT count(*) FROM editions e WHERE e.work_id = s.b_id) AS b_editions,
           wa.log_count AS a_logs, wb.log_count AS b_logs,
           ${onColumn(NORMALISED_TITLE_EXPR, 'wa.title')} = ${onColumn(NORMALISED_TITLE_EXPR, 'wb.title')} AS same_title,
           EXISTS (
             SELECT 1 FROM work_authors x JOIN work_authors y ON y.author_id = x.author_id
             WHERE x.work_id = s.a_id AND y.work_id = s.b_id
           ) AS shared_author
    FROM shared s
    JOIN works wa ON wa.id = s.a_id AND wa.merged_into_id IS NULL AND NOT wa.is_provisional
    JOIN works wb ON wb.id = s.b_id AND wb.merged_into_id IS NULL AND NOT wb.is_provisional
  )
  SELECT a_id AS survivor_id, b_id AS loser_id, isbn_13, same_title, shared_author
  FROM live
  WHERE (a_editions, a_logs, b_id) > (b_editions, b_logs, a_id)`;

/**
 * Move everything that points at the loser, then tombstone it.
 *
 * Every table that references a work, as the database has them today (Audit
 * 03 read the list from `pg_constraint` plus the references no foreign key
 * can express). When a table is added that holds a work id, it belongs here
 * AND in `undoMerge`, and the snapshot test in dedupe.test.ts should gain it.
 *
 *   reads           UNIQUE (user_id, work_id, attempt_no) — a user who logged
 *                   BOTH duplicates collides. Attempts are renumbered to
 *                   continue after that user's existing attempts, which is
 *                   also the semantically right answer: they did read it twice.
 *                   read_likes / read_comments hang off the read id and move
 *                   with it untouched.
 *   reviews         work_id is denormalised from the read — follows it.
 *   shelf_items     PK (shelf_id, work_id) — a shelf holding BOTH copies keeps
 *                   the survivor's item; the loser's is dropped and recorded.
 *                   The shelf_items trigger refreshes item_count and the
 *                   cover_work_ids mosaic.
 *   activity        plain repoint, so feed cards never point at a tombstone.
 *   mutes           no FK (target_id is polymorphic); PK (user, type, target).
 *                   Muted either copy → the survivor is muted.
 *   profiles        favourite_work_ids uuid[] — loser swapped for the survivor
 *                   in place; if both were favourites, the first slot wins.
 *   import_rows     plain repoint.
 *   works.log_count the survivor gains the loser's count (dump logs + Flyleaf
 *                   logs are both counted on the work row, never recomputed).
 *   work_authors / work_subjects / series_entries — PK collisions, insert what
 *                   the survivor lacks; what was ADDED is recorded so undo can
 *                   take exactly that back off the survivor.
 *   work_stats      the loser's row is dropped; the reads trigger has already
 *                   recomputed the survivor from the reads that just moved.
 *   editions        plain repoint.
 *   external_ids    PK (provider, external_id, entity_type) cannot collide on
 *                   a repoint, so the loser's keys simply move.
 *   field_provenance NOT moved: it describes the loser's own field values, and
 *                   a merge never copies values onto the survivor. Moving it
 *                   would claim (and possibly lock) a provenance the survivor's
 *                   fields do not have.
 *
 * Not repointed on purpose: `events` and `admin_audit_log` (history of what
 * happened, to the id it happened to) and `dedupe_queue` (a pending pair that
 * names the loser is refused cleanly when resolved, below).
 *
 * And merge CHAINS: anything already merged into the loser must be repointed
 * at the survivor, or following `merged_into_id` from an old link lands on a
 * tombstone that itself points elsewhere.
 *
 * All of it in ONE transaction, with both works locked. The admin console and
 * the monthly job can reach the same work at once; without the lock the second
 * merge would move reads onto a work that is being tombstoned.
 */
export async function mergeWorks(
  db: Db,
  { survivorId, loserId, stage, reason }: MergeCandidate,
): Promise<{ mergeId: string; moved: Record<string, unknown> }> {
  if (survivorId === loserId) throw new Error('cannot merge a work into itself');

  return db.transaction(async (tx) => {
    // Lock in id order so two merges that share a work cannot deadlock.
    const locked = await tx.execute<{ id: string; merged_into_id: string | null; log_count: number }>(sql`
      SELECT id, merged_into_id, log_count FROM works
      WHERE id IN (${survivorId}, ${loserId}) ORDER BY id FOR UPDATE`);
    const survivor = locked.find((w) => w.id === survivorId);
    const loser = locked.find((w) => w.id === loserId);
    if (!survivor || !loser) throw ApiError.notFound('Work not found.');
    if (survivor.merged_into_id || loser.merged_into_id) {
      throw ApiError.conflict('work_merged', 'One of these works has already been merged into another.');
    }

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

    const reviews = await tx.execute<{ id: string }>(sql`
      UPDATE reviews SET work_id = ${survivorId} WHERE work_id = ${loserId} RETURNING id`);

    const editions = await tx.execute(sql`
      UPDATE editions SET work_id = ${survivorId} WHERE work_id = ${loserId} RETURNING id`);

    // Shelves: drop the loser's item where the shelf already holds the
    // survivor, then repoint the rest. Order matters — repointing first would
    // hit the primary key.
    const shelfItemsDropped = await tx.execute<{
      shelf_id: string; position: number; note: string | null; added_at: string; added_by: string | null;
    }>(sql`
      DELETE FROM shelf_items l
      WHERE l.work_id = ${loserId}
        AND EXISTS (SELECT 1 FROM shelf_items s WHERE s.shelf_id = l.shelf_id AND s.work_id = ${survivorId})
      RETURNING l.shelf_id, l.position, l.note, l.added_at::text AS added_at, l.added_by`);
    const shelfItemsMoved = await tx.execute<{ shelf_id: string }>(sql`
      UPDATE shelf_items SET work_id = ${survivorId} WHERE work_id = ${loserId} RETURNING shelf_id`);

    const activity = await tx.execute<{ id: string }>(sql`
      UPDATE activity SET work_id = ${survivorId} WHERE work_id = ${loserId} RETURNING id`);

    // Mutes, the same shape as shelves.
    const mutesDropped = await tx.execute<{ user_id: string; created_at: string }>(sql`
      DELETE FROM mutes l
      WHERE l.target_type = 'work' AND l.target_id = ${loserId}
        AND EXISTS (
          SELECT 1 FROM mutes s
          WHERE s.user_id = l.user_id AND s.target_type = 'work' AND s.target_id = ${survivorId})
      RETURNING l.user_id, l.created_at::text AS created_at`);
    const mutesMoved = await tx.execute<{ user_id: string }>(sql`
      UPDATE mutes SET target_id = ${survivorId}
      WHERE target_type = 'work' AND target_id = ${loserId} RETURNING user_id`);

    // Favourites: swap in place, then drop a repeated id keeping its first slot.
    const favourites = await tx.execute<{ user_id: string; before: string[]; after: string[] }>(sql`
      WITH prior AS (
        SELECT user_id, favourite_work_ids AS before FROM profiles
        WHERE ${loserId}::uuid = ANY (favourite_work_ids)
        FOR UPDATE
      )
      UPDATE profiles p
      SET favourite_work_ids = (
        SELECT COALESCE(array_agg(id ORDER BY slot), '{}'::uuid[])
        FROM (
          SELECT id, min(slot) AS slot
          FROM unnest(array_replace(prior.before, ${loserId}::uuid, ${survivorId}::uuid))
               WITH ORDINALITY AS f(id, slot)
          GROUP BY id
        ) d
      )
      FROM prior
      WHERE p.user_id = prior.user_id
      RETURNING p.user_id, prior.before, p.favourite_work_ids AS after`);

    const importRows = await tx.execute<{ import_id: string; row_no: number }>(sql`
      UPDATE import_rows SET work_id = ${survivorId} WHERE work_id = ${loserId}
      RETURNING import_id, row_no`);

    await tx.execute(sql`
      UPDATE works SET log_count = log_count + ${Number(loser.log_count)} WHERE id = ${survivorId}`);

    // The ON CONFLICT tables. Insert what the survivor lacks, then drop the
    // loser's rows — an UPDATE would fail on the duplicates. RETURNING gives
    // exactly the rows the survivor GAINED, which is what undo must remove.
    const authorsAdded = await tx.execute<{ author_id: string; role: string }>(sql`
      INSERT INTO work_authors (work_id, author_id, role, position)
      SELECT ${survivorId}, author_id, role, position FROM work_authors WHERE work_id = ${loserId}
      ON CONFLICT (work_id, author_id, role) DO NOTHING
      RETURNING author_id, role`);
    await tx.execute(sql`DELETE FROM work_authors WHERE work_id = ${loserId}`);

    const subjectsAdded = await tx.execute<{ subject_id: string }>(sql`
      INSERT INTO work_subjects (work_id, subject_id, weight)
      SELECT ${survivorId}, subject_id, weight FROM work_subjects WHERE work_id = ${loserId}
      ON CONFLICT (work_id, subject_id) DO NOTHING
      RETURNING subject_id`);
    await tx.execute(sql`DELETE FROM work_subjects WHERE work_id = ${loserId}`);

    const seriesAdded = await tx.execute<{ series_id: string }>(sql`
      INSERT INTO series_entries (series_id, work_id, position)
      SELECT series_id, ${survivorId}, position FROM series_entries WHERE work_id = ${loserId}
      ON CONFLICT (series_id, work_id) DO NOTHING
      RETURNING series_id`);
    await tx.execute(sql`DELETE FROM series_entries WHERE work_id = ${loserId}`);

    const externalIds = await tx.execute<{ provider: string; external_id: string }>(sql`
      UPDATE external_ids SET entity_id = ${survivorId}
      WHERE entity_type = 'work' AND entity_id = ${loserId}
      RETURNING provider, external_id`);

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
      authors_added: authorsAdded.map((a) => ({ author_id: a.author_id, role: a.role })),
      subjects: priorSubjects.map((s) => ({
        subject_id: s.subject_id,
        weight: s.weight != null ? Number(s.weight) : null,
      })),
      subjects_added: subjectsAdded.map((s) => s.subject_id),
      series_entries: priorSeriesEntries.map((se) => ({
        series_id: se.series_id,
        position: se.position != null ? Number(se.position) : null,
      })),
      series_added: seriesAdded.map((s) => s.series_id),
      review_ids: reviews.map((r) => r.id),
      activity_ids: activity.map((a) => a.id),
      shelf_items_moved: shelfItemsMoved.map((s) => s.shelf_id),
      shelf_items_dropped: shelfItemsDropped.map((s) => ({
        shelf_id: s.shelf_id,
        position: Number(s.position),
        note: s.note,
        // As text: a JS Date would drop the microseconds and undo would not be exact.
        added_at: s.added_at,
        added_by: s.added_by,
      })),
      mutes_moved: mutesMoved.map((m) => m.user_id),
      mutes_dropped: mutesDropped.map((m) => ({
        user_id: m.user_id,
        created_at: m.created_at,
      })),
      favourites: favourites.map((f) => ({ user_id: f.user_id, before: f.before, after: f.after })),
      import_rows: importRows.map((r) => ({ import_id: r.import_id, row_no: Number(r.row_no) })),
      external_ids: externalIds.map((e) => ({ provider: e.provider, external_id: e.external_id })),
      log_count_added: Number(loser.log_count),
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

type MovedRecord = {
  reads?: { id: string; attempt_no: number }[];
  edition_ids?: string[];
  authors?: { author_id: string; role: string; position: number }[];
  authors_added?: { author_id: string; role: string }[];
  subjects?: { subject_id: string; weight: number | null }[];
  subjects_added?: string[];
  series_entries?: { series_id: string; position: number | null }[];
  series_added?: string[];
  review_ids?: string[];
  activity_ids?: string[];
  shelf_items_moved?: string[];
  shelf_items_dropped?: {
    shelf_id: string; position: number; note: string | null; added_at: string; added_by: string | null;
  }[];
  mutes_moved?: string[];
  mutes_dropped?: { user_id: string; created_at: string }[];
  favourites?: { user_id: string; before: string[]; after: string[] }[];
  import_rows?: { import_id: string; row_no: number }[];
  external_ids?: { provider: string; external_id: string }[];
  log_count_added?: number;
  rechained_ids?: string[];
};

/**
 * 30-day undo for merged works (FN-51, PRD §40.3).
 *
 * Reverses exactly what `mergeWorks` recorded in `moved`, in one transaction,
 * and sets `undone_at`. Refused when:
 *   - the merge was already undone, or is more than 30 days old;
 *   - the survivor has since been merged into something else. The loser's
 *     reads now sit on THAT work, and the later merge's record names the loser
 *     as re-chained, so undoing out of order corrupts both. Undo the later
 *     merge first;
 *   - the loser has gained reads since the merge (a stale id logged onto the
 *     tombstone). Restoring the recorded attempt numbers would collide.
 *
 * Rows a user changed after the merge are left as the user left them: a
 * favourites list edited since is not overwritten, and a shelf item the user
 * removed from the survivor is not resurrected on the loser.
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
  return db.transaction(async (tx) => {
    // Locked, and checked inside the transaction: two admins pressing undo at
    // once must not both pass the `undone_at` check.
    const [merge] = await tx.execute<{
      id: string;
      survivor_id: string;
      loser_id: string;
      moved: MovedRecord | null;
      undone_at: string | null;
      expired: boolean;
    }>(sql`
      SELECT id, survivor_id, loser_id, moved, undone_at,
             merged_at < now() - interval '30 days' AS expired
      FROM work_merges WHERE id = ${mergeId}
      FOR UPDATE
    `);

    if (!merge) throw ApiError.notFound(`Merge record ${mergeId} not found.`);
    if (merge.undone_at) throw ApiError.conflict('merge_already_undone', 'This merge has already been undone.');
    if (merge.expired) {
      throw ApiError.badRequest('undo_window_expired', 'Merges can only be undone within 30 days.');
    }

    const survivorId = merge.survivor_id;
    const loserId = merge.loser_id;

    // Same lock order as mergeWorks.
    const locked = await tx.execute<{ id: string; merged_into_id: string | null }>(sql`
      SELECT id, merged_into_id FROM works WHERE id IN (${survivorId}, ${loserId})
      ORDER BY id FOR UPDATE`);
    if (locked.find((w) => w.id === survivorId)?.merged_into_id) {
      throw ApiError.conflict(
        'survivor_merged',
        'The surviving work has since been merged into another. Undo that merge first.',
      );
    }

    const [newReads] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM reads WHERE work_id = ${loserId}`);
    if (Number(newReads!.n) > 0) {
      throw ApiError.conflict(
        'loser_modified',
        'Reads have been logged against the merged-away work since the merge, so it cannot be restored exactly.',
      );
    }

    const moved: MovedRecord = merge.moved ?? {};
    const json = (v: unknown) => sql`${JSON.stringify(v ?? [])}::jsonb`;
    const uuids = (v: string[] | undefined) => sql`ARRAY(SELECT jsonb_array_elements_text(${json(v)})::uuid)`;

    // 1. Untombstone the loser.
    await tx.execute(sql`
      UPDATE works SET merged_into_id = NULL, updated_at = now() WHERE id = ${loserId}`);

    // 2. Reads, back to their original work AND original attempt number. The
    // loser holds no reads (checked above), so the restored numbers are free.
    const reads = moved.reads ?? [];
    if (reads.length > 0) {
      await tx.execute(sql`
        UPDATE reads r
        SET work_id = ${loserId}, attempt_no = m.attempt_no, updated_at = now()
        FROM jsonb_to_recordset(${json(reads)}) AS m(id uuid, attempt_no int)
        WHERE r.id = m.id`);
    }

    // 3. Everything that moved by primary key.
    await tx.execute(sql`UPDATE editions SET work_id = ${loserId} WHERE id = ANY (${uuids(moved.edition_ids)})`);
    await tx.execute(sql`UPDATE reviews SET work_id = ${loserId} WHERE id = ANY (${uuids(moved.review_ids)})`);
    await tx.execute(sql`UPDATE activity SET work_id = ${loserId} WHERE id = ANY (${uuids(moved.activity_ids)})`);
    await tx.execute(sql`
      UPDATE import_rows ir SET work_id = ${loserId}
      FROM jsonb_to_recordset(${json(moved.import_rows)}) AS m(import_id uuid, row_no int)
      WHERE ir.import_id = m.import_id AND ir.row_no = m.row_no`);
    await tx.execute(sql`
      UPDATE external_ids e SET entity_id = ${loserId}
      FROM jsonb_to_recordset(${json(moved.external_ids)}) AS m(provider text, external_id text)
      WHERE e.entity_type = 'work' AND e.entity_id = ${survivorId}
        AND e.provider = m.provider AND e.external_id = m.external_id`);

    // 4. Shelves: repointed items go back; dropped items are re-created where
    // the shelf still exists.
    await tx.execute(sql`
      UPDATE shelf_items SET work_id = ${loserId}
      WHERE work_id = ${survivorId} AND shelf_id = ANY (${uuids(moved.shelf_items_moved)})`);
    await tx.execute(sql`
      INSERT INTO shelf_items (shelf_id, work_id, position, note, added_at, added_by)
      SELECT d.shelf_id, ${loserId}, d.position, d.note, d.added_at,
             (SELECT u.id FROM users u WHERE u.id = d.added_by)
      FROM jsonb_to_recordset(${json(moved.shelf_items_dropped)})
           AS d(shelf_id uuid, position int, note text, added_at timestamptz, added_by uuid)
      WHERE EXISTS (SELECT 1 FROM shelves s WHERE s.id = d.shelf_id)
      ON CONFLICT (shelf_id, work_id) DO NOTHING`);

    // 5. Mutes, the same shape.
    await tx.execute(sql`
      UPDATE mutes SET target_id = ${loserId}
      WHERE target_type = 'work' AND target_id = ${survivorId}
        AND user_id = ANY (${uuids(moved.mutes_moved)})`);
    await tx.execute(sql`
      INSERT INTO mutes (user_id, target_type, target_id, created_at)
      SELECT d.user_id, 'work', ${loserId}, d.created_at
      FROM jsonb_to_recordset(${json(moved.mutes_dropped)}) AS d(user_id uuid, created_at timestamptz)
      WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = d.user_id)
      ON CONFLICT DO NOTHING`);

    // 6. Favourites, only where the list is still exactly what the merge wrote.
    await tx.execute(sql`
      UPDATE profiles p
      SET favourite_work_ids = ARRAY(SELECT jsonb_array_elements_text(f.before)::uuid)
      FROM jsonb_to_recordset(${json(moved.favourites)}) AS f(user_id uuid, before jsonb, after jsonb)
      WHERE p.user_id = f.user_id
        AND p.favourite_work_ids = ARRAY(SELECT jsonb_array_elements_text(f.after)::uuid)`);

    // 7. Authorship, subjects, series: give the loser its rows back and take
    // off the survivor exactly the rows the merge added.
    const authors = moved.authors ?? [];
    await tx.execute(sql`
      INSERT INTO work_authors (work_id, author_id, role, position)
      SELECT ${loserId}, a.author_id, a.role, a.position
      FROM jsonb_to_recordset(${json(authors)}) AS a(author_id uuid, role text, position int)
      ON CONFLICT (work_id, author_id, role) DO NOTHING`);
    await tx.execute(sql`
      DELETE FROM work_authors wa
      USING jsonb_to_recordset(${json(moved.authors_added)}) AS a(author_id uuid, role text)
      WHERE wa.work_id = ${survivorId} AND wa.author_id = a.author_id AND wa.role = a.role`);

    const subjects = moved.subjects ?? [];
    await tx.execute(sql`
      INSERT INTO work_subjects (work_id, subject_id, weight)
      SELECT ${loserId}, s.subject_id, s.weight
      FROM jsonb_to_recordset(${json(subjects)}) AS s(subject_id uuid, weight real)
      ON CONFLICT (work_id, subject_id) DO NOTHING`);
    await tx.execute(sql`
      DELETE FROM work_subjects
      WHERE work_id = ${survivorId} AND subject_id = ANY (${uuids(moved.subjects_added)})`);

    await tx.execute(sql`
      INSERT INTO series_entries (series_id, work_id, position)
      SELECT se.series_id, ${loserId}, se.position
      FROM jsonb_to_recordset(${json(moved.series_entries)}) AS se(series_id uuid, position numeric)
      ON CONFLICT (series_id, work_id) DO NOTHING`);
    await tx.execute(sql`
      DELETE FROM series_entries
      WHERE work_id = ${survivorId} AND series_id = ANY (${uuids(moved.series_added)})`);

    // 8. Chains the merge flattened point back at the loser.
    await tx.execute(sql`
      UPDATE works SET merged_into_id = ${loserId}, updated_at = now()
      WHERE id = ANY (${uuids(moved.rechained_ids)})`);

    // 9. Counters. log_count gave the loser's count to the survivor; work_stats
    // is derived, so recompute both rather than trying to reverse it.
    if (moved.log_count_added) {
      await tx.execute(sql`
        UPDATE works SET log_count = GREATEST(log_count - ${moved.log_count_added}, 0)
        WHERE id = ${survivorId}`);
    }
    await tx.execute(sql`SELECT recompute_work_stats_for_work(${survivorId}::uuid)`);
    await tx.execute(sql`SELECT recompute_work_stats_for_work(${loserId}::uuid)`);

    await tx.execute(sql`UPDATE work_merges SET undone_at = now() WHERE id = ${merge.id}`);

    // If a dedupe_queue entry exists for this pair, reset its status to pending.
    await tx.execute(sql`
      UPDATE dedupe_queue
      SET status = 'pending', reviewed_at = NULL, reviewed_by_user_id = NULL
      WHERE survivor_id = ${survivorId} AND loser_id = ${loserId}
    `);

    return {
      undone: true as const,
      merge_id: merge.id,
      mergeId: merge.id,
      survivor_id: survivorId,
      survivorId,
      loser_id: loserId,
      loserId,
      restored: {
        reads: reads.length,
        editions: (moved.edition_ids ?? []).length,
        authors: authors.length,
        subjects: subjects.length,
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
 * A work is a stage-3 PROBE when it is popular (dump + Flyleaf logs) or has
 * Flyleaf user data. Only the authors of probe works are matched against
 * other author records by name (part B of STAGE3_SQL).
 *
 * Why a probe set at all: one `name % name` lookup in authors_name_trgm_idx
 * (15.4M names, 952 MB) costs ~80 ms warm and 1-1.7 s cold on the 8 GB dev
 * machine, so probing all 1.66M credited authors would take 37+ hours. At 100
 * logs the probe set is ~7.3k authors of 9.4k works on the full catalog, plus
 * the authors of every work anyone has read, shelved or favourited. Those are
 * the duplicates whose split ratings anyone would see.
 *
 * Decided scope limit (Audit 03b, A-03-023): cross-record duplicates among
 * works below the line are covered instead by user reports (stage 4) and by
 * probing, once, every work created since the previous finished pass
 * (`since`: ingested or gap-filled works; see dedupe_runs).
 */
export const STAGE3_PROBE_MIN_LOGS = 100;

/**
 * Stage 3 pairs: trigram similarity on the normalised title > 0.85, author
 * name similarity > 0.9, first-publication years within 2 (PRD §40.3).
 * QUEUED, never auto-merged: this band contains reissues, different
 * translations and series volumes with nearly identical titles.
 *
 * Titles are only ever compared WITHIN an author's works (D2, Audit 03b). The
 * first version compared every live work with every other: a 3.65M × 3.65M
 * nested loop (cost 1.09e12) that could not run on the full catalog.
 *
 *   A. Same author id. Every author's works, pairwise: 54M comparisons on
 *      the full catalog (the largest author has 1,930 works). A pair whose
 *      normalised titles are IDENTICAL is stage 2's, not this one's.
 *   B. The same author under two author records ("J.R.R. Tolkien" /
 *      "J. R. R. Tolkien"). For each probe author (STAGE3_PROBE_MIN_LOGS),
 *      the other credited authors whose name is > 0.9 similar come from
 *      authors_name_trgm_idx — this is that index's only user, so it must
 *      not be dropped — and their works are compared with the probe
 *      author's.
 *
 * B's author lookup is ONE STATEMENT PER PROBE NAME, on purpose. Written as a
 * join (one query, or a LATERAL over a batch of names), the planner never
 * builds a parameterised scan of the trigram index: it seq-scans or
 * bitmap-scans all 1.56M credited authors with `name % name` as a join
 * filter (measured: cost 1.3e12 in one query; 10 s for 2 names in a batch).
 * With the name as a constant it is a bitmap scan of authors_name_trgm_idx,
 * ~300 ms per name on the 8 GB dev machine, cold cache included.
 */
export const stage3ProbeSql = (since: string | null) => sql`
  WITH used AS (
    SELECT work_id FROM reads
    UNION SELECT work_id FROM shelf_items
    UNION SELECT unnest(favourite_work_ids) FROM profiles
  )
  SELECT DISTINCT a.id, a.name
  FROM work_authors wa
  JOIN works w ON w.id = wa.work_id
  JOIN authors a ON a.id = wa.author_id
  WHERE w.merged_into_id IS NULL AND NOT w.is_provisional
    AND (w.log_count >= ${sql.raw(String(STAGE3_PROBE_MIN_LOGS))}
         OR w.id IN (SELECT work_id FROM used)
         OR w.created_at > ${since}::timestamptz)`;

/** Other credited authors whose name is > 0.9 similar to one probe author's. */
const STAGE3_PEERS_SQL = (probe: { id: string; name: string }) => sql`
  SELECT b.id AS a2, similarity(${probe.name}, b.name) AS author_sim
  FROM authors b
  WHERE b.name % ${probe.name} AND b.id <> ${probe.id} AND b.has_works
    AND similarity(${probe.name}, b.name) > 0.9`;

/** Parts A and B → survivor-first pairs. $1: the author pairs from STAGE3_PEERS_SQL. */
const STAGE3_PAIRS_SQL = (peers: { a1: string; a2: string; author_sim: number }[]) => sql`
  WITH aw AS MATERIALIZED (
    SELECT wa.author_id, w.id, w.first_publish_year AS y,
           ${sql.raw(onColumn(NORMALISED_TITLE_EXPR, 'w.title'))} AS norm
    FROM work_authors wa
    JOIN works w ON w.id = wa.work_id
    WHERE w.merged_into_id IS NULL AND NOT w.is_provisional
  ),
  same_author AS (
    SELECT a.id AS x, b.id AS y, similarity(a.norm, b.norm) AS title_sim, 1.0::real AS author_sim
    FROM aw a
    JOIN aw b ON b.author_id = a.author_id AND b.id > a.id
    WHERE a.norm <> '' AND b.norm <> '' AND a.norm <> b.norm
      AND (a.y IS NULL OR b.y IS NULL OR abs(a.y - b.y) <= 2)
      AND similarity(a.norm, b.norm) > 0.85
  ),
  peers AS (
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(peers)}::jsonb) AS p(a1 uuid, a2 uuid, author_sim real)
  ),
  cross_record AS (
    SELECT least(a.id, b.id) AS x, greatest(a.id, b.id) AS y,
           similarity(a.norm, b.norm) AS title_sim, pr.author_sim
    FROM peers pr
    JOIN aw a ON a.author_id = pr.a1
    JOIN aw b ON b.author_id = pr.a2
    WHERE a.id <> b.id AND a.norm <> '' AND b.norm <> ''
      AND (a.y IS NULL OR b.y IS NULL OR abs(a.y - b.y) <= 2)
      AND similarity(a.norm, b.norm) > 0.85
      -- A shared author id makes it part A's pair (or stage 2's).
      AND NOT EXISTS (
        SELECT 1 FROM work_authors x JOIN work_authors z ON z.author_id = x.author_id
        WHERE x.work_id = a.id AND z.work_id = b.id)
  ),
  pairs AS (
    SELECT x, y, max(title_sim) AS title_sim, max(author_sim) AS author_sim
    FROM (SELECT * FROM same_author UNION ALL SELECT * FROM cross_record) u
    GROUP BY x, y
  ),
  ranked AS (
    SELECT p.*,
           (SELECT count(*) FROM editions e WHERE e.work_id = p.x) AS x_editions,
           (SELECT count(*) FROM editions e WHERE e.work_id = p.y) AS y_editions,
           wx.log_count AS x_logs, wy.log_count AS y_logs
    FROM pairs p
    JOIN works wx ON wx.id = p.x
    JOIN works wy ON wy.id = p.y
  )
  SELECT CASE WHEN (x_editions, x_logs, y) > (y_editions, y_logs, x) THEN x ELSE y END AS survivor_id,
         CASE WHEN (x_editions, x_logs, y) > (y_editions, y_logs, x) THEN y ELSE x END AS loser_id,
         title_sim, author_sim
  FROM ranked
  ORDER BY title_sim DESC, survivor_id, loser_id`;

export type Stage3Timings = { probeAuthors: number; authorPairs: number; probeMs: number; peersMs: number; pairsMs: number };

export async function findStage3Candidates(
  db: Db,
  limit?: number,
  onTimings?: (t: Stage3Timings) => void,
  /** Also probe works created after this instant (the previous finished run's start). */
  since: string | null = null,
): Promise<{ survivorId: string; loserId: string; titleSimilarity: number; authorSimilarity: number }[]> {
  const t0 = Date.now();
  const probes = await db.execute<{ id: string; name: string }>(stage3ProbeSql(since));
  const t1 = Date.now();

  const peers: { a1: string; a2: string; author_sim: number }[] = [];
  // Local to this transaction: every other query keeps the search threshold.
  // At 0.9 the index returns few candidates per name; at the search default
  // (0.45) each lookup rechecks far more heap rows. Custom plans, so a cached
  // generic plan can never fall back to scanning every author.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('pg_trgm.similarity_threshold', '0.9', true)`);
    await tx.execute(sql`SELECT set_config('plan_cache_mode', 'force_custom_plan', true)`);
    for (const p of probes) {
      const rows = await tx.execute<{ a2: string; author_sim: number }>(STAGE3_PEERS_SQL(p));
      peers.push(...rows.map((r) => ({ a1: p.id, a2: r.a2, author_sim: Number(r.author_sim) })));
    }
  });
  const t2 = Date.now();

  const rows = await db.execute<{ survivor_id: string; loser_id: string; title_sim: number; author_sim: number }>(
    limit == null ? STAGE3_PAIRS_SQL(peers) : sql`${STAGE3_PAIRS_SQL(peers)} LIMIT ${Math.trunc(limit)}`);
  onTimings?.({
    probeAuthors: probes.length, authorPairs: peers.length,
    probeMs: t1 - t0, peersMs: t2 - t1, pairsMs: Date.now() - t2,
  });

  return rows.map((r) => ({
    survivorId: r.survivor_id,
    loserId: r.loser_id,
    titleSimilarity: Number(r.title_sim),
    authorSimilarity: Number(r.author_sim),
  }));
}

export async function queueStage3Candidates(db: Db, limit?: number): Promise<number> {
  return queueStage3(db, await findStage3Candidates(db, limit));
}

async function queueStage3(
  db: Db,
  candidates: Awaited<ReturnType<typeof findStage3Candidates>>,
): Promise<number> {
  const queued = await queuePairs(db, candidates.map((c) => {
    const titlePct = Math.round(c.titleSimilarity * 100);
    const authorPct = Math.round(c.authorSimilarity * 100);
    return {
      survivorId: c.survivorId,
      loserId: c.loserId,
      stage: 3 as const,
      confidence: Math.round((c.titleSimilarity * 0.6 + c.authorSimilarity * 0.4) * 100) / 100,
      reason: `trigram title similarity ${titlePct}%, author similarity ${authorPct}% (Stage 3 probable)`,
      metadata: { titleSimilarity: c.titleSimilarity, authorSimilarity: c.authorSimilarity },
    };
  }), { automated: true });
  return queued.filter((q) => q.inserted).length;
}

type QueueItem = {
  survivorId: string;
  loserId: string;
  stage: 1 | 2 | 3 | 4;
  reason: string;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
};

/**
 * Put pairs in the review queue, set-based, with their impact.
 *
 * `impact` is the number of user-data rows (reads, reviews, shelf items,
 * favourites) on either work: the queue is reviewed highest-impact first (D1).
 * A pair already pending keeps its row, and its impact is refreshed. Skipped:
 * pairs where either work has been merged away since detection, pairs pending
 * in the other orientation, and — for `automated` stages only — pairs a
 * reviewer has already dismissed. A new user report of a dismissed pair is new
 * evidence and is queued again.
 */
async function queuePairs(
  db: Db,
  items: QueueItem[],
  { automated }: { automated: boolean },
): Promise<{ id: string; inserted: boolean }[]> {
  const out: { id: string; inserted: boolean }[] = [];
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const key = `${i.survivorId}:${i.loserId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Batches keep each statement's jsonb parameter and hash tables small.
  for (let at = 0; at < unique.length; at += 2000) {
    const batch = unique.slice(at, at + 2000).map((i) => ({
      survivor_id: i.survivorId,
      loser_id: i.loserId,
      stage: i.stage,
      reason: i.reason,
      confidence: i.confidence ?? null,
      metadata: i.metadata ?? {},
    }));
    const rows = await db.execute<{ id: string; inserted: boolean }>(sql`
      WITH p AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
          AS p(survivor_id uuid, loser_id uuid, stage smallint, reason text, confidence real, metadata jsonb)
      ),
      ids AS (SELECT survivor_id AS id FROM p UNION SELECT loser_id FROM p),
      used AS (
        SELECT u.id, count(*)::int AS n
        FROM (
          SELECT r.work_id AS id FROM reads r WHERE r.work_id IN (SELECT id FROM ids)
          UNION ALL SELECT v.work_id FROM reviews v WHERE v.work_id IN (SELECT id FROM ids)
          UNION ALL SELECT s.work_id FROM shelf_items s WHERE s.work_id IN (SELECT id FROM ids)
          UNION ALL SELECT f.id FROM profiles pr, unnest(pr.favourite_work_ids) AS f(id)
                    WHERE f.id IN (SELECT id FROM ids)
        ) u
        GROUP BY u.id
      )
      INSERT INTO dedupe_queue (survivor_id, loser_id, stage, status, confidence, reason, metadata, impact)
      SELECT p.survivor_id, p.loser_id, p.stage, 'pending', p.confidence, p.reason, p.metadata,
             COALESCE(us.n, 0) + COALESCE(ul.n, 0)
      FROM p
      JOIN works ws ON ws.id = p.survivor_id AND ws.merged_into_id IS NULL
      JOIN works wl ON wl.id = p.loser_id AND wl.merged_into_id IS NULL
      LEFT JOIN used us ON us.id = p.survivor_id
      LEFT JOIN used ul ON ul.id = p.loser_id
      WHERE NOT EXISTS (
          SELECT 1 FROM dedupe_queue d
          WHERE d.status = 'pending' AND d.survivor_id = p.loser_id AND d.loser_id = p.survivor_id)
        AND (NOT ${automated}::boolean OR NOT EXISTS (
          SELECT 1 FROM dedupe_queue d
          WHERE d.status = 'dismissed'
            AND ((d.survivor_id = p.survivor_id AND d.loser_id = p.loser_id)
              OR (d.survivor_id = p.loser_id AND d.loser_id = p.survivor_id))))
      ON CONFLICT (survivor_id, loser_id) WHERE status = 'pending'
        DO UPDATE SET impact = EXCLUDED.impact
      RETURNING id, (xmax = 0) AS inserted`);
    out.push(...rows.map((r) => ({ id: r.id, inserted: r.inserted === true || String(r.inserted) === 'true' })));
  }
  return out;
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

  // Insert-or-find rather than find-then-insert: two reports of the same pair
  // at once would otherwise both miss the SELECT and one would hit the
  // pending-pair unique index as a 500.
  const [queued] = await queuePairs(db, [{
    survivorId: data.survivorId,
    loserId: data.loserId,
    stage: 4,
    reason: data.reason,
    metadata: { reportedByUserId: data.reporterUserId ?? null },
  }], { automated: false });
  if (queued) return { id: queued.id, queued: true };

  // Already pending the other way round (or merged since the checks above).
  const [existing] = await db.execute<{ id: string }>(sql`
    SELECT id FROM dedupe_queue
    WHERE status = 'pending'
      AND ((survivor_id = ${data.survivorId} AND loser_id = ${data.loserId})
        OR (survivor_id = ${data.loserId} AND loser_id = ${data.survivorId}))
  `);
  if (!existing) throw ApiError.conflict('work_merged', 'One of these works has just been merged into another.');
  return { id: existing.id, queued: true };
}

/**
 * Returns paginated dedupe queue entries with joined survivor and loser details,
 * highest impact first.
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
      dq.impact,
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

  // Highest impact first: pairs where either work has user data are the
  // ones whose split ratings people see (D1, Audit 03b).
  query = sql`${query} ORDER BY dq.impact DESC, dq.created_at DESC, dq.id LIMIT ${limit} OFFSET ${offset}`;

  const rows = await db.execute<any>(query);

  return rows.map((r) => ({
    id: r.id,
    stage: Number(r.stage),
    status: r.status,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    reason: r.reason,
    impact: Number(r.impact),
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
  // One transaction with the item locked: a double click, or two reviewers on
  // the same item, must resolve it once. The merge runs as a savepoint inside.
  return db.transaction(async (tx) => {
    const [item] = await tx.execute<{
      id: string;
      survivor_id: string;
      loser_id: string;
      stage: number;
      status: string;
      reason: string;
    }>(sql`
      SELECT id, survivor_id, loser_id, stage, status, reason
      FROM dedupe_queue WHERE id = ${queueId}
      FOR UPDATE
    `);

    if (!item) throw ApiError.notFound('Queue item not found.');
    if (item.status !== 'pending') {
      throw ApiError.badRequest('already_resolved', `Queue item is already ${item.status}.`);
    }

    if (action === 'merge') {
      const mergeResult = await mergeWorks(tx as unknown as Db, {
        survivorId: item.survivor_id,
        loserId: item.loser_id,
        stage: item.stage as 1 | 2 | 3 | 4,
        reason: opts.reason ?? item.reason,
      });

      await tx.execute(sql`
        UPDATE dedupe_queue
        SET status = 'merged',
            reviewed_at = now(),
            reviewed_by_user_id = ${opts.reviewerUserId ?? null}
        WHERE id = ${queueId}
      `);

      return {
        success: true as const,
        action: 'merge' as const,
        merge_id: mergeResult.mergeId,
        mergeId: mergeResult.mergeId,
      };
    }

    await tx.execute(sql`
      UPDATE dedupe_queue
      SET status = 'dismissed',
          dismiss_reason = ${opts.reason ?? 'Dismissed by reviewer.'},
          reviewed_at = now(),
          reviewed_by_user_id = ${opts.reviewerUserId ?? null}
      WHERE id = ${queueId}
    `);

    return { success: true as const, action: 'dismiss' as const };
  });
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
  /** Stage 1 pairs detected (shared ISBN-13). */
  stage1: number;
  /** Stage 2 pairs detected (normalised main title + shared author). */
  stage2: number;
  /** Distinct stage 1-2 pairs that are unambiguous under D1 (either stage). */
  autoMergeable: number;
  /** Distinct stage 1-2 pairs that go to review instead (in a dry run: would go). */
  toReview: number;
  /** Of those, how many were newly queued (0 in a dry run). */
  queued: number;
  /** Stage 3 pairs detected. */
  stage3: number;
  stage3Queued: number;
  /** Stage 3 also probed works created after this (the previous finished run's start); null on a first run. */
  stage3Since: string | null;
  /** Whether this run was allowed to merge (DEDUPE_AUTO_MERGE / --auto-merge). */
  autoMerge: boolean;
  merged: number;
  skipped: number;
  /** Auto-mergeable pairs left for the next run because the merge cap was reached. */
  deferred: number;
};

/** Default per-run merge cap (D1, Audit 03b). */
export const DEFAULT_MERGE_CAP = 200;

export type Stage12Pair = {
  survivorId: string;
  loserId: string;
  /** The stages that found it. */
  stages: (1 | 2)[];
  /** Unambiguous under D1: auto-merged when merging is enabled. */
  auto: boolean;
  /** The stage recorded on the merge or the queue row. */
  stage: 1 | 2;
  reason: string;
};

/**
 * Stages 1 and 2, classified by the D1 rules (Audit 03b):
 *
 *   auto-merge  stage 1: same ISBN-13 AND same normalised title AND a shared author
 *               stage 2: same normalised title AND a shared author AND matching
 *                        subtitles (both absent, or both present and equal)
 *   review      everything else either stage finds
 *
 * A pair a reviewer has dismissed is dropped: the pass must not re-queue it or
 * merge it. A pair whose merge was undone is never auto-merged again; it goes
 * to review, because an undo is a human saying the rule got it wrong.
 */
export async function detectStage12(db: Db): Promise<{ stage1: number; stage2: number; pairs: Stage12Pair[] }> {
  const stage1 = await db.execute<{
    survivor_id: string; loser_id: string; isbn_13: string; same_title: boolean; shared_author: boolean;
  }>(sql.raw(STAGE1_SQL));
  const stage2 = await db.execute<{
    survivor_id: string; loser_id: string; norm: string; survivor_sub: string; loser_sub: string;
  }>(sql.raw(STAGE2_SQL));

  const key = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const dismissed = new Set((await db.execute<{ survivor_id: string; loser_id: string }>(sql`
    SELECT survivor_id, loser_id FROM dedupe_queue WHERE status = 'dismissed'`))
    .map((r) => key(r.survivor_id, r.loser_id)));
  const undone = new Set((await db.execute<{ survivor_id: string; loser_id: string }>(sql`
    SELECT survivor_id, loser_id FROM work_merges WHERE undone_at IS NOT NULL`))
    .map((r) => key(r.survivor_id, r.loser_id)));

  type Finding = { stage: 1 | 2; auto: boolean; reason: string };
  const found = new Map<string, { survivorId: string; loserId: string; findings: Finding[] }>();
  const add = (survivorId: string, loserId: string, f: Finding) => {
    const k = key(survivorId, loserId);
    if (dismissed.has(k)) return;
    const entry = found.get(k) ?? { survivorId, loserId, findings: [] };
    entry.findings.push(f);
    found.set(k, entry);
  };

  for (const r of stage1) {
    const sameTitle = r.same_title === true || String(r.same_title) === 'true';
    const sharedAuthor = r.shared_author === true || String(r.shared_author) === 'true';
    const missing = [!sameTitle && 'the normalised titles differ', !sharedAuthor && 'no author is shared']
      .filter(Boolean).join(' and ');
    add(r.survivor_id, r.loser_id, {
      stage: 1,
      auto: sameTitle && sharedAuthor,
      reason: missing
        ? `shared ISBN-13 ${r.isbn_13}, but ${missing}`
        : `shared ISBN-13 ${r.isbn_13}, same normalised title and a shared author`,
    });
  }
  for (const r of stage2) {
    const [s, l] = [r.survivor_sub, r.loser_sub];
    const auto = s === l;
    const why = auto ? (s ? `, same subtitle "${s}"` : '')
      : s && l ? `, but the subtitles differ ("${s}" / "${l}")`
      : `, but only one has a subtitle ("${s || l}")`;
    add(r.survivor_id, r.loser_id, {
      stage: 2,
      auto,
      reason: `normalised title "${r.norm}" and a shared author${why}`,
    });
  }

  const pairs: Stage12Pair[] = [];
  for (const [k, e] of found) {
    const autoFinding = e.findings.find((f) => f.auto);
    const wasUndone = undone.has(k);
    // Stage and reason come from the same finding: the unambiguous one if any.
    const chosen = autoFinding ?? e.findings.slice().sort((a, b) => a.stage - b.stage)[0]!;
    pairs.push({
      survivorId: e.survivorId,
      loserId: e.loserId,
      stages: [...new Set(e.findings.map((f) => f.stage))].sort(),
      auto: !!autoFinding && !wasUndone,
      stage: chosen.stage,
      reason: wasUndone && autoFinding
        ? `${chosen.reason} (an earlier merge of this pair was undone)`
        : chosen.reason,
    });
  }
  // Deterministic order, so a capped run merges the same pairs a re-run would.
  pairs.sort((a, b) => (a.survivorId + a.loserId < b.survivorId + b.loserId ? -1 : 1));
  return { stage1: stage1.length, stage2: stage2.length, pairs };
}

/**
 * One dedupe pass.
 *
 *   dryRun      detect and report; writes nothing.
 *   autoMerge   OFF by default. Off: detect, and queue what needs review — the
 *               scheduled job must never merge unattended unless someone
 *               turned it on (DEDUPE_AUTO_MERGE=true). On: also merge the
 *               unambiguous pairs, at most `mergeCap` per run.
 *
 * Order: merges, then the stage 1-2 review queue, then stage 3. Each merge
 * commits on its own, so a queueing or stage-3 failure can't undo or block
 * the merges, and a re-run resumes. Queueing after the merges also means no
 * queued pair names a work this run has just merged away.
 */
export async function runDedupe(
  db: Db,
  opts: {
    dryRun?: boolean;
    autoMerge?: boolean;
    mergeCap?: number;
    onMerge?: (c: MergeCandidate) => void;
    onDetected?: (pairs: Stage12Pair[]) => void;
    onStage3?: (t: Stage3Timings) => void;
  } = {},
): Promise<DedupeReport> {
  const autoMerge = opts.autoMerge === true;
  const mergeCap = opts.mergeCap ?? DEFAULT_MERGE_CAP;
  if (!Number.isInteger(mergeCap) || mergeCap < 0) throw new Error(`invalid merge cap: ${mergeCap}`);

  // The previous FINISHED pass: stage 3 probes every work created since it
  // started. As text, so the microseconds survive the round trip.
  const [previous] = await db.execute<{ since: string | null }>(sql`
    SELECT max(started_at)::text AS since FROM dedupe_runs WHERE finished_at IS NOT NULL`);
  const since = previous?.since ?? null;
  // Recorded before detection, so works created while this pass runs are
  // "since" for the next one. A dry run writes nothing, not even this.
  const [run] = opts.dryRun ? [] : await db.execute<{ id: string }>(sql`
    INSERT INTO dedupe_runs (auto_merge) VALUES (${autoMerge}::boolean) RETURNING id`);

  const { stage1, stage2, pairs } = await detectStage12(db);
  opts.onDetected?.(pairs);
  const auto = pairs.filter((p) => p.auto);
  const review = pairs.filter((p) => !p.auto);

  const report: DedupeReport = {
    stage1,
    stage2,
    autoMergeable: auto.length,
    toReview: review.length,
    queued: 0,
    stage3: 0,
    stage3Queued: 0,
    stage3Since: since,
    autoMerge,
    merged: 0,
    skipped: 0,
    deferred: 0,
  };

  if (opts.dryRun) {
    report.stage3 = (await findStage3Candidates(db, undefined, opts.onStage3, since)).length;
    return report;
  }

  if (autoMerge) {
    for (const [i, p] of auto.entries()) {
      if (report.merged >= mergeCap) { report.deferred = auto.length - i; break; }
      const c: MergeCandidate = { survivorId: p.survivorId, loserId: p.loserId, stage: p.stage, reason: p.reason };
      // Both ends must still be live. An earlier merge in this same batch, or an
      // admin merging from the console meanwhile, may have consumed either one;
      // mergeWorks checks that under its row locks and says so with a 409.
      try {
        await mergeWorks(db, c);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'work_merged') { report.skipped++; continue; }
        throw err;
      }
      opts.onMerge?.(c);
      report.merged++;
    }
  }

  const queued = await queuePairs(db, review.map((p) => ({
    survivorId: p.survivorId, loserId: p.loserId, stage: p.stage, reason: p.reason,
    metadata: { stages: p.stages },
  })), { automated: true });
  report.queued = queued.filter((q) => q.inserted).length;

  const stage3 = await findStage3Candidates(db, undefined, opts.onStage3, since);
  report.stage3 = stage3.length;
  report.stage3Queued = await queueStage3(db, stage3);

  // Only a pass that got this far counts as "previous" for the next one; a
  // pass that died leaves finished_at NULL and its window is covered again.
  await db.execute(sql`
    UPDATE dedupe_runs SET finished_at = now(), report = ${JSON.stringify(report)}::jsonb
    WHERE id = ${run!.id}`);
  return report;
}
