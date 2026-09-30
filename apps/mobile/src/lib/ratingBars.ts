// The book page's rating histogram (PRD §9.6, audit 09b). The API returns ten
// half-star buckets; the page draws five bars. A plain function so the
// grouping is testable without rendering.
import type { RatingBucket } from '@flyleaf/api-client';

export interface StarBar {
  stars: number;
  count: number;
  /** Share of all rated readers, rounded to a whole percent. */
  pct: number;
}

/**
 * Bar n holds the "n - 0.5" and "n.0" buckets: ratings above n - 1 up to n,
 * the same rule as the reviews list's rating filter (A-09-015), so the 4★
 * bar and the 4★ chip both mean 3.5 and 4.0. Five bars, 5★ first.
 */
export function starBars(distribution: Partial<Record<RatingBucket, number>> | undefined): StarBar[] {
  const at = (key: string) => distribution?.[key as RatingBucket] ?? 0;
  const total = Object.values(distribution ?? {}).reduce<number>((a, b) => a + (b ?? 0), 0);
  return [5, 4, 3, 2, 1].map((stars) => {
    const count = at((stars - 0.5).toFixed(1)) + at(stars.toFixed(1));
    return { stars, count, pct: total > 0 ? Math.round((count / total) * 100) : 0 };
  });
}
