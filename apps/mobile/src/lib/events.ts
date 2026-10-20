// First-party client telemetry emitter & event queue (SL-80, Architecture §3.7, PRD §28.1).
//
// Ingests app interactions, tracks session lifetimes, buffers events in memory,
// and flushes batches automatically with offline safety (events are preserved if network fails).

import type { TelemetryEvent } from '@flyleaf/api-client';

export type TelemetryTransport = (events: TelemetryEvent[]) => Promise<{ accepted: number }>;
let customTransport: TelemetryTransport | null = null;

export function setTelemetryTransport(transport: TelemetryTransport | null): void {
  customTransport = transport;
}

async function sendBatch(batch: TelemetryEvent[]): Promise<{ accepted: number }> {
  if (customTransport) {
    return customTransport(batch);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { api } = require('./api');
  return api.postEvents(batch);
}

// Safe runtime module resolution: in Metro/Expo, resolves react-native; in Node/tsx tests, prevents esbuild Flow parsing error
let PlatformOS = 'ios';
let AppStateModule: any = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = typeof require !== 'undefined' ? require('react-native') : null;
  if (rn?.Platform?.OS) PlatformOS = rn.Platform.OS;
  if (rn?.AppState) AppStateModule = rn.AppState;
} catch {
  PlatformOS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'ios' : 'android';
}

const FLUSH_INTERVAL_MS = 15_000;
const BATCH_SIZE_THRESHOLD = 20;
/** POST /v1/events takes at most 100 events; a bigger batch is a 400 every time. */
export const MAX_BATCH = 100;
const MAX_QUEUE = 200;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

let currentSessionId: string | null = null;
let lastActiveTimestamp: number = Date.now();
let eventQueue: TelemetryEvent[] = [];
let isFlushing = false;
let flushTimer: any = null;
let isInitialized = false;
// Backoff (beta bug, Oct 2026). Without it a failing batch was re-sent every
// 15 s forever: a 429 retried at once, a 400 (over MAX_BATCH) never
// succeeding. Signed out, every one of those counts against the per-IP
// anonymous Global tier, the same budget sign-in is checked against.
let retryAt = 0;
let failures = 0;
/** Bumped by resetTelemetry(): a send in flight then belongs to a session that has ended. */
let generation = 0;
let now: () => number = Date.now;

/** For testing: the clock the backoff reads. */
export function setTelemetryClock(clock: (() => number) | null): void {
  now = clock ?? Date.now;
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto?.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {
      // Fallback
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Returns the current active session ID, rotating it if idle for >30m.
 */
export function getSessionId(): string {
  const now = Date.now();
  if (!currentSessionId || now - lastActiveTimestamp > SESSION_IDLE_TIMEOUT_MS) {
    currentSessionId = generateUUID();
  }
  lastActiveTimestamp = now;
  return currentSessionId;
}

/**
 * Explicitly resets or rotates the session (e.g. on user logout).
 */
export function resetSessionId(): string {
  currentSessionId = generateUUID();
  lastActiveTimestamp = Date.now();
  return currentSessionId;
}

/**
 * Enqueues a telemetry event for background batch delivery.
 */
export function track(name: string, properties: Record<string, any> = {}): void {
  const event: TelemetryEvent = {
    name,
    session_id: getSessionId(),
    platform: PlatformOS,
    app_version: '1.0.0',
    properties,
    at: new Date().toISOString(),
  };

  eventQueue.push(event);
  // While backing off the buffer still fills; it stays bounded.
  if (eventQueue.length > MAX_QUEUE) eventQueue = eventQueue.slice(-MAX_QUEUE);

  if (eventQueue.length >= BATCH_SIZE_THRESHOLD) {
    void flushEvents();
  }
}

/**
 * Sends the oldest MAX_BATCH buffered events to the API backend.
 * - success: the next batch goes on the next tick;
 * - 429: nothing is sent until the server's Retry-After has passed;
 * - no response, 408 or 5xx: kept, and retried with exponential backoff;
 * - any other 4xx: the server will never take this batch, so it is dropped.
 */
export async function flushEvents(): Promise<number> {
  if (isFlushing || eventQueue.length === 0 || now() < retryAt) {
    return 0;
  }

  isFlushing = true;
  const sentIn = generation;
  const batch = eventQueue.slice(0, MAX_BATCH);
  eventQueue = eventQueue.slice(MAX_BATCH);

  try {
    const res = await sendBatch(batch);
    failures = 0;
    retryAt = 0;
    return res.accepted;
  } catch (err) {
    if (sentIn !== generation) return 0; // signed out meanwhile: not this session's to retry
    const { status, retryAfterSeconds } = (err ?? {}) as { status?: number; retryAfterSeconds?: number };
    if (status === 429) {
      retryAt = now() + (retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds : 60) * 1000;
    } else if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
      return 0; // refused for good: dropped
    } else {
      failures++;
      retryAt = now() + Math.min(FLUSH_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
    }
    // Offline resilience: put the batch back in front (capped to prevent unbounded growth)
    eventQueue = [...batch, ...eventQueue].slice(0, MAX_QUEUE);
    return 0;
  } finally {
    isFlushing = false;
  }
}

/**
 * Sign-out: the session's unsent events and its backoff go with it, and the
 * next session gets a new id. Events are not attributed to the next account,
 * and a retry loop cannot outlive the session it belonged to.
 */
export function resetTelemetry(): void {
  generation++;
  eventQueue = [];
  retryAt = 0;
  failures = 0;
  resetSessionId();
}

/**
 * Initializes automatic background flush hooks and lifecycle listeners.
 */
export function initTelemetry(): () => void {
  if (isInitialized) return () => {};
  isInitialized = true;

  getSessionId();

  // Periodic flush
  flushTimer = setInterval(() => {
    if (eventQueue.length > 0) {
      void flushEvents();
    }
  }, FLUSH_INTERVAL_MS);

  // Flush on app backgrounding if AppState is available
  let subscription: any = null;
  if (AppStateModule?.addEventListener) {
    subscription = AppStateModule.addEventListener('change', (state: any) => {
      if (state !== 'active') {
        void flushEvents();
      } else {
        lastActiveTimestamp = Date.now();
      }
    });
  }

  return () => {
    if (flushTimer) clearInterval(flushTimer);
    if (subscription?.remove) subscription.remove();
    isInitialized = false;
  };
}

/**
 * For testing: returns currently buffered events.
 */
export function getPendingEventQueue(): TelemetryEvent[] {
  return [...eventQueue];
}

/**
 * For testing: clears buffered events.
 */
export function clearEventQueue(): void {
  eventQueue = [];
  retryAt = 0;
  failures = 0;
}
