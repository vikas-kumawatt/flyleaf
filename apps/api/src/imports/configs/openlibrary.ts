// OpenLibrary declarative column mapping configuration (PRD §6.8, AC-9, IM-04).
//
// Rules that matter:
//   - Identity and reader state only, never book metadata.
//   - Open Library work keys (e.g. "/works/OL82563W") clean to canonical OL keys.
//   - Open Library statuses (already-read, currently-reading, want-to-read) map canonically.
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

export const openlibraryConfig: SourceColumnConfig = {
  source: 'openlibrary',
  displayName: 'OpenLibrary',
  description: 'OpenLibrary reading log export CSV',
  detection: {
    requiredHeaders: ['title', 'authors'],
    signatureHeaders: [
      'work_key',
      'edition_key',
      'read_status',
      'edition',
      'works',
      'ol_id',
      'Logged Date',
    ],
    minimumConfidence: 0.7,
  },
  fields: {
    title: {
      headers: ['title', 'Title', 'Work Title'],
      transform: (val) => cleanText(val) ?? '',
      required: true,
    },
    author: {
      headers: ['authors', 'Authors', 'author', 'Author'],
      transform: (val) => {
        const cleaned = cleanText(val);
        if (!cleaned) return null;
        if (cleaned.includes(',')) {
          const first = cleaned.split(',')[0]?.trim();
          return first && first.length > 0 ? first : cleaned;
        }
        return cleaned;
      },
    },
    additionalAuthors: {
      headers: ['additional_authors', 'Additional Authors', 'authors', 'Authors'],
      transform: (val, row) => {
        const add = cleanText(val);
        if (add && val !== row['authors'] && val !== row['Authors']) {
          return add
            .split(',')
            .map((s) => cleanText(s))
            .filter((s): s is string => s !== null && s.length > 0);
        }
        const authors = cleanText(row['authors'] ?? row['Authors']);
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
      headers: ['isbn', 'ISBN', 'isbn13', 'ISBN13', 'isbn10', 'ISBN10'],
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
    sourceId: {
      headers: ['work_key', 'Work', 'edition_key', 'Edition', 'ol_id'],
      transform: (val) => {
        const cleaned = cleanText(val);
        if (!cleaned) return null;
        // Strip "/works/" or "/books/" prefix if present
        return cleaned.replace(/^\/?(works|books)\//, '').trim();
      },
    },
    status: {
      headers: ['read_status', 'Read Status', 'shelf', 'Shelf', 'status'],
      transform: (val, row) => {
        if (val && val.trim().length > 0) {
          return mapStatus(
            val,
            {
              'already-read': 'finished',
              read: 'finished',
              finished: 'finished',
              'currently-reading': 'reading',
              reading: 'reading',
              'want-to-read': 'want',
              'to-read': 'want',
              want: 'want',
              'did-not-finish': 'dnf',
              dnf: 'dnf',
              abandoned: 'dnf',
            },
            'finished',
          );
        }
        if (row['date_read'] || row['Date Read'] || row['Logged Date']) {
          return 'finished';
        }
        return 'want';
      },
      required: true,
    },
    rating: {
      headers: ['rating', 'Rating', 'my_rating', 'My Rating'],
      transform: (val) => normalizeRating(val, '5'),
      fallback: null,
    },
    startedAt: {
      headers: ['date_added', 'Date Added'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    finishedAt: {
      headers: ['date_read', 'Date Read', 'logged_date', 'Logged Date'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    review: {
      headers: ['review', 'Review', 'notes', 'Notes'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
    shelves: {
      headers: ['shelves', 'Shelves', 'tags', 'Tags'],
      transform: (val) => parseShelves(val, /[,;]/),
      fallback: [],
    },
    readCount: {
      headers: ['read_count'],
      transform: () => null,
      fallback: null,
    },
    owned: {
      headers: ['owned'],
      transform: () => null,
      fallback: null,
    },
    format: {
      headers: ['edition', 'Edition', 'format', 'Format'],
      transform: (val) => mapFormat(val),
      fallback: null,
    },
    notes: {
      headers: ['notes', 'Notes'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
  },
};
