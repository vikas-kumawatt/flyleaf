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
  const rnName = ['react', 'native'].join('-');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = typeof require !== 'undefined' ? require(rnName) : null;
  if (rn?.Platform?.OS) PlatformOS = rn.Platform.OS;
  if (rn?.AppState) AppStateModule = rn.AppState;
} catch {
  PlatformOS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'ios' : 'android';
}

const FLUSH_INTERVAL_MS = 15_000;
const BATCH_SIZE_THRESHOLD = 20;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

let currentSessionId: string | null = null;
let lastActiveTimestamp: number = Date.now();
let eventQueue: TelemetryEvent[] = [];
let isFlushing = false;
let flushTimer: any = null;
let isInitialized = false;

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

  if (eventQueue.length >= BATCH_SIZE_THRESHOLD) {
    void flushEvents();
  }
}

/**
 * Flushes the current event buffer to the API backend.
 * Retains events in the queue if network delivery fails.
 */
export async function flushEvents(): Promise<number> {
  if (isFlushing || eventQueue.length === 0) {
    return 0;
  }

  isFlushing = true;
  const batch = [...eventQueue];
  eventQueue = [];

  try {
    const res = await sendBatch(batch);
    isFlushing = false;
    return res.accepted;
  } catch {
    // Offline resilience: prepend un-sent events back to queue (cap at 200 to prevent unbounded growth)
    eventQueue = [...batch, ...eventQueue].slice(0, 200);
    isFlushing = false;
    return 0;
  }
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
}
