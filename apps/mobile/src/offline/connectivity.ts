// What the sync provider treats as online, and when a change is a reconnect
// (D-07-2). Pure, so it runs under node --test; NetInfo feeds it in sync.tsx.

export interface NetState {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

/**
 * Only a definite "no" is offline. NetInfo reports null while it has not
 * probed yet, and a flaky probe must never stop a sync the queue would
 * survive anyway (a failed send waits without using up an attempt).
 */
export function isOnline(state: NetState): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/** Fed every state; true exactly when the connection comes back after being offline. */
export function reconnectDetector(): (state: NetState) => boolean {
  let wasOnline: boolean | null = null;
  return (state) => {
    const online = isOnline(state);
    const reconnected = wasOnline === false && online;
    wasOnline = online;
    return reconnected;
  };
}
