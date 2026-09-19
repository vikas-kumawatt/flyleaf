// Catalog Matching Engine (PRD §6.8, §34.4, §40.3, §5141, AC-9, Architecture §3.7, IM-05).
//
// Non-negotiable principles:
//   1. ISBN Match first (highest confidence, 1.0)
//   2. Source ID / Work Key match (confidence 0.98)
//   3. Title + Author exact match (confidence 0.90)
//   4. Title + Author fuzzy match with strict ambiguity thresholds
//   5. GOLDEN PRD RULE: Ambiguous matches NEVER guessed; marked 'unmatched'
//      with failure_reason = 'ambiguous_match' and sent to review list.

import { sql, eq } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { imports, importRows } from '../db/schema.js';
import { detectIsbn } from '../catalog/isbn.js';
import { normaliseTitle } from '../catalog/dedupe.js';
import type { NormalizedImportRow } from './types.js';

export type MatchStrategy =
  | 'isbn'
  | 'source_id'
  | 'exact_title_author'
  | 'fuzzy_title_author';

export type MatchFailureReason =
  | 'missing_title'
  | 'no_confident_match'
  | 'ambiguous_match';

export interface MatchCandidate {
  workId: string;
  title: string;
  authorName: string | null;
  score: number;
}

export interface MatchResult {
  state: 'matched' | 'unmatched';
  workId: string | null;
  editionId: string | null;
  confidence: number | null;
  failureReason: MatchFailureReason | null;
  strategy: MatchStrategy | null;
  candidates?: MatchCandidate[];
}

/**
 * Matches a single NormalizedImportRow against the Flyleaf catalog.
 */
export async function matchImportRow(
  db: Db,
  row: NormalizedImportRow,
): Promise<MatchResult> {
  // 1. Validate required identity fields
  if (!row.title || row.title.trim().length === 0) {
    return {
      state: 'unmatched',
      workId: null,
      editionId: null,
      confidence: 0,
      failureReason: 'missing_title',
      strategy: null,
    };
  }

  // 2. Stage 1: Exact ISBN match on editions
  const isbnMatch = await findMatchByIsbn(db, row);
  if (isbnMatch) {
    return isbnMatch;
  }

  // 3. Stage 2: Open Library Work / Edition Key match
  if (row.sourceId) {
    const sourceMatch = await findMatchBySourceId(db, row.sourceId);
    if (sourceMatch) {
      return sourceMatch;
    }
  }

  // 4. Stage 3: Exact Title + Author match
  const exactMatch = await findMatchByExactTitleAuthor(db, row);
  if (exactMatch) {
    return exactMatch;
  }

  // 5. Stage 4: Fuzzy Title + Author match (with ambiguity threshold enforcement)
  return await findMatchByFuzzyTitleAuthor(db, row);
}

/**
 * Stage 1: Matches ISBN-10 or ISBN-13 against editions table.
 * Confidence = 1.0
 */
async function findMatchByIsbn(
  db: Db,
  row: NormalizedImportRow,
): Promise<MatchResult | null> {
  const isbnCandidates: string[] = [];

  for (const raw of [row.isbn13, row.isbn10, row.isbn]) {
    if (!raw) continue;
    const det = detectIsbn(raw);
    if (det) {
      if (det.isbn13) isbnCandidates.push(det.isbn13);
      if (det.isbn10) isbnCandidates.push(det.isbn10);
    }
  }

  const uniqueIsbns = Array.from(new Set(isbnCandidates));
  if (uniqueIsbns.length === 0) return null;

  const results = await db.execute<{
    edition_id: string;
    work_id: string;
    work_title: string;
  }>(sql`
    SELECT
      e.id AS edition_id,
      e.work_id,
      w.title AS work_title
    FROM editions e
    JOIN works w ON w.id = e.work_id
    WHERE (e.isbn_13 IN ${uniqueIsbns} OR e.isbn_10 IN ${uniqueIsbns})
      AND w.merged_into_id IS NULL
      AND w.is_provisional = false
    ORDER BY w.log_count DESC, e.publish_year DESC NULLS LAST
    LIMIT 1
  `);

  const match = results[0];
  if (!match) return null;

  return {
    state: 'matched',
    workId: match.work_id,
    editionId: match.edition_id,
    confidence: 1.0,
    failureReason: null,
    strategy: 'isbn',
  };
}

