// Reviews, ratings, and social interactions (SL-62, SL-63, SL-64).
// Governed by:
//   - PRD §6.24–§6.27 (Book detail reviews, review detail, review composer)
//   - PRD §9.3–§9.7 (Ratings, Bayesian weighted average, polarization)
//   - PRD §10.1–§10.7 (Review ranking algorithm, content requirements, likes)
//   - Architecture §3.1, §3.5, §3.7 (reviews, read_likes, follows tables)

import { sql, eq, and, desc, asc, isNull, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../platform/index.js';
import {
  reviews,
  reads,
  readLikes,
  follows,
  works,
  users,
  profiles,
  workStats,
} from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import {
  canViewSql,
  canViewWith,
  loadRelationship,
  mostRestrictive,
  mostRestrictiveSql,
  requireVerified,
} from '../authorization/index.js';
import {
  createReviewBodySchema,
  updateReviewBodySchema,
  reviewSchema,
  workReviewsQuerySchema,
  workReviewsResponseSchema,
} from '../contract/schemas.js';

export interface ReviewAuthor {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ReviewItem {
  id: string;
  read_id: string;
  user_id: string;
  work_id: string;
  body: string;
  has_spoilers: boolean;
  spoiler_after_page: number | null;
  visibility: 'public' | 'followers' | 'private';
  published_at: string;
  edited_at: string | null;
  rating: number | null;
  hearted: boolean;
  format_override: string | null;
  like_count: number;
  comment_count: number;
  viewer_has_liked: boolean;
  author: ReviewAuthor;
  work_title?: string | null;
  work_author?: string | null;
  work_cover_id?: number | null;
}

export interface WorkReviewsQuery {
  sort?: 'friends' | 'likes' | 'newest' | 'highest' | 'lowest';
  rating?: number;
  limit?: number;
  offset?: number;
}

/**
 * Bayesian weighted rating formula (PRD §9.5, LOCKED).
 *
 * weighted_rating = (v / (v + m)) * R  +  (m / (v + m)) * C
 *
 * R = this work's mean rating
 * v = this work's rating count
 * m = minimum ratings for full confidence (25)
 * C = catalog mean rating (~3.90)
 */
export function calculateBayesianRating(
  ratingCount: number,
  meanRating: number | null,
  catalogMean = 3.9,
  confidenceThreshold = 25,
): number | null {
  if (!ratingCount || meanRating === null || meanRating <= 0) return null;
  const v = ratingCount;
  const m = confidenceThreshold;
  const R = meanRating;
  const C = catalogMean;
  const weighted = (v / (v + m)) * R + (m / (v + m)) * C;
  return Math.round(weighted * 100) / 100;
}

/**
 * Review ranking (SO-23, PRD §10.7).
 *
 *   score =  0.35 * social_proximity      1.0 follow · 0.6 follower-of-follower · 0.2 otherwise
 *          + 0.20 * likes                 log-scaled, capped
 *          + 0.10 * comments              log-scaled, below likes (comments can mean argument)
 *          + 0.15 * recency_decay         exp(-age_days / 45)
 *          + 0.10 * author_credibility    reviewer's median like count, log-normalised
 *          + 0.10 * length_quality        gentle curve favouring 80–600 characters
 *          - 0.10 * report_penalty        0 until reports exist (SO-40)
 *
 * Then ONE exploration slot: a new, unproven review from outside the viewer's
 * circle is shown to a deterministic ~20% sample of viewers regardless of its
 * score, at the first slot below the viewer's friends. Without this, ranking
 * calcifies within months — the first popular review owns the top forever.
 */
export const REVIEW_RANKING_WEIGHTS = {
  proximity: 0.35,
  likes: 0.2,
  comments: 0.1,
  recency: 0.15,
  credibility: 0.1,
  length: 0.1,
  report: 0.1,
} as const;

export const SOCIAL_PROXIMITY = { following: 1.0, secondDegree: 0.6, stranger: 0.2 } as const;

export const EXPLORATION = {
  /** Younger than this is "new". */
  maxAgeDays: 14,
  /** Fewer likes than this is "unproven"; a review with traction no longer needs help. */
  maxLikes: 5,
  /** Share of viewers who see any given eligible review in the exploration slot. */
  sampleRate: 0.2,
  /** Never above this position: the top two are earned. */
  earliestSlot: 2,
  /** The slot must land on the first page or it is not exploration. */
  pageSize: 10,
} as const;

export interface ReviewRankingContext {
  viewerId?: string | null;
  followedIds?: Set<string>;
  /** Accounts followed by accounts the viewer follows (accepted edges both hops). */
  secondDegreeIds?: Set<string>;
  /** Per-author credibility in [0, 1]. Missing = 0: unknown authors earn it. */
  credibility?: Map<string, number>;
  /** Per-review report penalty in [0, 1]. Wired by SO-40. */
  reportPenalty?: Map<string, number>;
  now?: Date;
  /** Seeds exploration sampling. A viewer id, or a daily-rotating key for guests. */
  explorationKey?: string | null;
}

export function socialProximity(authorId: string, ctx: ReviewRankingContext): number {
  if (ctx.viewerId && authorId === ctx.viewerId) return SOCIAL_PROXIMITY.following;
  if (ctx.followedIds?.has(authorId)) return SOCIAL_PROXIMITY.following;
  if (ctx.secondDegreeIds?.has(authorId)) return SOCIAL_PROXIMITY.secondDegree;
  return SOCIAL_PROXIMITY.stranger;
}

/** log10(1 + median likes) / 2, capped at 1: a median of 99 likes is full credibility. */
export function normaliseCredibility(medianLikes: number): number {
  return Math.min(1, Math.log10(1 + Math.max(0, medianLikes)) / 2);
}

export function lengthQuality(length: number): number {
  if (length >= 80 && length <= 600) return 1.0;
  return Math.max(0.1, 1 - Math.abs(length - 340) / 1200);
}

export function calculateReviewRankingScore(
  item: Pick<ReviewItem, 'id' | 'user_id' | 'like_count' | 'comment_count' | 'published_at' | 'body'>,
  ctxOrViewer: ReviewRankingContext | string | null = {},
  legacyFollowedIds?: Set<string>,
): number {
  // Positional form kept for SL-64 callers: (item, viewerId, followedIds).
  const ctx: ReviewRankingContext =
    typeof ctxOrViewer === 'string' || ctxOrViewer === null
      ? { viewerId: ctxOrViewer, followedIds: legacyFollowedIds }
      : ctxOrViewer;
  const w = REVIEW_RANKING_WEIGHTS;
  const now = (ctx.now ?? new Date()).getTime();

  const proximity = socialProximity(item.user_id, ctx);
  const likes = Math.min(1, Math.log10(1 + Math.max(0, item.like_count)) / 2);
  const comments = Math.min(1, Math.log10(1 + Math.max(0, item.comment_count)) / 1.5);
  const ageDays = Math.max(0, (now - new Date(item.published_at).getTime()) / 86_400_000);
  const recency = Math.exp(-ageDays / 45);
  const credibility = ctx.credibility?.get(item.user_id) ?? 0;
  const length = lengthQuality(item.body.length);
  const report = ctx.reportPenalty?.get(item.id) ?? 0;

  return (
    w.proximity * proximity +
    w.likes * likes +
    w.comments * comments +
    w.recency * recency +
    w.credibility * credibility +
    w.length * length -
    w.report * report
  );
}

/**
 * Deterministic sample: the same viewer sees the same exploration pick on
 * every request and every page, so pagination never duplicates or skips.
 * FNV-1a — cheap, stable across processes, no crypto needed for a coin flip.
 */
export function explorationRoll(key: string, reviewId: string): number {
  let h = 0x811c9dc5;
  const s = `${key}:${reviewId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

export function isExplorationEligible(
  item: Pick<ReviewItem, 'user_id' | 'like_count' | 'published_at'>,
  ctx: ReviewRankingContext,
): boolean {
  if (socialProximity(item.user_id, ctx) === SOCIAL_PROXIMITY.following) return false;
  if (item.like_count >= EXPLORATION.maxLikes) return false;
  const now = (ctx.now ?? new Date()).getTime();
  const ageDays = (now - new Date(item.published_at).getTime()) / 86_400_000;
  return ageDays <= EXPLORATION.maxAgeDays;
}

/**
 * Rank reviews for the friends-first sort.
 *
 * Social proximity is dominant structurally, not just by weight: reviews by
 * people you follow always come first (PRD §10.7: "a friend's 2-star review
 * is worth more to you than a stranger's viral one"), and the exploration
 * slot is placed BELOW every friend review on the first page, so exploring a
 * stranger never costs you a friend's take.
 */
export function rankReviews<T extends ReviewItem>(
  items: T[],
  ctx: ReviewRankingContext,
): { items: T[]; exploredId: string | null } {
  // Tier first, then score. The additive score alone cannot make proximity
  // dominant: the other five terms sum to 0.65, while following someone adds
  // only 0.35 × (1.0 − 0.2) = 0.28 over a stranger. Measured, not assumed —
  // see review-ranking.test.ts. So people you follow form the top tier, and
  // everyone else (followers-of-followers included) competes on the score,
  // where the 0.6-vs-0.2 proximity weight still counts.
  const tier = (item: T) => (socialProximity(item.user_id, ctx) === SOCIAL_PROXIMITY.following ? 1 : 0);
  const scored = items
    .map((item) => ({ item, tier: tier(item), score: calculateReviewRankingScore(item, ctx) }))
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        b.score - a.score ||
        new Date(b.item.published_at).getTime() - new Date(a.item.published_at).getTime() ||
        a.item.id.localeCompare(b.item.id),
    )
    .map((s) => s.item);

  const key = ctx.explorationKey;
  if (!key) return { items: scored, exploredId: null };

  // Pick at most one: the sampled eligible review with the lowest roll.
  let pick: T | null = null;
  let best = Infinity;
  for (const item of scored) {
    if (!isExplorationEligible(item, ctx)) continue;
    const roll = explorationRoll(key, item.id);
    if (roll < EXPLORATION.sampleRate && roll < best) {
      best = roll;
      pick = item;
    }
  }
  if (!pick) return { items: scored, exploredId: null };

  const firstPage = scored.slice(0, EXPLORATION.pageSize);
  let lastFriend = -1;
  firstPage.forEach((item, i) => {
    if (socialProximity(item.user_id, ctx) === SOCIAL_PROXIMITY.following) lastFriend = i;
  });
  const slot = Math.max(EXPLORATION.earliestSlot, lastFriend + 1);
  const current = scored.indexOf(pick);

  // Already visible at or above the slot on merit, or friends fill page one.
  if (current <= slot || slot >= EXPLORATION.pageSize) {
    return { items: scored, exploredId: current <= slot ? pick.id : null };
  }
  const reordered = scored.filter((i) => i !== pick);
  reordered.splice(slot, 0, pick);
  return { items: reordered, exploredId: pick.id };
}

/** Guests have no id; a key that rotates daily still gives each day a fresh sample. */
export function guestExplorationKey(now = new Date()): string {
  return `guest:${now.toISOString().slice(0, 10)}`;
}

import { ActivityService } from '../activity/index.js';

export class ReviewService {
  private activityService: ActivityService;

  constructor(private readonly db: Db) {
    this.activityService = new ActivityService(db);
  }

  /**
   * Recomputes work_stats in TypeScript/SQL as a fallback or reconciliation tool (SL-62).
   */
  async recomputeWorkStats(workId: string): Promise<void> {
    const [stats] = await this.db.execute<{
      v_count: string;
      r_sum: string;
      h_count: string;
      rd_count: string;
      d_count: string;
      p_stddev: number | null;
    }>(sql`
      SELECT
        COUNT(rating) FILTER (WHERE rating IS NOT NULL) AS v_count,
        COALESCE(SUM(rating), 0) AS r_sum,
        COUNT(DISTINCT user_id) FILTER (WHERE hearted = true) AS h_count,
        COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished') AS rd_count,
        COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf') AS d_count,
        stddev_samp(rating) AS p_stddev
      FROM reads
      WHERE work_id = ${workId}
    `);

    const [globalRow] = await this.db.execute<{ c_global: string }>(sql`
      SELECT COALESCE(AVG(rating), 3.9) AS c_global FROM reads WHERE rating IS NOT NULL AND work_id <> ${workId}
    `);

    const v = stats ? Number(stats.v_count) : 0;
    const rSum = stats ? Number(stats.r_sum) : 0;
    const cGlobal = globalRow ? Number(globalRow.c_global) : 3.9;
    const rMean = v > 0 ? rSum / v : null;
    const wRating = rMean !== null ? calculateBayesianRating(v, rMean, cGlobal, 25) : null;

    await this.db
      .insert(workStats)
      .values({
        workId,
        ratingSum: String(rSum),
        ratingCount: v,
        avgRating: rMean !== null ? rMean.toFixed(2) : null,
        weightedRating: wRating !== null ? wRating.toFixed(2) : null,
        heartCount: stats ? Number(stats.h_count) : 0,
        readCount: stats ? Number(stats.rd_count) : 0,
        dnfCount: stats ? Number(stats.d_count) : 0,
        polarisation: stats?.p_stddev ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workStats.workId,
        set: {
          ratingSum: String(rSum),
          ratingCount: v,
          avgRating: rMean !== null ? rMean.toFixed(2) : null,
          weightedRating: wRating !== null ? wRating.toFixed(2) : null,
          heartCount: stats ? Number(stats.h_count) : 0,
          readCount: stats ? Number(stats.rd_count) : 0,
          dnfCount: stats ? Number(stats.d_count) : 0,
          polarisation: stats?.p_stddev ?? null,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Create or update a review for a read (SL-63).
   */
  async upsertReview(
    userId: string,
    readId: string,
    input: {
      body: string;
      has_spoilers?: boolean;
      spoiler_after_page?: number | null;
      visibility?: 'public' | 'followers' | 'private';
      rating?: number | null;
      hearted?: boolean | null;
    },
  ): Promise<ReviewItem> {
    const trimmed = input.body.trim();
    if (!trimmed) {
      throw ApiError.badRequest('empty_body', 'Review body cannot be empty');
    }
    if (trimmed.length > 10000) {
      throw ApiError.badRequest('body_too_long', 'Review body exceeds 10,000 characters');
    }

    // Verify read exists and belongs to user
    const [read] = await this.db
      .select({
        id: reads.id,
        userId: reads.userId,
        workId: reads.workId,
        rating: reads.rating,
        hearted: reads.hearted,
        formatOverride: reads.formatOverride,
        likeCount: reads.likeCount,
        commentCount: reads.commentCount,
        source: reads.source,
      })
      .from(reads)
      .where(and(eq(reads.id, readId), eq(reads.userId, userId)));

    if (!read) {
      throw ApiError.notFound('Read not found');
    }

    // Check if review already exists for this read
    const [existing] = await this.db
      .select({ id: reviews.id, deletedAt: reviews.deletedAt })
      .from(reviews)
      .where(eq(reviews.readId, readId));

    // Publishing a review (new, or reviving a deleted one) needs a verified
    // email (D-04-1); editing a live review does not. Checked before any write.
    if (!existing || existing.deletedAt) await requireVerified(this.db, userId);

    // Update read rating or heart if provided
    const readUpdates: Record<string, any> = {};
    if (input.rating !== undefined) {
      readUpdates.rating = input.rating === null ? null : String(input.rating);
    }
    if (input.hearted !== undefined && input.hearted !== null) {
      readUpdates.hearted = input.hearted;
    }
    if (Object.keys(readUpdates).length > 0) {
      readUpdates.updatedAt = new Date();
      await this.db.update(reads).set(readUpdates).where(eq(reads.id, readId));
      // Recompute work_stats
      await this.recomputeWorkStats(read.workId);
    }

    let reviewId: string;
    if (existing) {
      reviewId = existing.id;
      await this.db
        .update(reviews)
        .set({
          body: trimmed,
          hasSpoilers: input.has_spoilers ?? false,
          spoilerAfterPage: input.spoiler_after_page ?? null,
          visibility: input.visibility ?? 'public',
          editedAt: new Date(),
          deletedAt: null,
        })
        .where(eq(reviews.id, existing.id));

      if (input.visibility) {
        await this.activityService.updateActivityVisibility(
          this.db,
          'review',
          reviewId,
          input.visibility,
        );
      }
    } else {
      const [inserted] = await this.db
        .insert(reviews)
        .values({
          readId,
          userId,
          workId: read.workId,
          body: trimmed,
          hasSpoilers: input.has_spoilers ?? false,
          spoilerAfterPage: input.spoiler_after_page ?? null,
          visibility: input.visibility ?? 'public',
          publishedAt: new Date(),
        })
        .returning({ id: reviews.id });
      reviewId = inserted!.id;

      if (read.source !== 'import') {
        await this.activityService.recordActivity(this.db, {
          actorId: userId,
          verb: 'reviewed',
          workId: read.workId,
          objectType: 'review',
          objectId: reviewId,
          metadata: {
            readId,
            hasSpoilers: input.has_spoilers ?? false,
            snippet: trimmed.slice(0, 200),
          },
          visibility: input.visibility ?? 'public',
          source: read.source,
        });
      }
    }

    const fetched = await this.getReview(reviewId, userId);
    return fetched;
  }

  /**
   * Get single review by reviewId (SL-64).
   */
  async getReview(reviewId: string, viewerId?: string | null): Promise<ReviewItem> {
    const [r] = await this.db
      .select({
        id: reviews.id,
        readId: reviews.readId,
        userId: reviews.userId,
        workId: reviews.workId,
        body: reviews.body,
        hasSpoilers: reviews.hasSpoilers,
        spoilerAfterPage: reviews.spoilerAfterPage,
        visibility: reviews.visibility,
        publishedAt: reviews.publishedAt,
        editedAt: reviews.editedAt,
        deletedAt: reviews.deletedAt,
        readVisibility: reads.visibility,
        readRating: reads.rating,
        readHearted: reads.hearted,
        readFormat: reads.formatOverride,
        readLikeCount: reads.likeCount,
        readCommentCount: reads.commentCount,
        workTitle: works.title,
        workCoverId: works.olCoverId,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
        viewerHasLiked: viewerId
          ? sql<boolean>`EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = ${reviews.readId} AND l.user_id = ${viewerId}::uuid)`
          : sql<boolean>`false`,
      })
      .from(reviews)
      .innerJoin(reads, eq(reads.id, reviews.readId))
      .innerJoin(works, eq(works.id, reviews.workId))
      .innerJoin(users, eq(users.id, reviews.userId))
      .leftJoin(profiles, eq(profiles.userId, reviews.userId))
      .where(and(eq(reviews.id, reviewId), isNull(reviews.deletedAt)));

    if (!r) {
      throw ApiError.notFound('Review not found');
    }

    // Blocks, private accounts, deleted owners and both visibilities (Audit 05):
    // every denial is the same 404 as a missing review.
    const viewer = viewerId ?? null;
    const rel = await loadRelationship(this.db, viewer, r.userId);
    if (!canViewWith(viewer, r.userId, rel, mostRestrictive(r.visibility, r.readVisibility))) {
      throw ApiError.notFound('Review not found');
    }
    const viewerHasLiked = Boolean(r.viewerHasLiked);

    return {
      id: r.id,
      read_id: r.readId,
      user_id: r.userId,
      work_id: r.workId,
      body: r.body,
      has_spoilers: r.hasSpoilers,
      spoiler_after_page: r.spoilerAfterPage,
      visibility: r.visibility as any,
      published_at: r.publishedAt.toISOString(),
      edited_at: r.editedAt ? r.editedAt.toISOString() : null,
      rating: r.readRating === null ? null : Number(r.readRating),
      hearted: r.readHearted,
      format_override: r.readFormat,
      like_count: r.readLikeCount,
      comment_count: r.readCommentCount,
      viewer_has_liked: viewerHasLiked,
      author: {
        id: r.userId,
        username: r.username ?? 'reader',
        display_name: r.displayName,
        avatar_url: r.avatarKey ? `/avatars/${r.avatarKey}` : null,
      },
      work_title: r.workTitle,
      work_cover_id: r.workCoverId,
    };
  }

  /**
   * Update an existing review (SL-63).
   */
  async updateReview(
    reviewId: string,
    userId: string,
    input: {
      body?: string;
      has_spoilers?: boolean;
      spoiler_after_page?: number | null;
      visibility?: 'public' | 'followers' | 'private';
      rating?: number | null;
      hearted?: boolean | null;
    },
  ): Promise<ReviewItem> {
    const [rev] = await this.db
      .select({ id: reviews.id, userId: reviews.userId, readId: reviews.readId, workId: reviews.workId })
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), isNull(reviews.deletedAt)));

    // Someone else's review is the same 404 as a missing one (PRD §25.3).
    if (!rev || rev.userId !== userId) throw ApiError.notFound('Review not found');

    const updateFields: Record<string, any> = { editedAt: new Date() };
    if (input.body !== undefined) {
      const trimmed = input.body.trim();
      if (!trimmed) throw ApiError.badRequest('empty_body', 'Review body cannot be empty');
      if (trimmed.length > 10000) throw ApiError.badRequest('body_too_long', 'Review body exceeds 10,000 characters');
      updateFields.body = trimmed;
    }
    if (input.has_spoilers !== undefined) updateFields.hasSpoilers = input.has_spoilers;
    if (input.spoiler_after_page !== undefined) updateFields.spoilerAfterPage = input.spoiler_after_page;
    if (input.visibility !== undefined) updateFields.visibility = input.visibility;

    await this.db.update(reviews).set(updateFields).where(eq(reviews.id, reviewId));

    // Update read rating or heart if specified
    const readUpdates: Record<string, any> = {};
    if (input.rating !== undefined) {
      readUpdates.rating = input.rating === null ? null : String(input.rating);
    }
    if (input.hearted !== undefined && input.hearted !== null) {
      readUpdates.hearted = input.hearted;
    }
    if (Object.keys(readUpdates).length > 0) {
      readUpdates.updatedAt = new Date();
      await this.db.update(reads).set(readUpdates).where(eq(reads.id, rev.readId));
      await this.recomputeWorkStats(rev.workId);
    }

    return this.getReview(reviewId, userId);
  }

  /**
   * Delete a review (SL-63).
   */
  async deleteReview(reviewId: string, userId: string): Promise<void> {
    const [rev] = await this.db
      .select({ id: reviews.id, userId: reviews.userId })
      .from(reviews)
      .where(and(eq(reviews.id, reviewId), isNull(reviews.deletedAt)));

    if (!rev || rev.userId !== userId) throw ApiError.notFound('Review not found');

    await this.db
      .update(reviews)
      .set({ deletedAt: new Date() })
      .where(eq(reviews.id, reviewId));

    await this.activityService.deleteActivity(this.db, 'review', reviewId);
  }

  /**
   * Everything the SO-23 ranking needs beyond the reviews themselves, in two
   * queries scoped to this list's authors — never a whole-graph walk.
   */
  async rankingContext(
    viewerId: string | null,
    followedIds: Set<string>,
    items: Pick<ReviewItem, 'user_id'>[],
  ): Promise<ReviewRankingContext> {
    const authorIds = [...new Set(items.map((i) => i.user_id))];
    const secondDegreeIds = new Set<string>();
    const credibility = new Map<string, number>();
    if (authorIds.length === 0) {
      return { viewerId, followedIds, secondDegreeIds, credibility, explorationKey: viewerId ?? guestExplorationKey() };
    }
    const authorList = sql.join(authorIds.map((id) => sql`${id}::uuid`), sql`, `);

    // Follower-of-follower: authors followed by someone the viewer follows.
    if (viewerId && followedIds.size > 0) {
      const rows = await this.db.execute<{ id: string }>(sql`
        SELECT DISTINCT f2.followee_id AS id
        FROM follows f1
        JOIN follows f2 ON f2.follower_id = f1.followee_id AND f2.state = 'accepted'
        WHERE f1.follower_id = ${viewerId}::uuid
          AND f1.state = 'accepted'
          AND f2.followee_id IN (${authorList})
      `);
      for (const r of rows) if (!followedIds.has(r.id)) secondDegreeIds.add(r.id);
    }

    // Credibility: the median like count across the author's live reviews.
    // A median, not a mean, so one viral review cannot buy an account
    // permanent rank; normalised and capped so no account dominates (§10.7).
    const cred = await this.db.execute<{ user_id: string; median: string | number | null }>(sql`
      SELECT rv.user_id,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY r.like_count) AS median
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      WHERE rv.user_id IN (${authorList}) AND rv.deleted_at IS NULL
      GROUP BY rv.user_id
    `);
    for (const r of cred) credibility.set(r.user_id, normaliseCredibility(Number(r.median ?? 0)));

    return {
      viewerId,
      followedIds,
      secondDegreeIds,
      credibility,
      explorationKey: viewerId ?? guestExplorationKey(),
    };
  }

  /**
   * List reviews for a work with friends-first or other sorts (SL-64).
   */
  async listWorkReviews(
    workId: string,
    query: WorkReviewsQuery,
    viewerId?: string | null,
  ): Promise<{ data: ReviewItem[]; total: number }> {
    const sort = query.sort ?? 'friends';
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = Math.max(0, query.offset ?? 0);

    // Fetch followed accounts if viewer is logged in
    const followedIds = new Set<string>();
    if (viewerId) {
      const followRows = await this.db
        .select({ followeeId: follows.followeeId })
        .from(follows)
        .where(and(eq(follows.followerId, viewerId), eq(follows.state, 'accepted')));
      for (const f of followRows) {
        followedIds.add(f.followeeId);
      }
    }

    // Base query conditions
    const whereConditions = [eq(reviews.workId, workId), isNull(reviews.deletedAt)];

    // Rating filter if present
    if (query.rating !== undefined) {
      whereConditions.push(eq(reads.rating, String(query.rating)));
    }

    // Visibility: canView() as SQL over the stricter of the review's and the
    // read's visibility, so blocks, private accounts and deleted owners are
    // filtered exactly as GET /v1/reviews/:id filters them (Audit 05).
    whereConditions.push(
      canViewSql(viewerId ?? null, {
        ownerId: reviews.userId,
        visibility: mostRestrictiveSql(reviews.visibility, reads.visibility),
        ownerIsPrivate: sql`COALESCE(${profiles.isPrivate}, true)`,
      }),
    );

    const rows = await this.db
      .select({
        id: reviews.id,
        readId: reviews.readId,
        userId: reviews.userId,
        workId: reviews.workId,
        body: reviews.body,
        hasSpoilers: reviews.hasSpoilers,
        spoilerAfterPage: reviews.spoilerAfterPage,
        visibility: reviews.visibility,
        publishedAt: reviews.publishedAt,
        editedAt: reviews.editedAt,
        deletedAt: reviews.deletedAt,
        readRating: reads.rating,
        readHearted: reads.hearted,
        readFormat: reads.formatOverride,
        readLikeCount: reads.likeCount,
        readCommentCount: reads.commentCount,
        workTitle: works.title,
        workCoverId: works.olCoverId,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
      })
      .from(reviews)
      .innerJoin(reads, eq(reads.id, reviews.readId))
      .innerJoin(works, eq(works.id, reviews.workId))
      .innerJoin(users, eq(users.id, reviews.userId))
      .leftJoin(profiles, eq(profiles.userId, reviews.userId))
      .where(and(...whereConditions));

    // Viewer likes set
    const viewerLikedReadIds = new Set<string>();
    if (viewerId && rows.length > 0) {
      const readIds = rows.map((r) => r.readId);
      const likes = await this.db
        .select({ readId: readLikes.readId })
        .from(readLikes)
        .where(and(eq(readLikes.userId, viewerId), inArray(readLikes.readId, readIds)));
      for (const l of likes) {
        viewerLikedReadIds.add(l.readId);
      }
    }

    const allItems: ReviewItem[] = rows.map((r) => ({
      id: r.id,
      read_id: r.readId,
      user_id: r.userId,
      work_id: r.workId,
      body: r.body,
      has_spoilers: r.hasSpoilers,
      spoiler_after_page: r.spoilerAfterPage,
      visibility: r.visibility as any,
      published_at: r.publishedAt.toISOString(),
      edited_at: r.editedAt ? r.editedAt.toISOString() : null,
      rating: r.readRating === null ? null : Number(r.readRating),
      hearted: r.readHearted,
      format_override: r.readFormat,
      like_count: r.readLikeCount,
      comment_count: r.readCommentCount,
      viewer_has_liked: viewerLikedReadIds.has(r.readId),
      author: {
        id: r.userId,
        username: r.username ?? 'reader',
        display_name: r.displayName,
        avatar_url: r.avatarKey ? `/avatars/${r.avatarKey}` : null,
      },
      work_title: r.workTitle,
      work_cover_id: r.workCoverId,
    }));

    // Sort items
    if (sort === 'friends') {
      const ctx = await this.rankingContext(viewerId ?? null, followedIds, allItems);
      const ranked = rankReviews(allItems, ctx);
      allItems.splice(0, allItems.length, ...ranked.items);
    } else if (sort === 'likes') {
      allItems.sort((a, b) => b.like_count - a.like_count || new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    } else if (sort === 'newest') {
      allItems.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    } else if (sort === 'highest') {
      allItems.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    } else if (sort === 'lowest') {
      allItems.sort((a, b) => (a.rating ?? 99) - (b.rating ?? 99) || new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    }

    const total = allItems.length;
    const paged = allItems.slice(offset, offset + limit);

    return { data: paged, total };
  }
}

/**
 * Fastify routes plugin for ratings and reviews.
 */
export async function reviewsPlugin(app: FastifyInstance, opts: { db: Db }) {
  const service = new ReviewService(opts.db);

  // POST /v1/reads/:id/review — write or edit a review for a read
  app.post<{
    Params: { id: string };
    Body: {
      body: string;
      has_spoilers?: boolean;
      spoiler_after_page?: number | null;
      visibility?: 'public' | 'followers' | 'private';
      rating?: number | null;
      hearted?: boolean | null;
    };
  }>(
    '/v1/reads/:id/review',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Create or update review for a read',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: createReviewBodySchema,
        response: { 200: reviewSchema, 201: reviewSchema },
      },
    },
    async (req, reply) => {
      const viewerId = requireViewer(req);
      const res = await service.upsertReview(viewerId, req.params.id, req.body);
      return reply.code(200).send(res);
    },
  );

  // GET /v1/reviews/:id — get review detail
  app.get<{ Params: { id: string } }>(
    '/v1/reviews/:id',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Get review detail by ID',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: reviewSchema },
      },
    },
    async (req, reply) => {
      const viewerId = req.viewer;
      const res = await service.getReview(req.params.id, viewerId);
      return reply.code(200).send(res);
    },
  );

  // PATCH /v1/reviews/:id — update existing review
  app.patch<{
    Params: { id: string };
    Body: {
      body?: string;
      has_spoilers?: boolean;
      spoiler_after_page?: number | null;
      visibility?: 'public' | 'followers' | 'private';
      rating?: number | null;
      hearted?: boolean | null;
    };
  }>(
    '/v1/reviews/:id',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Update existing review',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: updateReviewBodySchema,
        response: { 200: reviewSchema },
      },
    },
    async (req, reply) => {
      const viewerId = requireViewer(req);
      const res = await service.updateReview(req.params.id, viewerId, req.body);
      return reply.code(200).send(res);
    },
  );

  // DELETE /v1/reviews/:id — delete review
  app.delete<{ Params: { id: string } }>(
    '/v1/reviews/:id',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Delete review',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (req, reply) => {
      const viewerId = requireViewer(req);
      await service.deleteReview(req.params.id, viewerId);
      return reply.code(204).send();
    },
  );

  // GET /v1/works/:id/reviews — list reviews for a work
  app.get<{
    Params: { id: string };
    Querystring: WorkReviewsQuery;
  }>(
    '/v1/works/:id/reviews',
    {
      schema: {
        tags: ['reviews'],
        summary: 'List reviews for a work with friends-first ranking',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        querystring: workReviewsQuerySchema,
        response: { 200: workReviewsResponseSchema },
      },
    },
    async (req, reply) => {
      const viewerId = req.viewer;
      const res = await service.listWorkReviews(req.params.id, req.query, viewerId);
      return reply.code(200).send(res);
    },
  );
}
