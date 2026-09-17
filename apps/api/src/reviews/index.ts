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
  createReviewBodySchema,
  updateReviewBodySchema,
  reviewSchema,
  workReviewsQuerySchema,
  workReviewsResponseSchema,
  toggleLikeResponseSchema,
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
 * Review ranking algorithm (PRD §10.7).
 *
 * score =  0.35 * social_proximity
 *        + 0.20 * log(1 + likes)
 *        + 0.10 * log(1 + comments)
 *        + 0.15 * recency_decay
 *        + 0.10 * author_credibility
 *        + 0.10 * length_quality
 *        - 0.10 * report_penalty
 */
export function calculateReviewRankingScore(
  item: ReviewItem,
  viewerId?: string | null,
  viewerFollowedIds: Set<string> = new Set(),
): number {
  // 1. Social proximity (dominant 0.35 weight)
  let socialProximity = 0.2;
  if (viewerId && item.user_id === viewerId) {
    socialProximity = 1.0;
  } else if (viewerFollowedIds.has(item.user_id)) {
    socialProximity = 1.0;
  }

  // 2. Engagement log-scaled (normalized in [0, 1] so social proximity dominates deliberately, PRD §10.7)
  const likesScore = Math.min(1.0, Math.log10(1 + Math.max(0, item.like_count)) / 2);
  const commentsScore = Math.min(1.0, Math.log10(1 + Math.max(0, item.comment_count)) / 1.5);

  // 3. Recency decay: exp(-age_days / 45)
  const ageDays = Math.max(0, (Date.now() - new Date(item.published_at).getTime()) / 86400000);
  const recencyDecay = Math.exp(-ageDays / 45);

  // 4. Author credibility
  const authorCredibility = 0.5;

  // 5. Length quality (favours 80–600 chars)
  const len = item.body.length;
  const lengthQuality =
    len >= 80 && len <= 600 ? 1.0 : Math.max(0.1, 1 - Math.abs(len - 340) / 1200);

  return (
    0.35 * socialProximity +
    0.2 * likesScore +
    0.1 * commentsScore +
    0.15 * recencyDecay +
    0.1 * authorCredibility +
    0.1 * lengthQuality
  );
}

export class ReviewService {
  constructor(private readonly db: Db) {}

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
      })
      .from(reads)
      .where(and(eq(reads.id, readId), eq(reads.userId, userId)));

    if (!read) {
      throw ApiError.notFound('Read not found');
    }

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

    // Check if review already exists for this read
    const [existing] = await this.db
      .select({ id: reviews.id })
      .from(reviews)
      .where(eq(reviews.readId, readId));

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
      .where(and(eq(reviews.id, reviewId), isNull(reviews.deletedAt)));

    if (!r) {
      throw ApiError.notFound('Review not found');
    }

    // Check visibility
    if (r.visibility === 'private' && viewerId !== r.userId) {
      throw ApiError.notFound('Review not found');
    }
    if (r.visibility === 'followers' && viewerId !== r.userId) {
      if (!viewerId) throw ApiError.notFound('Review not found');
      const [follow] = await this.db
        .select({ state: follows.state })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, viewerId),
            eq(follows.followeeId, r.userId),
            eq(follows.state, 'accepted'),
          ),
        );
      if (!follow) throw ApiError.notFound('Review not found');
    }

    // Check if viewer has liked this read
    let viewerHasLiked = false;
    if (viewerId) {
      const [like] = await this.db
        .select({ readId: readLikes.readId })
        .from(readLikes)
        .where(and(eq(readLikes.readId, r.readId), eq(readLikes.userId, viewerId)));
      viewerHasLiked = !!like;
    }

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

    if (!rev) throw ApiError.notFound('Review not found');
    if (rev.userId !== userId) throw ApiError.forbidden('forbidden', 'You can only edit your own reviews');

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

    if (!rev) throw ApiError.notFound('Review not found');
    if (rev.userId !== userId) throw ApiError.forbidden('forbidden', 'You can only delete your own reviews');

    await this.db
      .update(reviews)
      .set({ deletedAt: new Date() })
      .where(eq(reviews.id, reviewId));
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

    // Visibility filter
    if (!viewerId) {
      whereConditions.push(eq(reviews.visibility, 'public'));
    } else {
      whereConditions.push(
        sql`(${reviews.visibility} = 'public' OR ${reviews.userId} = ${viewerId} OR (${reviews.visibility} = 'followers' AND ${reviews.userId} IN (SELECT followee_id FROM follows WHERE follower_id = ${viewerId} AND state = 'accepted')))`
      );
    }

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
      allItems.sort((a, b) => {
        const scoreA = calculateReviewRankingScore(a, viewerId, followedIds);
        const scoreB = calculateReviewRankingScore(b, viewerId, followedIds);
        return scoreB - scoreA;
      });
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

  /**
   * Toggle like on a read/review (Architecture §3.5).
   */
  async toggleLike(readId: string, userId: string): Promise<{ liked: boolean; like_count: number }> {
    const [read] = await this.db
      .select({ id: reads.id, likeCount: reads.likeCount })
      .from(reads)
      .where(eq(reads.id, readId));

    if (!read) throw ApiError.notFound('Read not found');

    const [existing] = await this.db
      .select({ readId: readLikes.readId })
      .from(readLikes)
      .where(and(eq(readLikes.readId, readId), eq(readLikes.userId, userId)));

    if (existing) {
      // Remove like
      await this.db
        .delete(readLikes)
        .where(and(eq(readLikes.readId, readId), eq(readLikes.userId, userId)));

      const nextCount = Math.max(0, read.likeCount - 1);
      await this.db
        .update(reads)
        .set({ likeCount: nextCount })
        .where(eq(reads.id, readId));

      return { liked: false, like_count: nextCount };
    } else {
      // Add like
      await this.db.insert(readLikes).values({
        readId,
        userId,
        createdAt: new Date(),
      });

      const nextCount = read.likeCount + 1;
      await this.db
        .update(reads)
        .set({ likeCount: nextCount })
        .where(eq(reads.id, readId));

      return { liked: true, like_count: nextCount };
    }
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

  // POST /v1/reads/:id/like — toggle like on a read
  app.post<{ Params: { id: string } }>(
    '/v1/reads/:id/like',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Toggle like on a read',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: toggleLikeResponseSchema },
      },
    },
    async (req, reply) => {
      const viewerId = requireViewer(req);
      const res = await service.toggleLike(req.params.id, viewerId);
      return reply.code(200).send(res);
    },
  );
}
