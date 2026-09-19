// Import Committer Service (PRD §6.8, §1833, §34.4, §4409, §4410, AC-9, Architecture §3.7, §8, §9, IM-06, IM-07).
//
// Non-negotiable architectural rules:
//   1. IM-06: `My Rating = 0` (or empty/unrated) MUST import as `rating = NULL`.
//      Never 0 (which violates the database constraint `reads_rating_ck`), and
//      never dropped (which drops unrated books from users' libraries).
//   2. IM-07: Imported reads MUST have `source = 'import'`, and are strictly
//      excluded from the social activity feed. Importing 800+ books must NEVER
//      spam followers or create 800 feed items.

import { sql, eq, and, desc } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import {
  reads,
  reviews,
  shelves,
  shelfItems,
  importRows,
} from '../db/schema.js';
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

/**
 * Generates a URL-safe slug for a custom shelf name.
 */
function slugifyShelfName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'shelf';
}

/**
 * Commits a single matched import row to Flyleaf's reading spine.
 *
 * Runs atomically inside the provided Db or Transaction client.
 */
export async function commitImportRow(
  db: Db,
  input: CommitImportRowInput,
): Promise<CommitImportRowResult> {
  const { userId, importId, row, match } = input;

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

  // 3. Date handling (ensure finishedAt >= startedAt if both exist)
  let startedAt = row.startedAt ?? null;
  let finishedAt = row.finishedAt ?? null;
  if (startedAt && finishedAt && finishedAt < startedAt) {
    // Retain finished date as primary, clear start date to prevent constraint violation
    startedAt = null;
  }

  // 4. Format override normalization
  const validFormats: NormalizedFormat[] = ['print', 'ebook', 'audiobook'];
  const formatOverride = row.format && validFormats.includes(row.format) ? row.format : null;

  // 5. Attempt number: find existing reads for (userId, workId)
  const existingReads = await db
    .select({ attemptNo: reads.attemptNo })
    .from(reads)
    .where(and(eq(reads.userId, userId), eq(reads.workId, workId)))
    .orderBy(desc(reads.attemptNo));

  const attemptNo = (existingReads[0]?.attemptNo ?? 0) + 1;

  // 6. IM-07: Create read with source = 'import'
  const [read] = await db
    .insert(reads)
    .values({
      userId,
      workId,
      editionId,
      status: row.status ?? 'finished',
      attemptNo,
      startedAt,
      finishedAt,
      rating, // strictly NULL for unrated / 0 (IM-06)
      source: 'import', // strictly 'import' (IM-07)
      formatOverride,
      visibility: 'public',
    })
    .returning();

  if (!read) {
    throw new Error('Failed to create read');
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
        visibility: 'public',
        publishedAt: finishedAt ? new Date(finishedAt) : new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (createdReview) {
      reviewId = createdReview.id;
    }
  }

  // 8. Custom Shelves persistence
  const shelfIds: string[] = [];
  if (row.shelves && row.shelves.length > 0) {
    // Unique shelf names
    const uniqueNames = Array.from(new Set(row.shelves.map((s) => s.trim()).filter(Boolean)));

    for (const shelfName of uniqueNames) {
      const slug = slugifyShelfName(shelfName);

      // Find or create shelf
      let [shelf] = await db
        .select()
        .from(shelves)
        .where(and(eq(shelves.userId, userId), eq(shelves.slug, slug)))
        .limit(1);

      if (!shelf) {
        const [newShelf] = await db
          .insert(shelves)
          .values({
            userId,
            name: shelfName.slice(0, 60),
            slug,
            privacy: 'public',
            itemCount: 0,
          })
          .returning();
        shelf = newShelf;
      }

      if (shelf) {
        shelfIds.push(shelf.id);

        // Check if work is already on shelf
        const [existingItem] = await db
          .select({ workId: shelfItems.workId })
          .from(shelfItems)
          .where(and(eq(shelfItems.shelfId, shelf.id), eq(shelfItems.workId, workId)))
          .limit(1);

        if (!existingItem) {
          await db.insert(shelfItems).values({
            shelfId: shelf.id,
            workId,
            position: shelf.itemCount + 1,
          });

          await db
            .update(shelves)
            .set({ itemCount: sql`${shelves.itemCount} + 1` })
            .where(eq(shelves.id, shelf.id));
        }
      }
    }
  }

  // 9. Mark import_rows as resolved
  await db
    .update(importRows)
    .set({ state: 'resolved' })
    .where(and(eq(importRows.importId, importId), eq(importRows.rowNo, row.rowNo)));

  return {
    committed: true,
    readId: read.id,
    reviewId,
    shelfIds,
  };
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
