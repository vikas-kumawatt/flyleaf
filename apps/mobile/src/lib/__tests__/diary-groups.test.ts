// Audit 10 (SL-70): Diary grouping and totals, against the screen's own code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diaryPages, groupDiary } from '../diaryGroups.js';

describe('Diary groups (SL-70, PRD §6.18, §17.4)', () => {
  it('groups by the finish date as written, newest first, whatever the device time zone', () => {
    // West of Greenwich, new Date('2025-03-01') is still 28 February.
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    const groups = groupDiary([
      { id: 'a', finished_at: '2025-03-01' },
      { id: 'b', finished_at: '2025-02-28' },
      { id: 'c', finished_at: '2025-03-31' },
    ], 'en-GB');
    assert.deepEqual(groups.map((g) => g.monthKey), ['2025-03', '2025-02']);
    assert.deepEqual(groups[0]!.reads.map((r) => r.id), ['c', 'a']);
    assert.equal(groups[0]!.monthLabel, 'March 2025');
    process.env.TZ = tz;
  });

  it('a finish without a date is "Undated", last, never placed by another date', () => {
    const groups = groupDiary([
      { id: 'imported', finished_at: null, updated_at: '2026-10-01T10:00:00Z' },
      { id: 'dated', finished_at: '2024-06-02' },
    ]);
    assert.deepEqual(groups.map((g) => [g.monthKey, g.reads.map((r) => r.id)]), [
      ['2024-06', ['dated']],
      ['undated', ['imported']],
    ]);
    assert.equal(groups[1]!.monthLabel, 'Undated');
  });

  it('pages are the books\' page counts, not the bookmark position', () => {
    assert.equal(diaryPages([{ finished_at: '2025-01-01', page_count: 320 }, { finished_at: null, page_count: null }]), 320);
  });
});
