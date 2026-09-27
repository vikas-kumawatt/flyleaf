// Discover search: which response may update the screen, and what counts as
// a recent search (SL-40, audit 08 / A-02-017).

export const MAX_RECENTS = 10;

/**
 * A query the user meant: submitted, or a result opened from it. Newest
 * first, case-insensitively unique, at most MAX_RECENTS. Every debounced
 * keystroke used to be saved ("ha", "har", "harr"…).
 */
export function addRecent(recents: string[], query: string): string[] {
  const q = query.trim();
  if (q.length < 2) return recents;
  return [q, ...recents.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENTS);
}

/**
 * Only the latest request may update the screen. The effect used to cancel
 * the debounce timer but not the request, so a slow answer for "ha" could
 * land after "harry" and replace its results.
 */
export function latestOnly() {
  let seq = 0;
  return {
    /** Call when a request starts; the returned check says whether it is still the latest. */
    begin(): () => boolean {
      const mine = ++seq;
      return () => mine === seq;
    },
    /** The query changed or the screen left: nothing in flight is current any more. */
    invalidate(): void {
      seq++;
    },
  };
}
