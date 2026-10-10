// Audit 14: Home feed state (src/lib/homeFeed.ts) and the feed card fields
// the API actually sends (A-14-011 … A-14-014).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_FEED,
  FEED_CAUGHT_UP_AFTER,
  activeImportForBanner,
  applyFeedPage,
  canShowTab,
  coldStartBanner,
  defaultFeedTab,
  formatEta,
  importEtaSeconds,
  isCaughtUp,
  shouldLoadMore,
  wantToReadToast,
  type FeedPage,
} from '../homeFeed.js';
import {
  cardHasSpoilers,
  cardText,
  formatActivityHeadline,
  getCardInteraction,
  getSwipeLeftAction,
  getSwipeRightAction,
  isEditorial,
  type FeedActivityItem,
} from '../feedCard.js';

const NIL = '00000000-0000-0000-0000-000000000000';

function card(id: string, over: Partial<FeedActivityItem> = {}): FeedActivityItem {
  return {
    id,
    actor_id: 'u1',
    actor: { id: 'u1', username: 'alice', display_name: 'Alice', avatar_url: null },
    verb: 'finished',
    work_id: 'w1',
    work: { id: 'w1', title: 'Piranesi', author_name: 'Susanna Clarke', cover_id: 1 },
    object_type: 'read',
    object_id: `r-${id}`,
    metadata: {},
    visibility: 'public',
    created_at: '2026-10-10T12:00:00.000Z',
    interaction: null,
    ...over,
  };
}

function page(ids: string[], over: Partial<FeedPage> = {}): FeedPage {
  return { items: ids.map((id) => card(id)), next_cursor: 'c', has_more: true, tab: 'friends', ...over };
}

describe('Home feed: tabs and paging', () => {
  test('signed in opens Friends; a guest opens Popular and cannot open Friends', () => {
    assert.equal(defaultFeedTab(true), 'friends');
    assert.equal(defaultFeedTab(false), 'popular');
    assert.equal(canShowTab('friends', false), false);
    assert.equal(canShowTab('popular', false), true);
    assert.equal(canShowTab('friends', true), true);
  });

  test('page one replaces; later pages append and never show an id twice', () => {
    let s = applyFeedPage(EMPTY_FEED, page(['a', 'b']), 'replace');
    s = applyFeedPage(s, page(['b', 'c'], { next_cursor: 'c2' }), 'append');
    assert.deepEqual(s.items.map((i) => i.id), ['a', 'b', 'c']);
    assert.equal(s.cursor, 'c2');
    assert.equal(shouldLoadMore(s, false), true);
    assert.equal(shouldLoadMore(s, true), false);
    s = applyFeedPage(s, page(['x'], { next_cursor: null, has_more: false }), 'replace');
    assert.deepEqual(s.items.map((i) => i.id), ['x']);
    assert.equal(isCaughtUp(s), true);
    assert.equal(shouldLoadMore(s, false), false);
  });

  test('a visible end after ~100 items, even if the server has more (§12.6)', () => {
    let s = EMPTY_FEED;
    for (let p = 0; p < 6; p++) {
      s = applyFeedPage(s, page(Array.from({ length: 20 }, (_, i) => `p${p}-${i}`)), p === 0 ? 'replace' : 'append');
    }
    assert.ok(s.items.length >= FEED_CAUGHT_UP_AFTER);
    assert.equal(s.hasMore, false);
    assert.equal(isCaughtUp(s), true);
  });

  test('Friends served as Popular is recorded, with the banner the response asks for', () => {
    const s = applyFeedPage(EMPTY_FEED, page(['a'], { tab: 'popular', is_cold_start: true, cold_start_reason: 'no_follows' }), 'replace');
    assert.equal(s.servedTab, 'popular');
    assert.equal(s.coldStart?.title, 'Follow readers to build your feed');
    assert.equal(coldStartBanner({ is_cold_start: true, cold_start_reason: 'sparse_follows' })?.reason, 'sparse_follows');
    assert.equal(coldStartBanner({ is_cold_start: true, cold_start_reason: 'no_activity' })?.reason, 'no_activity');
    assert.equal(coldStartBanner({ is_cold_start: false, cold_start_reason: null }), null);
  });
});

