import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, startsNewAttempt, type AttemptStatus } from '../readingRules';

const STATUSES: AttemptStatus[] = ['want', 'reading', 'paused', 'finished', 'dnf'];

describe('startsNewAttempt (PRD §8.2 [LOCKED], same rule as the server)', () => {
  it('a first log is always a new attempt', () => {
    for (const s of STATUSES) assert.equal(startsNewAttempt(null, s), true);
  });

  it('a terminal attempt moved to another status is a new attempt; nothing else is', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const terminal = from === 'finished' || from === 'dnf';
        assert.equal(startsNewAttempt(from, to), terminal && from !== to, `${from} → ${to}`);
      }
    }
  });
});

describe('localDate (PRD §8.5)', () => {
  it('is the device-local calendar date, not the UTC one', () => {
    // 00:30 local on 27 Sep. In any zone east of UTC this instant is still
    // 26 Sep in UTC, which is what toISOString() used to record.
    const lateNight = new Date(2026, 8, 27, 0, 30);
    assert.equal(localDate(lateNight), '2026-09-27');
  });

  it('pads month and day', () => {
    assert.equal(localDate(new Date(2026, 0, 5, 12)), '2026-01-05');
  });
});
