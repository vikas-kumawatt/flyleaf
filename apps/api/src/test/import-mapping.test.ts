// IM-03: Declarative column mapping and normalization engine tests (PRD §6.8, AC-9, IM-03, IM-06).

import { describe, expect, it } from 'vitest';
import { parseCsv } from '../imports/parser.js';
import {
  cleanText,
  cleanIsbn,
  normalizeRating,
  mapStatus,
  parseDate,
  parseShelves,
  mapFormat,
} from '../imports/transformers.js';
import {
  scoreHeaderMatch,
  detectSource,
  validateHeadersForSource,
} from '../imports/detector.js';
import {
  goodreadsConfig,
  getSourceConfig,
  getAllSourceConfigs,
  normalizeRow,
  normalizeImport,
} from '../imports/configs/index.js';

describe('IM-03: RFC 4180 CSV Parser (parseCsv)', () => {
  it('parses standard RFC 4180 CSV with headers and rows', () => {
    const csv = 'Title,Author,Year\nDune,Frank Herbert,1965\nHyperion,Dan Simmons,1989';
    const result = parseCsv(csv);

    expect(result.headers).toEqual(['Title', 'Author', 'Year']);
    expect(result.totalRows).toBe(2);
    expect(result.rows[0]?.rowNo).toBe(1);
    expect(result.rows[0]?.data).toEqual({
      Title: 'Dune',
      Author: 'Frank Herbert',
      Year: '1965',
    });
    expect(result.rows[1]?.rowNo).toBe(2);
    expect(result.rows[1]?.data).toEqual({
      Title: 'Hyperion',
      Author: 'Dan Simmons',
      Year: '1989',
    });
  });

  it('handles quoted fields containing embedded commas', () => {
    const csv =
      'Book Id,Title,Author\n123,"The Fellowship of the Ring, Part 1",J.R.R. Tolkien';
    const result = parseCsv(csv);

    expect(result.rows[0]?.data['Title']).toBe('The Fellowship of the Ring, Part 1');
    expect(result.rows[0]?.data['Author']).toBe('J.R.R. Tolkien');
  });

  it('handles multi-line quoted fields (e.g. user reviews with paragraphs)', () => {
    const csv =
      'Title,Review\nDune,"A masterpiece of science fiction.\n\nDeep ecology and politics.\n\nHighly recommended."';
    const result = parseCsv(csv);

    expect(result.totalRows).toBe(1);
    expect(result.rows[0]?.data['Review']).toBe(
      'A masterpiece of science fiction.\n\nDeep ecology and politics.\n\nHighly recommended.',
    );
  });

  it('handles escaped quotes ("" -> ") inside quoted fields', () => {
    const csv = 'Title,Note\n1984,"He wrote: ""War is peace"" in his diary."';
    const result = parseCsv(csv);

    expect(result.rows[0]?.data['Note']).toBe('He wrote: "War is peace" in his diary.');
  });

  it('strips UTF-8 Byte Order Mark (BOM)', () => {
    const bomCsv = '\uFEFFTitle,Author\nSolaris,Stanislaw Lem';
    const result = parseCsv(bomCsv);

    expect(result.headers).toEqual(['Title', 'Author']);
    expect(result.rows[0]?.data['Title']).toBe('Solaris');
  });

  it('handles Windows CRLF and trailing empty lines', () => {
    const csv = 'Title,Author\r\nUbik,Philip K. Dick\r\n\r\n\r\n';
    const result = parseCsv(csv);

    expect(result.totalRows).toBe(1);
    expect(result.rows[0]?.data['Title']).toBe('Ubik');
  });
});

