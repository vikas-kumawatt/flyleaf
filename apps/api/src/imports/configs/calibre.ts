// Calibre declarative column mapping configuration (PRD §6.8, AC-9, IM-04).
//
// Rules that matter:
//   - Identity and reader state only, never book metadata.
//   - Calibre separates authors with '&' or ','.
//   - Identifiers column can contain "isbn:9780441478125,google:xyz".
//   - Comments column holds HTML notes/descriptions.
//   - Reading status inferred from tags; defaults to finished.

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
      transform: (val) => {
        const tags = (val ?? '').toLowerCase();
        if (tags.includes('currently-reading') || tags.includes('reading')) {
          return 'reading';
        }
        if (tags.includes('to-read') || tags.includes('unread') || tags.includes('wishlist')) {
          return 'want';
        }
        if (tags.includes('dnf') || tags.includes('did-not-finish') || tags.includes('abandoned')) {
          return 'dnf';
        }
        return 'finished';
      },
      required: true,
    },
    rating: {
      headers: ['rating', 'Rating'],
      transform: (val) => normalizeRating(val, '5'),
      fallback: null,
    },
    startedAt: {
      headers: ['date', 'timestamp'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    finishedAt: {
      headers: ['pubdate', 'timestamp', 'date'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    review: {
      headers: ['comments', 'Comments', 'review'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
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
