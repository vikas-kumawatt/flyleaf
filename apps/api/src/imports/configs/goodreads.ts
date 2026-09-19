// Goodreads declarative column mapping configuration (PRD §6.8, AC-9, IM-03).
//
// Rules that matter:
//   - File is used for IDENTITY and STATE only, never metadata.
//   - My Rating = 0 converts to NULL (not 0 and not dropped).
//   - ISBN formula syntax (="0441478123") is cleaned.
//   - Multiline reviews in My Review are preserved.

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

export const goodreadsConfig: SourceColumnConfig = {
  source: 'goodreads',
  displayName: 'Goodreads',
  description: 'Goodreads library export (goodreads_library_export.csv)',
  detection: {
    requiredHeaders: ['Book Id', 'Title', 'Author', 'My Rating', 'Exclusive Shelf'],
    signatureHeaders: [
      'Date Read',
      'Date Added',
      'Bookshelves',
      'My Review',
      'ISBN',
      'ISBN13',
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
      headers: ['Author', 'Author l-f', 'author'],
      transform: (val) => cleanText(val),
    },
    additionalAuthors: {
      headers: ['Additional Authors', 'additional_authors'],
      transform: (val) =>
        val
          ? val
              .split(',')
              .map((s) => cleanText(s))
              .filter((s): s is string => s !== null && s.length > 0)
          : [],
      fallback: [],
    },
    isbn: {
      headers: ['ISBN13', 'ISBN', 'isbn13', 'isbn'],
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
      headers: ['ISBN13', 'isbn13'],
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
      headers: ['Exclusive Shelf', 'exclusive_shelf'],
      transform: (val) =>
        mapStatus(
          val,
          {
            read: 'finished',
            'currently-reading': 'reading',
            'to-read': 'want',
            'did-not-finish': 'dnf',
            dnf: 'dnf',
            abandoned: 'dnf',
            paused: 'paused',
            'on-hold': 'paused',
          },
          'finished',
        ),
      required: true,
    },
    rating: {
      headers: ['My Rating', 'my_rating', 'rating'],
      // IM-06 / PRD AC-9: My Rating = 0 imports as NULL
      transform: (val) => normalizeRating(val, '5'),
      fallback: null,
    },
    startedAt: {
      headers: ['Date Added', 'date_added'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    finishedAt: {
      headers: ['Date Read', 'date_read'],
      transform: (val) => parseDate(val),
      fallback: null,
    },
    review: {
      headers: ['My Review', 'my_review', 'Review'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
    shelves: {
      headers: ['Bookshelves', 'bookshelves'],
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
      headers: ['Owned Copies', 'owned_copies'],
      transform: (val) => {
        if (!val) return null;
        const n = Number.parseInt(val.trim(), 10);
        return !Number.isNaN(n) && n > 0;
      },
      fallback: null,
    },
    format: {
      headers: ['Binding', 'binding', 'Format'],
      transform: (val) => mapFormat(val),
      fallback: null,
    },
    notes: {
      headers: ['Private Notes', 'private_notes', 'Notes'],
      transform: (val) => cleanText(val),
      fallback: null,
    },
  },
};
