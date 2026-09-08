// Open Library JSON -> our rows (FN-21), the filter rule (FN-22) and
// maturity classification (FN-24).
//
// Open Library is a wiki. Every field is optional, many are the wrong type,
// dates are free text, and the same concept appears under several names
// across record vintages. Nothing here may throw on bad input; it returns
// null and the caller counts a skip.

// ---------------------------------------------------------------- helpers

/** OL stores text as either a string or `{ type: '/type/text', value }`. */
function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && 'value' in v) {
    const inner = (v as { value?: unknown }).value;
    return typeof inner === 'string' ? inner.trim() || null : null;
  }
  return null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter((s): s is string => s !== null);
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * A four-digit year out of OL's free-text dates.
 *
 * Real values include "1999", "June 1999", "c1999", "1999-06-01", "[1999]",
 * "MCMXCIX" (given up on) and "n.d.". Anything outside 1400..currentYear+2 is
 * a data error rather than a book.
 */
export function parseYear(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/(\d{4})/);
  if (!m) return null;
  const year = Number.parseInt(m[1]!, 10);
  const max = new Date().getUTCFullYear() + 2;
  return year >= 1400 && year <= max ? year : null;
}

/** First cover id. OL uses -1 to mean "known to have none". */
function coverId(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  for (const c of v) {
    const n = intOrNull(c);
    if (n !== null && n > 0) return n;
  }
  return null;
}

/** Digits only, then length check. OL ISBNs carry hyphens and stray spaces. */
function isbn(v: unknown, length: 10 | 13): string | null {
  const list = Array.isArray(v) ? v : [v];
  for (const raw of list) {
    const s = str(raw);
    if (!s) continue;
    const cleaned = s.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (cleaned.length === length) return cleaned;
  }
  return null;
}

/** "/authors/OL23919A" -> "/authors/OL23919A", from any of OL's shapes. */
function refKey(v: unknown): string | null {
  if (typeof v === 'string') return v.startsWith('/') ? v : null;
  if (v && typeof v === 'object') {
    const o = v as { key?: unknown; author?: unknown };
    if (typeof o.key === 'string') return o.key;
    if (o.author) return refKey(o.author);
  }
  return null;
}

// ---------------------------------------------------------------- maturity

/**
 * Maturity classification (FN-24, PRD §7.8).
 *
 * This runs AT INGEST and cannot be bolted on later: App Store guideline 1.2
 * treats a catalog that cannot describe its own adult content as a rejection
 * risk, and reclassifying afterwards means reprocessing everything. Keeping
 * `raw_payloads` is what makes a rule change a reprocess rather than a
 * re-download.
 *
 * Deliberately conservative in both directions:
 *   - `explicit` only on unambiguous signals.
 *   - `unclassified` is the default and is NOT a synonym for `general`. A
 *     surface that must be safe filters to `general` and accepts a smaller
 *     catalog, rather than assuming silence means safe.
 */
export type Maturity = 'general' | 'mature' | 'explicit' | 'unclassified';

const EXPLICIT_SUBJECTS = [
  'erotic fiction', 'erotica', 'pornography', 'sexually explicit',
  'bdsm', 'explicit sexual', 'adult fiction, erotic',
];

const MATURE_SUBJECTS = [
  'erotic', 'sexuality', 'sexual behavior', 'sex instruction',
  'true crime', 'serial murders', 'graphic violence', 'drug abuse',
  'suicide', 'self-mutilation', 'incest', 'rape',
];

const GENERAL_SUBJECTS = [
  "children's fiction", "children's stories", 'juvenile fiction',
  'juvenile literature', 'picture books', 'board books', 'early readers',
];

/** Imprints whose entire output is adult. Cheap, high-precision signal. */
const EXPLICIT_IMPRINTS = [
  'ellora', 'black lace', 'harlequin spice', 'cleis press', 'circlet press',
];

export function classifyMaturity(input: {
  subjects?: unknown;
  publishers?: unknown;
  title?: unknown;
}): Maturity {
  const subjects = strArray(input.subjects).map((s) => s.toLowerCase());
  const publishers = strArray(input.publishers).map((s) => s.toLowerCase());

  const hits = (haystack: string[], needles: string[]) =>
    haystack.some((h) => needles.some((n) => h.includes(n)));

  if (hits(subjects, EXPLICIT_SUBJECTS)) return 'explicit';
  if (hits(publishers, EXPLICIT_IMPRINTS)) return 'explicit';

  // Children's classification beats a mature keyword: a picture book about a
  // funeral is not mature content, and "death" appears in both lists.
  if (hits(subjects, GENERAL_SUBJECTS)) return 'general';
  if (hits(subjects, MATURE_SUBJECTS)) return 'mature';

  // Having subjects at all, with none of them flagged, is weak evidence of
  // general -- but it IS evidence, and it is the difference between a usable
  // filtered catalog and an empty one.
  if (subjects.length >= 3) return 'general';

  return 'unclassified';
}

// ---------------------------------------------------------------- rows

export type AuthorRow = {
  olAuthorKey: string;
  name: string;
  alternateNames: string[];
  sortName: string | null;
  bio: string | null;
  olPhotoId: number | null;
  birthYear: number | null;
  deathYear: number | null;
};

export type WorkRow = {
  olWorkKey: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  alternateTitles: string[];
  firstPublishYear: number | null;
  olCoverId: number | null;
  maturity: Maturity;
  authorKeys: string[];
};

