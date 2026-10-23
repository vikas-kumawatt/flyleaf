// Settings → Delete account (LA-01, PRD §25.4, AC-17).
//
// The words the flow shows, in one place, so the consequences the owner
// confirms are the ones the server carries out (identity/index.ts
// deleteAccount and the retention sweep). No imports: testable in Node.

/** Step 1 (PRD §25.4): what will be lost, in plain language. */
export const WHAT_IS_LOST: readonly string[] = [
  'Your reading history: every read, rating, diary entry and reading date.',
  'Your reviews, comments and likes.',
  'Your shelves and lists.',
  'Your profile, username, followers and the people you follow.',
  'Your stats, goals and Year in Review.',
];

/** Step 3: what stays after 30 days (PRD §25.4 step 6, disclosed in the privacy policy). */
export const WHAT_STAYS =
  "Ratings stay only as an anonymous part of each book's average. Nothing in it points back to you.";

/** Days between deletion and the permanent delete (jobs/retention.ts SOFT_DELETE_DAYS). */
export const GRACE_DAYS = 30;

export const GRACE_PROMISE = `Changed your mind? Sign in within ${GRACE_DAYS} days and everything comes back as it was.`;

export const RESTORED_TITLE = 'Welcome back';
export const RESTORED_MESSAGE = 'Your account has been restored and will not be deleted.';

/** "23 November 2026", from the server's purgeAfter. */
export function formatPurgeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `in ${GRACE_DAYS} days`;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The confirmation after the server said yes. */
export function deletedMessage(purgeAfter: string): string {
  return `Your account is deleted and no one can see it. Sign in before ${formatPurgeDate(purgeAfter)} to restore it; after that it is gone for good.`;
}

interface ApiErrorShape {
  status?: number;
  code?: string;
  retryAfterSeconds?: number;
}

/** What the password step says when the request fails. */
export function deleteErrorMessage(err: unknown): string {
  const { status, code, retryAfterSeconds } = err !== null && typeof err === 'object' ? (err as ApiErrorShape) : {};
  if (status === 422 && code === 'wrong_password') return 'That password is not right.';
  if (status === 422) return 'Enter your password.';
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60));
    return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }
  if (status === 401) return 'Your session has ended. Sign in again, then delete your account from here.';
  if (status === undefined && err instanceof TypeError) return "We couldn't reach the Flyleaf server. Nothing was deleted.";
  return 'Something went wrong. Nothing was deleted; try again in a moment.';
}
