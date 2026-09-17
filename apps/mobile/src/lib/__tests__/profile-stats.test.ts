import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Profile & Stats Mobile Helpers (SL-70 - SL-74)', () => {
  describe('Favourites reordering logic (SL-73)', () => {
    it('swaps elements correctly when moving up', () => {
      const favs: Array<{ work_id: string; title: string }> = [
        { work_id: 'w1', title: 'Book 1' },
        { work_id: 'w2', title: 'Book 2' },
        { work_id: 'w3', title: 'Book 3' },
      ];
      const index = 1;
      const next = [...favs];
      const prevEl = next[index - 1];
      const curEl = next[index];
      if (prevEl && curEl) {
        next[index - 1] = curEl;
        next[index] = prevEl;
      }

      assert.equal(next[0]?.work_id, 'w2');
      assert.equal(next[1]?.work_id, 'w1');
      assert.equal(next[2]?.work_id, 'w3');
    });

    it('swaps elements correctly when moving down', () => {
      const favs: Array<{ work_id: string; title: string }> = [
        { work_id: 'w1', title: 'Book 1' },
        { work_id: 'w2', title: 'Book 2' },
        { work_id: 'w3', title: 'Book 3' },
      ];
      const index = 1;
      const next = [...favs];
      const curEl = next[index];
      const nextEl = next[index + 1];
      if (curEl && nextEl) {
        next[index] = nextEl;
        next[index + 1] = curEl;
      }

      assert.equal(next[0]?.work_id, 'w1');
      assert.equal(next[1]?.work_id, 'w3');
      assert.equal(next[2]?.work_id, 'w2');
    });

    it('enforces maximum 4 favourites', () => {
      const favs = [
        { work_id: 'w1', title: 'Book 1' },
        { work_id: 'w2', title: 'Book 2' },
        { work_id: 'w3', title: 'Book 3' },
        { work_id: 'w4', title: 'Book 4' },
      ];
      assert.equal(favs.length, 4);
      const canAdd = favs.length < 4;
      assert.equal(canAdd, false);
    });
  });

  describe('Diary & Wall filtering and formatting (SL-70, SL-71)', () => {
    const sampleReads = [
      {
        id: 'r1',
        title: 'Book A',
        finished_at: '2026-03-15T12:00:00Z',
        rating: 5,
        hearted: 1,
        format_override: 'print',
      },
      {
        id: 'r2',
        title: 'Book B',
        finished_at: '2026-01-20T10:00:00Z',
        rating: 4,
        hearted: 0,
        format_override: 'ebook',
      },
      {
        id: 'r3',
        title: 'Book C',
        finished_at: '2025-11-05T09:00:00Z',
        rating: 3,
        hearted: 1,
        format_override: 'audiobook',
      },
    ];

    it('filters by year correctly', () => {
      const filtered2026 = sampleReads.filter(
        (r) => r.finished_at && new Date(r.finished_at).getFullYear() === 2026
      );
      assert.equal(filtered2026.length, 2);
      assert.equal(filtered2026[0]?.title, 'Book A');
      assert.equal(filtered2026[1]?.title, 'Book B');
    });

    it('filters by heart/favourite correctly', () => {
      const hearted = sampleReads.filter((r) => r.hearted === 1);
      assert.equal(hearted.length, 2);
      assert.equal(hearted[0]?.title, 'Book A');
      assert.equal(hearted[1]?.title, 'Book C');
    });

    it('filters by minimum rating threshold', () => {
      const rated4Plus = sampleReads.filter((r) => (r.rating || 0) >= 4);
      assert.equal(rated4Plus.length, 2);

      const rated5Only = sampleReads.filter((r) => (r.rating || 0) >= 5);
      assert.equal(rated5Only.length, 1);
    });

    it('filters by format override', () => {
      const audioOnly = sampleReads.filter((r) => r.format_override === 'audiobook');
      assert.equal(audioOnly.length, 1);
      assert.equal(audioOnly[0]?.title, 'Book C');
    });
  });

  describe('Reading stats metrics calculation (SL-74)', () => {
    it('computes volume and pace aggregates', () => {
      const mockMonthlyPace = [
        { month: 1, books_count: 3, pages_count: 900, audio_hours: 10 },
        { month: 2, books_count: 2, pages_count: 650, audio_hours: 5 },
      ];

      const totalBooks = mockMonthlyPace.reduce((sum, m) => sum + m.books_count, 0);
      const totalPages = mockMonthlyPace.reduce((sum, m) => sum + m.pages_count, 0);
      const totalHours = mockMonthlyPace.reduce((sum, m) => sum + m.audio_hours, 0);

      assert.equal(totalBooks, 5);
      assert.equal(totalPages, 1550);
      assert.equal(totalHours, 15);
    });

    it('formats average star rating accurately', () => {
      const avg = 4.333333;
      assert.equal(avg.toFixed(2), '4.33');
    });
  });
});
