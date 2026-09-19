// Reusable field transformers for library imports (PRD §6.8, §24.2, IM-03, IM-06).

import type { NormalizedFormat, NormalizedStatus } from './types.js';

/**
 * Strips HTML tags, decodes common HTML entities, and trims whitespace.
 */
export function cleanText(val: string | undefined): string | null {
  if (!val) return null;
  let text = val.trim();

  // Strip wrapping outer quotes if any
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  // HTML entity decode
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Strip residual HTML tags from reviews
  text = text.replace(/<[^>]*>/g, '').trim();

  return text.length > 0 ? text : null;
}

/**
 * Normalizes an ISBN string, handling:
 * - Goodreads formula wrapping (e.g. `="0441478123"`)
 * - Identifier prefixes (e.g. `isbn:9780441478125`)
 * - Brackets / enclosures (e.g. `[0441478123]`)
 * - Comma / semicolon delimited lists (extracts first valid ISBN)
 * Strips hyphens, whitespace, and asserts valid 10 or 13-character length.
 */
export function cleanIsbn(val: string | undefined): string | null {
  if (!val) return null;

  // 1. If multiple candidates delimited by commas, semicolons, or pipes, test each candidate
  const candidates =
    val.includes(',') || val.includes(';') || val.includes('|')
      ? val
          .split(/[,;|]/)
          .map((c) => c.trim())
          .filter(Boolean)
      : [val.trim()];

  for (const candidate of candidates) {
    // Strip Goodreads formula wrapping: ="0441478123" -> 0441478123
    let cleaned = candidate.replace(/^=\s*"?/, '').replace(/"?\s*$/, '').trim();

    // Strip identifier prefix e.g. "isbn:" or "isbn13:"
    cleaned = cleaned.replace(/^isbn(?:10|13)?:\s*/i, '');

    // Strip brackets and quotes
    cleaned = cleaned.replace(/[\[\]\(\)\{\}"']/g, '');

    // Remove hyphens, spaces, and punctuation
    cleaned = cleaned.replace(/[-\s._]/g, '');

    // Keep alphanumeric only (ISBN-10 can have 'X' as check digit)
    cleaned = cleaned.toUpperCase();

    // Validate length: must be 10 or 13 chars
    if (/^[0-9]{9}[0-9X]$/.test(cleaned) || /^[0-9]{13}$/.test(cleaned)) {
      return cleaned;
    }
  }

  return null;
}

/**
 * Normalizes rating across 5-star, 10-star, and quarter-star scales into half-stars (0.5–5.0).
 *
 * CRITICAL RULE (PRD §6.8, AC-9, IM-06):
 * `My Rating = 0` MUST import as `NULL`, not 0 and not dropped.
 */
export function normalizeRating(
  val: string | undefined,
  scale: '5' | '10' | 'storygraph' = '5',
): number | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (!trimmed) return null;

  const num = Number.parseFloat(trimmed);
  if (Number.isNaN(num) || num <= 0) {
    // 0 is unrated in Goodreads/StoryGraph/etc.
    return null;
  }

  let rating = num;
  if (scale === '10') {
    rating = num / 2;
  }

  // Quarter-stars (StoryGraph) round to nearest half-star (PRD §6.28, §51.2)
  rating = Math.round(rating * 2) / 2;

  // Clamp between 0.5 and 5.0
  if (rating < 0.5) return null;
  if (rating > 5.0) return 5.0;

  return rating;
}

/**
 * Maps source-specific status string to canonical Status enum.
 */
export function mapStatus(
  val: string | undefined,
  mapping: Record<string, NormalizedStatus>,
  defaultStatus: NormalizedStatus = 'finished',
): NormalizedStatus {
  if (!val) return defaultStatus;
  const key = val.trim().toLowerCase();
  return mapping[key] ?? defaultStatus;
}

/**
 * Robust date parser supporting ISO 8601, YYYY/MM/DD, YYYY-MM-DD, M/D/YYYY, and human formats.
 * Returns ISO date string `YYYY-MM-DD` or null.
 */
export function parseDate(val: string | undefined): string | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (!trimmed) return null;

  // 1. YYYY/MM/DD or YYYY-MM-DD (e.g. Goodreads, Calibre)
  const ymdMatch = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymdMatch && ymdMatch[1] && ymdMatch[2] && ymdMatch[3]) {
    const year = Number.parseInt(ymdMatch[1], 10);
    const month = Number.parseInt(ymdMatch[2], 10);
    const day = Number.parseInt(ymdMatch[3], 10);
    if (isValidDate(year, month, day)) {
      return formatDate(year, month, day);
    }
  }

  // 2. M/D/YYYY or MM/DD/YYYY (US format)
  const mdyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (mdyMatch && mdyMatch[1] && mdyMatch[2] && mdyMatch[3]) {
    const month = Number.parseInt(mdyMatch[1], 10);
    const day = Number.parseInt(mdyMatch[2], 10);
    const year = Number.parseInt(mdyMatch[3], 10);
    if (isValidDate(year, month, day)) {
      return formatDate(year, month, day);
    }
  }

  // 3. Fallback to Date.parse()
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const hasTimeOrZ = /T|\d:\d|Z|[+-]\d{2}/.test(trimmed);
    const year = hasTimeOrZ ? parsed.getUTCFullYear() : parsed.getFullYear();
    const month = (hasTimeOrZ ? parsed.getUTCMonth() : parsed.getMonth()) + 1;
    const day = hasTimeOrZ ? parsed.getUTCDate() : parsed.getDate();
    if (isValidDate(year, month, day)) {
      return formatDate(year, month, day);
    }
  }

  return null;
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (year < 1800 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return true;
}

