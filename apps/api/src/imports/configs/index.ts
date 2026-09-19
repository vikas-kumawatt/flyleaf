// Declarative configuration registry and normalization engine (PRD §6.8, Architecture §3.7, IM-03).

import type { ImportSource } from '../index.js';
import type { NormalizedImportRow, SourceColumnConfig } from '../types.js';
import { goodreadsConfig } from './goodreads.js';
import { storygraphConfig } from './storygraph.js';
import { librarythingConfig } from './librarything.js';
import { calibreConfig } from './calibre.js';
import { openlibraryConfig } from './openlibrary.js';
import { openreadsConfig } from './openreads.js';
import { parseCsv } from '../parser.js';

export * from './goodreads.js';
export * from './storygraph.js';
export * from './librarything.js';
export * from './calibre.js';
export * from './openlibrary.js';
export * from './openreads.js';

/**
 * Registry of all source mapping configurations across all 6 supported platforms (IM-04).
 */
export const SOURCE_CONFIGS: Record<ImportSource, SourceColumnConfig> = {
  goodreads: goodreadsConfig,
  storygraph: storygraphConfig,
  librarything: librarythingConfig,
  calibre: calibreConfig,
  openlibrary: openlibraryConfig,
  openreads: openreadsConfig,
};

export function getSourceConfig(source: ImportSource): SourceColumnConfig {
  const config = SOURCE_CONFIGS[source];
  if (!config) {
    throw new Error(`No column mapping config registered for source '${source}'`);
  }
  return config;
}

export function getAllSourceConfigs(): SourceColumnConfig[] {
  return Object.values(SOURCE_CONFIGS);
}

/**
 * Normalizes case and spacing of header keys for resilient lookup.
 */
function findValueByAliases(
  row: Record<string, string>,
  candidateHeaders: string[],
): string | undefined {
  // 1. Exact match first
  for (const h of candidateHeaders) {
    if (row[h] !== undefined && row[h].trim().length > 0) {
      return row[h];
    }
  }

  // 2. Case-insensitive / normalized lookup
  const rowKeys = Object.keys(row);
  for (const h of candidateHeaders) {
    const target = h.trim().toLowerCase().replace(/[\s_-]+/g, '');
    const foundKey = rowKeys.find(
      (k) => k.trim().toLowerCase().replace(/[\s_-]+/g, '') === target,
    );
    if (foundKey && row[foundKey] !== undefined && row[foundKey].trim().length > 0) {
      return row[foundKey];
    }
  }

  return undefined;
}

/**
 * Transforms a raw row dictionary into a canonical NormalizedImportRow using a SourceColumnConfig.
 */
