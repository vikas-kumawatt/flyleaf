// SO-21 / SO-22 client rules: what a feed card's like button targets, and the
// comment composer's validation, error copy and page merging.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getCardInteraction, type FeedActivityItem } from '../feedCard.js';
import {
  validateCommentBody,
  commentErrorMessage,
  mergeCommentPages,
  nextLikeState,
  COMMENT_MAX_LENGTH,
} from '../comments.js';

const base: FeedActivityItem = {
  id: 'activity-1',
  actor_id: 'u1',
  actor: { id: 'u1', username: 'alice', display_name: 'Alice', avatar_url: null },
  verb: 'finished',
  work_id: 'w1',
  work: { id: 'w1', title: 'Piranesi', author_name: 'Susanna Clarke', cover_id: null },
  object_type: 'read',
  object_id: 'read-1',
  metadata: {},
  visibility: 'public',
  created_at: new Date().toISOString(),
};

describe('SO-21: getCardInteraction', () => {
  test('uses the server-provided interaction for a finish with no review', () => {
    const r = getCardInteraction({
      ...base,
      interaction: { read_id: 'read-1', like_count: 3, comment_count: 1, viewer_has_liked: true },
    });
    assert.deepEqual(r, { readId: 'read-1', likeCount: 3, commentCount: 1, liked: true });
  });

  test('null from the server means no like or comment buttons at all', () => {
    assert.equal(getCardInteraction({ ...base, verb: 'started', interaction: null }), null);
  });

  test('a review card targets the parent READ, never the activity id (SO-15 bug)', () => {
    const r = getCardInteraction({
      ...base,
      verb: 'reviewed',
      object_type: 'review',
      object_id: 'review-9',
      metadata: { readId: 'read-7' },
    });
    assert.equal(r?.readId, 'read-7');
    assert.notEqual(r?.readId, 'activity-1');
  });

  test('without the server field, non-terminal cards are never likeable', () => {
    for (const verb of ['started', 'shelved', 'followed'] as const) {
      assert.equal(getCardInteraction({ ...base, verb }), null);
    }
    assert.equal(getCardInteraction({ ...base, verb: 'dnf' })?.readId, 'read-1');
  });
});

describe('SO-22: comment helpers', () => {
  test('validates: trims, rejects empty and whitespace, caps at 2,000', () => {
    assert.deepEqual(validateCommentBody('  hi  '), { ok: true, body: 'hi' });
    assert.deepEqual(validateCommentBody('   '), { ok: false, reason: 'empty' });
    assert.deepEqual(validateCommentBody('x'.repeat(COMMENT_MAX_LENGTH + 1)), { ok: false, reason: 'too_long' });
    assert.equal(validateCommentBody('x'.repeat(COMMENT_MAX_LENGTH)).ok, true);
  });

  test('every API refusal has reader-facing copy', () => {
    for (const code of ['rate_limited', 'thread_locked', 'not_commentable', 'not_found', 'body_too_long', 'empty_body']) {
      const msg = commentErrorMessage(code);
      assert.ok(msg.length > 0);
      assert.notEqual(msg, commentErrorMessage('something_else'));
    }
  });

  test('merging pages drops a comment already shown optimistically', () => {
    const merged = mergeCommentPages([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
    assert.deepEqual(merged.map((c) => c.id), ['a', 'b', 'c']);
  });

  test('like state moves to an explicit target and never goes below zero', () => {
    assert.deepEqual(nextLikeState({ liked: false, count: 2 }), { liked: true, count: 3 });
    assert.deepEqual(nextLikeState({ liked: true, count: 0 }), { liked: false, count: 0 });
  });
});
