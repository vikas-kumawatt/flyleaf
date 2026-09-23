import { describe, it, expect } from 'vitest';
import {
  getActivityWeight,
  calculateRecencyDecay,
  calculateDiversityPenalty,
  computeItemRankScore,
  violatesHardConstraints,
  rankAndDiversifyFeed,
  aggregateFeedItems,
} from '../activity/ranking.js';
import type { FeedActivityItem } from '../activity/index.js';

function makeItem(
  id: string,
  actorId: string,
  verb: any,
  workId: string | null = null,
  createdAt: string = new Date().toISOString(),
  metadata: Record<string, any> = {},
): FeedActivityItem {
  return {
    id,
    actor_id: actorId,
    actor: {
      id: actorId,
      username: `user_${actorId}`,
      display_name: `User ${actorId}`,
      avatar_url: null,
    },
    verb,
    work_id: workId,
    work: workId
      ? {
          id: workId,
          title: `Book ${workId}`,
          author_name: 'Author Name',
          cover_id: null,
        }
      : null,
    object_type: workId ? 'work' : null,
    object_id: workId,
    metadata,
    visibility: 'public',
    created_at: createdAt,
  };
}

describe('SO-12: Feed Ranking & Diversity Constraints', () => {
  describe('Activity Weights & Recency Decay', () => {
    it('returns exact activity weights according to PRD §12.2', () => {
      expect(getActivityWeight('reviewed')).toBe(1.0);
      expect(getActivityWeight('finished', { rating: 5 })).toBe(0.9);
      expect(getActivityWeight('finished', {})).toBe(0.7); // finished without rating
      expect(getActivityWeight('dnf')).toBe(0.5);
      expect(getActivityWeight('shelved')).toBe(0.3);
      expect(getActivityWeight('started')).toBe(0.2);
      expect(getActivityWeight('goal_reached')).toBe(0.6);
      expect(getActivityWeight('followed')).toBe(0.1);
      expect(getActivityWeight('quoted')).toBe(0.4);
    });

    it('calculates recency decay with 36-hour half-life/parameter exp(-age_hours / 36.0)', () => {
      const now = new Date('2026-09-23T12:00:00Z');

      const brandNew = calculateRecencyDecay('2026-09-23T12:00:00Z', now);
      expect(brandNew).toBeCloseTo(1.0, 4);

      const hours36Old = calculateRecencyDecay('2026-09-22T00:00:00Z', now);
      expect(hours36Old).toBeCloseTo(Math.exp(-1), 4); // ~0.3679

      const hours72Old = calculateRecencyDecay('2026-09-20T12:00:00Z', now);
      expect(hours72Old).toBeCloseTo(Math.exp(-2), 4); // ~0.1353
    });

    it('computes composite rank score factoring weight, decay, affinity, and diversity penalty', () => {
      const now = new Date('2026-09-23T12:00:00Z');
      const item = makeItem('1', 'userA', 'reviewed', 'work1', '2026-09-23T12:00:00Z');

      const score = computeItemRankScore(item, [], { now, affinities: { userA: 1.5 } });
      expect(score).toBeCloseTo(1.0 * 1.0 * 1.5 * 1.0, 4);
    });
  });

  describe('Hard Diversity Rules (PRD §12.4 & AC-11)', () => {
    it('Rule 1: prevents more than 2 consecutive cards from the same person', () => {
      const itemA1 = makeItem('a1', 'userA', 'reviewed');
      const itemA2 = makeItem('a2', 'userA', 'finished', 'work1', new Date().toISOString(), { rating: 4 });
      const itemA3 = makeItem('a3', 'userA', 'shelved');

      const selected = [itemA1, itemA2];
      expect(violatesHardConstraints(itemA3, selected)).toBe(true);

      const itemB = makeItem('b1', 'userB', 'reviewed');
      expect(violatesHardConstraints(itemB, selected)).toBe(false);
    });

    it('Rule 2: prevents more than 3 cards about the same book in a single 20-item page window', () => {
      const selected = [
        makeItem('1', 'userA', 'reviewed', 'workX'),
        makeItem('2', 'userB', 'reviewed', 'workX'),
        makeItem('3', 'userC', 'finished', 'workX', new Date().toISOString(), { rating: 5 }),
      ];

      const fourthWorkX = makeItem('4', 'userD', 'shelved', 'workX');
      expect(violatesHardConstraints(fourthWorkX, selected)).toBe(true);

      const workY = makeItem('5', 'userD', 'shelved', 'workY');
      expect(violatesHardConstraints(workY, selected)).toBe(false);
    });

    it('Rule 3: limits "started" cards to at most 1 per 10-item block', () => {
      const selected = [
        makeItem('1', 'userA', 'started', 'work1'),
        makeItem('2', 'userB', 'reviewed', 'work2'),
      ];

      const secondStarted = makeItem('3', 'userC', 'started', 'work3');
      expect(violatesHardConstraints(secondStarted, selected)).toBe(true);

      const secondReviewed = makeItem('3', 'userC', 'reviewed', 'work3');
      expect(violatesHardConstraints(secondReviewed, selected)).toBe(false);
    });
  });

  describe('Re-ranking & Diversification Algorithm (rankAndDiversifyFeed)', () => {
    it('interleaves consecutive items from the same actor to satisfy AC-11', () => {
      const now = new Date();
      const candidates = [
        makeItem('a1', 'userA', 'reviewed', 'w1', new Date(now.getTime() - 1000).toISOString()),
        makeItem('a2', 'userA', 'finished', 'w2', new Date(now.getTime() - 2000).toISOString(), { rating: 5 }),
        makeItem('a3', 'userA', 'dnf', 'w3', new Date(now.getTime() - 3000).toISOString()),
        makeItem('a4', 'userA', 'shelved', 'w4', new Date(now.getTime() - 4000).toISOString()),
        makeItem('b1', 'userB', 'reviewed', 'w5', new Date(now.getTime() - 5000).toISOString()),
        makeItem('b2', 'userB', 'finished', 'w6', new Date(now.getTime() - 6000).toISOString(), { rating: 4 }),
      ];

      const result = rankAndDiversifyFeed(candidates, 6, { now });

      // Verify no 3 consecutive cards from userA
      for (let i = 2; i < result.length; i++) {
        const actor1 = result[i - 2]?.actor_id;
        const actor2 = result[i - 1]?.actor_id;
        const actor3 = result[i]?.actor_id;
        const allSame = actor1 === actor2 && actor2 === actor3;
        expect(allSame).toBe(false);
      }
    });

    it('enforces maximum of 3 cards for the same book in a page', () => {
      const now = new Date();
      const candidates = [
        makeItem('1', 'userA', 'reviewed', 'popularBook', new Date(now.getTime() - 1000).toISOString()),
        makeItem('2', 'userB', 'reviewed', 'popularBook', new Date(now.getTime() - 2000).toISOString()),
        makeItem('3', 'userC', 'finished', 'popularBook', new Date(now.getTime() - 3000).toISOString(), { rating: 5 }),
        makeItem('4', 'userD', 'dnf', 'popularBook', new Date(now.getTime() - 4000).toISOString()),
        makeItem('5', 'userE', 'reviewed', 'otherBook', new Date(now.getTime() - 5000).toISOString()),
      ];

      const result = rankAndDiversifyFeed(candidates, 5, { now });
      const popularBookCount = result.filter((item) => item.work_id === 'popularBook').length;

      expect(popularBookCount).toBeLessThanOrEqual(3);
    });

    it('prioritizes higher weighted activities (reviews & finishes) over low weighted activities (starts)', () => {
      const now = new Date();
      const candidateReview = makeItem('rev', 'userA', 'reviewed', 'w1', new Date(now.getTime() - 10000).toISOString());
      const candidateStart = makeItem('start', 'userB', 'started', 'w2', new Date(now.getTime() - 5000).toISOString());

      // candidateStart is slightly newer (5s ago vs 10s ago), but review weight (1.0) dominates start weight (0.2)
      const result = rankAndDiversifyFeed([candidateStart, candidateReview], 2, { now });

      expect(result[0]?.id).toBe('rev');
    });
  });

  describe('SO-13: Feed Aggregation (PRD §12.2, AC-11)', () => {
    it('aggregates multiple shelf adds by the same actor into a single summary card', () => {
      const item1 = makeItem('s1', 'userA', 'shelved', 'work1', '2026-09-23T10:00:00Z', { shelf_name: 'Summer Reads' });
      const item2 = makeItem('s2', 'userA', 'shelved', 'work2', '2026-09-23T10:05:00Z', { shelf_name: 'Summer Reads' });
      const item3 = makeItem('s3', 'userA', 'shelved', 'work3', '2026-09-23T10:10:00Z', { shelf_name: 'Summer Reads' });

      const aggregated = aggregateFeedItems([item1, item2, item3]);

      expect(aggregated.length).toBe(1);
      expect(aggregated[0]?.metadata.is_aggregated).toBe(true);
      expect(aggregated[0]?.metadata.count).toBe(3);
      expect(aggregated[0]?.metadata.shelf_name).toBe('Summer Reads');
      expect(aggregated[0]?.metadata.works.length).toBe(3);
    });

    it('aggregates multiple follow activities by the same actor into a single summary card', () => {
      const f1 = makeItem('f1', 'userA', 'followed', null, '2026-09-23T11:00:00Z', { target_id: 'u1', target_username: 'reader1' });
      const f2 = makeItem('f2', 'userA', 'followed', null, '2026-09-23T11:02:00Z', { target_id: 'u2', target_username: 'reader2' });
      const f3 = makeItem('f3', 'userA', 'followed', null, '2026-09-23T11:05:00Z', { target_id: 'u3', target_username: 'reader3' });

      const aggregated = aggregateFeedItems([f1, f2, f3]);

      expect(aggregated.length).toBe(1);
      expect(aggregated[0]?.metadata.is_aggregated).toBe(true);
      expect(aggregated[0]?.metadata.count).toBe(3);
      expect(aggregated[0]?.metadata.targets.length).toBe(3);
    });

    it('aggregates multiple "started" activities on the same day by the same actor into a single summary card', () => {
      const st1 = makeItem('st1', 'userA', 'started', 'work1', '2026-09-23T08:00:00Z');
      const st2 = makeItem('st2', 'userA', 'started', 'work2', '2026-09-23T09:00:00Z');

      const aggregated = aggregateFeedItems([st1, st2]);

      expect(aggregated.length).toBe(1);
      expect(aggregated[0]?.metadata.is_aggregated).toBe(true);
      expect(aggregated[0]?.metadata.count).toBe(2);
      expect(aggregated[0]?.metadata.works.length).toBe(2);
    });

    it('never aggregates high-value activities (reviews, finishes, DNFs)', () => {
      const rev1 = makeItem('r1', 'userA', 'reviewed', 'work1', '2026-09-23T10:00:00Z');
      const rev2 = makeItem('r2', 'userA', 'reviewed', 'work2', '2026-09-23T10:05:00Z');
      const fin1 = makeItem('fn1', 'userA', 'finished', 'work3', '2026-09-23T10:10:00Z', { rating: 5 });

      const result = aggregateFeedItems([rev1, rev2, fin1]);

      expect(result.length).toBe(3);
      expect(result.every((i) => !i.metadata?.is_aggregated)).toBe(true);
    });
  });
});
