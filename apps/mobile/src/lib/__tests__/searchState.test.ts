import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addRecent, latestOnly, MAX_RECENTS } from '../searchState';

describe('recent searches (SL-40)', () => {
  it('newest first, unique ignoring case, capped', () => {
    let r: string[] = [];
    for (let i = 0; i < 12; i++) r = addRecent(r, `query ${i}`);
    assert.equal(r.length, MAX_RECENTS);
    assert.equal(r[0], 'query 11');
    assert.deepEqual(addRecent(['Dune', 'Piranesi'], 'dune'), ['dune', 'Piranesi']);
  });

  it('ignores blanks and single characters', () => {
    assert.deepEqual(addRecent(['Dune'], '  '), ['Dune']);
    assert.deepEqual(addRecent(['Dune'], 'h'), ['Dune']);
  });
});

describe('latestOnly (A-02-017)', () => {
  it('a slow answer for an earlier query does not replace the later one', async () => {
    const guard = latestOnly();
    const shown: string[] = [];
    const request = (q: string, ms: number) => {
      const current = guard.begin();
      return new Promise<void>((resolve) => setTimeout(() => {
        if (current()) shown.push(q);
        resolve();
      }, ms));
    };
    await Promise.all([request('ha', 30), request('harry', 5)]);
    assert.deepEqual(shown, ['harry']);
  });

  it('nothing in flight is current after invalidate', () => {
    const guard = latestOnly();
    const current = guard.begin();
    guard.invalidate();
    assert.equal(current(), false);
  });
});
