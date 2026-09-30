// The histogram's five bars from the API's ten half-star buckets (audit 09b,
// A-09-029): grouped by the reviews filter's rule, so a bar and its chip agree.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RatingBucket } from '@flyleaf/api-client';
import { starBars } from '../ratingBars';

const KEYS: RatingBucket[] = ['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0'];

describe('starBars', () => {
  it('puts every half-star bucket in the bar whose rating chip lists it', () => {
    // The server's filter for chip n: rating > n - 1 AND rating <= n (reviews/index.ts).
    const chipFor = (rating: number) => [1, 2, 3, 4, 5].filter((n) => rating > n - 1 && rating <= n);
    for (const key of KEYS) {
      const bars = starBars({ [key]: 1 });
      const lit = bars.filter((b) => b.count > 0).map((b) => b.stars);
      assert.deepEqual(lit, chipFor(Number(key)), `bucket ${key}`);
    }
  });

  it('sums both halves of a bar and keeps the total', () => {
    const bars = starBars({ '0.5': 1, '1.0': 0, '1.5': 2, '2.0': 3, '2.5': 0, '3.0': 0, '3.5': 4, '4.0': 5, '4.5': 6, '5.0': 7 });
    assert.deepEqual(bars.map((b) => [b.stars, b.count]), [[5, 13], [4, 9], [3, 0], [2, 5], [1, 1]]);
    assert.equal(bars.reduce((a, b) => a + b.count, 0), 28);
    assert.equal(bars[0]!.pct, 46);
  });

  it('draws five empty bars for a book nobody rated', () => {
    assert.deepEqual(starBars(undefined).map((b) => [b.stars, b.count, b.pct]), [[5, 0, 0], [4, 0, 0], [3, 0, 0], [2, 0, 0], [1, 0, 0]]);
  });
});
