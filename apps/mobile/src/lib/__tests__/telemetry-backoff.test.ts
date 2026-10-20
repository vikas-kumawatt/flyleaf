// Beta bug (Oct 2026): a failing telemetry batch was re-sent every 15 s for
// ever, and after sign-out every attempt counted against the anonymous
// per-IP Global tier that sign-in is checked against. Now: batches of at
// most 100 (the server's cap), 429 waits for Retry-After, no response or 5xx
// backs off, a batch refused for good is dropped, and sign-out resets it all.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BATCH,
  clearEventQueue,
  flushEvents,
  getPendingEventQueue,
  resetTelemetry,
  setTelemetryClock,
  setTelemetryTransport,
  track,
} from '../events';

let clock = 1_000_000;
const httpError = (status: number, retryAfterSeconds?: number) =>
  Object.assign(new Error(`HTTP ${status}`), { status, retryAfterSeconds });

function fill(n: number) {
  for (let i = 0; i < n; i++) track('book_added', { i });
}

describe('telemetry delivery backs off', () => {
  beforeEach(() => {
    clock = 1_000_000;
    setTelemetryClock(() => clock);
    setTelemetryTransport(async () => ({ accepted: 0 }));
    clearEventQueue();
  });
  afterEach(() => {
    setTelemetryTransport(null);
    setTelemetryClock(null);
    clearEventQueue();
  });

  test('never sends more than the server takes in one batch', async () => {
    const sizes: number[] = [];
    fill(19); // under the auto-flush threshold
    setTelemetryTransport(async (batch) => {
      sizes.push(batch.length);
      return { accepted: batch.length };
    });
    fill(181); // 200 waiting, as after a stretch offline
    while (getPendingEventQueue().length > 0) await flushEvents();
    assert.ok(sizes.every((n) => n <= MAX_BATCH), String(sizes));
    assert.equal(sizes.reduce((a, b) => a + b, 0), 200);
  });

  test('a 429 waits for Retry-After before sending again', async () => {
    let calls = 0;
    setTelemetryTransport(async () => {
      calls++;
      throw httpError(429, 600);
    });
    fill(1);
    await flushEvents();
    for (let t = 0; t < 39; t++) {
      clock += 15_000; // the 15 s timer, for 9m45s
      await flushEvents();
    }
    assert.equal(calls, 1);
    assert.equal(getPendingEventQueue().length, 1, 'kept for later');
    clock += 15_000;
    await flushEvents();
    assert.equal(calls, 2);
  });

  test('no response backs off exponentially, and success resets it', async () => {
    const at: number[] = [];
    let fail = true;
    setTelemetryTransport(async (batch) => {
      at.push(clock);
      if (fail) throw new TypeError('Network request failed');
      return { accepted: batch.length };
    });
    fill(1);
    for (let t = 0; t < 40; t++) {
      await flushEvents();
      clock += 15_000;
    }
    // 10 minutes of 15 s ticks: 40 sends before; now only a handful.
    assert.ok(at.length <= 6, `sent ${at.length} times`);
    fail = false;
    clock += 10 * 60_000;
    await flushEvents();
    assert.equal(getPendingEventQueue().length, 0);
    fill(1);
    await flushEvents();
    assert.equal(getPendingEventQueue().length, 0, 'no backoff left after a success');
  });

  test('a batch the server refuses for good (400) is dropped, not retried', async () => {
    let calls = 0;
    setTelemetryTransport(async () => {
      calls++;
      throw httpError(400);
    });
    fill(3);
    await flushEvents();
    clock += 15_000;
    await flushEvents();
    assert.equal(calls, 1);
    assert.equal(getPendingEventQueue().length, 0);
  });

  test('sign-out drops the queue and the backoff; a send in flight is not re-queued into the next session', async () => {
    let release!: (err: Error) => void;
    setTelemetryTransport(() => new Promise((_, reject) => (release = reject)));
    fill(2);
    const inFlight = flushEvents();
    resetTelemetry();
    release(new TypeError('Network request failed'));
    await inFlight;
    assert.equal(getPendingEventQueue().length, 0);

    setTelemetryTransport(async (batch) => ({ accepted: batch.length }));
    fill(1);
    assert.equal(await flushEvents(), 1, 'the next session sends at once');
  });

  test('the buffer stays bounded while backing off', async () => {
    setTelemetryTransport(async () => {
      throw httpError(429, 3600);
    });
    fill(1);
    await flushEvents();
    fill(500);
    assert.ok(getPendingEventQueue().length <= 200);
  });
});