export function normalizeRow(
  config: SourceColumnConfig,
  raw: Record<string, string>,
  rowNo: number,
): NormalizedImportRow {
  const errors: string[] = [];
  const fields = config.fields;

  // Title (Mandatory identity field)
  const rawTitle = findValueByAliases(raw, fields.title.headers);
  const title = fields.title.transform(rawTitle, raw);
  if (!title || title.trim().length === 0) {
    errors.push('Missing required book title');
  }

  // Author
  const rawAuthor = fields.author ? findValueByAliases(raw, fields.author.headers) : undefined;
  const author = fields.author
    ? fields.author.transform(rawAuthor, raw)
    : null;

  // Additional Authors
  const rawAddAuthors = fields.additionalAuthors
    ? findValueByAliases(raw, fields.additionalAuthors.headers)
    : undefined;
  const additionalAuthors = fields.additionalAuthors
    ? fields.additionalAuthors.transform(rawAddAuthors, raw)
    : [];

  // ISBNs
  const rawIsbn = fields.isbn ? findValueByAliases(raw, fields.isbn.headers) : undefined;
  const isbn = fields.isbn ? fields.isbn.transform(rawIsbn, raw) : null;

  const rawIsbn10 = fields.isbn10 ? findValueByAliases(raw, fields.isbn10.headers) : undefined;
  const isbn10 = fields.isbn10 ? fields.isbn10.transform(rawIsbn10, raw) : null;

  const rawIsbn13 = fields.isbn13 ? findValueByAliases(raw, fields.isbn13.headers) : undefined;
  const isbn13 = fields.isbn13 ? fields.isbn13.transform(rawIsbn13, raw) : null;

  // Source ID
  const rawSourceId = fields.sourceId
    ? findValueByAliases(raw, fields.sourceId.headers)
    : undefined;
  const sourceId = fields.sourceId ? fields.sourceId.transform(rawSourceId, raw) : null;

  // Reading Status
  const rawStatus = findValueByAliases(raw, fields.status.headers);
  const status = fields.status.transform(rawStatus, raw);

  // Rating (0 must be null per PRD AC-9)
  const rawRating = fields.rating ? findValueByAliases(raw, fields.rating.headers) : undefined;
  const rating = fields.rating ? fields.rating.transform(rawRating, raw) : null;

  // Dates
  const rawStarted = fields.startedAt
    ? findValueByAliases(raw, fields.startedAt.headers)
    : undefined;
  const startedAt = fields.startedAt ? fields.startedAt.transform(rawStarted, raw) : null;

  const rawFinished = fields.finishedAt
    ? findValueByAliases(raw, fields.finishedAt.headers)
    : undefined;
  const finishedAt = fields.finishedAt ? fields.finishedAt.transform(rawFinished, raw) : null;

  // Review
  const rawReview = fields.review ? findValueByAliases(raw, fields.review.headers) : undefined;
  const review = fields.review ? fields.review.transform(rawReview, raw) : null;

  // Shelves / Tags
  const rawShelves = fields.shelves ? findValueByAliases(raw, fields.shelves.headers) : undefined;
  const shelves = fields.shelves ? fields.shelves.transform(rawShelves, raw) : [];

  // Read count
  const rawReadCount = fields.readCount
    ? findValueByAliases(raw, fields.readCount.headers)
    : undefined;
  const readCount = fields.readCount ? fields.readCount.transform(rawReadCount, raw) : null;

  // Owned
  const rawOwned = fields.owned ? findValueByAliases(raw, fields.owned.headers) : undefined;
  const owned = fields.owned ? fields.owned.transform(rawOwned, raw) : null;

  // Format
  const rawFormat = fields.format ? findValueByAliases(raw, fields.format.headers) : undefined;
  const format = fields.format ? fields.format.transform(rawFormat, raw) : null;

  // Notes
  const rawNotes = fields.notes ? findValueByAliases(raw, fields.notes.headers) : undefined;
  const notes = fields.notes ? fields.notes.transform(rawNotes, raw) : null;

  return {
    rowNo,
    raw,
    title,
    author,
    additionalAuthors,
    isbn,
    isbn10,
    isbn13,
    sourceId,
    status,
    rating,
    startedAt,
    finishedAt,
    review,
    shelves,
    readCount,
    owned,
    format,
    notes,
    errors,
  };
}

export interface NormalizeImportResult {
  headers: string[];
  rows: NormalizedImportRow[];
  total: number;
  valid: number;
  malformed: number;
}

/**
 * Parses CSV and applies declarative column config to transform all rows.
 * Per PRD §6.8: Malformed rows (e.g. missing title) are flagged and reported,
 * while valid rows import smoothly.
 */
export function normalizeImport(
  config: SourceColumnConfig,
  csvInput: string | Buffer,
): NormalizeImportResult {
  const parsed = parseCsv(csvInput);
  const rows: NormalizedImportRow[] = [];
  let malformed = 0;

  for (const r of parsed.rows) {
    const normalized = normalizeRow(config, r.data, r.rowNo);
    if (normalized.errors.length > 0) {
      malformed++;
    }
    rows.push(normalized);
  }

  return {
    headers: parsed.headers,
    rows,
    total: parsed.totalRows,
    valid: parsed.totalRows - malformed,
    malformed,
  };
}
