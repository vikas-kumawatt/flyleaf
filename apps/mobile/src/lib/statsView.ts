// What the stats screen shows, as plain functions (SL-74, audit 10), so the
// rules are tested against the code the screen runs rather than a copy.
import type { RatingBucket, ReadingStats } from '@flyleaf/api-client';

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
