import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCardType,
  formatActivityHeadline,
  getSwipeRightAction,
  getSwipeLeftAction,
  getCardBadgeLabel,
  type FeedActivityItem,
} from '../feedCard.js';

describe('SO-15: Feed Card Types & Swipe Action Helpers', () => {
  const baseActor = { id: 'u1', username: 'alice', display_name: 'Alice', avatar_url: null };
  const baseWork = { id: 'w1', title: 'Piranesi', author_name: 'Susanna Clarke', cover_id: 8231856 };

  test('determines card type correctly across all activity verbs', () => {
    const reviewItem: FeedActivityItem = {
      id: 'a1',
      actor_id: 'u1',
      actor: baseActor,
      verb: 'reviewed',
      work_id: 'w1',
      work: baseWork,
      object_type: 'read',
      object_id: 'r1',
      metadata: { rating: 5, review_text: 'Incredible book!' },
      visibility: 'public',
      created_at: new Date().toISOString(),
    };
    assert.equal(getCardType(reviewItem), 'review');

    const finishItem: FeedActivityItem = {
      ...reviewItem,
      verb: 'finished',
      metadata: { rating: 4 },
    };
    assert.equal(getCardType(finishItem), 'finish');

    const dnfItem: FeedActivityItem = {
      ...reviewItem,
      verb: 'dnf',
      metadata: { reason: 'Pacing was too slow' },
    };
    assert.equal(getCardType(dnfItem), 'dnf');

    const editorialItem: FeedActivityItem = {
      ...reviewItem,
      verb: 'goal_reached',
      metadata: { is_editorial: true, title: 'Welcome' },
    };
    assert.equal(getCardType(editorialItem), 'editorial');
  });

  test('formats activity headlines correctly including aggregated activities', () => {
    const aggFollows: FeedActivityItem = {
      id: 'a2',
      actor_id: 'u1',
      actor: baseActor,
      verb: 'followed',
      work_id: null,
      work: null,
      object_type: 'user',
      object_id: null,
      metadata: { is_aggregated: true, count: 4 },
      visibility: 'public',
      created_at: new Date().toISOString(),
    };
    assert.equal(formatActivityHeadline(aggFollows), 'followed 4 readers');

    const aggShelved: FeedActivityItem = {
      id: 'a3',
      actor_id: 'u1',
      actor: baseActor,
      verb: 'shelved',
      work_id: null,
      work: null,
      object_type: 'shelf',
      object_id: 's1',
      metadata: { is_aggregated: true, count: 6, shelf_name: 'Summer Favourites' },
      visibility: 'public',
      created_at: new Date().toISOString(),
    };
    assert.equal(formatActivityHeadline(aggShelved), 'added 6 books to "Summer Favourites"');

    const goalItem: FeedActivityItem = {
      id: 'a4',
      actor_id: 'u1',
      actor: baseActor,
      verb: 'goal_reached',
      work_id: null,
      work: null,
      object_type: 'system',
      object_id: null,
      metadata: { goal: 25 },
      visibility: 'public',
      created_at: new Date().toISOString(),
    };
    assert.equal(formatActivityHeadline(goalItem), 'reached 2026 reading goal! 🎉');
  });

  test('resolves swipe right and swipe left actions when work_id is present', () => {
    const item: FeedActivityItem = {
      id: 'a5',
      actor_id: 'u1',
      actor: baseActor,
      verb: 'finished',
      work_id: 'w1',
      work: baseWork,
      object_type: 'read',
      object_id: 'r1',
      metadata: { rating: 5 },
      visibility: 'public',
      created_at: new Date().toISOString(),
    };

    const rightAction = getSwipeRightAction(item);
    assert.notEqual(rightAction, null);
    assert.equal(rightAction?.type, 'want_to_read');
    assert.equal(rightAction?.workId, 'w1');

    const leftAction = getSwipeLeftAction(item);
    assert.notEqual(leftAction, null);
    assert.equal(leftAction?.type, 'rate_and_review');
    assert.equal(leftAction?.workId, 'w1');
  });

  test('returns null swipe actions when activity has no associated work', () => {
    const item: FeedActivityItem = {
      id: 'a6',
      actor_id: 'u1',
      actor: baseActor,
      verb: 'followed',
      work_id: null,
      work: null,
      object_type: 'user',
      object_id: 'u2',
      metadata: {},
      visibility: 'public',
      created_at: new Date().toISOString(),
    };

    assert.equal(getSwipeRightAction(item), null);
    assert.equal(getSwipeLeftAction(item), null);
  });

  test('extracts card badge labels for cold start blended items', () => {
    const blendedPopular: FeedActivityItem = {
      id: 'a7',
      actor_id: 'u1',
      actor: baseActor,
      verb: 'reviewed',
      work_id: 'w1',
      work: baseWork,
      object_type: 'read',
      object_id: 'r1',
      metadata: { is_blended_popular: true, label: 'Popular on Flyleaf' },
      visibility: 'public',
      created_at: new Date().toISOString(),
    };
    const badge1 = getCardBadgeLabel(blendedPopular);
    assert.equal(badge1?.text, 'Popular on Flyleaf');
    assert.equal(badge1?.variant, 'popular');

    const backfillWait: FeedActivityItem = {
      ...blendedPopular,
      metadata: { is_blended_popular: true, label: 'While you wait' },
    };
    const badge2 = getCardBadgeLabel(backfillWait);
    assert.equal(badge2?.text, 'While you wait');
    assert.equal(badge2?.variant, 'wait');
  });
});