function formatDate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Splits delimited shelves/tags string (e.g. "sci-fi, favourites, owned") into normalized array.
 */
export function parseShelves(
  val: string | undefined,
  delimiter = /[,;|]/,
  excludedShelves: Set<string> = new Set(['read', 'to-read', 'currently-reading']),
): string[] {
  if (!val) return [];
  return val
    .split(delimiter)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && !excludedShelves.has(s));
}

/**
 * Normalizes book binding/format names into 'print' | 'ebook' | 'audiobook'.
 */
export function mapFormat(val: string | undefined): NormalizedFormat | null {
  if (!val) return null;
  const s = val.trim().toLowerCase();

  if (/audio|audible|mp3|spoken/i.test(s)) {
    return 'audiobook';
  }
  if (/ebook|kindle|epub|nook|pdf|digital/i.test(s)) {
    return 'ebook';
  }
  if (/print|physical|paperback|hardcover|hardback|mass market|library binding|leather/i.test(s)) {
    return 'print';
  }

  return null;
}

/**
 * Inverts "Last, First" author format (e.g. "Herbert, Frank" -> "Frank Herbert")
 * while preserving already standard "First Last" formats or single-word names.
 */
export function formatAuthorName(val: string | undefined): string | null {
  const cleaned = cleanText(val);
  if (!cleaned) return null;

  // If contains a single comma and no '&', ';', or 'and', flip "Last, First"
  if (
    cleaned.includes(',') &&
    !cleaned.includes('&') &&
    !cleaned.includes(';') &&
    !/\band\b/i.test(cleaned)
  ) {
    const parts = cleaned.split(',').map((p) => p.trim());
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `${parts[1]} ${parts[0]}`.trim();
    }
  }

  return cleaned;
}

/**
 * Parses date ranges (e.g. "2024/01/01-2024/01/15" or "2024-01-01 to 2024-01-15").
 * Returns [startedAt, finishedAt] as ISO date strings or nulls.
 */
export function parseDateRange(val: string | undefined): [string | null, string | null] {
  if (!val) return [null, null];
  const trimmed = val.trim();
  if (!trimmed) return [null, null];

  // Split on " - ", " to ", ",", or slash-date range "YYYY/MM/DD-YYYY/MM/DD"
  let parts: string[] = [];
  if (trimmed.includes(' to ')) {
    parts = trimmed.split(' to ');
  } else if (trimmed.includes(' - ')) {
    parts = trimmed.split(' - ');
  } else if (trimmed.includes(',')) {
    parts = trimmed.split(',');
  } else {
    // Check for "YYYY/MM/DD-YYYY/MM/DD" or "YYYY-MM-DD-YYYY-MM-DD"
    const slashRange = trimmed.match(/^(\d{4}\/\d{1,2}\/\d{1,2})\s*-\s*(\d{4}\/\d{1,2}\/\d{1,2})$/);
    if (slashRange && slashRange[1] && slashRange[2]) {
      parts = [slashRange[1], slashRange[2]];
    } else {
      const dashRange = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/);
      if (dashRange && dashRange[1] && dashRange[2]) {
        parts = [dashRange[1], dashRange[2]];
      }
    }
  }

  if (parts.length >= 2 && parts[0] && parts[1]) {
    const start = parseDate(parts[0]);
    const end = parseDate(parts[1]);
    return [start, end];
  }

  const single = parseDate(trimmed);
  return [null, single];
}
