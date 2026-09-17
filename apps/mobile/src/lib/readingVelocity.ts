// Reading velocity & finish date prediction (SL-52, PRD §6.15, §8.3).
//
// Calculates reader slope (pages/day or %/day) from recent progress events
// or start date, and projects completion date.

export interface ProgressPoint {
  at: string;
  page?: number | null;
  percent?: number | null;
}

export interface PredictionInput {
  currentPage?: number | null;
  pageCount?: number | null;
  percent?: number | null;
  startedAt?: string | null;
  recentEvents?: ProgressPoint[];
}

export function predictFinishDate(input: PredictionInput): string {
  const { currentPage, pageCount, percent, startedAt, recentEvents } = input;

  // Case 1: Already 100% or reached page count
  if (pageCount != null && currentPage != null && currentPage >= pageCount) {
    return 'Completed';
  }
  if (percent != null && percent >= 100) {
    return 'Completed';
  }

  // Case 2: No progress logged yet
  if ((currentPage == null || currentPage <= 0) && (percent == null || percent <= 0)) {
    return 'Log progress to predict finish';
  }

  const now = Date.now();

  // Case 3: Page-based calculation
  if (pageCount != null && pageCount > 0 && currentPage != null) {
    const pagesLeft = Math.max(0, pageCount - currentPage);
    if (pagesLeft === 0) return 'Completed';

    let pagesPerDay: number | null = null;

    // Check if we have multiple recent events spanning time
    if (recentEvents && recentEvents.length >= 2) {
      const sorted = [...recentEvents]
        .filter((e) => e.page != null)
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

      if (sorted.length >= 2) {
        const oldest = sorted[0]!;
        const newest = sorted[sorted.length - 1]!;
        const daySpan =
          (new Date(newest.at).getTime() - new Date(oldest.at).getTime()) / (1000 * 60 * 60 * 24);
        const pageDelta = (newest.page ?? 0) - (oldest.page ?? 0);

        if (daySpan >= 0.5 && pageDelta > 0) {
          pagesPerDay = pageDelta / daySpan;
        }
      }
    }

    // Fallback to startedAt date
    if (pagesPerDay == null && startedAt) {
      const startMs = new Date(startedAt).getTime();
      const daysSinceStart = Math.max(0.5, (now - startMs) / (1000 * 60 * 60 * 24));
      if (currentPage > 0) {
        pagesPerDay = Math.round((currentPage / daysSinceStart) * 100) / 100;
      }
    }

    // Honest minimum fallback if newly started today
    if (pagesPerDay == null || pagesPerDay <= 0) {
      pagesPerDay = 25; // standard reader benchmark
    }

    // Clamp pages/day to sane bounds (e.g. 5 to 500 pages/day)
    const clampedSpeed = Math.max(5, Math.min(500, pagesPerDay));
    const daysLeft = Math.max(1, Math.ceil(pagesLeft / clampedSpeed));

    return formatDaysLeft(daysLeft, now);
  }

  // Case 4: Percentage-based calculation (ebook or unknown page count)
  if (percent != null && percent > 0) {
    const percentLeft = Math.max(0, 100 - percent);
    let percentPerDay: number | null = null;

    if (startedAt) {
      const startMs = new Date(startedAt).getTime();
      const daysSinceStart = Math.max(0.5, (now - startMs) / (1000 * 60 * 60 * 24));
      percentPerDay = Math.round((percent / daysSinceStart) * 100) / 100;
    }

    if (percentPerDay == null || percentPerDay <= 0) {
      percentPerDay = 10; // 10% per day fallback
    }

    const clampedPercentSpeed = Math.max(1, Math.min(100, percentPerDay));
    const daysLeft = Math.max(1, Math.ceil(Math.round((percentLeft / clampedPercentSpeed) * 1e4) / 1e4));

    return formatDaysLeft(daysLeft, now);
  }

  return 'Keep reading to predict finish';
}

function formatDaysLeft(days: number, currentMs: number): string {
  if (days === 1) {
    return 'Estimated finish: tomorrow';
  }
  if (days < 14) {
    return `Estimated finish: in ${days} days`;
  }

  const finishDate = new Date(currentMs + days * 24 * 60 * 60 * 1000);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `Estimated finish: ${monthNames[finishDate.getMonth()]} ${finishDate.getDate()}`;
}