export type EditionRow = {
  olEditionKey: string;
  workKey: string;
  isbn13: string | null;
  isbn10: string | null;
  title: string | null;
  publisher: string | null;
  publishDateRaw: string | null;
  publishYear: number | null;
  pageCount: number | null;
  format: 'hardcover' | 'paperback' | 'ebook' | 'audiobook' | 'unknown';
  language: string;
  olCoverId: number | null;
};

export function normaliseAuthor(key: string, json: Record<string, unknown>): AuthorRow | null {
  const name = str(json.name) ?? str(json.personal_name);
  if (!name) return null;          // an author with no name is not usable

  // Every string OL offers for this person. `alternate_names` is the big one
  // -- it is how "murakami" reaches an author record named 村上春樹 -- but
  // personal_name and fuller_name are free and sometimes carry the only Latin
  // spelling. Deduplicated case-insensitively against the primary name so the
  // common case does not store the same string twice.
  const seen = new Set([name.toLowerCase()]);
  const alternateNames: string[] = [];
  for (const candidate of [
    ...strArray(json.alternate_names),
    str(json.personal_name) ?? '',
    str(json.fuller_name) ?? '',
    str(json.sort_name) ?? '',
  ]) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > 200) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    alternateNames.push(trimmed);
  }

  return {
    olAuthorKey: key,
    name,
    // A handful of OL records carry hundreds of aliases; the tail is noise
    // and it all lands in one indexed string.
    alternateNames: alternateNames.slice(0, 40),
    sortName: str(json.sort_name) ?? null,
    bio: str(json.bio),
    olPhotoId: coverId(json.photos),
    birthYear: parseYear(json.birth_date),
    deathYear: parseYear(json.death_date),
  };
}

/**
 * The filter rule (FN-22), adapted for works.
 *
 * architecture.md §5.1 states it as **title AND author AND (ISBN OR cover
 * ID)**. ISBN lives on editions, not works, so at the work level the testable
 * form is title AND author AND (cover OR a later edition supplies an ISBN).
 * Requiring a cover here would discard real books that simply have no cover
 * art on OL, so a work passes on title AND author, and the ISBN-or-cover half
 * is enforced on the edition pass.
 *
 * Unfiltered, the dumps need ~250 GB and are mostly noise: catalog stubs,
 * duplicate imports, records with a key and nothing else.
 */
export function normaliseWork(key: string, json: Record<string, unknown>): WorkRow | null {
  const title = str(json.title);
  if (!title) return null;
  if (title.length > 500) return null;              // a description in the title field

  const authorKeys = Array.isArray(json.authors)
    ? json.authors.map(refKey).filter((k): k is string => k !== null)
    : [];
  if (authorKeys.length === 0) return null;         // the AND author half of the rule

  // OL spells this several ways depending on record vintage.
  const alternates = [
    ...strArray(json.alternate_titles),
    ...strArray(json.other_titles),
    ...strArray(json.alternative_title),
  ];

  return {
    olWorkKey: key,
    title,
    subtitle: str(json.subtitle),
    description: str(json.description),
    alternateTitles: [...new Set(alternates)].slice(0, 20),
    firstPublishYear: parseYear(json.first_publish_date),
    olCoverId: coverId(json.covers),
    maturity: classifyMaturity({
      subjects: json.subjects,
      title: json.title,
    }),
    authorKeys: [...new Set(authorKeys)].slice(0, 20),
  };
}

const FORMAT_PATTERNS: [RegExp, EditionRow['format']][] = [
  [/audio|spoken|cassette|cd\b|mp3/i, 'audiobook'],
  [/ebook|e-book|kindle|epub|electronic/i, 'ebook'],
  [/hardcover|hardback|hard cover|library binding|bound/i, 'hardcover'],
  [/paperback|softcover|soft cover|mass market|trade pbk|pbk/i, 'paperback'],
];

export function normaliseEdition(key: string, json: Record<string, unknown>): EditionRow | null {
  const workKey = Array.isArray(json.works) ? refKey(json.works[0]) : null;
  if (!workKey) return null;                        // an edition of nothing

  const isbn13 = isbn(json.isbn_13, 13);
  const isbn10 = isbn(json.isbn_10, 10);
  const cover = coverId(json.covers);

  // The (ISBN OR cover ID) half of the filter rule (FN-22).
  if (!isbn13 && !isbn10 && cover === null) return null;

  const physical = str(json.physical_format) ?? '';
  let format: EditionRow['format'] = 'unknown';
  for (const [pattern, value] of FORMAT_PATTERNS) {
    if (pattern.test(physical)) { format = value; break; }
  }

  const pages = intOrNull(json.number_of_pages);

  return {
    olEditionKey: key,
    workKey,
    isbn13,
    isbn10,
    title: str(json.title),
    publisher: strArray(json.publishers)[0] ?? null,
    publishDateRaw: str(json.publish_date),
    publishYear: parseYear(json.publish_date),
    // 30,000-page "books" are OCR errors, not omnibuses.
    pageCount: pages !== null && pages > 0 && pages < 30_000 ? pages : null,
    format,
    language: refKey(Array.isArray(json.languages) ? json.languages[0] : null)
      ?.replace('/languages/', '') ?? 'und',
    olCoverId: cover,
  };
}
