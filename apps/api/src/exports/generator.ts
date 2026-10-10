// Export Data Generator and Formatters (PRD §6.8, §24.2, §34.4, §1290, §3608, §5320, IM-10, Phases §217).
//
// Produces RFC 4180 compliant CSV and structured JSON exports of reader libraries.
// The CSV export format strictly round-trips through Flyleaf's import engine without data loss:
// - Ratings: Formatted as numeric strings (e.g. "4.5"); unrated/NULL books are empty strings (never 0).
// - Shelves: Exclusive shelf mapped to canonical status; custom shelves comma-separated.
// - RFC 4180: Double quotes escaped as `""`, fields containing commas or newlines quoted.

import { eq, and, desc, inArray, isNull } from 'drizzle-orm';
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
  progressEvents,
  follows,
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
  hearted: boolean;
  visibility: string;
  source: string;
  startedAt: string | null; // ISO string or null
  finishedAt: string | null; // ISO string or null
  abandonedAt: string | null;
  abandonedPage: number | null;
  dnfReason: string | null;
  dnfNote: string | null;
  attemptNo: number;
  format: string | null;
  /** Every progress update of this read, oldest first (PRD §26.4 "progress"). */
  progress: Array<{
    at: string;
    page: number | null;
    percent: string | null;
    audioSeconds: number | null;
    minutes: number | null;
    note: string | null;
  }>;
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

export interface ExportFollow {
  username: string;
  state: string;
  since: string;
}

export interface ExportData {
  version: string;
  exportedAt: string;
  user: ExportUserSummary;
  reads: ExportReadItem[];
  shelves: ExportShelfItem[];
  /** Accounts the reader follows or asked to follow (PRD §26.4 "follows"). */
  following: ExportFollow[];
}

/**
 * Escapes a cell value according to RFC 4180:
 * - If contains comma, quote, or newline, enclose in double quotes.
 * - Double quotes inside value are replaced with `""`.
 */