/**
 * Stage 2: Matches Open Library Work or Edition IDs.
 * Confidence = 0.98
 */
async function findMatchBySourceId(
  db: Db,
  sourceId: string,
): Promise<MatchResult | null> {
  const trimmed = sourceId.trim();

  // Match Open Library Work Key (e.g. OL82563W or /works/OL82563W)
  const workKeyMatch = trimmed.match(/(OL\d+W)/i);
  if (workKeyMatch && workKeyMatch[1]) {
    const key = workKeyMatch[1].toUpperCase();
    const results = await db.execute<{
      work_id: string;
      edition_id: string | null;
    }>(sql`
      SELECT
        w.id AS work_id,
        COALESCE(
          w.default_edition_id,
          (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
        ) AS edition_id
      FROM works w
      WHERE w.ol_work_key = ${key}
        AND w.merged_into_id IS NULL
        AND w.is_provisional = false
      LIMIT 1
    `);

    const match = results[0];
    if (match) {
      return {
        state: 'matched',
        workId: match.work_id,
        editionId: match.edition_id,
        confidence: 0.98,
        failureReason: null,
        strategy: 'source_id',
      };
    }
  }

  // Match Open Library Edition Key (e.g. OL24364628M or /books/OL24364628M)
  const editionKeyMatch = trimmed.match(/(OL\d+M)/i);
  if (editionKeyMatch && editionKeyMatch[1]) {
    const key = editionKeyMatch[1].toUpperCase();
    const results = await db.execute<{
      work_id: string;
      edition_id: string;
    }>(sql`
      SELECT
        e.work_id,
        e.id AS edition_id
      FROM editions e
      JOIN works w ON w.id = e.work_id
      WHERE e.ol_edition_key = ${key}
        AND w.merged_into_id IS NULL
        AND w.is_provisional = false
      LIMIT 1
    `);

    const match = results[0];
    if (match) {
      return {
        state: 'matched',
        workId: match.work_id,
        editionId: match.edition_id,
        confidence: 0.98,
        failureReason: null,
        strategy: 'source_id',
      };
    }
  }

  return null;
}

/**
 * Stage 3: Matches exact title and author.
 * PRD Rule: If multiple distinct works match, it is ambiguous and goes unmatched!
 */
