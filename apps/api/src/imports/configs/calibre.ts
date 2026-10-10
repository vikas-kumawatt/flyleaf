// Calibre declarative column mapping configuration (PRD §6.8, AC-9, IM-04).
//
// Rules that matter:
//   - Identity and reader state only, never book metadata.
//   - Calibre separates authors with '&' or ','.
//   - Identifiers column can contain "isbn:9780441478125,google:xyz".
//   - Comments column holds HTML notes/descriptions.
//   - Reading status inferred from whole tags; defaults to want (D-12-2).

import type { SourceColumnConfig } from '../types.js';
import {
  cleanText,
  cleanIsbn,
  normalizeRating,
  formatAuthorName,
  parseShelves,
  mapFormat,
} from '../transformers.js';

const CALIBRE_DNF_TAGS = new Set(['dnf', 'did-not-finish', 'did not finish', 'abandoned']);
const CALIBRE_READING_TAGS = new Set(['reading', 'currently-reading', 'currently reading']);
const CALIBRE_READ_TAGS = new Set(['read', 'finished']);

/** D-12-2: want unless a whole tag says DNF, reading or read (in that order). */
export function calibreStatus(val: string | undefined): 'want' | 'reading' | 'finished' | 'dnf' {
  const tags = (val ?? '').split(/[,;|]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tags.some((t) => CALIBRE_DNF_TAGS.has(t))) return 'dnf';
  if (tags.some((t) => CALIBRE_READING_TAGS.has(t))) return 'reading';
  if (tags.some((t) => CALIBRE_READ_TAGS.has(t))) return 'finished';
  return 'want';
}

export const calibreConfig: SourceColumnConfig = {
  source: 'calibre',
  displayName: 'Calibre',
  description: 'Calibre ebook library catalog CSV',
  detection: {
    requiredHeaders: ['title', 'authors'],
    signatureHeaders: [
      'isbn',
      'rating',
      'tags',
      'pubdate',
      'series',
      'publisher',
      'identifiers',
      'formats',
      'comments',
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
      headers: ['authors', 'Authors', 'author'],
      transform: (val) => {
        const cleaned = cleanText(val);
        if (!cleaned) return null;
        // Calibre separates multiple authors with '&' or ','
        if (cleaned.includes('&')) {
          const first = cleaned.split('&')[0]?.trim();
          return first ? formatAuthorName(first) : cleaned;
        }
        if (cleaned.includes(',')) {
          // If "Herbert, Frank", formatAuthorName flips to "Frank Herbert"
          return formatAuthorName(cleaned);
        }
        return cleaned;
      },
    },
    additionalAuthors: {
      headers: ['authors', 'Authors'],
      transform: (val) => {
        const cleaned = cleanText(val);
        if (!cleaned) return [];
        if (cleaned.includes('&')) {
          return cleaned
            .split('&')
            .slice(1)
            .map((s) => formatAuthorName(s.trim()))
            .filter((s): s is string => s !== null && s.length > 0);
        }
        return [];
      },
      fallback: [],
    },
    isbn: {
      headers: ['isbn', 'ISBN', 'identifiers'],
      transform: (val, row) => {
        const direct = cleanIsbn(val);
        if (direct) return direct;
        const identifiers = row['identifiers'] ?? row['Identifiers'];
        return cleanIsbn(identifiers);
      },
    },
    isbn10: {
      headers: ['isbn', 'ISBN', 'identifiers'],
      transform: (val, row) => {
        const cleaned = cleanIsbn(val) ?? cleanIsbn(row['identifiers'] ?? row['Identifiers']);
        return cleaned && cleaned.length === 10 ? cleaned : null;
      },
    },
    isbn13: {
      headers: ['isbn', 'ISBN', 'identifiers'],
      transform: (val, row) => {
        const cleaned = cleanIsbn(val) ?? cleanIsbn(row['identifiers'] ?? row['Identifiers']);
        return cleaned && cleaned.length === 13 ? cleaned : null;
      },
    },
    sourceId: {
      headers: ['id', 'calibre_id', 'ID'],
      transform: (val) => cleanText(val),
    },
    status: {
      headers: ['tags', 'Tags', 'status'],
      // D-12-2 (owner, option b): a Calibre library is a collection, not a
      // reading log, so a book is want-to-read unless one of its tags says
      // read, reading or DNF. Whole tags, not substrings: `reading-list` or
      // `dread` say nothing about the reader.
      transform: (val) => calibreStatus(val),
      required: true,
    },
    rating: {
      headers: ['rating', 'Rating'],
      transform: (val) => normalizeRating(val, '5'),
      fallback: null,
    },
    // No reading dates: Calibre has none. `timestamp` is when the file was
    // added and `pubdate` is the book's publication date (audit 12, A-12-009).
    // No review: `comments` is the book's description (publisher blurb), not
    // the reader's words, and must never be published under their name.

    shelves: {
      headers: ['tags', 'Tags', 'series', 'Series'],
      transform: (val, row) => {
        const tags = parseShelves(row['tags'] ?? row['Tags']);
        const series = cleanText(row['series'] ?? row['Series']);
        if (series) {
          tags.push(series.toLowerCase());
        }
        return tags;
      },
      fallback: [],
    },
    readCount: {
      headers: ['read_count'],
      transform: () => null,
      fallback: null,
    },
    owned: {
      headers: ['id'],
      // Books in a user's Calibre catalog are owned
      transform: () => true,
      fallback: true,
    },
    format: {
      headers: ['formats', 'Formats'],
      transform: (val) => mapFormat(val) ?? 'ebook',
      fallback: 'ebook',
    },
    notes: {
      headers: ['notes'],
      transform: () => null,
      fallback: null,
    },
  },
};
