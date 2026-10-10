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

/** D-10-2: an impression ends after 10 minutes. */
export const BOOK_IMPRESSION_MS = 10 * 60 * 1000;

interface BookImpression {
  startedAt: number;
  taps: number;
  screen: 'search' | 'book';
  /** Tapped open from a search row; adopted by that work's book page. */
  carry: boolean;
  source?: string;
}

class BudgetTracker {
  /** Clock, replaceable in tests. */
  now: () => number = () => Date.now();
  private impressions = new Map<string, BookImpression>();
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
  // The tap counter, per D-10-2 (refined; audit 15). A book's impression
  // starts at the first render of a screen offering the shelve action for it:
  // a search row, or the book page. Opening the book page from a search row
  // for the same work carries the impression over, and that tap counts. It
  // ends on navigation elsewhere or after 10 minutes, and stops at local
  // success (the optimistic local write), when book_logged is sent with the
  // taps counted. Counted taps are the ones on the shelve path: the row that
  // opens the book, and the status button.

  /** Search rows now showing these works (call on every render of the list). */
  searchRowsShown(workIds: readonly string[]): void {
    const now = this.now();
    this.dropExpired(now);
    for (const id of workIds) {
      if (!this.impressions.has(id)) this.impressions.set(id, { startedAt: now, taps: 0, screen: 'search', carry: false });
    }
  }

  /** The reader tapped a search row to open this work's book page. */
  searchRowOpened(workId: string): void {
    const now = this.now();
    this.dropExpired(now);
    let imp = this.impressions.get(workId);
    if (!imp) {
      imp = { startedAt: now, taps: 0, screen: 'search', carry: false };
      this.impressions.set(workId, imp);
    }
    imp.taps += 1;
    imp.carry = true;
  }

  /** The search screen lost focus: its rows' impressions end, except the one carried to a book page. */
  searchLeft(): void {
    for (const [id, imp] of this.impressions) {
      if (imp.screen === 'search' && !imp.carry) this.impressions.delete(id);
    }
  }

  /** The book page for this work is shown: adopt a carried impression, or start one. */
  bookPageShown(workId: string): void {
    const now = this.now();
    this.dropExpired(now);
    const carried = this.impressions.get(workId);
    for (const [id, imp] of this.impressions) {
      if (id !== workId && imp.screen === 'book') this.impressions.delete(id);
      if (id !== workId && imp.carry) this.impressions.delete(id);
    }
    if (carried && carried.carry) {
      carried.screen = 'book';
      carried.carry = false;
      carried.source = 'search';
      return;
    }
    this.impressions.set(workId, { startedAt: now, taps: 0, screen: 'book', carry: false, source: 'work_detail' });
  }

  /** The book page for this work is gone (back, or navigation elsewhere). */
  bookPageLeft(workId: string): void {
    const imp = this.impressions.get(workId);
    if (imp && imp.screen === 'book') this.impressions.delete(workId);
  }

  /** A tap on the shelve action (a status button) for this work. */
  shelveTapped(workId: string): void {
    const imp = this.impressions.get(workId);
    if (imp && this.now() - imp.startedAt <= BOOK_IMPRESSION_MS) imp.taps += 1;
  }

  /**
   * The shelve write succeeded locally: sends book_logged with the taps
   * counted since the impression began, once. Nothing is sent without a live
   * impression (no invented counts, audit 10).
   */
  bookShelvedLocally(workId: string, options: { targetStatus: string }): void {
    const imp = this.impressions.get(workId);
    if (!imp) return;
    this.impressions.delete(workId);
    if (this.now() - imp.startedAt > BOOK_IMPRESSION_MS || imp.taps < 1) return;
    this.recordBookLogged({ tapCount: imp.taps, source: imp.source ?? imp.screen, targetStatus: options.targetStatus });
  }

  private dropExpired(now: number): void {
    for (const [id, imp] of this.impressions) {
      if (now - imp.startedAt > BOOK_IMPRESSION_MS) this.impressions.delete(id);
    }
  }

  /**
   * Sends one book_logged sample with a counted tapCount. Called by
   * bookShelvedLocally; audit 10 removed the call sites that passed a
   * constant 2, which could never miss the budget.
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
export { BudgetTracker };