describe('IM-03: Declarative Field Transformers', () => {
  describe('cleanText', () => {
    it('trims whitespace and unquotes', () => {
      expect(cleanText('   "Left Hand of Darkness"   ')).toBe('Left Hand of Darkness');
      expect(cleanText(" 'A Wizard of Earthsea' ")).toBe('A Wizard of Earthsea');
    });

    it('decodes HTML entities and strips residual HTML tags', () => {
      expect(cleanText('War &amp; Peace')).toBe('War & Peace');
      expect(cleanText('<p>Amazing book &quot;must read&quot;!</p>')).toBe(
        'Amazing book "must read"!',
      );
      expect(cleanText('')).toBeNull();
      expect(cleanText(undefined)).toBeNull();
    });
  });

  describe('cleanIsbn', () => {
    it('cleans Goodreads formula syntax: ="0441478123"', () => {
      expect(cleanIsbn('="0441478123"')).toBe('0441478123');
      expect(cleanIsbn('="9780441478125"')).toBe('9780441478125');
    });

    it('cleans hyphens, spaces, and punctuation from ISBNs', () => {
      expect(cleanIsbn('978-0-345-39180-3')).toBe('9780345391803');
      expect(cleanIsbn(' 0-8044-2957-X ')).toBe('080442957X');
    });

    it('rejects invalid ISBN strings', () => {
      expect(cleanIsbn('12345')).toBeNull();
      expect(cleanIsbn('invalid-isbn-text')).toBeNull();
      expect(cleanIsbn('=""')).toBeNull();
      expect(cleanIsbn('')).toBeNull();
      expect(cleanIsbn(undefined)).toBeNull();
    });
  });

  describe('normalizeRating (IM-06 & PRD AC-9)', () => {
    it('CRITICAL RULE: My Rating = 0 converts to NULL (not 0 and not dropped)', () => {
      expect(normalizeRating('0')).toBeNull();
      expect(normalizeRating('0.0')).toBeNull();
      expect(normalizeRating(' 0 ')).toBeNull();
      expect(normalizeRating('')).toBeNull();
      expect(normalizeRating(undefined)).toBeNull();
    });

    it('converts 1–5 star ratings accurately', () => {
      expect(normalizeRating('5')).toBe(5.0);
      expect(normalizeRating('4')).toBe(4.0);
      expect(normalizeRating('3.5')).toBe(3.5);
      expect(normalizeRating('1')).toBe(1.0);
      expect(normalizeRating('0.5')).toBe(0.5);
    });

    it('rounds StoryGraph quarter-stars to nearest half-star (PRD §6.28)', () => {
      expect(normalizeRating('3.75', 'storygraph')).toBe(4.0);
      expect(normalizeRating('3.25', 'storygraph')).toBe(3.5);
      expect(normalizeRating('4.25', 'storygraph')).toBe(4.5);
      expect(normalizeRating('4.75', 'storygraph')).toBe(5.0);
    });

    it('normalizes 10-point scales (LibraryThing / Calibre)', () => {
      expect(normalizeRating('10', '10')).toBe(5.0);
      expect(normalizeRating('9', '10')).toBe(4.5);
      expect(normalizeRating('8', '10')).toBe(4.0);
      expect(normalizeRating('5', '10')).toBe(2.5);
      expect(normalizeRating('0', '10')).toBeNull();
    });
  });

  describe('mapStatus', () => {
    const goodreadsStatusMap = {
      read: 'finished' as const,
      'currently-reading': 'reading' as const,
      'to-read': 'want' as const,
      'did-not-finish': 'dnf' as const,
      abandoned: 'dnf' as const,
      paused: 'paused' as const,
    };

    it('maps exclusive shelf names correctly', () => {
      expect(mapStatus('read', goodreadsStatusMap)).toBe('finished');
      expect(mapStatus('currently-reading', goodreadsStatusMap)).toBe('reading');
      expect(mapStatus('to-read', goodreadsStatusMap)).toBe('want');
      expect(mapStatus('did-not-finish', goodreadsStatusMap)).toBe('dnf');
    });

    it('falls back to specified default when unknown', () => {
      expect(mapStatus('unknown-shelf', goodreadsStatusMap, 'want')).toBe('want');
      expect(mapStatus(undefined, goodreadsStatusMap, 'finished')).toBe('finished');
    });
  });

  describe('parseDate', () => {
    it('parses YYYY/MM/DD and YYYY-MM-DD', () => {
      expect(parseDate('2026/01/15')).toBe('2026-01-15');
      expect(parseDate('2025-11-04')).toBe('2025-11-04');
    });

    it('parses US M/D/YYYY formats', () => {
      expect(parseDate('1/15/2026')).toBe('2026-01-15');
      expect(parseDate('12/25/2024')).toBe('2024-12-25');
    });

    it('parses human textual dates', () => {
      expect(parseDate('15 Jan 2026')).toBe('2026-01-15');
      expect(parseDate('November 4, 2025')).toBe('2025-11-04');
    });

    it('returns null for empty or invalid dates', () => {
      expect(parseDate('')).toBeNull();
      expect(parseDate('not-a-date')).toBeNull();
      expect(parseDate(undefined)).toBeNull();
    });
  });

  describe('parseShelves', () => {
    it('extracts custom shelves while filtering out default system shelves', () => {
      const result = parseShelves('favorites, sci-fi, read, to-read, owned-books');
      expect(result).toEqual(['favorites', 'sci-fi', 'owned-books']);
    });
  });

  describe('mapFormat', () => {
    it('maps binding keywords to canonical formats', () => {
      expect(mapFormat('Paperback')).toBe('print');
      expect(mapFormat('Hardcover')).toBe('print');
      expect(mapFormat('Kindle Edition')).toBe('ebook');
      expect(mapFormat('EPUB ebook')).toBe('ebook');
      expect(mapFormat('Audible Audio')).toBe('audiobook');
      expect(mapFormat('Audio CD')).toBe('audiobook');
      expect(mapFormat('Unknown format')).toBeNull();
    });
  });
});

