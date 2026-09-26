// Live username availability for signup (PRD §6.7, SL-22; audit 07 A-07-010).
//
// - Checked 400 ms after typing stops.
// - Only the latest request may set the result: an older response arriving
//   late is dropped, and the older request is aborted.
// - Offline (or any failure): "unknown"; the server still decides on submit.

import type { UsernameAvailability } from '@flyleaf/api-client';

export type UsernameStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available' }
  | { state: 'unavailable'; reason: 'invalid' | 'reserved' | 'taken'; suggestions: string[] }
  | { state: 'unknown' };

export const USERNAME_CHECK_DELAY_MS = 400;

export function createUsernameChecker(
  check: (username: string, signal: AbortSignal) => Promise<UsernameAvailability>,
  onStatus: (status: UsernameStatus) => void,
  delayMs = USERNAME_CHECK_DELAY_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let seq = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    inflight?.abort();
    inflight = null;
  };

  return {
    /** Call on every change with the normalised name, or null when it fails local validation. */
    update(username: string | null) {
      cancel();
      const mine = ++seq;
      if (!username) {
        onStatus({ state: 'idle' });
        return;
      }
      onStatus({ state: 'checking' });
      timer = setTimeout(() => {
        const controller = new AbortController();
        inflight = controller;
        check(username, controller.signal).then(
          (r) => {
            if (mine !== seq) return;
            onStatus(
              r.available
                ? { state: 'available' }
                : { state: 'unavailable', reason: r.reason ?? 'taken', suggestions: r.suggestions ?? [] },
            );
          },
          () => {
            if (mine === seq) onStatus({ state: 'unknown' });
          },
        );
      }, delayMs);
    },
    dispose() {
      seq++;
      cancel();
    },
  };
}