describe('Want to read toast (D-11-1)', () => {
  test('says what happened, and offers Undo only when the swipe wrote a read', () => {
    assert.deepEqual(wantToReadToast({ kind: 'added', readId: 'r' }), { message: 'Added to Want to read', undo: true, tone: 'ok' });
    assert.equal(wantToReadToast({ kind: 'queued', readId: 'r' }).undo, true);
    assert.deepEqual(wantToReadToast({ kind: 'already' }), { message: 'Already in your library', undo: false, tone: 'info' });
    assert.equal(wantToReadToast({ kind: 'failed' }).tone, 'error');
  });
});

describe('Import banner on Home (A-12-023)', () => {
  const imp = (id: string, state: string) => ({ id, state, total_rows: 100, matched: 0, unmatched: 0 });
  test('the newest import, only while queued or processing, unless dismissed', () => {
    assert.equal(activeImportForBanner([imp('n', 'processing'), imp('o', 'processing')], new Set())?.id, 'n');
    assert.equal(activeImportForBanner([imp('n', 'completed'), imp('o', 'processing')], new Set()), null);
    assert.equal(activeImportForBanner([imp('n', 'queued')], new Set(['n'])), null);
    assert.equal(activeImportForBanner([], new Set()), null);
  });
  test('an ETA needs two samples that moved: rows per second × rows left', () => {
    assert.equal(importEtaSeconds([{ at: 0, processed: 10 }], 100), null);
    assert.equal(importEtaSeconds([{ at: 0, processed: 10 }, { at: 5000, processed: 10 }], 100), null);
    // 20 rows in 10 s = 2 rows/s; 60 left → 30 s.
    assert.equal(importEtaSeconds([{ at: 0, processed: 20 }, { at: 4000, processed: 28 }, { at: 10_000, processed: 40 }], 100), 30);
    assert.equal(formatEta(30), 'less than a minute left');
    assert.equal(formatEta(600), 'about 10 min left');
    assert.equal(formatEta(4500), 'about 1 h 15 min left');
  });
});

describe('Feed cards from real API payloads', () => {
  test('a review card shows the snippet the API writes, blurred when it has spoilers', () => {
    const review = card('rv', { verb: 'reviewed', object_type: 'review', metadata: { readId: 'r1', hasSpoilers: true, snippet: 'It ends well.' } });
    assert.equal(cardText(review), 'It ends well.');
    assert.equal(cardHasSpoilers(review), true);
    assert.equal(cardHasSpoilers(card('x', { metadata: { snippet: 'fine', hasSpoilers: false } })), false);
    assert.equal(cardText(card('y')), null);
  });

  test('shelf and follow cards name the shelf and the reader the API sends', () => {
    const shelf = card('s', { verb: 'shelved', object_type: 'shelf_item', metadata: { shelfId: 's1', shelfName: 'Monsoon Reading' } });
    assert.equal(formatActivityHeadline(shelf), 'added to "Monsoon Reading"');
    const agg = card('s2', { verb: 'shelved', metadata: { is_aggregated: true, count: 6, shelf_name: 'Monsoon Reading', shelfName: 'Monsoon Reading' } });
    assert.equal(formatActivityHeadline(agg), 'added 6 books to "Monsoon Reading"');
    const f = card('f', { verb: 'followed', work_id: null, work: null, object_type: 'user', object_id: 'u9', metadata: { followeeId: 'u9', target_username: 'bob' } });
    assert.equal(formatActivityHeadline(f), 'followed @bob');
  });

  test('a goal card names the year it was reached, not a year in the code', () => {
    const g = card('g', { verb: 'goal_reached', work_id: null, work: null, created_at: '2027-01-02T00:00:00.000Z' });
    assert.equal(formatActivityHeadline(g), 'reached 2027 reading goal! 🎉');
  });

  test('the editorial card has no profile, no like and no swipe (nil actor id)', () => {
    const ed = card(NIL, {
      actor_id: NIL, actor: { id: NIL, username: 'flyleaf', display_name: 'Flyleaf', avatar_url: null },
      verb: 'goal_reached', work_id: null, work: null, object_type: 'system', object_id: null,
      metadata: { is_editorial: true, title: 'Welcome' }, interaction: null,
    });
    assert.equal(isEditorial(ed), true);
    assert.equal(getCardInteraction(ed), null);
    assert.equal(getSwipeRightAction(ed), null);
    assert.equal(getSwipeLeftAction(ed), null);
  });

  test('swipe actions use theme tokens, not hex colours', () => {
    const right = getSwipeRightAction(card('a'))!;
    const left = getSwipeLeftAction(card('a'))!;
    for (const a of [right, left]) {
      assert.doesNotMatch(`${a.color} ${a.backgroundColor}`, /#/);
    }
  });
});
