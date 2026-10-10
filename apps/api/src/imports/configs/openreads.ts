// OpenReads declarative column mapping configuration (PRD §6.8, AC-9, IM-04).
//
// Rules that matter:
//   - Identity and reader state only, never book metadata.
//   - OpenReads status values (finished, reading, not_started, unfinished) map cleanly.
//   - Format values (physical, ebook, audiobook) map to canonical format enum.
//   - 0 or unrated ratings convert to NULL (PRD AC-9, IM-06).

import type { SourceColumnConfig } from '../types.js';
import {
  cleanText,
  cleanIsbn,
  normalizeRating,
  mapStatus,
  parseDate,
  parseShelves,
  mapFormat,
} from '../transformers.js';

export const openreadsConfig: SourceColumnConfig = {
  source: 'openreads',
  displayName: 'OpenReads',
  description: 'OpenReads privacy-oriented tracker backup CSV',
  detection: {
    requiredHeaders: ['title', 'author', 'status'],
    signatureHeaders: [
      'readings',
      'my_review',
      'book_format',
      'olid',
      'favourite',
      'deleted',
      'pages',
      'notes',
      'tags',
      'rating',
    ],
    minimumConfidence: 0.7,
  },
  fields: {
    title: {
      headers: ['title', 'Title'],
      transform: (val) => cleanText(val) ?? '',
      required: true,
    },
    author: {
      headers: ['author', 'Author', 'authors', 'Authors'],
      transform: (val) => cleanText(val),
    },
    additionalAuthors: {
      headers: ['additional_authors', 'contributors', 'additionalAuthors'],
      transform: (val) => {
        const cleaned = cleanText(val);
        if (!cleaned) return [];
        return cleaned
          .split(/[,;&]/)
          .map((s) => cleanText(s))
          .filter((s): s is string => s !== null && s.length > 0);
      },
      fallback: [],
    },
    isbn: {
      headers: ['isbn', 'ISBN', 'isbn13', 'isbn10'],
      transform: (val) => cleanIsbn(val),
    },
    isbn10: {
      headers: ['isbn10', 'ISBN10', 'isbn', 'ISBN'],
      transform: (val) => {
        const cleaned = cleanIsbn(val);
        return cleaned && cleaned.length === 10 ? cleaned : null;
      },
    },
    isbn13: {
      headers: ['isbn13', 'ISBN13', 'isbn', 'ISBN'],
      transform: (val) => {
        const cleaned = cleanIsbn(val);
        return cleaned && cleaned.length === 13 ? cleaned : null;
      },
    },
    // An Open Library edition key (OL…M), which the matcher understands.
    sourceId: {
      headers: ['olid', 'id', 'openreads_id', 'ID'],
      transform: (val) => cleanText(val),
    },
    status: {
      headers: ['status', 'Status'],
      transform: (val) =>
        mapStatus(
          val,
          {
            finished: 'finished',
            read: 'finished',
            reading: 'reading',
            in_progress: 'reading',
            'in-progress': 'reading',
            not_started: 'want',
            'not-started': 'want',
            // OpenReads writes finished / in_progress / planned / abandoned / unknown.
            planned: 'want',
            unknown: 'want',
            to_read: 'want',
            'to-read': 'want',
            unfinished: 'dnf',
            abandoned: 'dnf',
            dnf: 'dnf',
          },
          'finished',
        ),
      required: true,
    },
    rating: {
      headers: ['rating', 'Rating'],
      transform: (val) => normalizeRating(val, '5'),
      fallback: null,
    },
    // `readings` is `start|finish|ms;start|finish|ms` (ISO dates); the latest
    // reading is the one a read records.
    startedAt: {
      headers: ['started_date', 'start_date', 'startedAt'],
      transform: (val, row) => parseDate(val) ?? lastReading(row)[0],
      fallback: null,
    },
    finishedAt: {
      headers: ['finished_date', 'finish_date', 'finishedAt'],
      transform: (val, row) => parseDate(val) ?? lastReading(row)[1],
      fallback: null,
    },
    review: {
      headers: ['my_review', 'review', 'Review'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
    // OpenReads joins tags with '|||||'.
    shelves: {
      headers: ['tags', 'Tags', 'genres', 'shelves'],
      transform: (val) => parseShelves(val, /\|{5}|[,;]/),
      fallback: [],
    },
    readCount: {
      headers: ['read_count', 'readCount'],
      transform: (val) => {
        if (!val) return null;
        const n = Number.parseInt(val.trim(), 10);
        return Number.isNaN(n) || n < 1 ? null : n;
      },
      fallback: null,
    },
    owned: {
      headers: ['owned'],
      transform: () => null,
      fallback: null,
    },
    format: {
      headers: ['book_format', 'format', 'Format'],
      transform: (val) => mapFormat(val),
      fallback: null,
    },
    notes: {
      headers: ['notes', 'Notes', 'comment'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
    // A book in OpenReads' trash is exported with deleted=true.
    excluded: {
      headers: ['deleted'],
      transform: (val) => (val ?? '').trim().toLowerCase() === 'true',
      fallback: false,
    },
  },
};

/** [start, finish] of the last entry of OpenReads' `readings` column. */
function lastReading(row: Record<string, string>): [string | null, string | null] {
  const readings = (row['readings'] ?? '').split(';').map((r) => r.trim()).filter(Boolean);
  const last = readings[readings.length - 1];
  if (!last) return [null, null];
  const [start, finish] = last.split('|');
  return [parseDate(start), parseDate(finish)];
}
