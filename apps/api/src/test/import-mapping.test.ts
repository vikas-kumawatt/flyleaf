// IM-03: Declarative column mapping and normalization engine tests (PRD §6.8, AC-9, IM-03, IM-06).

import { describe, expect, it } from 'vitest';
import { parseCsv } from '../imports/parser.js';
import {
  cleanText,
  cleanIsbn,
  normalizeRating,
  mapStatus,
  parseDate,
  parseDateRange,
  parseShelves,
  mapFormat,
  formatAuthorName,
} from '../imports/transformers.js';
import {
  scoreHeaderMatch,
  detectSource,
  validateHeadersForSource,
} from '../imports/detector.js';
import {
  goodreadsConfig,
  storygraphConfig,
  librarythingConfig,
  calibreConfig,
  openlibraryConfig,
  openreadsConfig,
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

    it('handles bracketed and comma-separated ISBNs (LibraryThing / Calibre)', () => {
      expect(cleanIsbn('[0441478123]')).toBe('0441478123');
      expect(cleanIsbn('0441478123, 9780441478125')).toBe('0441478123');
      expect(cleanIsbn('isbn:9780441478125')).toBe('9780441478125');
      expect(cleanIsbn('isbn13: 9780441478125')).toBe('9780441478125');
    });

    it('rejects invalid ISBN strings', () => {
      expect(cleanIsbn('12345')).toBeNull();
      expect(cleanIsbn('invalid-isbn-text')).toBeNull();
      expect(cleanIsbn('=""')).toBeNull();
      expect(cleanIsbn('')).toBeNull();
      expect(cleanIsbn(undefined)).toBeNull();
    });
  });

  describe('formatAuthorName', () => {
    it('inverts "Last, First" into "First Last"', () => {
      expect(formatAuthorName('Herbert, Frank')).toBe('Frank Herbert');
      expect(formatAuthorName('Austen, Jane')).toBe('Jane Austen');
      expect(formatAuthorName('Le Guin, Ursula K.')).toBe('Ursula K. Le Guin');
    });

    it('preserves already standard "First Last" or single names', () => {
      expect(formatAuthorName('Dan Simmons')).toBe('Dan Simmons');
      expect(formatAuthorName('Homer')).toBe('Homer');
      expect(formatAuthorName('')).toBeNull();
    });
  });

  describe('parseDateRange', () => {
    it('extracts start and finish dates from range strings', () => {
      expect(parseDateRange('2024/01/01-2024/01/15')).toEqual(['2024-01-01', '2024-01-15']);
      expect(parseDateRange('2024-01-01 to 2024-01-15')).toEqual(['2024-01-01', '2024-01-15']);
      expect(parseDateRange('2024/02/01')).toEqual([null, '2024-02-01']);
      expect(parseDateRange('')).toEqual([null, null]);
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

  it('detects all 6 supported export platforms correctly (IM-04)', () => {
    const allConfigs = getAllSourceConfigs();

    // 1. Goodreads
    const grHeaders = [
      'Book Id',
      'Title',
      'Author',
      'My Rating',
      'Exclusive Shelf',
      'Date Read',
      'Bookshelves',
    ];
    expect(detectSource(grHeaders, allConfigs)?.source).toBe('goodreads');

    // 2. StoryGraph
    const sgHeaders = [
      'Title',
      'Authors',
      'Star Rating',
      'Review',
      'Tags',
      'Read Status',
      'Last Date Read',
      'Format',
      'ISBN/UID',
    ];
    expect(detectSource(sgHeaders, allConfigs)?.source).toBe('storygraph');

    // 3. LibraryThing
    const ltHeaders = [
      'Book Id',
      'Title',
      'Primary Author',
      'Publication',
      'Rating',
      'Collections',
      'ISBN',
      'Date Read',
    ];
    expect(detectSource(ltHeaders, allConfigs)?.source).toBe('librarything');

    // 4. Calibre
    const calHeaders = [
      'id',
      'title',
      'authors',
      'isbn',
      'rating',
      'tags',
      'pubdate',
      'formats',
      'comments',
    ];
    expect(detectSource(calHeaders, allConfigs)?.source).toBe('calibre');

    // 5. OpenLibrary
    const olHeaders = [
      'work_key',
      'edition_key',
      'title',
      'authors',
      'read_status',
      'edition',
      'Logged Date',
    ];
    expect(detectSource(olHeaders, allConfigs)?.source).toBe('openlibrary');

    // 6. OpenReads
    const orHeaders = [
      'id',
      'title',
      'author',
      'status',
      'started_date',
      'finished_date',
      'rating',
      'pages',
      'notes',
    ];
    expect(detectSource(orHeaders, allConfigs)?.source).toBe('openreads');
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

describe('IM-04: StoryGraph Source Normalization Pipeline', () => {
  const sampleStoryGraphCsv = [
    'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Star Rating,Review,Tags,Owned?',
    '"Project Hail Mary",Andy Weir,,9780593135204,digital,read,2024/01/01,2024/01/15,2024/01/01-2024/01/15,4.75,"Incredible audio experience.","sci-fi, favourites",Yes',
    '"Tomorrow, and Tomorrow, and Tomorrow",Gabrielle Zevin,,9780593321201,print,read,2024/02/01,2024/02/10,,3.25,"Beautiful gaming story.",fiction,No',
    '"Klara and the Sun",Kazuo Ishiguro,,9780593318171,audio,currently-reading,2024/03/01,,,0,,in-progress,Yes',
    '"Babel",R.F. Kuang,,9780063021426,print,to-read,2024/03/10,,,,dark-academia,',
    '"Unfinished Tale",Unknown Author,,9780000000000,digital,did-not-finish,2024/03/12,,,1.5,"Could not get into it.",dnf,No',
  ].join('\n');

  it('normalizes StoryGraph rows faithfully, rounding quarter-stars to half-stars', () => {
    const config = getSourceConfig('storygraph');
    const result = normalizeImport(config, sampleStoryGraphCsv);

    expect(result.total).toBe(5);
    expect(result.valid).toBe(5);
    expect(result.malformed).toBe(0);

    // Row 1: 4.75 stars rounds to 5.0 (PRD §6.28, §51.2)
    const r1 = result.rows[0]!;
    expect(r1.title).toBe('Project Hail Mary');
    expect(r1.author).toBe('Andy Weir');
    expect(r1.isbn13).toBe('9780593135204');
    expect(r1.status).toBe('finished');
    expect(r1.rating).toBe(5.0); // 4.75 -> 5.0
    expect(r1.startedAt).toBe('2024-01-01');
    expect(r1.finishedAt).toBe('2024-01-15');
    expect(r1.format).toBe('ebook'); // digital -> ebook
    expect(r1.shelves).toEqual(['sci-fi', 'favourites']);
    expect(r1.owned).toBe(true);
    expect(r1.review).toBe('Incredible audio experience.');

    // Row 2: 3.25 stars rounds to 3.5
    const r2 = result.rows[1]!;
    expect(r2.title).toBe('Tomorrow, and Tomorrow, and Tomorrow');
    expect(r2.rating).toBe(3.5); // 3.25 -> 3.5
    expect(r2.format).toBe('print');
    expect(r2.owned).toBe(false);

    // Row 3: Currently reading, 0 star converts to NULL
    const r3 = result.rows[2]!;
    expect(r3.title).toBe('Klara and the Sun');
    expect(r3.status).toBe('reading');
    expect(r3.rating).toBeNull(); // 0 -> null
    expect(r3.format).toBe('audiobook'); // audio -> audiobook

    // Row 4: To read / unrated
    const r4 = result.rows[3]!;
    expect(r4.title).toBe('Babel');
    expect(r4.status).toBe('want');
    expect(r4.rating).toBeNull();

    // Row 5: DNF
    const r5 = result.rows[4]!;
    expect(r5.title).toBe('Unfinished Tale');
    expect(r5.status).toBe('dnf');
    expect(r5.rating).toBe(1.5);
  });
});

describe('IM-04: LibraryThing Source Normalization Pipeline', () => {
  const sampleLibraryThingCsv = [
    'Book Id,Title,Primary Author,Secondary Author,Publication,Rating,Tags,Collections,ISBN,Entry Date,Date Read,Review,Comments',
    '5001,"Dune","Herbert, Frank",,"Chilton Books",5,"sci-fi, classics","Your library, Favorites","[0441478123]",2025-01-01,2025-01-20,"Spice must flow.","First printing copy"',
    '5002,"Sense and Sensibility","Austen, Jane",,"Penguin Classics",0,"romance","Currently reading",9780141439662,2025-02-01,,,"Reading for book club"',
    '5003,"The Silmarillion","Tolkien, J.R.R.","Christopher Tolkien","HarperCollins",4.5,"fantasy","Wishlist",0048231398,2025-02-15,,,,',
  ].join('\n');

  it('normalizes LibraryThing rows, inverting "Last, First" authors and parsing bracketed ISBNs', () => {
    const config = getSourceConfig('librarything');
    const result = normalizeImport(config, sampleLibraryThingCsv);

    expect(result.total).toBe(3);
    expect(result.valid).toBe(3);

    // Row 1: Inverts "Herbert, Frank" -> "Frank Herbert", cleans "[0441478123]"
    const r1 = result.rows[0]!;
    expect(r1.title).toBe('Dune');
    expect(r1.author).toBe('Frank Herbert');
    expect(r1.isbn10).toBe('0441478123');
    expect(r1.status).toBe('finished');
    expect(r1.rating).toBe(5.0);
    expect(r1.startedAt).toBe('2025-01-01');
    expect(r1.finishedAt).toBe('2025-01-20');
    expect(r1.review).toBe('Spice must flow.');
    expect(r1.notes).toBe('First printing copy');
    expect(r1.owned).toBe(true);

    // Row 2: Inverts "Austen, Jane" -> "Jane Austen", maps Currently Reading
    const r2 = result.rows[1]!;
    expect(r2.title).toBe('Sense and Sensibility');
    expect(r2.author).toBe('Jane Austen');
    expect(r2.status).toBe('reading');
    expect(r2.rating).toBeNull(); // 0 -> null
    expect(r2.notes).toBe('Reading for book club');

    // Row 3: Co-author, Wishlist -> want
    const r3 = result.rows[2]!;
    expect(r3.title).toBe('The Silmarillion');
    expect(r3.author).toBe('J.R.R. Tolkien');
    expect(r3.additionalAuthors).toEqual(['Christopher Tolkien']);
    expect(r3.status).toBe('want');
    expect(r3.rating).toBe(4.5);
    expect(r3.owned).toBe(false);
  });
});

describe('IM-04: Calibre Source Normalization Pipeline', () => {
  const sampleCalibreCsv = [
    'id,title,authors,isbn,rating,tags,pubdate,series,publisher,identifiers,formats,comments',
    '1,"Foundation","Isaac Asimov",9780553293357,5,"sci-fi, classic",2020-01-01,"Foundation, #1","Bantam","isbn:9780553293357","EPUB, MOBI","<p>Great psycho-history concept.</p>"',
    '2,"Children of Time","Adrian Tchaikovsky & Someone Else",,0,"currently-reading, space",2022-05-01,,"Tor",,"EPUB","<p>Spiders evolving!</p>"',
    '3,"Consider Phlebas","Iain M. Banks",,3,"to-read",2023-01-01,"Culture, #1",,,AZW3,',
  ].join('\n');

  it('normalizes Calibre catalog CSV, splitting authors on & and parsing formats', () => {
    const config = getSourceConfig('calibre');
    const result = normalizeImport(config, sampleCalibreCsv);

    expect(result.total).toBe(3);
    expect(result.valid).toBe(3);

    // Row 1: Finished with rating and series in shelves
    const r1 = result.rows[0]!;
    expect(r1.title).toBe('Foundation');
    expect(r1.author).toBe('Isaac Asimov');
    expect(r1.isbn13).toBe('9780553293357');
    expect(r1.rating).toBe(5.0);
    expect(r1.status).toBe('finished');
    expect(r1.format).toBe('ebook');
    expect(r1.shelves).toContain('sci-fi');
    expect(r1.shelves).toContain('foundation, #1');
    expect(r1.review).toBe('Great psycho-history concept.');
    expect(r1.owned).toBe(true);

    // Row 2: Split author on &, currently-reading status tag, rating 0 -> null
    const r2 = result.rows[1]!;
    expect(r2.title).toBe('Children of Time');
    expect(r2.author).toBe('Adrian Tchaikovsky');
    expect(r2.additionalAuthors).toEqual(['Someone Else']);
    expect(r2.status).toBe('reading');
    expect(r2.rating).toBeNull();
    expect(r2.review).toBe('Spiders evolving!');

    // Row 3: to-read tag -> want status
    const r3 = result.rows[2]!;
    expect(r3.title).toBe('Consider Phlebas');
    expect(r3.status).toBe('want');
    expect(r3.rating).toBe(3.0);
  });
});

describe('IM-04: OpenLibrary Source Normalization Pipeline', () => {
  const sampleOpenLibraryCsv = [
    'work_key,edition_key,title,authors,isbn,read_status,rating,date_read,date_added,notes',
    '/works/OL82563W,/books/OL24364628M,"Neuromancer","William Gibson",9780441569595,already-read,5,2025-01-10,2025-01-01,"The sky above the port was the color of television..."',
    '/works/OL102749W,,Snow Crash,"Neal Stephenson",0553380958,currently-reading,0,,2025-02-01,"Metaverse origin."',
    '/works/OL45804W,,Cryptonomicon,"Neal Stephenson",,want-to-read,,,,',
  ].join('\n');

  it('normalizes OpenLibrary export CSV, cleaning work keys and reading statuses', () => {
    const config = getSourceConfig('openlibrary');
    const result = normalizeImport(config, sampleOpenLibraryCsv);

    expect(result.total).toBe(3);
    expect(result.valid).toBe(3);

    // Row 1: Strips "/works/" prefix for sourceId, maps already-read -> finished
    const r1 = result.rows[0]!;
    expect(r1.title).toBe('Neuromancer');
    expect(r1.author).toBe('William Gibson');
    expect(r1.isbn13).toBe('9780441569595');
    expect(r1.sourceId).toBe('OL82563W');
    expect(r1.status).toBe('finished');
    expect(r1.rating).toBe(5.0);
    expect(r1.startedAt).toBe('2025-01-01');
    expect(r1.finishedAt).toBe('2025-01-10');
    expect(r1.review).toBe('The sky above the port was the color of television...');

    // Row 2: currently-reading -> reading, 0 rating -> null
    const r2 = result.rows[1]!;
    expect(r2.title).toBe('Snow Crash');
    expect(r2.status).toBe('reading');
    expect(r2.rating).toBeNull();
    expect(r2.isbn10).toBe('0553380958');

    // Row 3: want-to-read -> want
    const r3 = result.rows[2]!;
    expect(r3.title).toBe('Cryptonomicon');
    expect(r3.status).toBe('want');
  });
});

describe('IM-04: OpenReads Source Normalization Pipeline', () => {
  const sampleOpenReadsCsv = [
    'id,title,author,status,rating,started_date,finished_date,pages,notes,review,tags,format',
    '1,"Ancillary Justice","Ann Leckie",finished,4.5,2024-05-01,2024-05-12,416,"Radch empire notes","Brilliant spaceship perspective.","sci-fi, space-opera",physical',
    '2,"Ancillary Sword","Ann Leckie",reading,0,2024-05-15,,384,"Sequel notes",,"sci-fi",ebook',
    '3,"Ancillary Mercy","Ann Leckie",not_started,0,,,368,,,"sci-fi",audiobook',
    '4,"Unfinished Book","Unknown",unfinished,1.0,2024-06-01,2024-06-02,50,"Dropped early","Not for me.",,physical',
  ].join('\n');

  it('normalizes OpenReads export CSV, mapping native statuses and format fields', () => {
    const config = getSourceConfig('openreads');
    const result = normalizeImport(config, sampleOpenReadsCsv);

    expect(result.total).toBe(4);
    expect(result.valid).toBe(4);

    // Row 1: finished -> finished, physical -> print, notes & review preserved
    const r1 = result.rows[0]!;
    expect(r1.title).toBe('Ancillary Justice');
    expect(r1.author).toBe('Ann Leckie');
    expect(r1.status).toBe('finished');
    expect(r1.rating).toBe(4.5);
    expect(r1.startedAt).toBe('2024-05-01');
    expect(r1.finishedAt).toBe('2024-05-12');
    expect(r1.notes).toBe('Radch empire notes');
    expect(r1.review).toBe('Brilliant spaceship perspective.');
    expect(r1.format).toBe('print');
    expect(r1.shelves).toEqual(['sci-fi', 'space-opera']);

    // Row 2: reading -> reading, ebook -> ebook, 0 rating -> null
    const r2 = result.rows[1]!;
    expect(r2.title).toBe('Ancillary Sword');
    expect(r2.status).toBe('reading');
    expect(r2.rating).toBeNull();
    expect(r2.format).toBe('ebook');

    // Row 3: not_started -> want
    const r3 = result.rows[2]!;
    expect(r3.title).toBe('Ancillary Mercy');
    expect(r3.status).toBe('want');
    expect(r3.format).toBe('audiobook');

    // Row 4: unfinished -> dnf
    const r4 = result.rows[3]!;
    expect(r4.title).toBe('Unfinished Book');
    expect(r4.status).toBe('dnf');
    expect(r4.rating).toBe(1.0);
  });
});

