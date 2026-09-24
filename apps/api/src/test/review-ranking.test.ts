// SO-23: review ranking — social proximity dominant, exploration boost.
//
// PRD §10.7. The two properties that matter, stated as tests:
//   1. A friend's quiet review beats a stranger's viral one.
//   2. New writing from unknown accounts gets seen by SOMEONE, without the
//      viewer losing a friend's review to make room for it.

import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  calculateReviewRankingScore,
  rankReviews,
  socialProximity,
  normaliseCredibility,
  lengthQuality,
  explorationRoll,
  isExplorationEligible,
  guestExplorationKey,
  EXPLORATION,
  SOCIAL_PROXIMITY,
  ReviewService,
  type ReviewItem,
  type ReviewRankingContext,
} from '../reviews/index.js';
import { reads, reviews } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { interactionHarness, makeUser, makeWork, makeRead, follow } from './interaction-fixtures.js';

const NOW = new Date('2026-09-24T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let seq = 0;
function review(over: Partial<ReviewItem> & { user_id: string }): ReviewItem {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    read_id: `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    work_id: 'w',
    body: 'x'.repeat(200),
    has_spoilers: false,
    spoiler_after_page: null,
    visibility: 'public',
    published_at: daysAgo(30),
    edited_at: null,
    rating: 4,
    hearted: false,
    format_override: null,
    like_count: 0,
    comment_count: 0,
    viewer_has_liked: false,
    author: { id: over.user_id, username: over.user_id, display_name: null, avatar_url: null },
    ...over,
  };
}

const base: ReviewRankingContext = {
  viewerId: 'viewer',
  followedIds: new Set(['friend', 'friend2', 'friend3']),
  secondDegreeIds: new Set(['fof']),
  credibility: new Map(),
  now: NOW,
};

describe('SO-23: scoring terms', () => {
  it('social proximity: 1.0 follow (and self) · 0.6 follower-of-follower · 0.2 otherwise', () => {
    expect(socialProximity('friend', base)).toBe(1.0);
    expect(socialProximity('viewer', base)).toBe(1.0);
    expect(socialProximity('fof', base)).toBe(0.6);
    expect(socialProximity('stranger', base)).toBe(0.2);
    expect(socialProximity('friend', { viewerId: null })).toBe(SOCIAL_PROXIMITY.stranger);
  });

  it('⚠️ the PRD weights ALONE cannot make proximity dominant — which is why ranking is tiered', () => {
    // Recorded so nobody "simplifies" rankReviews back to a plain score sort.
    const friend = review({ user_id: 'friend', published_at: daysAgo(60), like_count: 0 });
    const viral = review({ user_id: 'stranger', published_at: daysAgo(0), like_count: 500, comment_count: 80 });
    const ctx = { ...base, credibility: new Map([['stranger', 1]]) };
    expect(calculateReviewRankingScore(viral, ctx)).toBeGreaterThan(calculateReviewRankingScore(friend, ctx));
  });

  it('⚠️ a friend\'s 2-month-old, zero-like, 2-star review ranks above a stranger\'s viral one', () => {
    const friend = review({ user_id: 'friend', published_at: daysAgo(60), like_count: 0, rating: 2 });
    const viral = review({ user_id: 'stranger', published_at: daysAgo(0), like_count: 500, comment_count: 80 });
    const ctx = { ...base, credibility: new Map([['stranger', 1]]), explorationKey: null };
    expect(rankReviews([viral, friend], ctx).items.map((r) => r.user_id)).toEqual(['friend', 'stranger']);
  });

  it('below the friend tier, a popular stranger CAN outrank a quiet follower-of-follower', () => {
    const fof = review({ user_id: 'fof', published_at: daysAgo(60) });
    const viral = review({ user_id: 'stranger', published_at: daysAgo(0), like_count: 500 });
    expect(rankReviews([fof, viral], { ...base, explorationKey: null }).items[0]!.user_id).toBe('stranger');
  });

  it('a follower-of-follower outranks an otherwise identical stranger', () => {
    const fof = review({ user_id: 'fof' });
    const stranger = review({ user_id: 'stranger' });
    expect(calculateReviewRankingScore(fof, base)).toBeGreaterThan(calculateReviewRankingScore(stranger, base));
  });

  it('engagement is log-scaled: 1,000 likes is not 100× the value of 10', () => {
    const s = (likes: number) => calculateReviewRankingScore(review({ user_id: 'x', like_count: likes }), base);
    expect(s(1000) - s(0)).toBeLessThanOrEqual(0.2 + 1e-9); // capped at the likes weight
    expect((s(1000) - s(0)) / (s(10) - s(0))).toBeLessThan(3);
  });

  it('comments weigh less than likes', () => {
    const likes = calculateReviewRankingScore(review({ user_id: 'x', like_count: 10 }), base);
    const comments = calculateReviewRankingScore(review({ user_id: 'x', comment_count: 10 }), base);
    expect(likes).toBeGreaterThan(comments);
  });

  it('credibility is the log-normalised median, capped at 1', () => {
    expect(normaliseCredibility(0)).toBe(0);
    expect(normaliseCredibility(99)).toBeCloseTo(1);
    expect(normaliseCredibility(10_000)).toBe(1);
    expect(normaliseCredibility(9)).toBeCloseTo(0.5);
  });

  it('length quality favours 80–600 characters; neither one word nor an essay wins by default', () => {
    expect(lengthQuality(80)).toBe(1);
    expect(lengthQuality(600)).toBe(1);
    expect(lengthQuality(3)).toBeLessThan(1);
    expect(lengthQuality(5000)).toBe(0.1);
  });

  it('recency decays gently over 45 days', () => {
    const fresh = calculateReviewRankingScore(review({ user_id: 'x', published_at: daysAgo(0) }), base);
    const old = calculateReviewRankingScore(review({ user_id: 'x', published_at: daysAgo(45) }), base);
    expect(fresh - old).toBeCloseTo(0.15 * (1 - Math.exp(-1)), 5);
  });

  it('report penalty is subtractive (wired to reports in SO-40)', () => {
    const r = review({ user_id: 'x' });
    const penalised = calculateReviewRankingScore(r, { ...base, reportPenalty: new Map([[r.id, 1]]) });
    expect(calculateReviewRankingScore(r, base) - penalised).toBeCloseTo(0.1);
  });

  it('keeps the SL-64 positional signature working', () => {
    const r = review({ user_id: 'friend' });
    expect(calculateReviewRankingScore(r, 'viewer', new Set(['friend']))).toBeCloseTo(
      calculateReviewRankingScore(r, { viewerId: 'viewer', followedIds: new Set(['friend']) }),
    );
  });
});

describe('SO-23: exploration boost', () => {
  it('eligibility: new (≤14d), unproven (<5 likes), and not already in your circle', () => {
    expect(isExplorationEligible(review({ user_id: 'stranger', published_at: daysAgo(2) }), base)).toBe(true);
    expect(isExplorationEligible(review({ user_id: 'fof', published_at: daysAgo(2) }), base)).toBe(true);
    expect(isExplorationEligible(review({ user_id: 'stranger', published_at: daysAgo(20) }), base)).toBe(false);
    expect(isExplorationEligible(review({ user_id: 'stranger', published_at: daysAgo(2), like_count: 5 }), base)).toBe(false);
    expect(isExplorationEligible(review({ user_id: 'friend', published_at: daysAgo(2) }), base)).toBe(false);
  });

  it('the sample is deterministic per viewer and close to the configured rate', () => {
    expect(explorationRoll('v1', 'r1')).toBe(explorationRoll('v1', 'r1'));
    let hits = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (explorationRoll(`viewer-${i}`, 'review-x') < EXPLORATION.sampleRate) hits++;
    expect(hits / n).toBeGreaterThan(0.18);
    expect(hits / n).toBeLessThan(0.22);
  });

  /** A list where the new stranger review would rank LAST on score alone. */
  function scenario() {
    const friends = ['friend', 'friend2', 'friend3'].map((u) => review({ user_id: u, published_at: daysAgo(40) }));
    const established = Array.from({ length: 12 }, (_, i) =>
      review({ user_id: `pop${i}`, like_count: 200 + i, published_at: daysAgo(5) }),
    );
    const newbie = review({ user_id: 'newbie', body: 'short', published_at: daysAgo(1) });
    return { friends, established, newbie, all: [newbie, ...established, ...friends] };
  }

  /** Find a viewer key that samples `reviewId` in. */
  function keyThatSamples(reviewId: string, want = true): string {
    for (let i = 0; i < 10_000; i++) {
      const k = `viewer-${i}`;
      if ((explorationRoll(k, reviewId) < EXPLORATION.sampleRate) === want) return k;
    }
    throw new Error('no key found');
  }

  it('a sampled viewer sees the new review on page one, directly below their friends', () => {
    const { friends, newbie, all } = scenario();
    const withoutExploration = rankReviews(all, { ...base, explorationKey: null }).items;
    expect(withoutExploration.indexOf(newbie)).toBe(all.length - 1);

    const { items, exploredId } = rankReviews(all, { ...base, explorationKey: keyThatSamples(newbie.id) });
    expect(exploredId).toBe(newbie.id);
    // Friends keep the top three slots; exploration never costs a friend.
    expect(items.slice(0, 3).map((r) => r.user_id).sort()).toEqual(friends.map((f) => f.user_id).sort());
    expect(items.indexOf(newbie)).toBe(3);
    expect(items).toHaveLength(all.length);
  });

  it('never above the second slot, even for a viewer with no friends in the list', () => {
    const { newbie, established } = scenario();
    const { items } = rankReviews([newbie, ...established], {
      now: NOW,
      viewerId: 'loner',
      explorationKey: keyThatSamples(newbie.id),
    });
    expect(items.indexOf(newbie)).toBe(EXPLORATION.earliestSlot);
  });

  it('an unsampled viewer sees plain score order', () => {
    const { newbie, all } = scenario();
    const ranked = rankReviews(all, { ...base, explorationKey: keyThatSamples(newbie.id, false) });
    expect(ranked.exploredId).toBeNull();
    expect(ranked.items.indexOf(newbie)).toBe(all.length - 1);
  });

  it('if friends fill page one, exploration yields rather than displacing one', () => {
    const manyFriends = new Set(Array.from({ length: 12 }, (_, i) => `f${i}`));
    const friendReviews = [...manyFriends].map((u) => review({ user_id: u }));
    const newbie = review({ user_id: 'newbie', published_at: daysAgo(1) });
    const { items, exploredId } = rankReviews([newbie, ...friendReviews], {
      now: NOW,
      viewerId: 'v',
      followedIds: manyFriends,
      explorationKey: keyThatSamples(newbie.id),
    });
    expect(exploredId).toBeNull();
    expect(items.slice(0, EXPLORATION.pageSize).every((r) => manyFriends.has(r.user_id))).toBe(true);
  });

  it('at most one exploration slot per list', () => {
    const newbies = Array.from({ length: 30 }, (_, i) => review({ user_id: `n${i}`, body: 'hm', published_at: daysAgo(1) }));
    const popular = Array.from({ length: 10 }, (_, i) => review({ user_id: `p${i}`, like_count: 300, published_at: daysAgo(3) }));
    const plain = rankReviews([...newbies, ...popular], { now: NOW, viewerId: 'v', explorationKey: null }).items;
    const explored = rankReviews([...newbies, ...popular], { now: NOW, viewerId: 'v', explorationKey: 'v' }).items;
    const moved = explored.filter((r, i) => plain.indexOf(r) !== i && newbies.includes(r) && i < plain.indexOf(r));
    expect(moved.length).toBeLessThanOrEqual(1);
  });

  it('guests get a daily-rotating key', () => {
    expect(guestExplorationKey(NOW)).toBe('guest:2026-09-24');
  });
});

describe('SO-23: through the API', () => {
  let db: Db;
  let app: FastifyInstance;

  it('ranks follower-of-follower above stranger, and uses credibility from real likes', async () => {
    ({ db, app } = await interactionHarness());
    const viewer = await makeUser(db, 'viewer');
    const friend = await makeUser(db, 'friend');
    const fof = await makeUser(db, 'fof');
    const stranger = await makeUser(db, 'stranger');
    await follow(db, viewer.id, friend.id);
    await follow(db, friend.id, fof.id);

    const workId = await makeWork(db, 'Middlemarch');
    const svc = new ReviewService(db);
    const body = 'A careful, patient portrait of a provincial town and everyone in it.';
    for (const u of [friend, fof, stranger]) {
      const readId = await makeRead(db, u.id, workId);
      const r = await svc.upsertReview(u.id, readId, { body });
      // Old enough to be outside the exploration window, so order is score alone.
      await db.update(reviews).set({ publishedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(reviews.id, r.id));
    }

    const res = await app.inject({
      method: 'GET',
      url: `/v1/works/${workId}/reviews?sort=friends`,
      headers: viewer.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((r: { author: { username: string } }) => r.author.username)).toEqual([
      'friend',
      'fof',
      'stranger',
    ]);

    const ctx = await svc.rankingContext(viewer.id, new Set([friend.id]), [
      { user_id: friend.id },
      { user_id: fof.id },
      { user_id: stranger.id },
    ]);
    expect([...(ctx.secondDegreeIds ?? [])]).toEqual([fof.id]);
    expect(ctx.explorationKey).toBe(viewer.id);

    // Credibility reads the trigger-maintained counter.
    const [sRead] = await db.select({ id: reads.id }).from(reads).where(eq(reads.userId, stranger.id));
    for (const u of [viewer, friend, fof]) {
      await app.inject({ method: 'POST', url: `/v1/reads/${sRead!.id}/like`, headers: u.auth });
    }
    const ctx2 = await svc.rankingContext(viewer.id, new Set([friend.id]), [{ user_id: stranger.id }]);
    expect(ctx2.credibility?.get(stranger.id)).toBeCloseTo(normaliseCredibility(3));
  });
});
