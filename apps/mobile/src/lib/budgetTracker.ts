// PRD §4.4 Interaction Budget Instrumenter (SL-81, PRD §4.4).
//
// Measures the 5 non-negotiable UX budgets in real-time and reports via telemetry:
// 1. Time from Reading tab open -> progress saved (budget: p75 < 5s)
// 2. Taps from book impression -> shelved (budget: p75 <= 2)
// 3. Time from Finish tapped -> log saved (budget: p75 < 20s)
// 4. Time from `+` FAB tapped -> anything saved (budget: p75 < 15s)
// 5. Finish flow abandonment rate (budget: < 8%)
//
// A budget event is a measurement or nothing (audit 10). With no running
// clock nothing is sent: the tracker used to invent 1200 ms, 4 s or 3500 ms,
// all inside budget, which made the §4.4 report a false green.

import { track } from './events';

class BudgetTracker {
  private readingTabOpenTime: number | null = null;
  private finishFlowStartTimes = new Map<string, number>();
  private logSheetStartTime: number | null = null;

  // ---------------------------------------------------------------- 1. Progress Updated Budget
  /**
   * Call when reader focuses/opens the Reading tab.
   */
  startReadingTab(): void {
    this.readingTabOpenTime = Date.now();
  }

  /**
   * Call when reader updates & saves reading progress.
   */
  recordProgressSaved(options: {
    method?: 'slider' | 'sheet' | 'quick_add' | 'direct';
    deltaPages?: number;
  } = {}): void {
    // §4.4 measures Reading tab open -> progress saved: one sample per
    // visit. A later save in the same visit did not start at the tab.
    if (this.readingTabOpenTime === null) return;
    const durationMs = Math.max(1, Date.now() - this.readingTabOpenTime);
    this.readingTabOpenTime = null;

    track('progress_updated', {
      duration_ms: durationMs,
      method: options.method || 'slider',
      delta_pages: options.deltaPages ?? 0,
    });
  }

  // ---------------------------------------------------------------- 2. Book Shelved Tap Budget
  /**
   * Call when reader shelves a book, with the taps COUNTED since the book's
   * impression. No call site counts them yet (audit 10: both passed a
   * constant 2, which can never miss the budget), so nothing calls this until
   * a tap counter exists.
   */
  recordBookLogged(options: {
    tapCount: number;
    source?: string;
    targetStatus?: string;
  }): void {
    track('book_logged', {
      tap_count: options.tapCount,
      source: options.source || 'work_detail',
      target_status: options.targetStatus || 'want',
    });
  }

  // ---------------------------------------------------------------- 3. Finish Flow Budget
  /**
   * Call when reader taps "Finish" on a read.
   */
  startFinishFlow(readId: string): void {
    this.finishFlowStartTimes.set(readId, Date.now());
  }

  /**
   * Call when finish flow is completed & saved.
   */
  recordFinishCompleted(
    readId: string,
    options: {
      hadRating?: boolean;
      hadReview?: boolean;
      hearted?: boolean;
      format?: string | null;
      pageCount?: number | null;
    } = {},
  ): void {
    const startTime = this.finishFlowStartTimes.get(readId);
    if (startTime === undefined) return;
    const durationMs = Math.max(100, Date.now() - startTime);
    const durationSeconds = Math.round(durationMs / 1000);

    track('finish_completed', {
      duration_seconds: durationSeconds,
      duration_ms: durationMs,
      had_rating: options.hadRating ?? false,
      had_review: options.hadReview ?? false,
      hearted: options.hearted ?? false,
      format: options.format || 'unknown',
      page_count: options.pageCount ?? null,
    });

    this.finishFlowStartTimes.delete(readId);
  }

  /**
   * Call when reader exits or dismisses the finish flow without saving.
   */
  recordFinishAbandoned(
    readId: string,
    options: {
      stage?: 'rating' | 'review' | 'confirmation' | 'initial';
    } = {},
  ): void {
    const startTime = this.finishFlowStartTimes.get(readId);
    if (!startTime) return;

    const timeSpentMs = Math.max(50, Date.now() - startTime);

    track('finish_flow_abandoned', {
      stage: options.stage || 'initial',
      time_spent_ms: timeSpentMs,
    });

    this.finishFlowStartTimes.delete(readId);
  }

  // ---------------------------------------------------------------- 4. FAB Log Sheet Budget
  /**
   * Call when reader taps the center FAB `+` button (§4.4: "+ tapped ->
   * anything saved"); the next save anywhere completes it.
   */
  startLogSheet(_readId?: string): void {
    this.logSheetStartTime = Date.now();
  }

  /**
   * Call when any book action is saved from the log sheet.
   */
  recordLogSheetCompleted(
    readIdOrOptions?: string | { targetStatus?: string; deltaPages?: number; hadNote?: boolean; hadMinutes?: boolean },
    maybeOptions?: { targetStatus?: string; deltaPages?: number; hadNote?: boolean; hadMinutes?: boolean },
  ): void {
    const options = typeof readIdOrOptions === 'string' ? maybeOptions || {} : readIdOrOptions || {};
    if (this.logSheetStartTime === null) return;
    const durationMs = Math.max(1, Date.now() - this.logSheetStartTime);

    track('log_sheet_completed', {
      duration_ms: durationMs,
      target_status: options.targetStatus || 'reading',
      delta_pages: options.deltaPages ?? 0,
      had_note: options.hadNote ?? false,
      had_minutes: options.hadMinutes ?? false,
    });

    this.logSheetStartTime = null;
  }
}

export const budgetTracker = new BudgetTracker();
