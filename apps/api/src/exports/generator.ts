// Export Data Generator and Formatters (PRD §6.8, §24.2, §34.4, §1290, §3608, §5320, IM-10, Phases §217).
//
// Produces RFC 4180 compliant CSV and structured JSON exports of reader libraries.
// The CSV export format strictly round-trips through Flyleaf's import engine without data loss:
// - Ratings: Formatted as numeric strings (e.g. "4.5"); unrated/NULL books are empty strings (never 0).
// - Shelves: Exclusive shelf mapped to canonical status; custom shelves comma-separated.
// - RFC 4180: Double quotes escaped as `""`, fields containing commas or newlines quoted.

import { eq, and, desc, inArray } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import {
  users,
  profiles,
  reads,
  works,
  editions,
  reviews,
  shelves,
  shelfItems,
  workAuthors,
  authors,
} from '../db/schema.js';

export interface ExportUserSummary {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  createdAt: string;
}

export interface ExportReadItem {
  readId: string;
  workId: string;
  title: string;
  author: string | null;
  isbn10: string | null;
  isbn13: string | null;
  status: string;
  rating: string | null; // e.g. "4.5" or null
  startedAt: string | null; // ISO string or null
  finishedAt: string | null; // ISO string or null
  attemptNo: number;
  format: string | null;
  review: {
    body: string;
    hasSpoilers: boolean;
    visibility: string;
    publishedAt: string;
  } | null;
  shelves: string[];
  createdAt: string;
}

export interface ExportShelfItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  privacy: string;
  isRanked: boolean;
  itemCount: number;
  createdAt: string;
  items: Array<{
    workId: string;
    title: string;
    author: string | null;
    position: number;
    note: string | null;
  }>;
}

export interface ExportData {
  version: string;
  exportedAt: string;
  user: ExportUserSummary;
  reads: ExportReadItem[];
  shelves: ExportShelfItem[];
}

/**
 * Escapes a cell value according to RFC 4180:
 * - If contains comma, quote, or newline, enclose in double quotes.
 * - Double quotes inside value are replaced with `""`.
 */
export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Maps Flyleaf read status to standard external exclusive shelf.
 */
export function statusToExclusiveShelf(status: string): string {
  switch (status) {
    case 'finished':
      return 'read';
    case 'reading':
      return 'currently-reading';
    case 'want':
      return 'to-read';
    case 'dnf':
      return 'did-not-finish';
    case 'paused':
      return 'on-hold';
    default:
      return 'read';
  }
}

/**
 * Formats a Date or ISO string as YYYY/MM/DD for CSV portability.
 */
export function formatDateForCsv(dateVal: string | Date | null | undefined): string {
  if (!dateVal) return '';
  try {
    const d = typeof dateVal === 'string' ? new Date(dateVal) : dateVal;
    if (isNaN(d.getTime())) return '';
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  } catch {
    return '';
  }
}

/**
 * Safely converts a Date or string to an ISO string.
 */
export function toIsoString(dateVal: string | Date | null | undefined): string | null {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    return isNaN(dateVal.getTime()) ? null : dateVal.toISOString();
  }
  const d = new Date(dateVal);
  return isNaN(d.getTime()) ? String(dateVal) : d.toISOString();
}

/**
 * Gathers complete library data for the user.
 */
