// Home feed state (SO-15, audit 14): the rules the Home screen follows, kept
// out of the component so they can be tested without React Native.
//
// - Tabs (PRD §12.1, §12.5): a signed-in reader opens Friends (the server
//   switches a reader with no follows to Popular and says so); a guest sees
//   Popular only.
// - Paging: the cursor is opaque; pages are appended, never re-sorted, and an
//   id already shown is not shown twice (a refresh can race a page).
// - A visible end (§12.6): after ~100 items, or when the server has no more,
//   the feed says "You're all caught up" and stops asking.
// - Cold start banners come from the response, not from guesses.

import type { FeedActivityItem } from './feedCard';

export type FeedTab = 'friends' | 'popular';

/** §12.6: "After ~100 items, 'You're all caught up'". */
export const FEED_CAUGHT_UP_AFTER = 100;
export const FEED_PAGE_SIZE = 20;

export interface FeedPage {
  items: FeedActivityItem[];
  next_cursor: string | null;
  has_more: boolean;
  tab: string;
  is_cold_start?: boolean;
  following_count?: number;
  cold_start_reason?: string | null;
}

export interface FeedState {
  items: FeedActivityItem[];
  cursor: string | null;
  hasMore: boolean;
  /** What the server actually served: Friends with no follows comes back as Popular. */
  servedTab: FeedTab | null;
  coldStart: ColdStartBanner | null;
}

export const EMPTY_FEED: FeedState = { items: [], cursor: null, hasMore: false, servedTab: null, coldStart: null };

export function defaultFeedTab(signedIn: boolean): FeedTab {
  return signedIn ? 'friends' : 'popular';
}

/** Guests may read Popular; Friends needs an account (PRD §4.2). */
export function canShowTab(tab: FeedTab, signedIn: boolean): boolean {
  return tab === 'popular' || signedIn;
}

/** Page one replaces the list; later pages append, skipping ids already shown. */
export function applyFeedPage(state: FeedState, page: FeedPage, mode: 'replace' | 'append'): FeedState {
  const base = mode === 'replace' ? [] : state.items;
  const seen = new Set(base.map((i) => i.id));
  const fresh = page.items.filter((i) => !seen.has(i.id));
  const items = [...base, ...fresh];
  return {
    items,
    cursor: page.next_cursor,
    hasMore: page.has_more && page.next_cursor !== null && items.length < FEED_CAUGHT_UP_AFTER,
    servedTab: page.tab === 'popular' ? 'popular' : 'friends',
    coldStart: mode === 'replace' ? coldStartBanner(page) : state.coldStart,
  };
}

/** Whether to ask for another page now. */
export function shouldLoadMore(state: FeedState, loading: boolean): boolean {
  return !loading && state.hasMore && state.cursor !== null;
}

/** The end row: shown once the feed has nothing more to ask for. */
export function isCaughtUp(state: FeedState): boolean {
  return state.items.length > 0 && !state.hasMore;
}

export interface ColdStartBanner {
  reason: 'no_follows' | 'sparse_follows' | 'no_activity';
  title: string;
  subtitle: string;
}

/** PRD §12.5's banners, from is_cold_start / cold_start_reason. */
export function coldStartBanner(page: Pick<FeedPage, 'is_cold_start' | 'cold_start_reason'>): ColdStartBanner | null {
  if (!page.is_cold_start) return null;
  switch (page.cold_start_reason) {
    case 'no_follows':
      return {
        reason: 'no_follows',
        title: 'Follow readers to build your feed',
        subtitle: 'Until then, here is what is popular on Flyleaf.',
      };
    case 'sparse_follows':
      return {
        reason: 'sparse_follows',
        title: 'Your feed is just getting started',
        subtitle: 'Cards marked "Popular on Flyleaf" fill in until you follow a few more readers.',
      };
    case 'no_activity':
      return {
        reason: 'no_activity',
        title: 'Nothing new from people you follow',
        subtitle: 'While you wait, here is what is popular.',
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- want to read

/**
 * The swipe's outcome (D-11-1): it writes only when the reader has no read
 * of the book, and Undo removes only a read the swipe itself created.
 */
export type WantToReadOutcome =
  | { kind: 'added'; readId: string }
  | { kind: 'queued'; readId: string }
  | { kind: 'already' }
  | { kind: 'failed' };

export function wantToReadToast(outcome: WantToReadOutcome): { message: string; undo: boolean; tone: 'ok' | 'info' | 'error' } {
  switch (outcome.kind) {
    case 'added':
      return { message: 'Added to Want to read', undo: true, tone: 'ok' };
    case 'queued':
      return { message: 'Added to Want to read · will sync when you are online', undo: true, tone: 'ok' };
    case 'already':
      return { message: 'Already in your library', undo: false, tone: 'info' };
    case 'failed':
      return { message: 'Could not save that. Try again.', undo: false, tone: 'error' };
  }
}

// ---------------------------------------------------------------- import banner

export interface ImportLike {
  id: string;
  state: string;
  total_rows: number;
  matched: number;
  unmatched: number;
}

/** The newest import still running, unless the reader dismissed it (A-12-023). */
export function activeImportForBanner<T extends ImportLike>(imports: T[], dismissed: ReadonlySet<string>): T | null {
  const newest = imports[0];
  if (!newest) return null;
  if (newest.state !== 'queued' && newest.state !== 'processing') return null;
  return dismissed.has(newest.id) ? null : newest;
}

export interface ProgressSample {
  at: number;
  processed: number;
}

/**
 * Seconds left, from the first and last of two or more samples (rows per
 * second × rows remaining). Null until there are two samples that moved.
 */
export function importEtaSeconds(samples: ProgressSample[], total: number): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const rows = last.processed - first.processed;
  const seconds = (last.at - first.at) / 1000;
  if (rows <= 0 || seconds <= 0) return null;
  const remaining = Math.max(total - last.processed, 0);
  return Math.ceil(remaining / (rows / seconds));
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `about ${hours} h ${rest} min left` : `about ${hours} h left`;
}
