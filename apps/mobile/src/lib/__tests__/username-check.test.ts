// PRD §6.7: debounced 400 ms availability check; audit 07: stale responses dropped.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createUsernameChecker, type UsernameStatus } from '../usernameCheck';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('username availability checker', () => {
  test('typing quickly sends one request, for the last value, after the delay', async () => {
    const sent: string[] = [];
    const seen: UsernameStatus[] = [];
    const checker = createUsernameChecker(
      async (u) => {
        sent.push(u);
        return { username: u, available: true };
      },
      (s) => seen.push(s),
      30,
    );
    for (const v of ['r', 're', 'rea', 'read', 'reader']) checker.update(v);
    await sleep(10);
    assert.deepEqual(sent, [], 'nothing before the delay');
    await sleep(40);
    assert.deepEqual(sent, ['reader']);
    assert.deepEqual(seen.at(-1), { state: 'available' });
  });

  test('an older response that arrives after a newer one is dropped', async () => {
    const seen: UsernameStatus[] = [];
    const checker = createUsernameChecker(
      async (u) => {
        await sleep(u === 'slow_taken' ? 80 : 5); // the first request is the slow one
        return u === 'slow_taken'
          ? { username: u, available: false, reason: 'taken', suggestions: ['x_reads'] }
          : { username: u, available: true };
      },
      (s) => seen.push(s),
      5,
    );
    checker.update('slow_taken');
    await sleep(15); // its request is in flight
    checker.update('fresh_name');
    await sleep(120);
    assert.deepEqual(seen.at(-1), { state: 'available' });
    assert.ok(!seen.some((s) => s.state === 'unavailable'), 'the stale "taken" never showed');
  });

  test('offline is "unknown", not "taken"; a locally invalid name sends nothing', async () => {
    const seen: UsernameStatus[] = [];
    let calls = 0;
    const checker = createUsernameChecker(
      async () => {
        calls++;
        throw new TypeError('Network request failed');
      },
      (s) => seen.push(s),
      5,
    );
    checker.update(null);
    assert.deepEqual(seen.at(-1), { state: 'idle' });
    checker.update('offline_name');
    await sleep(30);
    assert.equal(calls, 1);
    assert.deepEqual(seen.at(-1), { state: 'unknown' });
  });
});