async function findMatchByExactTitleAuthor(
  db: Db,
  row: NormalizedImportRow,
): Promise<MatchResult | null> {
  const normTitle = normaliseTitle(row.title);
  const authorClean = row.author?.trim();

  // If author is missing, title-alone matching is only allowed if unique in catalog
  if (!authorClean) {
    const titleResults = await db.execute<{
      work_id: string;
      work_title: string;
      edition_id: string | null;
      author_name: string | null;
    }>(sql`
      SELECT
        w.id AS work_id,
        w.title AS work_title,
        COALESCE(
          w.default_edition_id,
          (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
        ) AS edition_id,
        (
          SELECT a.name
          FROM work_authors wa
          JOIN authors a ON a.id = wa.author_id
          WHERE wa.work_id = w.id
          ORDER BY wa.position, a.name
          LIMIT 1
        ) AS author_name
      FROM works w
      WHERE w.merged_into_id IS NULL
        AND w.is_provisional = false
        AND (
          lower(w.title) = lower(${row.title.trim()})
          OR btrim(regexp_replace(
               regexp_replace(
                 regexp_replace(lower(split_part(w.title, ':', 1)), '^(the|a|an)\\s+', ''),
                 '[[:punct:]]', ' ', 'g'),
               '\\s+', ' ', 'g')) = ${normTitle}
        )
      LIMIT 5
    `);

    if (titleResults.length === 1 && titleResults[0]) {
      return {
        state: 'matched',
        workId: titleResults[0].work_id,
        editionId: titleResults[0].edition_id,
        confidence: 0.88,
        failureReason: null,
        strategy: 'exact_title_author',
      };
    }

    if (titleResults.length > 1) {
      // Multiple works share this title and no author was given -> ambiguous!
      return {
        state: 'unmatched',
        workId: null,
        editionId: null,
        confidence: 0.50,
        failureReason: 'ambiguous_match',
        strategy: null,
        candidates: titleResults.map((r) => ({
          workId: r.work_id,
          title: r.work_title,
          authorName: r.author_name,
          score: 0.50,
        })),
      };
    }

    return null;
  }

  // Exact title + Author check
  const results = await db.execute<{
    work_id: string;
    work_title: string;
    edition_id: string | null;
    author_name: string | null;
  }>(sql`
    SELECT
      w.id AS work_id,
      w.title AS work_title,
      COALESCE(
        w.default_edition_id,
        (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
      ) AS edition_id,
      (
        SELECT a.name
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
        ORDER BY wa.position, a.name
        LIMIT 1
      ) AS author_name
    FROM works w
    WHERE w.merged_into_id IS NULL
      AND w.is_provisional = false
      AND (
        lower(w.title) = lower(${row.title.trim()})
        OR btrim(regexp_replace(
             regexp_replace(
               regexp_replace(lower(split_part(w.title, ':', 1)), '^(the|a|an)\\s+', ''),
               '[[:punct:]]', ' ', 'g'),
             '\\s+', ' ', 'g')) = ${normTitle}
      )
      AND EXISTS (
        SELECT 1
        FROM work_authors wa
        JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id
          AND (
            lower(a.name) = lower(${authorClean})
            OR lower(a.name) ILIKE ${'%' + authorClean.toLowerCase() + '%'}
            OR lower(${authorClean}) ILIKE ('%' || lower(a.name) || '%')
          )
      )
    ORDER BY w.log_count DESC
    LIMIT 5
  `);

  if (results.length === 1 && results[0]) {
    return {
      state: 'matched',
      workId: results[0].work_id,
      editionId: results[0].edition_id,
      confidence: 0.92,
      failureReason: null,
      strategy: 'exact_title_author',
    };
  }

  if (results.length > 1) {
    // CRITICAL PRD AC-9: Ambiguous matches NEVER guessed
    return {
      state: 'unmatched',
      workId: null,
      editionId: null,
      confidence: 0.50,
      failureReason: 'ambiguous_match',
      strategy: null,
      candidates: results.map((r) => ({
        workId: r.work_id,
        title: r.work_title,
        authorName: r.author_name,
        score: 0.92,
      })),
    };
  }

  return null;
}

/**
 * Stage 4: Fuzzy Title + Author matching with strict ambiguity rejection.
 */
