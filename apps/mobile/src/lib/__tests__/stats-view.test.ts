// Audit 10: the stats screen's rules, tested against the functions the
// screen runs (lib/statsView.ts). The server sends ten half-star buckets
// (A-09-043), an unknown format, a DNF fraction and a §17.4 disclosure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dnfPercent, excludedNote, formatShares, statsRatingRows } from '../statsView.js';

describe('stats screen helpers (SL-74, audit 10)', () => {
  it('draws the ten half-star buckets, 5.0 first, scaled to the fullest', () => {
    const rows = statsRatingRows({ '4.5': 2, '0.5': 1 });
    assert.deepEqual(rows.map((r) => r.bucket), ['5.0', '4.5', '4.0', '3.5', '3.0', '2.5', '2.0', '1.5', '1.0', '0.5']);
    assert.deepEqual(rows.map((r) => r.count), [0, 2, 0, 0, 0, 0, 0, 0, 0, 1]);
    assert.equal(rows[1]!.fill, 100);
    assert.equal(rows[9]!.fill, 50);
    // The old five-key shape draws nothing rather than inventing bars.
    assert.ok(statsRatingRows({ '5': 3 } as never).every((r) => r.count === 0));
  });

  it('shows unknown formats as unknown, never as print, and only when there are any', () => {
    const shares = formatShares({ print: 1, ebook: 1, audiobook: 0, unknown: 2 });
    assert.deepEqual(shares, [
      { key: 'print', count: 1, pct: 25 },
      { key: 'ebook', count: 1, pct: 25 },
      { key: 'audiobook', count: 0, pct: 0 },
      { key: 'unknown', count: 2, pct: 50 },
    ]);
    assert.equal(formatShares({ print: 2, ebook: 0, audiobook: 0, unknown: 0 }).some((s) => s.key === 'unknown'), false);
    assert.deepEqual(formatShares({ print: 0, ebook: 0, audiobook: 0, unknown: 0 }), []);
  });

  it('the DNF rate is a fraction on the wire and a percent on screen', () => {
    assert.equal(dnfPercent(0.12), 12);
    assert.equal(dnfPercent(0), 0);
  });

  it('§17.4: says what was left out, and nothing when nothing was', () => {
    assert.equal(excludedNote({ year: '2025', excluded: { undated: 0, missing_page_count: 0 } }), null);
    assert.equal(
      excludedNote({ year: '2025', excluded: { undated: 2, missing_page_count: 1 } }),
      '2 finished books have no finish date and are only counted in All time. 1 book has no page count and adds no pages.',
    );
    assert.match(excludedNote({ year: 'all', excluded: { undated: 1, missing_page_count: 0 } })!, /counted here but not in any month/);
  });
});