export async function generateExportData(db: Db, userId: string): Promise<ExportData> {
  // 1. Fetch user & profile
  const [userRow] = await db
    .select({
      id: users.id,
      email: users.email,
      createdAt: users.createdAt,
      username: profiles.username,
      displayName: profiles.displayName,
      bio: profiles.bio,
    })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) {
    throw new Error(`User not found: ${userId}`);
  }

  const userSummary: ExportUserSummary = {
    id: userRow.id,
    email: userRow.email,
    username: userRow.username || 'reader',
    displayName: userRow.displayName,
    bio: userRow.bio,
    createdAt: toIsoString(userRow.createdAt)!,
  };

  // 2. Fetch all user reads with works, editions, and reviews
  const readRows = await db
    .select({
      readId: reads.id,
      workId: reads.workId,
      editionId: reads.editionId,
      status: reads.status,
      rating: reads.rating,
      startedAt: reads.startedAt,
      finishedAt: reads.finishedAt,
      attemptNo: reads.attemptNo,
      formatOverride: reads.formatOverride,
      createdAt: reads.createdAt,
      workTitle: works.title,
      editionIsbn10: editions.isbn10,
      editionIsbn13: editions.isbn13,
      editionFormat: editions.format,
      reviewBody: reviews.body,
      reviewHasSpoilers: reviews.hasSpoilers,
      reviewVisibility: reviews.visibility,
      reviewPublishedAt: reviews.publishedAt,
    })
    .from(reads)
    .innerJoin(works, eq(works.id, reads.workId))
    .leftJoin(editions, eq(editions.id, reads.editionId))
    .leftJoin(reviews, eq(reviews.readId, reads.id))
    .where(eq(reads.userId, userId))
    .orderBy(desc(reads.createdAt));

  // 3. Fetch primary authors for these works
  const workIds = Array.from(new Set(readRows.map((r) => r.workId)));
  const authorMap = new Map<string, string>();

  if (workIds.length > 0) {
    const authorRows = await db
      .select({
        workId: workAuthors.workId,
        authorName: authors.name,
      })
      .from(workAuthors)
      .innerJoin(authors, eq(authors.id, workAuthors.authorId))
      .where(inArray(workAuthors.workId, workIds))
      .orderBy(workAuthors.position);

    for (const row of authorRows) {
      if (!authorMap.has(row.workId)) {
        authorMap.set(row.workId, row.authorName);
      }
    }
  }

  // 4. Fetch custom shelf memberships for these works
  const shelfItemMap = new Map<string, string[]>();
  const userShelves = await db
    .select({
      shelfId: shelves.id,
      shelfName: shelves.name,
      workId: shelfItems.workId,
    })
    .from(shelves)
    .innerJoin(shelfItems, eq(shelfItems.shelfId, shelves.id))
    .where(eq(shelves.userId, userId));

  for (const item of userShelves) {
    const list = shelfItemMap.get(item.workId) || [];
    list.push(item.shelfName);
    shelfItemMap.set(item.workId, list);
  }

  // Build reads export list
  const exportReads: ExportReadItem[] = readRows.map((r) => {
    const author = authorMap.get(r.workId) || null;
    const customShelves = shelfItemMap.get(r.workId) || [];

    return {
      readId: r.readId,
      workId: r.workId,
      title: r.workTitle,
      author,
      isbn10: r.editionIsbn10,
      isbn13: r.editionIsbn13,
      status: r.status,
      rating: r.rating,
      startedAt: toIsoString(r.startedAt),
      finishedAt: toIsoString(r.finishedAt),
      attemptNo: r.attemptNo,
      format: r.formatOverride || (r.editionFormat !== 'unknown' ? r.editionFormat : null),
      review: r.reviewBody
        ? {
            body: r.reviewBody,
            hasSpoilers: r.reviewHasSpoilers ?? false,
            visibility: r.reviewVisibility || 'public',
            publishedAt: toIsoString(r.reviewPublishedAt) || toIsoString(r.createdAt)!,
          }
        : null,
      shelves: customShelves,
      createdAt: toIsoString(r.createdAt)!,
    };
  });

  // 5. Fetch all user shelves with items
  const allShelves = await db
    .select()
    .from(shelves)
    .where(eq(shelves.userId, userId))
    .orderBy(desc(shelves.createdAt));

  const exportShelves: ExportShelfItem[] = [];
  for (const s of allShelves) {
    const items = await db
      .select({
        workId: shelfItems.workId,
        position: shelfItems.position,
        note: shelfItems.note,
        title: works.title,
      })
      .from(shelfItems)
      .innerJoin(works, eq(works.id, shelfItems.workId))
      .where(eq(shelfItems.shelfId, s.id))
      .orderBy(shelfItems.position);

    exportShelves.push({
      id: s.id,
      name: s.name,
      slug: s.slug,
      description: s.description,
      privacy: s.privacy,
      isRanked: s.isRanked,
      itemCount: s.itemCount,
      createdAt: toIsoString(s.createdAt)!,
      items: items.map((i) => ({
        workId: i.workId,
        title: i.title,
        author: authorMap.get(i.workId) || null,
        position: i.position,
        note: i.note,
      })),
    });
  }

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    user: userSummary,
    reads: exportReads,
    shelves: exportShelves,
  };
}

/**
 * Formats data into standard RFC 4180 CSV with Flyleaf/Goodreads compatible headers.
 */
export function formatAsCsv(data: ExportData): string {
  const headers = [
    'Title',
    'Author',
    'ISBN',
    'ISBN13',
    'My Rating',
    'Exclusive Shelf',
    'Date Read',
    'Date Added',
    'Bookshelves',
    'My Review',
    'Format',
  ];

  const lines: string[] = [headers.join(',')];

  for (const r of data.reads) {
    const row = [
      escapeCsvField(r.title),
      escapeCsvField(r.author || ''),
      escapeCsvField(r.isbn10 || ''),
      escapeCsvField(r.isbn13 || ''),
      escapeCsvField(r.rating || ''), // empty if unrated/null, never 0
      escapeCsvField(statusToExclusiveShelf(r.status)),
      escapeCsvField(formatDateForCsv(r.finishedAt)),
      escapeCsvField(formatDateForCsv(r.startedAt || r.createdAt)),
      escapeCsvField(r.shelves.join(', ')),
      escapeCsvField(r.review ? r.review.body : ''),
      escapeCsvField(r.format || ''),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n');
}

/**
 * Formats data into pretty-printed JSON.
 */
export function formatAsJson(data: ExportData): string {
  return JSON.stringify(data, null, 2);
}