async function findMatchByFuzzyTitleAuthor(
  db: Db,
  row: NormalizedImportRow,
): Promise<MatchResult> {
  const normTitle = normaliseTitle(row.title);
  const authorClean = row.author?.trim();

  const candidates = await db.execute<{
    work_id: string;
    work_title: string;
    edition_id: string | null;
    author_name: string | null;
    title_sim: number;
    author_sim: number;
    total_score: number;
  }>(sql`
    WITH candidates AS (
      SELECT
        w.id AS work_id,
        w.title AS work_title,
        w.log_count,
        COALESCE(
          w.default_edition_id,
          (SELECT e.id FROM editions e WHERE e.work_id = w.id ORDER BY e.publish_year DESC NULLS LAST LIMIT 1)
        ) AS edition_id,
        (
          SELECT a.name
          FROM work_authors wa
          JOIN authors a ON a.id = wa.author_id
          WHERE wa.work_id = w.id
          ORDER BY wa.position, a.name
          LIMIT 1
        ) AS author_name,
        similarity(w.title, ${row.title}) AS title_sim,
        COALESCE((
          SELECT max(similarity(a.name, ${authorClean ?? ''}))
          FROM work_authors wa
          JOIN authors a ON a.id = wa.author_id
          WHERE wa.work_id = w.id
        ), 0) AS author_sim
      FROM works w
      WHERE w.merged_into_id IS NULL
        AND w.is_provisional = false
        AND (
          similarity(w.title, ${row.title}) > 0.40
          OR w.title ILIKE ${'%' + normTitle.slice(0, 20) + '%'}
        )
    )
    SELECT
      work_id,
      work_title,
      edition_id,
      author_name,
      title_sim,
      author_sim,
      (
        title_sim * 0.60 +
        author_sim * 0.40
      ) AS total_score
    FROM candidates
    ORDER BY total_score DESC, log_count DESC
    LIMIT 5
  `);

  if (candidates.length === 0) {
    return {
      state: 'unmatched',
      workId: null,
      editionId: null,
      confidence: 0,
      failureReason: 'no_confident_match',
      strategy: null,
    };
  }

  const top = candidates[0]!;
  const score1 = Number(top.total_score);

  // If top candidate doesn't reach minimum confidence threshold
  if (score1 < 0.70) {
    return {
      state: 'unmatched',
      workId: null,
      editionId: null,
      confidence: Math.round(score1 * 100) / 100,
      failureReason: 'no_confident_match',
      strategy: null,
      candidates: candidates.map((c) => ({
        workId: c.work_id,
        title: c.work_title,
        authorName: c.author_name,
        score: Number(c.total_score),
      })),
    };
  }

  // Ambiguity evaluation: compare score1 and runner-up score2
  const runnerUp = candidates[1];
  if (runnerUp) {
    const score2 = Number(runnerUp.total_score);
    const margin = score1 - score2;

    // PRD Rule: If runner up is within 0.15 margin, match is ambiguous -> NEVER GUESS
    if (margin < 0.15) {
      return {
        state: 'unmatched',
        workId: null,
        editionId: null,
        confidence: Math.round(score1 * 100) / 100,
        failureReason: 'ambiguous_match',
        strategy: null,
        candidates: candidates.map((c) => ({
          workId: c.work_id,
          title: c.work_title,
          authorName: c.author_name,
          score: Number(c.total_score),
        })),
      };
    }
  }

  // Clear winner with high confidence
  if (score1 >= 0.82) {
    return {
      state: 'matched',
      workId: top.work_id,
      editionId: top.edition_id,
      confidence: Math.round(score1 * 100) / 100,
      failureReason: null,
      strategy: 'fuzzy_title_author',
      candidates: candidates.map((c) => ({
        workId: c.work_id,
        title: c.work_title,
        authorName: c.author_name,
        score: Number(c.total_score),
      })),
    };
  }

  // Score between 0.70 and 0.82 without decisive margin
  return {
    state: 'unmatched',
    workId: null,
    editionId: null,
    confidence: Math.round(score1 * 100) / 100,
    failureReason: 'no_confident_match',
    strategy: null,
  };
}

/**
 * Batch matches normalized import rows and persists results into `import_rows`.
 * Updates `imports` counters: total_rows, matched, unmatched.
 */
export async function persistImportRowMatches(
  db: Db,
  importId: string,
  records: Array<{ row: NormalizedImportRow; match: MatchResult }>,
): Promise<{ total: number; matched: number; unmatched: number }> {
  let matchedCount = 0;
  let unmatchedCount = 0;

  for (const { row, match } of records) {
    if (match.state === 'matched') {
      matchedCount++;
    } else {
      unmatchedCount++;
    }

    await db
      .insert(importRows)
      .values({
        importId,
        rowNo: row.rowNo,
        raw: row.raw,
        state: match.state,
        workId: match.workId,
        editionId: match.editionId,
        confidence: match.confidence,
        failureReason: match.failureReason,
      })
      .onConflictDoUpdate({
        target: [importRows.importId, importRows.rowNo],
        set: {
          raw: row.raw,
          state: match.state,
          workId: match.workId,
          editionId: match.editionId,
          confidence: match.confidence,
          failureReason: match.failureReason,
        },
      });
  }

  // Update parent import job summary counters
  await db
    .update(imports)
    .set({
      totalRows: records.length,
      matched: matchedCount,
      unmatched: unmatchedCount,
      updatedAt: new Date(),
    })
    .where(eq(imports.id, importId));

  return {
    total: records.length,
    matched: matchedCount,
    unmatched: unmatchedCount,
  };
}
