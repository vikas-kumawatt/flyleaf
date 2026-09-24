// Comment thread helpers (SO-22, PRD §6.28).
//
// Pure functions so the rules are testable without rendering: what the
// composer accepts, what each server refusal means to a reader, and how pages
// of a thread merge without duplicating a comment the user just posted.

export const COMMENT_MAX_LENGTH = 2000;
/** Show the counter once the reader is close enough for it to matter. */
export const COMMENT_COUNTER_THRESHOLD = 1800;

export type CommentValidation =
  | { ok: true; body: string }
  | { ok: false; reason: 'empty' | 'too_long' };

export function validateCommentBody(raw: string): CommentValidation {
  const body = raw.trim();
  if (!body) return { ok: false, reason: 'empty' };
  if (body.length > COMMENT_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, body };
}

/** Copy for each refusal the API can give. Neutral, never blaming. */
export function commentErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'rate_limited':
      return 'You’re commenting quickly — try again in a minute.';
    case 'thread_locked':
      return 'This review was removed, so its comments are closed.';
    case 'not_commentable':
      return 'Comments open once the book is finished or set aside.';
    case 'not_found':
      return 'This post isn’t available.';
    case 'body_too_long':
      return `Comments can be up to ${COMMENT_MAX_LENGTH.toLocaleString()} characters.`;
    case 'empty_body':
      return 'Write something first.';
    default:
      return 'Couldn’t post your comment. Please try again.';
  }
}

/**
 * Append a page to a thread, oldest-first, dropping ids already present —
 * a comment the user just posted optimistically will also arrive in the next
 * page from the server.
 */
export function mergeCommentPages<T extends { id: string }>(existing: T[], page: T[]): T[] {
  const seen = new Set(existing.map((c) => c.id));
  return [...existing, ...page.filter((c) => !seen.has(c.id))];
}

/**
 * Optimistic like state. The client sends the state it WANTS (POST or
 * DELETE), never a flip, so replaying the request cannot undo it.
 */
export function nextLikeState(current: { liked: boolean; count: number }): { liked: boolean; count: number } {
  return current.liked
    ? { liked: false, count: Math.max(0, current.count - 1) }
    : { liked: true, count: current.count + 1 };
}
