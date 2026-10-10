// Audit 12 (A-12-022): the import banner's polling.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startImportPolling } from '../importPolling';

function fakeTimers() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: (fn: () => void) => { const id = next++; timers.set(id, fn); return id; },
    clearInterval: (h: unknown) => { timers.delete(h as number); },
    async tick() { for (const fn of [...timers.values()]) fn(); await new Promise((r) => setImmediate(r)); },
    get active() { return timers.size; },
  };
}

describe('startImportPolling', () => {
  test('polls while processing, stops on completed and reports done exactly once', async () => {
    const t = fakeTimers();
    const states = ['processing', 'processing', 'completed', 'completed'];
    let fetches = 0;
    let done = 0;
    startImportPolling({
      fetch: async () => ({ state: states[Math.min(fetches++, states.length - 1)]! }),
      onUpdate: () => {},
      onDone: () => { done++; },
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    await t.tick();
    await t.tick();
    await t.tick();
    assert.equal(done, 1);
    assert.equal(t.active, 0);
    assert.equal(fetches, 3);
  });

  test('an import already finished is fetched once and never polled again', async () => {
    const t = fakeTimers();
    let fetches = 0;
    let done = 0;
    startImportPolling({
      fetch: async () => { fetches++; return { state: 'failed' }; },
      onUpdate: () => {},
      onDone: () => { done++; },
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });
    await new Promise((r) => setImmediate(r));
    await t.tick();
    assert.equal(fetches, 1);
    assert.equal(done, 1);
    assert.equal(t.active, 0);
  });

  test('stop() (unmount) ends polling and drops a response in flight', async () => {
    const t = fakeTimers();
    let updates = 0;
    const stop = startImportPolling({
      fetch: async () => ({ state: 'processing' }),
      onUpdate: () => { updates++; },
      setInterval: t.setInterval,
      clearInterval: t.clearInterval,
    });
    stop();
    await new Promise((r) => setImmediate(r));
    await t.tick();
    assert.equal(updates, 0);
    assert.equal(t.active, 0);
  });
});
