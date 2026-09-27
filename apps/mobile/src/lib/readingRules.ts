// Rules the app applies offline and the server applies on sync. They must
// agree, or a write made offline lands on a different attempt than the one
// the app shows (audit 08).

export type AttemptStatus = 'want' | 'reading' | 'paused' | 'finished' | 'dnf';

/**
 * PRD §8.1 / §8.2 [LOCKED], the same rule as `startsNewAttempt` in
 * apps/api/src/reading/index.ts: moving a terminal attempt (finished, dnf) to
 * any other status is a new attempt, so a finished or abandoned record is
 * never overwritten. The same status again edits the attempt.
 */
export function startsNewAttempt(current: AttemptStatus | null, next: AttemptStatus): boolean {
  if (current === null) return true;
  return (current === 'finished' || current === 'dnf') && next !== current;
}

/**
 * Today as the reader sees it, YYYY-MM-DD in the device's time zone
 * (PRD §8.5). `toISOString().slice(0, 10)` is the UTC date: a book finished at
 * 00:30 in India was recorded as finished the day before.
 */
export function localDate(d: Date = new Date()): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}
