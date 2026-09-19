// Canonical normalized schema and declarative mapping types for library imports (Architecture §3.7, PRD §6.8, IM-03).
//
// Rules that matter (docs/phases.md §Phase 3):
//   1. Identity and state ONLY, never metadata. Metadata comes from the catalog.
//   2. Ambiguous matches go to an unmatched list, never guessed.
//   3. My Rating = 0 imports as NULL.

import type { ImportSource } from './index.js';

export type NormalizedStatus = 'want' | 'reading' | 'finished' | 'dnf' | 'paused';
export type NormalizedFormat = 'print' | 'ebook' | 'audiobook';

/**
 * The canonical representation of a single book row extracted from any source.
 *
 * Sourced strictly for IDENTITY (title, author, isbn) and READER STATE (status,
 * rating, dates, review, shelves).
 */
export interface NormalizedImportRow {
  /** 1-indexed row number in the uploaded file */
  rowNo: number;
  /** Exact raw row dictionary preserved for import_rows.raw (PRD AC-9) */
  raw: Record<string, string>;

  // --- Identity Keys (for catalog matching in IM-05) ---
  title: string;
  author: string | null;
  additionalAuthors: string[];
  isbn: string | null;
  isbn10: string | null;
  isbn13: string | null;
  sourceId: string | null;

  // --- Reader State (for user reading history) ---
  status: NormalizedStatus;
  /** 0.5 to 5.0 in 0.5 steps; NULL if unrated or 0 (PRD §6.28, IM-06) */
  rating: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  review: string | null;
  shelves: string[];
  readCount: number | null;
  owned: boolean | null;
  format: NormalizedFormat | null;
  notes: string | null;

  // --- Validation Warnings ---
  errors: string[];
}

export type FieldTransformer<T> = (
  value: string | undefined,
  row: Record<string, string>,
) => T;

export interface FieldMapping<T = any> {
  /** Candidate column header names in order of preference (case-insensitive) */
  headers: string[];
  /** Transform function converting raw cell text to canonical target */
  transform: FieldTransformer<T>;
  /** Optional fallback value when column is missing or empty */
  fallback?: T;
  /** Whether the field is mandatory for the row to be valid (e.g. title) */
  required?: boolean;
}

export interface HeaderDetectionConfig {
  /** Columns that MUST be present to identify this source format */
  requiredHeaders: string[];
  /** Optional signature columns that increase detection confidence */
  signatureHeaders?: string[];
  /** Minimum score in [0, 1] required for positive match */
  minimumConfidence?: number;
}

export interface SourceColumnConfig {
  source: ImportSource;
  displayName: string;
  description: string;
  detection: HeaderDetectionConfig;
  fields: {
    title: FieldMapping<string>;
    author?: FieldMapping<string | null>;
    additionalAuthors?: FieldMapping<string[]>;
    isbn?: FieldMapping<string | null>;
    isbn10?: FieldMapping<string | null>;
    isbn13?: FieldMapping<string | null>;
    sourceId?: FieldMapping<string | null>;
    status: FieldMapping<NormalizedStatus>;
    rating?: FieldMapping<number | null>;
    startedAt?: FieldMapping<string | null>;
    finishedAt?: FieldMapping<string | null>;
    review?: FieldMapping<string | null>;
    shelves?: FieldMapping<string[]>;
    readCount?: FieldMapping<number | null>;
    owned?: FieldMapping<boolean | null>;
    format?: FieldMapping<NormalizedFormat | null>;
    notes?: FieldMapping<string | null>;
  };
}

export interface DetectionResult {
  source: ImportSource;
  confidence: number;
  matchedHeaders: string[];
  missingRequiredHeaders: string[];
}
