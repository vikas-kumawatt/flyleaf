// What the stats screen shows, as plain functions (SL-74, audit 10), so the
// rules are tested against the code the screen runs rather than a copy.
import type { GoalResponse, RatingBucket, ReadingStats } from '@flyleaf/api-client';

export interface RatingRow {
  bucket: RatingBucket;
  count: number;
  /** Bar width against the fullest bucket, 0-100. */
  fill: number;
}

const BUCKETS: RatingBucket[] = ['5.0', '4.5', '4.0', '3.5', '3.0', '2.5', '2.0', '1.5', '1.0', '0.5'];

/** PRD §17.2: the ten half-star buckets, 5.0 first. */
export function statsRatingRows(distribution: Partial<Record<RatingBucket, number>> | undefined): RatingRow[] {
  const counts = BUCKETS.map((b) => distribution?.[b] ?? 0);
  const max = Math.max(1, ...counts);
  return BUCKETS.map((bucket, i) => ({ bucket, count: counts[i]!, fill: (counts[i]! / max) * 100 }));
}

export type FormatKey = keyof ReadingStats['format_breakdown'];

/** Share of each format, unknown included (it is a real answer, never folded into print). */
export function formatShares(breakdown: ReadingStats['format_breakdown'] | undefined): { key: FormatKey; count: number; pct: number }[] {
  if (!breakdown) return [];
  const keys: FormatKey[] = ['print', 'ebook', 'audiobook', 'unknown'];
  const total = keys.reduce((n, k) => n + (breakdown[k] ?? 0), 0);
  if (total === 0) return [];
  return keys
    .filter((k) => k !== 'unknown' || (breakdown.unknown ?? 0) > 0)
    .map((key) => ({ key, count: breakdown[key] ?? 0, pct: Math.round(((breakdown[key] ?? 0) / total) * 100) }));
}

/** dnf_rate is a fraction (0.12); the screen says 12%. */
export function dnfPercent(rate: number): number {
  return Math.round(rate * 100);
}

/**
 * PRD §17.4 "never fabricate": say what the figures leave out. Null when
 * nothing is left out. Undated finishes are counted only in "All time".
 */
export function excludedNote(stats: Pick<ReadingStats, 'year' | 'excluded'>): string | null {
  const parts: string[] = [];
  const { undated, missing_page_count } = stats.excluded ?? { undated: 0, missing_page_count: 0 };
  if (undated > 0) {
    const books = undated === 1 ? '1 finished book has' : `${undated} finished books have`;
    parts.push(
      stats.year === 'all'
        ? `${books} no finish date, so ${undated === 1 ? 'it is' : 'they are'} counted here but not in any month`
        : `${books} no finish date and ${undated === 1 ? 'is' : 'are'} only counted in All time`,
    );
  }
  if (missing_page_count > 0) {
    parts.push(
      missing_page_count === 1
        ? '1 book has no page count and adds no pages'
        : `${missing_page_count} books have no page count and add no pages`,
    );
  }
  return parts.length ? `${parts.join('. ')}.` : null;
}

/** The device's IANA zone, for streak days (PRD §8.7). Undefined lets the server use UTC. */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- ST-03

export type CoverageKey = keyof ReadingStats['coverage'];

/** What a book (or session) lacks when it is left out of each figure. */
const MISSING: Record<CoverageKey, { one: string; many: string }> = {
  pages: { one: 'is missing a page count', many: 'are missing page counts' },
  months: { one: 'has no finish date', many: 'have no finish date' },
  ratings: { one: 'is unrated', many: 'are unrated' },
  vs_crowd: { one: 'has no other ratings yet', many: 'have no other ratings yet' },
  formats: { one: 'has no known format', many: 'have no known format' },
  authors: { one: 'has no author on record', many: 'have no author on record' },
  genres: { one: 'has no genre on record', many: 'have no genre on record' },
  decades: { one: 'has no publication year', many: 'have no publication year' },
  languages: { one: 'has no language on record', many: 'have no language on record' },
  velocity: { one: 'has no start date', many: 'have no start date' },
  audio: { one: 'has no length or listening progress', many: 'have no length or listening progress' },
  pace: { one: 'has no earlier page to count from', many: 'have no earlier page to count from' },
  speed: { one: 'has no minutes or pages logged', many: 'have no minutes or pages logged' },
};

