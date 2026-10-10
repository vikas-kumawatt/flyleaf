// Import Committer Service (PRD §6.8, §1833, §34.4, §4409, §4410, AC-9, Architecture §3.7, §8, §9, IM-06, IM-07).
//
// Non-negotiable architectural rules:
//   1. IM-06: `My Rating = 0` (or empty/unrated) MUST import as `rating = NULL`.
//      Never 0 (which violates the database constraint `reads_rating_ck`), and
//      never dropped (which drops unrated books from users' libraries).
//   2. IM-07: Imported reads MUST have `source = 'import'`, and are strictly
//      excluded from the social activity feed. Importing 800+ books must NEVER
//      spam followers or create 800 feed items.

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { importRows, reads, reviews, shelves } from '../db/schema.js';
import {
  MAX_ITEMS_PER_SHELF,
  MAX_SHELVES_PER_USER,
  generateUniqueSlug,
  lockUserShelves,
  slugify,
} from '../shelves/index.js';
import type { NormalizedImportRow, NormalizedFormat } from './types.js';
import type { MatchResult } from './matcher.js';

export interface CommitImportRowInput {
  userId: string;
  importId: string;
  row: NormalizedImportRow;
  match: MatchResult;
}

export interface CommitImportRowResult {
  committed: boolean;
  readId: string | null;
  reviewId: string | null;
  shelfIds: string[];
  reason?: string;
}

export interface CommitImportBatchResult {
  totalProcessed: number;
  committed: number;
  skipped: number;
  readIds: string[];
}

/**
 * IM-06: Normalizes rating for database insertion.
 *
 * Enforces the PRD rule:
 * - Unrated books (`0`, `'0'`, `0.0`, `null`, `undefined`, `""`) -> `null`.
 * - Valid ratings (0.5 to 5.0 in 0.5 steps) -> formatted numeric string (e.g. `'4.5'`).
 * - Under no circumstances is 0 returned, avoiding violation of `reads_rating_ck`.
 */
export function normalizeRatingForPersistence(rawRating: unknown): string | null {
  if (rawRating === null || rawRating === undefined) return null;
  const num = typeof rawRating === 'number' ? rawRating : parseFloat(String(rawRating).trim());
  if (isNaN(num) || num <= 0) return null; // 0 or negative -> NULL

  // Clamp to valid range [0.5, 5.0]
  if (num < 0.5 || num > 5.0) return null;

  // Round to nearest half-star if floating imprecision exists
  const halfStep = Math.round(num * 2) / 2;
  return halfStep.toFixed(1);
}

/**
 * IM-07: Activity & Feed exclusion check.
 *
 * Any read where `source === 'import'` is excluded from the activity feed
 * and must not generate live social activity rows.
 */
export function isExcludedFromActivity(read: { source: string }): boolean {
  return read.source === 'import';
}

/**
 * IM-07: Returns true if the read is eligible for the public activity feed.
 */
export function isEligibleForActivityFeed(read: { source: string }): boolean {
  return read.source !== 'import';
}

/**
 * IM-07: SQL filter expression to exclude imported reads from feed queries.
 */
export function feedExcludesImportsSql() {
  return sql`${reads.source} != 'import'`;
}

export interface CommitOptions {
  /**
   * Shelf ids already resolved in this transaction, by lower-cased tag (or
   * null: no room for a new shelf). One import tags hundreds of rows with the
   * same few names; this saves a lookup per row and tag.
   */
  shelfCache?: Map<string, string | null>;
}

/**
 * Commits a single matched import row to Flyleaf's reading spine.
 *
 * Runs inside the provided Db or Transaction client. Never touches
 * import_rows: the caller records the row's outcome.
 *
 * A book the reader already has (any attempt, from the app or an earlier
 * import) is left exactly as it is, and the row is reported
 * `already_in_library` (audit 12, A-12-001 / D-12-1). Re-importing a file, or a
 * newer export that overlaps an older one, used to add a second attempt of
 * every book: double the finished books, every rating counted twice.
 */
