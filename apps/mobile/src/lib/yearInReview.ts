// Year in Review on the phone (ST-09; PRD §6.41, §17.6). The cards and their
// words come from the server (GET /me/year-in-review), the same function the
// share cards are drawn from, so this file only decides where it is offered
// and what the locked and empty states say. Pure.

import type { YearInReview } from '@flyleaf/api-client';

export interface YirBanner {
  year: number;
  title: string;
  subtitle: string;
}

/** The stats screen's entry point: only once it is open and has a book (no countdown before: design.md §8). */
export function yirBanner(yir: YearInReview | null | undefined): YirBanner | null {
  if (!yir || !yir.unlocked || yir.variant === null || yir.variant === 'empty') return null;
  return { year: yir.year, title: `Your ${yir.year} Year in Review`, subtitle: 'Your year in books, one card at a time.' };
}

/** What the screen says when there are no cards. Never a count, never a shortfall. */
export function yirEmptyCopy(yir: YearInReview): { title: string; subtitle: string } | null {
  if (!yir.unlocked) {
    return { title: `Your ${yir.year} Year in Review`, subtitle: 'It opens on 1 December.' };
  }
  if (yir.variant === 'empty' || yir.cards.length === 0) {
    return { title: `Your ${yir.year} Year in Review`, subtitle: `It fills in with the books you finish in ${yir.year}.` };
  }
  return null;
}

/** "flyleaf://year-in-review/2026" → 2026 (a notification's link); anything else null. */
export function yirYearFromLink(path: string | undefined): number | null {
  const m = /^(\d{4})$/.exec(path ?? '');
  return m ? Number(m[1]) : null;
}