/** The unit each figure counts in: books, except the session-based ones. */
function unit(key: CoverageKey, n: number): string {
  if (key === 'pace' || key === 'speed') return n === 1 ? 'session' : 'sessions';
  if (key === 'vs_crowd') return n === 1 ? 'rated book' : 'rated books';
  if (key === 'audio') return n === 1 ? 'audiobook' : 'audiobooks';
  return n === 1 ? 'book' : 'books';
}

/**
 * PRD §17.4 / ST-03, "never fabricate": "Based on 180 of your 247 books — 67
 * are missing page counts." Null when the figure is based on everything (or
 * there is nothing to base it on). `whose` is "your" on your own stats and
 * "their" on someone else's.
 */
export function coverageNote(
  stats: Pick<ReadingStats, 'coverage'>,
  key: CoverageKey,
  whose: 'your' | 'their' = 'your',
): string | null {
  const c = stats.coverage?.[key];
  if (!c || c.of === 0 || c.based_on >= c.of) return null;
  const missing = c.of - c.based_on;
  const why = missing === 1 ? `1 ${MISSING[key].one}` : `${missing.toLocaleString('en-GB')} ${MISSING[key].many}`;
  return `Based on ${c.based_on.toLocaleString('en-GB')} of ${whose} ${c.of.toLocaleString('en-GB')} ${unit(key, c.of)} — ${why}.`;
}

// ---------------------------------------------------------------- ST-06

export interface StreakCopy {
  /** The big figure and its label, or null to show nothing at all. */
  hero: string;
  label: string;
  /** "Longest: 47 days (12 Mar – 27 Apr)", when there is a longest to show beside a current one. */
  detail: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(d: string): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

/**
 * PRD §8.7: a streak is never shown as a loss. A live streak shows its days;
 * a broken one is shown as the longest, an achievement ("Longest streak: 47
 * days"); someone who never logs progress sees nothing and is never told
 * they are missing one (§8.3).
 */
export function streakCopy(
  stats: Pick<ReadingStats, 'current_streak' | 'longest_streak' | 'longest_streak_range'>,
): StreakCopy | null {
  const range = stats.longest_streak_range
    ? ` (${shortDate(stats.longest_streak_range.start)} – ${shortDate(stats.longest_streak_range.end)})`
    : '';
  if (stats.current_streak > 0) {
    return {
      hero: days(stats.current_streak),
      label: 'Reading streak',
      detail: stats.longest_streak > stats.current_streak ? `Longest: ${days(stats.longest_streak)}${range}` : null,
    };
  }
  if (stats.longest_streak > 0) {
    return { hero: days(stats.longest_streak), label: 'Longest streak', detail: range ? range.slice(2, -1) : null };
  }
  return null;
}

// ---------------------------------------------------------------- ST-05

export interface GoalRingModel {
  /** 0–1, the share of the ring drawn. */
  progress: number;
  /** "12/24" inside the ring. */
  label: string;
  accessibilityLabel: string;
  reached: boolean;
}

/**
 * PRD §8.6 [LOCKED]: the ring, and nothing else. It says how many of the
 * target are read; never "behind", "ahead", "left" or a schedule.
 */
export function goalRingModel(goal: GoalResponse | null | undefined): GoalRingModel | null {
  const g = goal?.goal;
  if (!goal || !g) return null;
  return {
    progress: Math.max(0, Math.min(1, g.books_count / g.target_books)),
    label: `${g.books_count}/${g.target_books}`,
    accessibilityLabel: `Reading goal ${goal.year}: ${g.books_count} of ${g.target_books} books`,
    reached: g.books_reached,
  };
}

/** A goal target typed in a field: a whole number in range, else null (the field says why). */
export function parseGoalTarget(text: string, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= max ? n : null;
}