export async function commitImportRow(
  db: Db,
  input: CommitImportRowInput,
  opts: CommitOptions = {},
): Promise<CommitImportRowResult> {
  const { userId, row, match } = input;

  // 1. Only matched rows with a resolved work ID can be committed
  if (match.state !== 'matched' || !match.workId) {
    return {
      committed: false,
      readId: null,
      reviewId: null,
      shelfIds: [],
      reason: match.failureReason ?? 'unmatched_row',
    };
  }

  const workId = match.workId;
  const editionId = match.editionId ?? null;

  // 2. IM-06: Rating normalisation (0 -> NULL)
  const rating = normalizeRatingForPersistence(row.rating);

  // 3. Dates were sanitised in normalizeRow; keep the order rule here too for
  // callers that build rows by hand.
  let startedAt = row.startedAt ?? null;
  const finishedAt = row.finishedAt ?? null;
  if (startedAt && finishedAt && finishedAt < startedAt) startedAt = null;

  // 4. Format override normalization
  const validFormats: NormalizedFormat[] = ['print', 'ebook', 'audiobook'];
  const formatOverride = row.format && validFormats.includes(row.format) ? row.format : null;

  // 5 + 6. IM-07: the read, source = 'import', only if the reader has no read
  // of this work. One statement: the app's per-(user, work) attempt lock
  // (SL-56), the existence check and the insert.
  const [read] = await db.execute<{ id: string }>(sql`
    WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${`reads:${userId}:${workId}`}, 0))
    )
    INSERT INTO reads (user_id, work_id, edition_id, status, attempt_no, started_at, finished_at,
                       rating, source, format_override, visibility)
    SELECT ${userId}::uuid, ${workId}::uuid, ${editionId}::uuid, ${row.status ?? 'finished'}, 1,
           ${startedAt}::date, ${finishedAt}::date, ${rating}::numeric, 'import', ${formatOverride}, 'public'
    FROM lock
    WHERE NOT EXISTS (SELECT 1 FROM reads WHERE user_id = ${userId}::uuid AND work_id = ${workId}::uuid)
    RETURNING id
  `);

  if (!read) {
    return { committed: false, readId: null, reviewId: null, shelfIds: [], reason: 'already_in_library' };
  }

  let reviewId: string | null = null;

  // 7. Optional Review persistence
  if (row.review && row.review.trim().length > 0) {
    const reviewBody = row.review.trim().slice(0, 10000);
    const [createdReview] = await db
      .insert(reviews)
      .values({
        readId: read.id,
        userId,
        workId,
        body: reviewBody,
        hasSpoilers: row.hasSpoilers === true,
        visibility: 'public',
        publishedAt: finishedAt ? new Date(finishedAt) : new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (createdReview) {
      reviewId = createdReview.id;
    }
  }

  // 8. Custom shelves from the source's tags
  const shelfIds: string[] = [];
  const cache = opts.shelfCache ?? new Map<string, string | null>();
  const uniqueNames = Array.from(new Set((row.shelves ?? []).map((s) => s.trim()).filter(Boolean)));
  for (const shelfName of uniqueNames) {
    const shelfId = await importShelf(db, userId, shelfName, cache);
    if (!shelfId) continue;
    shelfIds.push(shelfId);
    // At the end of the shelf, never past MAX_ITEMS_PER_SHELF, never twice.
    await db.execute(sql`
      INSERT INTO shelf_items (shelf_id, work_id, position)
      SELECT ${shelfId}::uuid, ${workId}::uuid, COALESCE(max(position), 0) + 1
      FROM shelf_items WHERE shelf_id = ${shelfId}::uuid
      HAVING count(*) < ${MAX_ITEMS_PER_SHELF}
      ON CONFLICT DO NOTHING
    `);
  }

  return {
    committed: true,
    readId: read.id,
    reviewId,
    shelfIds,
  };
}

/**
 * The reader's live shelf for an import tag: one with that name (any case) or
 * that slug, else a new one, as the shelves API would create it (same slug
 * rules, same 200-shelf limit under the same lock; A-12-011). A deleted shelf
 * is never filled: it keeps its slug for restore, so the new shelf gets the
 * next one. null when the reader is at the shelf limit: the book is imported,
 * only the tag is dropped.
 */
async function importShelf(
  db: Db,
  userId: string,
  name: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;

  const shelfName = name.slice(0, 60);
  const [found] = await db.execute<{ id: string }>(sql`
    SELECT id FROM shelves
    WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
      AND (lower(name) = lower(${shelfName}) OR slug = ${slugify(shelfName)})
    ORDER BY (lower(name) = lower(${shelfName})) DESC, created_at
    LIMIT 1
  `);
  if (found) {
    cache.set(key, found.id);
    return found.id;
  }

  await lockUserShelves(db, userId);
  const [count] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM shelves WHERE user_id = ${userId}::uuid AND deleted_at IS NULL`);
  if (Number(count?.n ?? 0) >= MAX_SHELVES_PER_USER) {
    cache.set(key, null);
    return null;
  }
  const slug = await generateUniqueSlug(db, userId, shelfName);
  const [created] = await db
    .insert(shelves)
    .values({ userId, name: shelfName, slug, privacy: 'public', itemCount: 0 })
    .returning({ id: shelves.id });
  cache.set(key, created!.id);
  return created!.id;
}

/**
 * Commits a batch of matched import rows within a single transaction.
 */
export async function commitImportBatch(
  db: Db,
  userId: string,
  importId: string,
  items: Array<{ row: NormalizedImportRow; match: MatchResult }>,
): Promise<CommitImportBatchResult> {
  return db.transaction(async (tx) => {
    let committed = 0;
    let skipped = 0;
    const readIds: string[] = [];

    for (const item of items) {
      const result = await commitImportRow(tx as unknown as Db, {
        userId,
        importId,
        row: item.row,
        match: item.match,
      });

      if (result.committed && result.readId) {
        committed++;
        readIds.push(result.readId);
        await tx
          .update(importRows)
          .set({ state: 'resolved' })
          .where(and(eq(importRows.importId, importId), eq(importRows.rowNo, item.row.rowNo)));
      } else {
        skipped++;
      }
    }

    return {
      totalProcessed: items.length,
      committed,
      skipped,
      readIds,
    };
  });
}
