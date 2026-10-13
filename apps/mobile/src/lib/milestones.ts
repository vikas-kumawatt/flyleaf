// Milestone moments on the phone (ST-10; PRD §18.4). Pure: the words for each
// moment, how it is shown, what it offers to share, and the queue of finishes
// whose "longest book yet" note is still to check.
//
// In-app only (§18.4 "never becomes a push"): the server never pushes these;
// the app shows them when it next talks to the server after the write that
// reached them (a finish is saved offline first and synced).
//
// Tone (§18.3, design.md §8): a mirror, not a scoreboard. Nothing says what
// comes next, how far away it is, or compares the reader with anyone.

import type { Milestone, ShareCard } from '@flyleaf/api-client';

export interface Moment {
  key: string;
  /** 'full': a full-screen moment; 'subtle': a short banner. */
  style: 'full' | 'subtle';
  title: string;
  body: string;
  /** What "Share" opens in the preview, if anything. */
  share: ShareCard | null;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);

/** The moment for a milestone, or null for one that has none (the first follower is a note in the list). */
export function momentFor(m: Milestone, userId: string): Moment | null {
  if (m.treatment === 'note') return null;
  const books = /^books_(\d+)$/.exec(m.key);
  if (books) {
    const n = Number(books[1]);
    if (n === 1) {
      const readId = str(m.data.read_id);
      return {
        key: m.key, style: 'full', title: 'Your first book',
        body: 'Your first finished book on Flyleaf. Here’s to the reading ahead.',
        share: readId ? { template: 'finish', readId } : null,
      };
    }
    if (m.treatment === 'subtle') return { key: m.key, style: 'subtle', title: `${n} books`, body: `${n} finished books on Flyleaf.`, share: null };
    const words: Record<number, string> = { 100: 'One hundred', 500: 'Five hundred', 1000: 'One thousand' };
    return {
      key: m.key, style: 'full', title: `${n.toLocaleString('en-GB')} books`,
      body: `${words[n] ?? n.toLocaleString('en-GB')} finished books on Flyleaf.`,
      share: { template: 'stat', userId, stat: 'books', year: 'all' },
    };
  }
  const goal = /^goal_(\d{4})$/.exec(m.key);
  if (goal) {
    return {
      key: m.key, style: 'full', title: 'Goal reached', body: `You reached your ${goal[1]} reading goal.`,
      share: { template: 'stat', userId, stat: 'books', year: Number(goal[1]) },
    };
  }
  if (m.key === 'first_review') {
    const reviewId = str(m.data.review_id);
    return {
      key: m.key, style: 'full', title: 'Your first review',
      body: 'Thank you for writing it. A few honest lines are how readers find their next book.',
      share: reviewId ? { template: 'review', reviewId } : null,
    };
  }
  return null;
}

/** §18.4 "Longest book yet: inline note on the finish screen". */
export const LONGEST_YET: Moment = { key: 'longest_yet', style: 'subtle', title: 'Longest book yet', body: 'Your longest book yet.', share: null };

// Finishes whose "longest yet" note is still to check once they reach the server.
const pending = new Set<string>();
const listeners = new Set<() => void>();

/** The finish screen calls this after saving: the bridge checks once the finish has synced. */
export function requestMilestoneCheck(readId?: string): void {
  if (readId) pending.add(readId);
  for (const l of listeners) l();
}

export function takePendingReads(): string[] {
  const ids = [...pending];
  pending.clear();
  return ids;
}

export function onMilestoneRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
