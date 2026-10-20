// What the sign-in screens say when a call fails (beta bug, Oct 2026).
//
// Sign-in used to say "Email or password is incorrect" for every failure,
// so a 429 from the anonymous per-IP limits, a dropped connection or a 5xx
// all read as a wrong password. Now "incorrect" is only for the server's
// 401 invalid_credentials. Still enumeration-safe: none of these messages
// depends on whether the email has an account (the 429s are counted before
// the account is looked up, PRD §6.4).
//
// No imports, so it is testable in Node (and from the API's e2e test). An
// error is read by shape: FlyleafApiError carries status, code and
// retryAfterSeconds; a failed fetch is a TypeError.

export const INCORRECT_CREDENTIALS = 'Email or password is incorrect. Please try again.';
export const UNREACHABLE = "We couldn't reach the Flyleaf server. Check your connection and try again.";

interface ApiErrorShape {
  status?: number;
  code?: string;
  retryAfterSeconds?: number;
}

function shape(err: unknown): ApiErrorShape {
  return err !== null && typeof err === 'object' ? (err as ApiErrorShape) : {};
}

/** "Try again in 3 minutes", from Retry-After; rounded up, at least a minute. */
export function tryAgainIn(retryAfterSeconds: number | undefined): string {
  if (!retryAfterSeconds || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return 'Try again in a few minutes.';
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * The message for a failure that is about the connection or the server, not
 * the request: 429, 5xx, no response at all. Null for anything else.
 */
export function transientAuthError(err: unknown): string | null {
  const { status, retryAfterSeconds } = shape(err);
  if (status === 429) return `Too many attempts. ${tryAgainIn(retryAfterSeconds)}`;
  if (typeof status === 'number' && status >= 500) return UNREACHABLE;
  if (status === undefined && err instanceof TypeError) return UNREACHABLE; // fetch failed
  return null;
}

/** The sign-in screen's message for a failed sign-in. */
export function loginErrorMessage(err: unknown): string {
  const { status, code } = shape(err);
  if (status === 401 && code === 'invalid_credentials') return INCORRECT_CREDENTIALS;
  return transientAuthError(err) ?? 'Something went wrong signing in. Please try again.';
}