export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // A spreadsheet runs a cell that starts with = + - @ (or tab/CR before
  // one): `=HYPERLINK("http://evil","click")` in a review or a shelf name
  // would run when the reader opens their export (audit 12, A-12-015; OWASP
  // "CSV injection"). A leading ' makes it text. The importer removes exactly
  // this prefix again (unguardCell), so the export still round-trips.
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
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

  // 2. Every read, with its work, edition and live review. A deleted review
  // is not exported (the reader removed it).
  const readRows = await db
    .select({
      readId: reads.id,
      workId: reads.workId,
      editionId: reads.editionId,
      status: reads.status,
      rating: reads.rating,
      hearted: reads.hearted,
      visibility: reads.visibility,
      source: reads.source,
      startedAt: reads.startedAt,
      finishedAt: reads.finishedAt,
      abandonedAt: reads.abandonedAt,
      abandonedPage: reads.abandonedPage,
      dnfReason: reads.dnfReason,
      dnfNote: reads.dnfNote,
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
    .leftJoin(reviews, and(eq(reviews.readId, reads.id), isNull(reviews.deletedAt)))
    .where(eq(reads.userId, userId))
    .orderBy(desc(reads.createdAt));

  // 3. Progress updates of those reads, in one query.
  const progressRows = await db
    .select({
      readId: progressEvents.readId,
      at: progressEvents.at,
      page: progressEvents.page,
      percent: progressEvents.percent,
      audioSeconds: progressEvents.audioSeconds,
      minutes: progressEvents.minutes,
      note: progressEvents.note,
    })
    .from(progressEvents)
    .innerJoin(reads, eq(reads.id, progressEvents.readId))
    .where(eq(reads.userId, userId))
    .orderBy(progressEvents.at);
  const progressByRead = new Map<string, ExportReadItem['progress']>();
  for (const p of progressRows) {
    const list = progressByRead.get(p.readId) ?? [];
    list.push({
      at: toIsoString(p.at)!,
      page: p.page,
      percent: p.percent,
      audioSeconds: p.audioSeconds,
      minutes: p.minutes,
      note: p.note,
    });
    progressByRead.set(p.readId, list);
  }

  // 4. The reader's live shelves and all their items, in one query each
  // (audit 12, A-12-017: one query per shelf before). Deleted shelves are not
  // exported.
  const allShelves = await db
    .select()
    .from(shelves)
    .where(and(eq(shelves.userId, userId), isNull(shelves.deletedAt)))
    .orderBy(desc(shelves.createdAt));
  const itemRows = await db
    .select({
      shelfId: shelfItems.shelfId,
      workId: shelfItems.workId,
      position: shelfItems.position,
      note: shelfItems.note,
      title: works.title,
    })
    .from(shelfItems)
    .innerJoin(shelves, eq(shelves.id, shelfItems.shelfId))
    .innerJoin(works, eq(works.id, shelfItems.workId))
    .where(and(eq(shelves.userId, userId), isNull(shelves.deletedAt)))
    .orderBy(shelfItems.shelfId, shelfItems.position);

  // 5. Primary authors of every work in reads and on shelves.
  const workIds = Array.from(new Set([...readRows.map((r) => r.workId), ...itemRows.map((i) => i.workId)]));
  const authorMap = new Map<string, string>();
  if (workIds.length > 0) {
    const authorRows = await db
      .select({ workId: workAuthors.workId, authorName: authors.name })
      .from(workAuthors)
      .innerJoin(authors, eq(authors.id, workAuthors.authorId))
      .where(inArray(workAuthors.workId, workIds))
      .orderBy(workAuthors.position);
    for (const row of authorRows) {
      if (!authorMap.has(row.workId)) authorMap.set(row.workId, row.authorName);
    }
  }

  const shelfName = new Map(allShelves.map((s) => [s.id, s.name]));
  const shelfItemMap = new Map<string, string[]>();
  const itemsByShelf = new Map<string, ExportShelfItem['items']>();
  for (const i of itemRows) {
    const names = shelfItemMap.get(i.workId) ?? [];
    names.push(shelfName.get(i.shelfId)!);
    shelfItemMap.set(i.workId, names);
    const items = itemsByShelf.get(i.shelfId) ?? [];
    items.push({ workId: i.workId, title: i.title, author: authorMap.get(i.workId) || null, position: i.position, note: i.note });
    itemsByShelf.set(i.shelfId, items);
  }

  const exportReads: ExportReadItem[] = readRows.map((r) => ({
    readId: r.readId,
    workId: r.workId,
    title: r.workTitle,
    author: authorMap.get(r.workId) || null,
    isbn10: r.editionIsbn10,
    isbn13: r.editionIsbn13,
    status: r.status,
    rating: r.rating,
    hearted: r.hearted,
    visibility: r.visibility,
    source: r.source,
    startedAt: toIsoString(r.startedAt),
    finishedAt: toIsoString(r.finishedAt),
    abandonedAt: toIsoString(r.abandonedAt),
    abandonedPage: r.abandonedPage,
    dnfReason: r.dnfReason,
    dnfNote: r.dnfNote,
    attemptNo: r.attemptNo,
    format: r.formatOverride || (r.editionFormat !== 'unknown' ? r.editionFormat : null),
    progress: progressByRead.get(r.readId) ?? [],
    review: r.reviewBody
      ? {
          body: r.reviewBody,
          hasSpoilers: r.reviewHasSpoilers ?? false,
          visibility: r.reviewVisibility || 'public',
          publishedAt: toIsoString(r.reviewPublishedAt) || toIsoString(r.createdAt)!,
        }
      : null,
    shelves: shelfItemMap.get(r.workId) ?? [],
    createdAt: toIsoString(r.createdAt)!,
  }));

  const exportShelves: ExportShelfItem[] = allShelves.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    privacy: s.privacy,
    isRanked: s.isRanked,
    itemCount: s.itemCount,
    createdAt: toIsoString(s.createdAt)!,
    items: itemsByShelf.get(s.id) ?? [],
  }));

  // 6. Follows: the accounts this reader follows (their usernames only; who
  // follows the reader is the other accounts' data).
  const followRows = await db
    .select({ username: profiles.username, state: follows.state, since: follows.createdAt })
    .from(follows)
    .innerJoin(profiles, eq(profiles.userId, follows.followeeId))
    .where(eq(follows.followerId, userId))
    .orderBy(follows.createdAt);

  return {
    version: '1.1',
    exportedAt: new Date().toISOString(),
    user: userSummary,
    reads: exportReads,
    shelves: exportShelves,
    following: followRows.map((f) => ({ username: f.username, state: f.state, since: toIsoString(f.since)! })),
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
    // Not Goodreads columns' order, but their names where Goodreads has one
    // (Spoiler), so the file still reads as Goodreads format; the importer
    // reads both back (audit 12: round trip of start dates and spoilers).
    'Date Started',
    'Spoiler',
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
      escapeCsvField(formatDateForCsv(r.createdAt)),
      escapeCsvField(r.shelves.join(', ')),
      escapeCsvField(r.review ? r.review.body : ''),
      escapeCsvField(r.format || ''),
      escapeCsvField(formatDateForCsv(r.startedAt)),
      escapeCsvField(r.review?.hasSpoilers ? 'true' : ''),
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
