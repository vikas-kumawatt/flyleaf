// StoryGraph declarative column mapping configuration (PRD §2.3, §6.8, §6.28, AC-9, IM-04).
//
// Rules that matter:
//   - Identity and reader state only, never book metadata.
//   - Quarter-star ratings round to nearest half-star (PRD §6.28, §51.2).
//   - 0 or unrated ratings convert to NULL (PRD AC-9, IM-06).
//   - Dates Read can be range "YYYY/MM/DD-YYYY/MM/DD" or "YYYY-MM-DD to YYYY-MM-DD".
//   - Raw row dictionary is preserved for import_rows.raw.

import type { SourceColumnConfig } from '../types.js';
import {
  cleanText,
  cleanIsbn,
  normalizeRating,
  mapStatus,
  parseDate,
  parseDateRange,
  parseShelves,
  mapFormat,
} from '../transformers.js';

export const storygraphConfig: SourceColumnConfig = {
  source: 'storygraph',
  displayName: 'StoryGraph',
  description: 'The StoryGraph library export CSV',
  detection: {
    requiredHeaders: ['Title', 'Authors'],
    signatureHeaders: [
      'Star Rating',
      'Review',
      'Tags',
      'Date Added',
      'Last Date Read',
      'Dates Read',
      'Format',
      'Read Status',
      'Owned?',
      'ISBN/UID',
    ],
    minimumConfidence: 0.7,
  },
  fields: {
    title: {
      headers: ['Title', 'title'],
      transform: (val) => cleanText(val) ?? '',
      required: true,
    },
    author: {
      headers: ['Authors', 'Author', 'author'],
      transform: (val) => {
        const cleaned = cleanText(val);
        if (!cleaned) return null;
        // If comma-separated multiple authors, take primary author before comma
        if (cleaned.includes(',')) {
          const first = cleaned.split(',')[0]?.trim();
          return first && first.length > 0 ? first : cleaned;
        }
        return cleaned;
      },
    },
    additionalAuthors: {
      headers: ['Contributors', 'contributors', 'Authors'],
      transform: (val, row) => {
        const contributors = cleanText(val);
        if (contributors) {
          return contributors
            .split(',')
            .map((s) => cleanText(s))
            .filter((s): s is string => s !== null && s.length > 0);
        }
        // If authors column has multiple authors
        const authors = cleanText(row['Authors'] ?? row['authors']);
        if (authors && authors.includes(',')) {
          return authors
            .split(',')
            .slice(1)
            .map((s) => cleanText(s))
            .filter((s): s is string => s !== null && s.length > 0);
        }
        return [];
      },
      fallback: [],
    },
    isbn: {
      headers: ['ISBN/UID', 'ISBN', 'isbn'],
      transform: (val) => cleanIsbn(val),
    },
    isbn10: {
      headers: ['ISBN/UID', 'ISBN', 'isbn'],
      transform: (val) => {
        const cleaned = cleanIsbn(val);
        return cleaned && cleaned.length === 10 ? cleaned : null;
      },
    },
    isbn13: {
      headers: ['ISBN/UID', 'ISBN', 'isbn'],
      transform: (val) => {
        const cleaned = cleanIsbn(val);
        return cleaned && cleaned.length === 13 ? cleaned : null;
      },
    },
    sourceId: {
      headers: ['ISBN/UID', 'id'],
      transform: (val) => cleanText(val),
    },
    status: {
      headers: ['Read Status', 'read_status', 'Status', 'status'],
      transform: (val, row) => {
        // If Read Status is explicitly provided
        if (val && val.trim().length > 0) {
          return mapStatus(
            val,
            {
              read: 'finished',
              finished: 'finished',
              'currently-reading': 'reading',
              reading: 'reading',
              'to-read': 'want',
              want: 'want',
              'did-not-finish': 'dnf',
              dnf: 'dnf',
              abandoned: 'dnf',
              paused: 'paused',
              'on-hold': 'paused',
            },
            'finished',
          );
        }
        // Fallback: If Last Date Read exists -> finished, else want
        if (row['Last Date Read'] || row['Dates Read']) {
          return 'finished';
        }
        return 'want';
      },
      required: true,
    },
    rating: {
      headers: ['Star Rating', 'star_rating', 'Rating', 'rating'],
      // StoryGraph quarter-stars round to nearest half-star; 0 converts to null
      transform: (val) => normalizeRating(val, 'storygraph'),
      fallback: null,
    },
    startedAt: {
      headers: ['Dates Read', 'Date Added', 'date_added'],
      transform: (val, row) => {
        const datesRead = row['Dates Read'] ?? row['dates_read'];
        if (datesRead) {
          const [start] = parseDateRange(datesRead);
          if (start) return start;
        }
        return parseDate(val ?? row['Date Added']);
      },
      fallback: null,
    },
    finishedAt: {
      headers: ['Last Date Read', 'Dates Read', 'Date Read'],
      transform: (val, row) => {
        const direct = parseDate(val);
        if (direct) return direct;
        const datesRead = row['Dates Read'] ?? row['dates_read'];
        if (datesRead) {
          const [, end] = parseDateRange(datesRead);
          if (end) return end;
        }
        return null;
      },
      fallback: null,
    },
    review: {
      headers: ['Review', 'review'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
    shelves: {
      headers: ['Tags', 'tags'],
      transform: (val) => parseShelves(val, /[,;]/),
      fallback: [],
    },
    readCount: {
      headers: ['Read Count', 'read_count'],
      transform: (val) => {
        if (!val) return null;
        const n = Number.parseInt(val.trim(), 10);
        return Number.isNaN(n) || n < 1 ? null : n;
      },
      fallback: null,
    },
    owned: {
      headers: ['Owned?', 'owned'],
      transform: (val) => {
        if (!val) return null;
        const s = val.trim().toLowerCase();
        if (s === 'yes' || s === 'true' || s === '1' || s === 'y') return true;
        if (s === 'no' || s === 'false' || s === '0' || s === 'n') return false;
        return null;
      },
      fallback: null,
    },
    format: {
      headers: ['Format', 'format'],
      transform: (val) => mapFormat(val),
      fallback: null,
    },
    notes: {
      headers: ['Notes', 'notes', 'Private Notes'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
  },
};
