// The Stars control's rules (SL-60, audit 09): half steps, and a way back to
// no rating (PRD §9.3), which the control did not have.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decrementRating, incrementRating, starTarget, tapRating } from '../stars';

describe('starTarget: the half star under the finger', () => {
  it('maps a 160-wide row to ten half steps, never 0 or above 5', () => {
    assert.equal(starTarget(-20, 160), 0.5);
    assert.equal(starTarget(0, 160), 0.5);
    assert.equal(starTarget(1, 160), 0.5);
    assert.equal(starTarget(16, 160), 0.5);
    assert.equal(starTarget(17, 160), 1.0);
    assert.equal(starTarget(80, 160), 2.5);
    assert.equal(starTarget(159, 160), 5.0);
    assert.equal(starTarget(400, 160), 5.0);
  });

  it('only ever yields half steps', () => {
    for (let x = 0; x <= 160; x += 0.7) {
      const v = starTarget(x, 160);
      assert.equal(v * 2, Math.round(v * 2), `x=${x} gave ${v}`);
    }
  });
});

describe('clearing a rating (PRD §9.3)', () => {
  it('tapping the current value clears it; any other value sets it', () => {
    assert.equal(tapRating(3.5, 3.5), null);
    assert.equal(tapRating(4, 3.5), 4);
    assert.equal(tapRating(0.5, null), 0.5);
  });

  it('the screen-reader decrement goes below half a star to no rating', () => {
    assert.equal(decrementRating(1), 0.5);
    assert.equal(decrementRating(0.5), null);
    assert.equal(decrementRating(null), null);
  });

  it('the screen-reader increment starts at half a star and stops at five', () => {
    assert.equal(incrementRating(null), 0.5);
    assert.equal(incrementRating(4.5), 5);
    assert.equal(incrementRating(5), 5);
  });
});
