import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { predictFinishDate } from '../readingVelocity';

// A fixed clock. Every timestamp below is built from NOW and passed to the
// function as its `now`, so no assertion depends on how much wall-clock time
// passes between building the input and running the prediction (audit 08,
// A-02-021: this suite failed CI when two Date.now() calls straddled a tick).
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number, extraMs = 0) => new Date(NOW - n * DAY + extraMs).toISOString();

describe('Reading Velocity & Predicted Finish Date (SL-52, PRD §6.15)', () => {
  it('returns Completed if progress matches or exceeds page count', () => {
    assert.equal(
      predictFinishDate({ currentPage: 300, pageCount: 300 }, NOW),
      'Completed',
    );
    assert.equal(
      predictFinishDate({ percent: 100 }, NOW),
      'Completed',
    );
  });

  it('handles empty progress gracefully', () => {
    assert.equal(
      predictFinishDate({ currentPage: 0, pageCount: 300 }, NOW),
      'Log progress to predict finish',
    );
  });

  it('predicts days left based on started_at and current page', () => {
    // Read 100 pages in 2 days = 50 pages/day.
    // 300 - 100 = 200 pages left / 50 pages/day = 4 days left.
    const pred = predictFinishDate({
      currentPage: 100,
      pageCount: 300,
      startedAt: daysAgo(2),
    }, NOW);
    assert.equal(pred, 'Estimated finish: in 4 days');
  });

  it('predicts finish from recent progress events slope', () => {
    const events = [
      { at: daysAgo(3), page: 50 },
      { at: daysAgo(1), page: 150 },
    ];
    // 100 pages in 2 days = 50 pages/day.
    // 250 - 150 = 100 pages left -> 2 days left.
    const pred = predictFinishDate({
      currentPage: 150,
      pageCount: 250,
      recentEvents: events,
    }, NOW);
    assert.equal(pred, 'Estimated finish: in 2 days');
  });

  it('a span a few milliseconds over a whole number of days does not add a day', () => {
    // The CI failure: 100 pages over 2 days + 5 ms is 49.9999 pages/day, and
    // ceil(100 / 49.9999) = ceil(2.000001) = 3.
    const events = [
      { at: daysAgo(3), page: 50 },
      { at: daysAgo(1, 5), page: 150 },
    ];
    const pred = predictFinishDate({
      currentPage: 150,
      pageCount: 250,
      recentEvents: events,
    }, NOW);
    assert.equal(pred, 'Estimated finish: in 2 days');
  });

  it('predicts from percent when page count is unknown', () => {
    // 50% in 5 days = 10%/day -> 5 days left.
    const pred = predictFinishDate({
      percent: 50,
      startedAt: daysAgo(5),
    }, NOW);
    assert.equal(pred, 'Estimated finish: in 5 days');
  });

  it('dates a long prediction from the given clock, not the wall clock', () => {
    // 10 pages in 2 days = 5 pages/day (the floor); 190 left -> 38 days.
    // NOW is 26 Sep 2026 12:00 UTC, so 38 days on is 3 Nov.
    const pred = predictFinishDate({
      currentPage: 10,
      pageCount: 200,
      startedAt: daysAgo(2),
    }, NOW);
    const expected = new Date(NOW + 38 * DAY);
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][expected.getMonth()];
    assert.equal(pred, `Estimated finish: ${month} ${expected.getDate()}`);
  });
});
