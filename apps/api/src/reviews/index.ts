// Reviews, ratings, and social interactions (SL-62, SL-63, SL-64).
// Governed by:
//   - PRD §6.24–§6.27 (Book detail reviews, review detail, review composer)
//   - PRD §9.3–§9.7 (Ratings, Bayesian weighted average, polarization)
//   - PRD §10.1–§10.7 (Review ranking algorithm, content requirements, likes)
//   - Architecture §3.1, §3.5, §3.7 (reviews, read_likes, follows tables)

import { sql, eq, and, desc, asc, isNull, inArray, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Cache, Db } from '../platform/index.js';
import {
  reviews,
  reads,
  readLikes,
  follows,
  works,
  users,
  profiles,
} from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { resolveWorkId } from '../catalog/resolve.js';
import {
  canViewSql,
  canViewWith,
  loadRelationship,
  mostRestrictive,
  mostRestrictiveSql,
  requireVerified,
  type Visibility,
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

/**
 * What the ranking reads from a review. The list ranks these narrow rows
 * (body_length from SQL, no body) and loads only the page in full (audit 09).
 */
export type RankableReview = Pick<ReviewItem, 'id' | 'user_id' | 'like_count' | 'comment_count' | 'published_at'> &
  ({ body: string } | { body_length: number });

const bodyLength = (item: RankableReview) => ('body_length' in item ? item.body_length : [...item.body].length);

export function calculateReviewRankingScore(
  item: RankableReview,
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
  const length = lengthQuality(bodyLength(item));
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
export function rankReviews<T extends RankableReview>(
  items: T[],
  rankingCtx: ReviewRankingContext,
): { items: T[]; exploredId: string | null } {
  // One clock for the whole ranking. Read per item, reviews that tie drew
  // recency from instants microseconds apart, so ties fell in a different
  // order on each request and pages repeated or skipped reviews (audit 09).
  const ctx: ReviewRankingContext = { ...rankingCtx, now: rankingCtx.now ?? new Date() };
  const scored = scoreAndSort(items, ctx).map((s) => s.item);

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

/**
 * The order before the exploration slot, with each review's tier and exact
 * score. `ctx.now` must be set: one clock per ranking.
 *
 * Tier first, then score. The additive score alone cannot make proximity
 * dominant: the other five terms sum to 0.65, while following someone adds
 * only 0.35 × (1.0 − 0.2) = 0.28 over a stranger. Measured, not assumed —
 * see review-ranking.test.ts. So people you follow form the top tier, and
 * everyone else (followers-of-followers included) competes on the score,
 * where the 0.6-vs-0.2 proximity weight still counts.
 */
export function scoreAndSort<T extends RankableReview>(
  items: T[],
  ctx: ReviewRankingContext,
): { item: T; tier: number; score: number }[] {
  const tier = (item: T) => (socialProximity(item.user_id, ctx) === SOCIAL_PROXIMITY.following ? 1 : 0);
  return items
    .map((item) => ({ item, tier: tier(item), score: calculateReviewRankingScore(item, ctx) }))
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        b.score - a.score ||
        new Date(b.item.published_at).getTime() - new Date(a.item.published_at).getTime() ||
        a.item.id.localeCompare(b.item.id),
    );
}

/**
 * The most the terms a SQL lower bound leaves out can add (audit 09b): the
 * lower bound scores credibility as 0 and a non-friend as a stranger (0.2).
 * A friend's proximity is exact (1.0), so only credibility is missing.
 */
export const LOWER_BOUND_SLACK = {
  friend: REVIEW_RANKING_WEIGHTS.credibility,
  other:
    REVIEW_RANKING_WEIGHTS.credibility +
    REVIEW_RANKING_WEIGHTS.proximity * (SOCIAL_PROXIMITY.secondDegree - SOCIAL_PROXIMITY.stranger),
} as const;

/** SQL and JS compute the same bound in different floating-point orders. */
const BOUND_EPSILON = 1e-9;

/**
 * Whether the first `k` of a ranking of CAPPED candidates are the first `k`
 * of the ranking of every review. The candidates are every review above
 * `boundary` in (friend tier, lower bound) order, plus extras; `boundary` is
 * the last one the SQL returned, or null when it returned them all.
 *
 * A review left out scores at most boundary.lb + slack. If the k-th ranked
 * candidate scores more (or is a friend while the boundary is not), nothing
 * left out can rank above it. Ties are not enough: a tie is broken by date
 * and id, which the bound says nothing about. The exploration slot only
 * moves a review within the first page, so an exact prefix stays exact.
 */
export function cappedPrefixIsExact(
  sorted: { tier: number; score: number }[],
  k: number,
  boundary: { friend: boolean; lb: number } | null,
): boolean {
  if (!boundary) return true;
  const x = sorted[k - 1];
  if (!x) return false;
  if (boundary.friend) return x.tier === 1 && x.score > boundary.lb + LOWER_BOUND_SLACK.friend + BOUND_EPSILON;
  return x.tier === 1 || x.score > boundary.lb + LOWER_BOUND_SLACK.other + BOUND_EPSILON;
}

/** Guests have no id; a key that rotates daily still gives each day a fresh sample. */
export function guestExplorationKey(now = new Date()): string {
  return `guest:${now.toISOString().slice(0, 10)}`;
}

import { ActivityService } from '../activity/index.js';

/** PRD §10.6: no minimum, 10,000 characters. Counted in code points, as char_length() and the schema's maxLength count. */
function checkBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw ApiError.badRequest('empty_body', 'Review body cannot be empty');
  if ([...trimmed].length > 10000) throw ApiError.badRequest('body_too_long', 'Review body exceeds 10,000 characters');
  return trimmed;
}

/**
 * The spoiler fields to store. A page without the spoiler flag means nothing
 * and is dropped (the app keeps the page field after the switch goes off); a
 * page past the end of the read's edition is refused. Omitted fields keep
 * `current` (a live review) or the defaults.
 */
function resolveSpoilers(
  input: { has_spoilers?: boolean; spoiler_after_page?: number | null },
  current: { hasSpoilers: boolean; spoilerAfterPage: number | null } | null,
  pageCount: number | null,
): { hasSpoilers: boolean; spoilerAfterPage: number | null } {
  const hasSpoilers = input.has_spoilers ?? current?.hasSpoilers ?? false;
  const page = input.spoiler_after_page !== undefined ? input.spoiler_after_page : (current?.spoilerAfterPage ?? null);
  if (!hasSpoilers) return { hasSpoilers, spoilerAfterPage: null };
  if (page !== null && pageCount !== null && page > pageCount) {
    throw ApiError.unprocessable(
      'spoiler_page_out_of_range',
      `Spoilers after page ${page}, but this edition has ${pageCount} pages.`,
      'spoiler_after_page',
    );
  }
  return { hasSpoilers, spoilerAfterPage: page };
}

/** rating: null clears the rating (PRD §9.3); the heart is independent of it (§9.4). */
async function writeRatingAndHeart(
  tx: Db,
  readId: string,
  input: { rating?: number | null; hearted?: boolean | null },
): Promise<void> {
  const set: { rating?: string | null; hearted?: boolean; updatedAt?: Date } = {};
  if (input.rating !== undefined) set.rating = input.rating === null ? null : input.rating.toFixed(1);
  if (input.hearted !== undefined && input.hearted !== null) set.hearted = input.hearted;
  if (Object.keys(set).length === 0) return;
  set.updatedAt = new Date();
  await tx.update(reads).set(set).where(eq(reads.id, readId));
}

/**
 * Make a review's feed activity match the review, from its current state
 * (audit 09). The feed trusts activity.visibility, so this is the privacy
 * control for review cards: none for a deleted, imported (IM-07) or
 * effectively private review; otherwise the stricter of the review's and the
 * read's visibility, followers-only for a private account (PRD §26.2), with
 * the current text and spoiler flag. An existing row is updated in place
 * (its created_at keeps its place in feeds); a missing one is created now.
 * Call it in the transaction of every write that changes any of those.
 */
export async function syncReviewActivity(tx: Db, reviewId: string): Promise<void> {
  const [rv] = await tx.execute<{
    user_id: string; work_id: string; read_id: string; body: string; has_spoilers: boolean;
    visibility: string; read_visibility: string; deleted: boolean; source: string; is_private: boolean;
  }>(sql`
    SELECT rv.user_id, rv.work_id, rv.read_id, rv.body, rv.has_spoilers, rv.visibility,
           r.visibility AS read_visibility, rv.deleted_at IS NOT NULL AS deleted, r.source,
           COALESCE(p.is_private, false) AS is_private
    FROM reviews rv
    JOIN reads r ON r.id = rv.read_id
    LEFT JOIN profiles p ON p.user_id = rv.user_id
    WHERE rv.id = ${reviewId}::uuid`);
  const effective = rv ? mostRestrictive(rv.visibility, rv.read_visibility) : 'private';
  if (!rv || rv.deleted || rv.source === 'import' || effective === 'private') {
    await tx.execute(sql`DELETE FROM activity WHERE object_type = 'review' AND object_id = ${reviewId}::uuid`);
    return;
  }
  const visibility: Visibility = rv.is_private ? 'followers' : effective;
  const metadata = { readId: rv.read_id, hasSpoilers: rv.has_spoilers, snippet: rv.body.slice(0, 200) };
  const updated = await tx.execute<{ id: string }>(sql`
    UPDATE activity SET visibility = ${visibility}, metadata = ${JSON.stringify(metadata)}::jsonb
    WHERE object_type = 'review' AND object_id = ${reviewId}::uuid
    RETURNING id`);
  if (updated.length > 0) return;
  await new ActivityService(tx).recordActivity(tx, {
    actorId: rv.user_id,
    verb: 'reviewed',
    workId: rv.work_id,
    objectType: 'review',
    objectId: reviewId,
    metadata,
    visibility,
    source: rv.source,
  });
}

/**
 * FROM … WHERE for the reviews of a work `viewer` may see. canView() as SQL
 * over the stricter of the review's and the read's visibility, so blocks,
 * private accounts and deleted owners are filtered exactly as GET
 * /v1/reviews/:id filters them (Audit 05). `rating` is the star bucket:
 * above rating − 1, up to rating.
 */
function visibleReviews(workId: string, viewer: string | null, rating: number | undefined): SQL {
  return sql`
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      LEFT JOIN profiles p ON p.user_id = rv.user_id
      WHERE rv.work_id = ${workId}::uuid
        AND rv.deleted_at IS NULL
        ${rating !== undefined ? sql`AND r.rating > ${rating - 1} AND r.rating <= ${rating}` : sql``}
        AND ${canViewSql(viewer, {
          ownerId: sql`rv.user_id`,
          visibility: mostRestrictiveSql(sql`rv.visibility`, sql`r.visibility`),
          ownerIsPrivate: sql`COALESCE(p.is_private, true)`,
        })}`;
}

/** What the friends sort reads per review: narrow, no body (audit 09). */
type RankRow = {
  id: string; user_id: string; published_at: string | Date;
  like_count: number; comment_count: number; body_length: number;
};
const RANK_COLUMNS = sql`rv.id, rv.user_id, rv.published_at, r.like_count, r.comment_count,
  char_length(rv.body) AS body_length`;
const toRankable = (r: RankRow) => ({
  id: r.id,
  user_id: r.user_id,
  published_at: new Date(r.published_at).toISOString(),
  like_count: Number(r.like_count),
  comment_count: Number(r.comment_count),
  body_length: Number(r.body_length),
});

export class ReviewService {
  /** `cache`: the guest friends-sort ranking (audit 09b). Without one, nothing is cached. */
  constructor(
    private readonly db: Db,
    private readonly cache?: Cache,
  ) {}

  /**
   * Create or update the review of a read (SL-63). One transaction: the
   * read's rating and heart, the review and its feed activity are written
   * together or not at all (audit 09). work_stats follows the rating and
   * heart through the reads trigger, the one implementation of the
   * aggregates (0026); nothing here recomputes them.
   *
   * Fields the request omits keep the review's current values, so an offline
   * replay that carries only the body cannot reset its visibility or
   * spoilers. Writing over a deleted review publishes it again: a new
   * publication (published now, not "edited"), public unless told otherwise.
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
    const trimmed = checkBody(input.body);

    const reviewId = await this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      // The row lock serialises two writes of one read (a double submit, an
      // offline replay racing the original): the second sees the first's review.
      const [read] = await tx.execute<{ id: string; work_id: string; status: string; page_count: number | null }>(sql`
        SELECT r.id, r.work_id, r.status, e.page_count
        FROM reads r LEFT JOIN editions e ON e.id = r.edition_id
        WHERE r.id = ${readId}::uuid AND r.user_id = ${userId}::uuid
        FOR UPDATE OF r`);
      if (!read) throw ApiError.notFound('Read not found');
      // Decided 2026-09-30 (A-09-026): a book on the want list has not been
      // read, so it cannot be reviewed. Reading, paused, finished and DNF can.
      if (read.status === 'want') {
        throw ApiError.unprocessable(
          'review_needs_reading',
          'Start or finish this book before reviewing it.',
          'status',
        );
      }

      const [existing] = await tx
        .select({
          id: reviews.id,
          deletedAt: reviews.deletedAt,
          hasSpoilers: reviews.hasSpoilers,
          spoilerAfterPage: reviews.spoilerAfterPage,
          visibility: reviews.visibility,
        })
        .from(reviews)
        .where(eq(reviews.readId, readId));
      const live = existing && !existing.deletedAt ? existing : null;

      // Publishing a review (new, or reviving a deleted one) needs a verified
      // email (D-04-1); editing a live review does not. Checked before any write.
      if (!live) await requireVerified(tx, userId);

      const spoilers = resolveSpoilers(input, live, read.page_count);
      const visibility = input.visibility ?? (live?.visibility as Visibility | undefined) ?? 'public';

      await writeRatingAndHeart(tx, readId, input);

      let id: string;
      if (existing) {
        id = existing.id;
        const now = new Date();
        await tx
          .update(reviews)
          .set({
            body: trimmed,
            ...spoilers,
            visibility,
            ...(live ? { editedAt: now } : { publishedAt: now, editedAt: null, deletedAt: null }),
          })
          .where(eq(reviews.id, existing.id));
      } else {
        const [inserted] = await tx
          .insert(reviews)
          .values({ readId, userId, workId: read.work_id, body: trimmed, ...spoilers, visibility, publishedAt: new Date() })
          .returning({ id: reviews.id });
        id = inserted!.id;
      }
      await syncReviewActivity(tx, id);
      return id;
    });

    return this.getReview(reviewId, userId);
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
   * Update an existing review (SL-63). Same transaction and activity rules
   * as upsertReview; only the fields sent change.
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
    const body = input.body === undefined ? undefined : checkBody(input.body);

    await this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const [rev] = await tx.execute<{
        id: string; user_id: string; read_id: string; has_spoilers: boolean;
        spoiler_after_page: number | null; page_count: number | null;
      }>(sql`
        SELECT rv.id, rv.user_id, rv.read_id, rv.has_spoilers, rv.spoiler_after_page, e.page_count
        FROM reviews rv
        JOIN reads r ON r.id = rv.read_id
        LEFT JOIN editions e ON e.id = r.edition_id
        WHERE rv.id = ${reviewId}::uuid AND rv.deleted_at IS NULL
        FOR UPDATE OF r, rv`);

      // Someone else's review is the same 404 as a missing one (PRD §25.3).
      if (!rev || rev.user_id !== userId) throw ApiError.notFound('Review not found');

      const spoilers = resolveSpoilers(
        input,
        { hasSpoilers: rev.has_spoilers, spoilerAfterPage: rev.spoiler_after_page },
        rev.page_count,
      );
      await tx
        .update(reviews)
        .set({
          editedAt: new Date(),
          ...(body !== undefined ? { body } : {}),
          ...spoilers,
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        })
        .where(eq(reviews.id, reviewId));

      await writeRatingAndHeart(tx, rev.read_id, input);
      await syncReviewActivity(tx, reviewId);
    });

    return this.getReview(reviewId, userId);
  }

  /**
   * Delete a review (SL-63): soft delete, and its activity goes with it.
   */
  async deleteReview(reviewId: string, userId: string): Promise<void> {
    await this.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      const [rev] = await tx
        .select({ id: reviews.id, userId: reviews.userId })
        .from(reviews)
        .where(and(eq(reviews.id, reviewId), isNull(reviews.deletedAt)))
        .for('update');

      if (!rev || rev.userId !== userId) throw ApiError.notFound('Review not found');

      await tx.update(reviews).set({ deletedAt: new Date() }).where(eq(reviews.id, reviewId));
      await syncReviewActivity(tx, reviewId);
    });
  }

  /**
   * Everything the SO-23 ranking needs beyond the reviews themselves, in two
   * queries scoped to the authors of this work's reviews: never a whole-graph
   * walk, and never a parameter list of every author (audit 09: a ~3,000-uuid
   * IN list per query on the hot work).
   */
  async rankingContext(
    viewerId: string | null,
    followedIds: Set<string>,
    workId: string,
    /** Only these authors (the capped candidates, audit 09b); default: every author of the work. */
    authorIds?: string[],
  ): Promise<ReviewRankingContext> {
    const secondDegreeIds = new Set<string>();
    const credibility = new Map<string, number>();
    const authors = authorIds
      ? sql`(${authorIds.length ? sql.join(authorIds.map((id) => sql`${id}::uuid`), sql`, `) : sql`NULL::uuid`})`
      : sql`(SELECT a.user_id FROM reviews a WHERE a.work_id = ${workId}::uuid AND a.deleted_at IS NULL)`;

    // Follower-of-follower: authors followed by someone the viewer follows.
    if (viewerId && followedIds.size > 0) {
      const rows = await this.db.execute<{ id: string }>(sql`
        SELECT DISTINCT f2.followee_id AS id
        FROM follows f1
        JOIN follows f2 ON f2.follower_id = f1.followee_id AND f2.state = 'accepted'
        WHERE f1.follower_id = ${viewerId}::uuid
          AND f1.state = 'accepted'
          AND f2.followee_id IN ${authors}
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
      WHERE rv.user_id IN ${authors} AND rv.deleted_at IS NULL
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
   *
   * Audit 09: this loaded every review of the work in full (bodies up to
   * 10,000 characters), mapped and sorted them in JS and sliced a page:
   * 2.4 s p50 on the 5,300-review bench work. Now:
   *   - likes / newest / highest / lowest sort and page in SQL, id last so
   *     ties never repeat or skip across pages;
   *   - friends ranks narrow rows (no body) exactly as before (SO-23), then
   *     loads only the page.
   * The rating filter is the star bucket of rating_distribution: 4 means
   * above 3 up to 4, so half stars are reachable.
   */
  async listWorkReviews(
    workId: string,
    query: WorkReviewsQuery,
    viewerId?: string | null,
  ): Promise<{ data: ReviewItem[]; total: number }> {
    // D3: a merged work's id lists the survivor's reviews. An id that names
    // no work keeps its old answer, an empty list.
    workId = (await resolveWorkId(this.db, workId)) ?? workId;
    const sort = query.sort ?? 'friends';
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = Math.max(0, query.offset ?? 0);
    const viewer = viewerId ?? null;
    const visible = visibleReviews(workId, viewer, query.rating);

    let pageIds: string[];
    let total: number;
    if (sort === 'friends' && !viewer) {
      ({ ids: pageIds, total } = await this.#guestFriendsPage(workId, query.rating, visible, offset, limit));
    } else if (sort === 'friends') {
      ({ ids: pageIds, total } = await this.#friendsPage(workId, viewer!, visible, offset, limit));
    } else {
      const order = {
        likes: sql`r.like_count DESC, rv.published_at DESC, rv.id DESC`,
        newest: sql`rv.published_at DESC, rv.id DESC`,
        highest: sql`r.rating DESC NULLS LAST, rv.published_at DESC, rv.id DESC`,
        lowest: sql`r.rating ASC NULLS LAST, rv.published_at DESC, rv.id DESC`,
      }[sort];
      const [rows, [count]] = await Promise.all([
        this.db.execute<{ id: string }>(sql`SELECT rv.id ${visible} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`),
        this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n ${visible}`),
      ]);
      total = Number(count?.n ?? 0);
      pageIds = rows.map((r) => r.id);
    }

    return { data: await this.#hydrate(pageIds, viewer), total };
  }

  /**
   * Every visible review's id in friends-first order, uncapped: narrow rows
   * (no body), ranked in JS. The guest path caches it; the capped path must
   * agree with it (reviews-audit.test.ts parity).
   */
  async rankAll(workId: string, viewer: string | null, rating?: number): Promise<string[]> {
    const visible = visibleReviews(workId, viewer, rating);
    const followedIds = new Set<string>();
    if (viewer) {
      const followRows = await this.db
        .select({ followeeId: follows.followeeId })
        .from(follows)
        .where(and(eq(follows.followerId, viewer), eq(follows.state, 'accepted')));
      for (const f of followRows) followedIds.add(f.followeeId);
    }
    const [rows, ctx] = await Promise.all([
      this.db.execute<RankRow>(sql`SELECT ${RANK_COLUMNS} ${visible}`),
      this.rankingContext(viewer, followedIds, workId),
    ]);
    return rankReviews(rows.map(toRankable), ctx).items.map((r) => r.id);
  }

  /**
   * Guests (audit 09b, A-09-009): the ranking is the same for every guest
   * within a day (the exploration key is daily), so the ranked id list is
   * cached per work, rating filter and day for 60 s, like GET /works/:id.
   * The page is re-checked against the live visibility before it is
   * hydrated: a review deleted or made private within the 60 s drops out
   * (the page is one short and the total one high until the entry expires).
   * Signed-in viewers never reach this path.
   */
  async #guestFriendsPage(
    workId: string,
    rating: number | undefined,
    visible: SQL,
    offset: number,
    limit: number,
  ): Promise<{ ids: string[]; total: number }> {
    const key = `reviews:friends:guest:${workId}:${rating ?? 'all'}:${guestExplorationKey()}`;
    let ranked = await this.cache?.get<string[]>(key);
    if (!ranked) {
      ranked = await this.rankAll(workId, null, rating);
      await this.cache?.set(key, ranked, 60);
    }
    const page = ranked.slice(offset, offset + limit);
    if (page.length === 0) return { ids: [], total: ranked.length };
    const live = await this.db.execute<{ id: string }>(sql`
      SELECT rv.id ${visible} AND rv.id IN (${sql.join(page.map((id) => sql`${id}::uuid`), sql`, `)})`);
    const liveIds = new Set(live.map((r) => r.id));
    return { ids: page.filter((id) => liveIds.has(id)), total: ranked.length };
  }

  /**
   * Signed-in friends-first page from a capped, exact candidate set (audit
   * 09b, A-09-009). SO-23's order is unchanged; fewer reviews are ranked.
   * Candidates:
   *   - the top N visible reviews in (friend tier, lower bound) order. The
   *     lower bound is the score with credibility 0 and every non-friend a
   *     stranger, in SQL with the same weights, at the same instant;
   *   - the exploration pick, chosen from the whole pool (non-friend,
   *     <= 14 days, < 5 likes) as rankReviews would choose it.
   * Ranked exactly in JS with the ranking context of the candidates' authors
   * only. While a review left out could still reach the page
   * (cappedPrefixIsExact), N doubles. N starts at max(200, 2 × (offset + limit)).
   *
   * One deviation from the approved plan, which loaded every friend review:
   * the friend tier is capped by the same bound (slack: credibility only).
   * The heavy bench viewer follows 1,158 accounts, and 2,007 of the hot
   * work's reviews are theirs; loading them all would keep most of the cost.
   */
  async #friendsPage(
    workId: string,
    viewer: string,
    visible: SQL,
    offset: number,
    limit: number,
  ): Promise<{ ids: string[]; total: number }> {
    const now = new Date();
    const k = offset + limit;
    const w = REVIEW_RANKING_WEIGHTS;
    const friend = sql`(rv.user_id = ${viewer}::uuid OR rv.user_id IN (
      SELECT f.followee_id FROM follows f WHERE f.follower_id = ${viewer}::uuid AND f.state = 'accepted'))`;
    // calculateReviewRankingScore without credibility, report penalty and
    // second-degree proximity: the same inputs and weights, at `now`.
    const lowerBound = sql`(
      ${w.proximity}::float8 * CASE WHEN c.friend THEN ${SOCIAL_PROXIMITY.following}::float8 ELSE ${SOCIAL_PROXIMITY.stranger}::float8 END
      + ${w.likes}::float8 * LEAST(1, log(1 + GREATEST(0, c.like_count)::float8) / 2)
      + ${w.comments}::float8 * LEAST(1, log(1 + GREATEST(0, c.comment_count)::float8) / 1.5)
      + ${w.recency}::float8 * exp(-GREATEST(0, extract(epoch FROM (${now.toISOString()}::timestamptz - c.published_at))::float8) / 86400 / 45)
      + ${w.length}::float8 * CASE WHEN c.body_length BETWEEN 80 AND 600 THEN 1
          ELSE GREATEST(0.1, 1 - abs(c.body_length - 340)::float8 / 1200) END)`;
    const candidates = sql`(SELECT ${RANK_COLUMNS}, ${friend} AS friend ${visible}) c`;
    // A minute wider than 14 days: an extra row is harmless, a missing one is not.
    const poolSince = new Date(now.getTime() - (EXPLORATION.maxAgeDays * 86_400 + 60) * 1000).toISOString();

    const top = (n: number) => this.db.execute<RankRow & { friend: boolean; lb: number }>(sql`
      SELECT c.*, ${lowerBound} AS lb FROM ${candidates}
      ORDER BY c.friend DESC, lb DESC, c.id LIMIT ${n}`);
    const firstN = Math.max(200, 2 * k);

    // The first candidate read runs with the others: it needs none of them.
    const [followRows, [count], pool, firstRows] = await Promise.all([
      this.db
        .select({ followeeId: follows.followeeId })
        .from(follows)
        .where(and(eq(follows.followerId, viewer), eq(follows.state, 'accepted'))),
      this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n ${visible}`),
      this.db.execute<RankRow>(sql`
        SELECT c.* FROM ${candidates}
        WHERE NOT c.friend AND c.like_count < ${EXPLORATION.maxLikes} AND c.published_at >= ${poolSince}::timestamptz`),
      top(firstN),
    ]);
    const followedIds = new Set(followRows.map((f) => f.followeeId));

    // The pick, as rankReviews picks it: the eligible review with the lowest
    // roll under the sample rate.
    const base: ReviewRankingContext = { viewerId: viewer, followedIds, now };
    let pick: ReturnType<typeof toRankable> | null = null;
    let best = Infinity;
    for (const row of pool.map(toRankable)) {
      if (!isExplorationEligible(row, base)) continue;
      const roll = explorationRoll(viewer, row.id);
      if (roll < EXPLORATION.sampleRate && roll < best) [pick, best] = [row, roll];
    }

    for (let n = firstN; ; n *= 2) {
      const rows = n === firstN ? firstRows : await top(n);
      const items = rows.map(toRankable);
      if (pick && !items.some((i) => i.id === pick!.id)) items.push(pick);
      const ctx: ReviewRankingContext = {
        ...(await this.rankingContext(viewer, followedIds, workId, [...new Set(items.map((i) => i.user_id))])),
        now,
      };
      const last = rows.length === n ? rows[n - 1]! : null;
      const boundary = last ? { friend: Boolean(last.friend), lb: Number(last.lb) } : null;
      if (cappedPrefixIsExact(scoreAndSort(items, ctx), k, boundary)) {
        const ranked = rankReviews(items, ctx);
        return { ids: ranked.items.slice(offset, offset + limit).map((r) => r.id), total: Number(count?.n ?? 0) };
      }
    }
  }

  /** Full items for one page of already-authorised review ids, in that order. */
  async #hydrate(ids: string[], viewer: string | null): Promise<ReviewItem[]> {
    if (ids.length === 0) return [];
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
        viewerHasLiked: viewer
          ? sql<boolean>`EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = ${reviews.readId} AND l.user_id = ${viewer}::uuid)`
          : sql<boolean>`false`,
      })
      .from(reviews)
      .innerJoin(reads, eq(reads.id, reviews.readId))
      .innerJoin(works, eq(works.id, reviews.workId))
      .leftJoin(profiles, eq(profiles.userId, reviews.userId))
      .where(inArray(reviews.id, ids));

    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const r = byId.get(id);
      if (!r) return [];
      return [{
        id: r.id,
        read_id: r.readId,
        user_id: r.userId,
        work_id: r.workId,
        body: r.body,
        has_spoilers: r.hasSpoilers,
        spoiler_after_page: r.spoilerAfterPage,
        visibility: r.visibility as ReviewItem['visibility'],
        published_at: r.publishedAt.toISOString(),
        edited_at: r.editedAt ? r.editedAt.toISOString() : null,
        rating: r.readRating === null ? null : Number(r.readRating),
        hearted: r.readHearted,
        format_override: r.readFormat,
        like_count: r.readLikeCount,
        comment_count: r.readCommentCount,
        viewer_has_liked: Boolean(r.viewerHasLiked),
        author: {
          id: r.userId,
          username: r.username ?? 'reader',
          display_name: r.displayName,
          avatar_url: r.avatarKey ? `/avatars/${r.avatarKey}` : null,
        },
        work_title: r.workTitle,
        work_cover_id: r.workCoverId,
      }];
    });
  }
}

/**
 * Fastify routes plugin for ratings and reviews.
 */
export async function reviewsPlugin(app: FastifyInstance, opts: { db: Db; cache?: Cache }) {
  const service = new ReviewService(opts.db, opts.cache);

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
