// LibraryThing declarative column mapping configuration (PRD §6.8, AC-9, IM-04).
//
// Rules that matter:
//   - Identity and reader state only, never book metadata.
//   - Inverts "Last, First" primary author format (e.g. "Herbert, Frank" -> "Frank Herbert").
//   - ISBN field can contain brackets or multiple ISBNs (e.g. "[0441478123]").
//   - Reading status inferred from Collections and Date Read.
//   - 0 or unrated ratings convert to NULL (PRD AC-9, IM-06).

import type { SourceColumnConfig } from '../types.js';
import {
  cleanText,
  cleanIsbn,
  normalizeRating,
  formatAuthorName,
  parseDate,
  parseShelves,
  mapFormat,
} from '../transformers.js';

export const librarythingConfig: SourceColumnConfig = {
  source: 'librarything',
  displayName: 'LibraryThing',
  description: 'LibraryThing catalog export CSV',
  detection: {
    requiredHeaders: ['Title', 'Primary Author'],
    signatureHeaders: [
      'Book Id',
      'Secondary Author',
      'Publication',
      'Rating',
      'Tags',
      'Collections',
      'ISBN',
      'Entry Date',
      'Date Read',
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
      headers: ['Primary Author', 'Author', 'author'],
      // Inverts "Herbert, Frank" -> "Frank Herbert"
      transform: (val) => formatAuthorName(val),
    },
    additionalAuthors: {
      headers: ['Secondary Author', 'Other Authors', 'secondary_author'],
      transform: (val) => {
        const cleaned = cleanText(val);
        if (!cleaned) return [];
        return cleaned
          .split(/[,;&]/)
          .map((s) => formatAuthorName(s))
          .filter((s): s is string => s !== null && s.length > 0);
      },
      fallback: [],
    },
    isbn: {
      headers: ['ISBN', 'isbn'],
      transform: (val) => cleanIsbn(val),
    },
    isbn10: {
      headers: ['ISBN', 'isbn'],
      transform: (val) => {
        const cleaned = cleanIsbn(val);
        return cleaned && cleaned.length === 10 ? cleaned : null;
      },
    },
    isbn13: {
      headers: ['ISBN', 'isbn'],
      transform: (val) => {
        const cleaned = cleanIsbn(val);
        return cleaned && cleaned.length === 13 ? cleaned : null;
      },
    },
    sourceId: {
      headers: ['Book Id', 'book_id', 'id'],
      transform: (val) => cleanText(val),
    },
    status: {
      headers: ['Collections', 'collections', 'Status', 'status'],
      transform: (val, row) => {
        const coll = (val ?? '').toLowerCase();
        if (coll.includes('currently reading') || coll.includes('reading')) {
          return 'reading';
        }
        if (coll.includes('to read') || coll.includes('wishlist')) {
          return 'want';
        }
        if (coll.includes('did not finish') || coll.includes('dnf') || coll.includes('abandoned')) {
          return 'dnf';
        }
        if (row['Date Read'] || row['date_read']) {
          return 'finished';
        }
        if (coll.includes('your library') || coll.includes('read but unowned')) {
          return 'finished';
        }
        return 'finished';
      },
      required: true,
    },
    rating: {
      headers: ['Rating', 'rating'],
      transform: (val) => normalizeRating(val, '5'),
      fallback: null,
    },
    startedAt: {
      headers: ['Entry Date', 'entry_date', 'Date Added'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    finishedAt: {
      headers: ['Date Read', 'date_read'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    review: {
      headers: ['Review', 'review'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
    shelves: {
      headers: ['Tags', 'tags', 'Collections', 'collections'],
      transform: (val, row) => {
        const tags = parseShelves(row['Tags'] ?? row['tags']);
        const colls = parseShelves(row['Collections'] ?? row['collections']);
        const combined = Array.from(new Set([...tags, ...colls]));
        return combined.filter(
          (s) => !['your library', 'read but unowned', 'currently reading', 'to read', 'wishlist'].includes(s),
        );
      },
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
      headers: ['Collections', 'collections'],
      transform: (val) => {
        if (!val) return null;
        const coll = val.toLowerCase();
        if (coll.includes('your library')) return true;
        if (coll.includes('read but unowned') || coll.includes('wishlist')) return false;
        return null;
      },
      fallback: null,
    },
    format: {
      headers: ['Publication', 'publication', 'Format'],
      transform: (val) => mapFormat(val),
      fallback: null,
    },
    notes: {
      headers: ['Comments', 'Private Comments', 'Summary', 'comments'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
  },
};