describe('IM-03: Header Signature Detector', () => {
  it('detects Goodreads export headers with high confidence (>= 0.7)', () => {
    const goodreadsHeaders = [
      'Book Id',
      'Title',
      'Author',
      'Author l-f',
      'Additional Authors',
      'ISBN',
      'ISBN13',
      'My Rating',
      'Average Rating',
      'Publisher',
      'Binding',
      'Number of Pages',
      'Year Published',
      'Date Read',
      'Date Added',
      'Bookshelves',
      'Exclusive Shelf',
      'My Review',
    ];

    const result = scoreHeaderMatch(goodreadsHeaders, goodreadsConfig);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.missingRequiredHeaders).toEqual([]);

    const detected = detectSource(goodreadsHeaders, getAllSourceConfigs());
    expect(detected).not.toBeNull();
    expect(detected?.source).toBe('goodreads');
  });

  it('flags missing required headers', () => {
    const badHeaders = ['Author', 'My Rating', 'Date Read'];
    const result = scoreHeaderMatch(badHeaders, goodreadsConfig);

    expect(result.missingRequiredHeaders).toContain('Book Id');
    expect(result.missingRequiredHeaders).toContain('Title');
    expect(result.missingRequiredHeaders).toContain('Exclusive Shelf');
    expect(result.confidence).toBeLessThan(0.5);

    const validation = validateHeadersForSource('goodreads', badHeaders, goodreadsConfig);
    expect(validation.valid).toBe(false);
    expect(validation.missing).toContain('Title');
  });
});

