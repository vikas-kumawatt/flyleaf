// What the review composer sends (audit 09). It used to send the rating and
// heart it happened to have loaded (blank when loading failed: a posted
// review wiped the read's rating), and a spoiler page with the switch off.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPayload, canReview, type ComposerState } from '../reviewPayload';

const base: ComposerState = {
  body: '  A slow burn.  ',
  hasSpoilers: false,
  spoilerAfterPage: '',
  visibility: 'followers',
  rating: null,
  ratingTouched: false,
  hearted: false,
  heartTouched: false,
};

describe('buildReviewPayload', () => {
  it('leaves an untouched rating and heart out, so the read keeps its own', () => {
    const p = buildReviewPayload(base);
    assert.equal('rating' in p, false);
    assert.equal('hearted' in p, false);
    assert.equal(p.body, 'A slow burn.');
    assert.equal(p.visibility, 'followers');
  });

  it('sends a changed rating, and null when the writer cleared it', () => {
    assert.equal(buildReviewPayload({ ...base, rating: 3.5, ratingTouched: true }).rating, 3.5);
    const cleared = buildReviewPayload({ ...base, rating: null, ratingTouched: true });
    assert.equal('rating' in cleared, true);
    assert.equal(cleared.rating, null);
    assert.equal(buildReviewPayload({ ...base, hearted: false, heartTouched: true }).hearted, false);
  });

  it('sends the spoiler page only with the spoiler switch on', () => {
    assert.equal(buildReviewPayload({ ...base, hasSpoilers: false, spoilerAfterPage: '120' }).spoiler_after_page, null);
    assert.equal(buildReviewPayload({ ...base, hasSpoilers: true, spoilerAfterPage: '120' }).spoiler_after_page, 120);
    assert.equal(buildReviewPayload({ ...base, hasSpoilers: true, spoilerAfterPage: '' }).spoiler_after_page, null);
  });
});

describe('canReview (A-09-026: the want list cannot be reviewed)', () => {
  it('needs a read that has been started', () => {
    assert.equal(canReview(null), false);
    assert.equal(canReview(undefined), false);
    assert.equal(canReview('want'), false);
    for (const s of ['reading', 'paused', 'finished', 'dnf']) assert.equal(canReview(s), true, s);
  });
});
