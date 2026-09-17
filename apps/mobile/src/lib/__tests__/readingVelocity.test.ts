import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { predictFinishDate } from '../readingVelocity';

describe('Reading Velocity & Predicted Finish Date (SL-52, PRD §6.15)', () => {
  it('returns Completed if progress matches or exceeds page count', () => {
    assert.equal(
      predictFinishDate({ currentPage: 300, pageCount: 300 }),
      'Completed',
    );
    assert.equal(
      predictFinishDate({ percent: 100 }),
      'Completed',
    );
  });

  it('handles empty progress gracefully', () => {
    assert.equal(
      predictFinishDate({ currentPage: 0, pageCount: 300 }),
      'Log progress to predict finish',
    );
  });

  it('predicts days left based on started_at and current page', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    // Read 100 pages in 2 days = 50 pages/day.
    // 300 - 100 = 200 pages left / 50 pages/day = 4 days left.
    const pred = predictFinishDate({
      currentPage: 100,
      pageCount: 300,
      startedAt: twoDaysAgo,
    });
    assert.match(pred, /Estimated finish: in (4|5) days/);
  });

  it('predicts finish from recent progress events slope', () => {
    const events = [
      { at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), page: 50 },
      { at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), page: 150 },
    ];
    // 100 pages in 2 days = 50 pages/day.
    // 250 - 150 = 100 pages left -> 2 days left.
    const pred = predictFinishDate({
      currentPage: 150,
      pageCount: 250,
      recentEvents: events,
    });
    assert.match(pred, /Estimated finish: in 2 days/);
  });

  it('predicts from percent when page count is unknown', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    // 50% in 5 days = 10%/day -> 5 days left.
    const pred = predictFinishDate({
      percent: 50,
      startedAt: fiveDaysAgo,
    });
    assert.match(pred, /Estimated finish: in 5 days/);
  });
});