describe('IM-03: Goodreads Reference Normalization Engine', () => {
  const sampleGoodreadsCsv = [
    'Book Id,Title,Author,Additional Authors,ISBN,ISBN13,My Rating,Exclusive Shelf,Date Read,Date Added,Bookshelves,Binding,My Review',
    '101,"The Left Hand of Darkness",Ursula K. Le Guin,,="0441478123",="9780441478125",5,read,2026/01/15,2026/01/01,"favorites, classics",Paperback,"Essential feminist science fiction masterpiece."',
    '102,"Hyperion",Dan Simmons,,="0553283685",="9780553283686",0,to-read,,2026/01/10,sci-fi,Kindle Edition,',
    '103,"Good Omens",Neil Gaiman,Terry Pratchett,="0060853980",="9780060853983",4,currently-reading,,2026/02/01,comedy,Paperback,"Very funny."',
    '104,"The Dispossessed",Ursula K. Le Guin,,,="9780060512750",0,did-not-finish,,2026/02/10,anarchism,Hardcover,',
  ].join('\n');

  it('normalizes Goodreads library rows into canonical NormalizedImportRow', () => {
    const config = getSourceConfig('goodreads');
    const result = normalizeImport(config, sampleGoodreadsCsv);

    expect(result.total).toBe(4);
    expect(result.valid).toBe(4);
    expect(result.malformed).toBe(0);

    // Row 1: Rated finish with review
    const r1 = result.rows[0]!;
    expect(r1.rowNo).toBe(1);
    expect(r1.title).toBe('The Left Hand of Darkness');
    expect(r1.author).toBe('Ursula K. Le Guin');
    expect(r1.isbn).toBe('9780441478125');
    expect(r1.isbn10).toBe('0441478123');
    expect(r1.isbn13).toBe('9780441478125');
    expect(r1.sourceId).toBe('101');
    expect(r1.status).toBe('finished');
    expect(r1.rating).toBe(5.0);
    expect(r1.finishedAt).toBe('2026-01-15');
    expect(r1.startedAt).toBe('2026-01-01');
    expect(r1.shelves).toEqual(['favorites', 'classics']);
    expect(r1.format).toBe('print');
    expect(r1.review).toBe('Essential feminist science fiction masterpiece.');
    // Untouched raw dictionary preserved for import_rows.raw
    expect(r1.raw['Book Id']).toBe('101');
    expect(r1.raw['Title']).toBe('The Left Hand of Darkness');

    // Row 2: My Rating = 0 MUST BE NULL (IM-06, PRD AC-9)
    const r2 = result.rows[1]!;
    expect(r2.title).toBe('Hyperion');
    expect(r2.status).toBe('want');
    expect(r2.rating).toBeNull();
    expect(r2.format).toBe('ebook');
    expect(r2.finishedAt).toBeNull();

    // Row 3: Co-authors and currently-reading
    const r3 = result.rows[2]!;
    expect(r3.title).toBe('Good Omens');
    expect(r3.author).toBe('Neil Gaiman');
    expect(r3.additionalAuthors).toEqual(['Terry Pratchett']);
    expect(r3.status).toBe('reading');
    expect(r3.rating).toBe(4.0);

    // Row 4: DNF status mapping
    const r4 = result.rows[3]!;
    expect(r4.title).toBe('The Dispossessed');
    expect(r4.status).toBe('dnf');
    expect(r4.rating).toBeNull();
  });

  it('preserves valid rows while reporting malformed rows missing title (PRD §6.8)', () => {
    const csvWithBadRow = [
      'Book Id,Title,Author,My Rating,Exclusive Shelf',
      '201,"Valid Book",Author One,4,read',
      '202,"",Author Two,3,read', // missing title!
      '203,"Another Valid Book",Author Three,5,read',
    ].join('\n');

    const config = getSourceConfig('goodreads');
    const result = normalizeImport(config, csvWithBadRow);

    expect(result.total).toBe(3);
    expect(result.valid).toBe(2);
    expect(result.malformed).toBe(1);

    expect(result.rows[0]?.title).toBe('Valid Book');
    expect(result.rows[0]?.errors).toHaveLength(0);

    expect(result.rows[1]?.title).toBe('');
    expect(result.rows[1]?.errors).toContain('Missing required book title');

    expect(result.rows[2]?.title).toBe('Another Valid Book');
    expect(result.rows[2]?.errors).toHaveLength(0);
  });
});
