// Activity service & Feed query: write-on-action logging & cursor-paginated feed (SO-10, SO-11).
//
// Key rules:
//  1. Write on action: every social activity (start, finish, rate, review, dnf, shelf, follow, goal_reached, quote)
//     emits an activity row atomically or within the same service call.
//  2. Exclude imports (IM-07, PRD §4410): reads/reviews with source = 'import' NEVER generate activity rows.
//  3. Respect per-item visibility: items with visibility = 'private' generate NO activity row at all (PRD §26.2).
//  4. Respect private accounts: if user account is private (isPrivate = true), activity visibility is forced to 'followers' (PRD §16.3).
//  5. Support retroactive account privacy updates: when user toggles isPrivate from false to true, existing public activity rows
//     for that actor are restricted to 'followers' (PRD §16.3, §26.1).
//  6. Feed query (SO-11, PRD §12.7, Architecture §8): Fan-out on read query for followed users (state = 'accepted'),
//     cursor-paginated by created_at DESC, with blocks (bidirectional) and mutes (user and book) strictly excluded.

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { activity, profiles, type Activity } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import type { Visibility } from '../authorization/index.js';
import { requireViewer } from '../http.js';
import {
  feedQuerySchema,
  feedResponseSchema,
  errorResponseSchema,
} from '../contract/schemas.js';
import { rankAndDiversifyFeed } from './ranking.js';
import { InteractionService, INTERACTIVE_VERBS, type ReadInteraction } from '../interactions/index.js';

export type ActivityVerb =
  | 'started'
  | 'finished'
  | 'rated'
  | 'reviewed'
  | 'dnf'
  | 'shelved'
  | 'followed'
  | 'goal_reached'
  | 'quoted';

export interface RecordActivityParams {
  actorId: string;
  verb: ActivityVerb;
  workId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  metadata?: Record<string, any>;
  visibility?: Visibility | string | null;
  source?: string | null;
}

export interface FeedActivityActor {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface FeedActivityWork {
  id: string;
  title: string;
  author_name: string | null;
  cover_id: number | null;
}

export interface FeedActivityItem {
  id: string;
  actor_id: string;
  actor: FeedActivityActor;
  verb: ActivityVerb;
  work_id: string | null;
  work: FeedActivityWork | null;
  object_type: string | null;
  object_id: string | null;
  metadata: Record<string, any>;
  visibility: Visibility;
  created_at: string;
  /** Like/comment state of the read behind the card (SO-21). Null when the card is not a social object. */
  interaction?: ReadInteraction | null;
}

/**
 * The read a feed card is about, when that card is a social object.
 * finished/dnf cards carry the read directly; review cards carry it in
 * metadata (the review's parent read — its likes ARE the read's likes).
 */
export function interactiveReadId(item: Pick<FeedActivityItem, 'verb' | 'object_type' | 'object_id' | 'metadata'>): string | null {
  if (!(INTERACTIVE_VERBS as readonly string[]).includes(item.verb)) return null;
  if (item.object_type === 'read') return item.object_id;
  if (item.object_type === 'review') {
    const readId = item.metadata?.readId;
    return typeof readId === 'string' ? readId : null;
  }
  return null;
}

export interface GetFeedOptions {
  tab?: 'friends' | 'popular';
  cursor?: string | null;
  limit?: number;
}

export interface FeedResponse {
  items: FeedActivityItem[];
  next_cursor: string | null;
  has_more: boolean;
  tab: 'friends' | 'popular';
  is_cold_start?: boolean;
  following_count?: number;
  cold_start_reason?: 'no_follows' | 'sparse_follows' | 'no_activity' | null;
}

export class ActivityService {
  constructor(private db: Db) {}

  /**
   * Records an activity row respecting source exclusion, item privacy, and account privacy.
   */
  async recordActivity(
    dbOrTx: Db,
    params: RecordActivityParams,
  ): Promise<Activity | null> {
    // 1. Exclude imports (IM-07, PRD §4410)
    if (params.source === 'import') {
      return null;
    }

    const itemVis: Visibility = (params.visibility as Visibility) ?? 'public';

    // 2. Private items generate NO activity row at all (PRD §26.2)
    if (itemVis === 'private') {
      return null;
    }

    // Check actor profile privacy
    const [actorProfile] = await dbOrTx
      .select({ isPrivate: profiles.isPrivate })
      .from(profiles)
      .where(eq(profiles.userId, params.actorId))
      .limit(1);

    const isActorPrivate = actorProfile?.isPrivate ?? false;

    // 3. Effective visibility: if account is private, force to 'followers'
    const effectiveVisibility: Visibility = isActorPrivate ? 'followers' : itemVis;

    const [row] = await dbOrTx
      .insert(activity)
      .values({
        actorId: params.actorId,
        verb: params.verb,
        workId: params.workId ?? null,
        objectType: params.objectType ?? null,
        objectId: params.objectId ?? null,
        metadata: params.metadata ?? {},
        visibility: effectiveVisibility,
      })
      .returning();

    return row ?? null;
  }

  /**
   * Updates activity visibility when underlying item visibility changes.
   */
  async updateActivityVisibility(
    dbOrTx: Db,
    objectType: string,
    objectId: string,
    newVisibility: Visibility,
  ): Promise<void> {
    if (newVisibility === 'private') {
      await dbOrTx
        .delete(activity)
        .where(and(eq(activity.objectType, objectType), eq(activity.objectId, objectId)));
    } else {
      await dbOrTx
        .update(activity)
        .set({ visibility: newVisibility })
        .where(and(eq(activity.objectType, objectType), eq(activity.objectId, objectId)));
    }
  }

  /**
   * Deletes activity row associated with a deleted item.
   */
  async deleteActivity(
    dbOrTx: Db,
    objectType: string,
    objectId: string,
  ): Promise<void> {
    await dbOrTx
      .delete(activity)
      .where(and(eq(activity.objectType, objectType), eq(activity.objectId, objectId)));
  }

  /**
   * Deletes follow activity row for a specific actor and followee.
   */
  async deleteFollowActivity(
    dbOrTx: Db,
    actorId: string,
    followeeId: string,
  ): Promise<void> {
    await dbOrTx
      .delete(activity)
      .where(
        and(
          eq(activity.actorId, actorId),
          eq(activity.verb, 'followed'),
          eq(activity.objectType, 'user'),
          eq(activity.objectId, followeeId),
        ),
      );
  }

  /**
   * Retroactively adjusts public activities for an actor when account privacy changes (PRD §16.3, §26.1).
   */
  async setAccountPrivacy(
    dbOrTx: Db,
    actorId: string,
    isPrivate: boolean,
  ): Promise<void> {
    if (isPrivate) {
      await dbOrTx
        .update(activity)
        .set({ visibility: 'followers' })
        .where(and(eq(activity.actorId, actorId), eq(activity.visibility, 'public')));
    }
  }

  /**
   * Attach like/comment state to every card that is a social object, in two
   * queries for the whole page (SO-21). Cards about a non-terminal read, and
   * cards whose read has since been re-shelved, get `interaction: null` — the
   * client hides the like button rather than offering one that 409s.
   */
  async #withInteractions(viewer: string | null, items: FeedActivityItem[]): Promise<FeedActivityItem[]> {
    const ids = items.map(interactiveReadId).filter((id): id is string => id !== null);
    const state = await new InteractionService(this.db).interactionsFor(viewer, ids);
    return items.map((item) => {
      const readId = interactiveReadId(item);
      return { ...item, interaction: readId ? (state.get(readId) ?? null) : null };
    });
  }

  /**
   * SO-11 & SO-14: Cursor-paginated Friends Feed query with Cold Start handling.
   *  - 0 follows: auto-switches to Popular feed (PRD §12.5).
   *  - 1–3 follows: Friends feed blended with Popular content (PRD §12.5).
   *  - >3 follows with no recent activity: backfilled with Popular content so feed is NEVER EMPTY.
   *  - Strictly excludes blocked accounts (bidirectional) and muted accounts/books.
   */
  async getFriendsFeed(
    viewer: string,
    opts: GetFeedOptions = {},
  ): Promise<FeedResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const cursorIso = cursorDate && !isNaN(cursorDate.getTime()) ? cursorDate.toISOString() : null;

    // 1. Inspect accepted following count for viewer
    const [followCountRow] = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM follows
      WHERE follower_id = ${viewer}::uuid AND state = 'accepted'
    `);
    const followingCount = followCountRow?.count ?? 0;

    // 2. Scenario 1: 0 Follows -> Auto-switch to Popular Feed (PRD §12.5)
    if (followingCount === 0) {
      const popularFeed = await this.getPopularFeed(viewer, opts);
      return {
        ...popularFeed,
        tab: 'popular',
        is_cold_start: true,
        following_count: 0,
        cold_start_reason: 'no_follows',
      };
    }

    // 3. Query candidate activities from followed users
    const rows = await this.db.execute<{
      id: string;
      actor_id: string;
      verb: string;
      work_id: string | null;
      object_type: string | null;
      object_id: string | null;
      metadata: any;
      visibility: string;
      created_at: string | Date;
      actor_username: string;
      actor_display_name: string | null;
      actor_avatar_key: string | null;
      work_title: string | null;
      work_cover_id: number | null;
      author_name: string | null;
    }>(sql`
      SELECT
        a.id,
        a.actor_id,
        a.verb,
        a.work_id,
        a.object_type,
        a.object_id,
        a.metadata,
        a.visibility,
        a.created_at,
        p.username AS actor_username,
        p.display_name AS actor_display_name,
        p.avatar_key AS actor_avatar_key,
        w.title AS work_title,
        w.ol_cover_id AS work_cover_id,
        (
          SELECT auth.name
          FROM work_authors wa
          JOIN authors auth ON auth.id = wa.author_id
          WHERE wa.work_id = a.work_id
          ORDER BY wa.position ASC
          LIMIT 1
        ) AS author_name
      FROM activity a
      JOIN profiles p ON p.user_id = a.actor_id
      -- Deleted accounts are hidden platform-wide (PRD §25.4, Audit 05).
      JOIN users au ON au.id = a.actor_id AND au.deleted_at IS NULL
      LEFT JOIN works w ON w.id = a.work_id
      JOIN follows f ON f.followee_id = a.actor_id AND f.follower_id = ${viewer}::uuid AND f.state = 'accepted'
      WHERE (${cursorIso}::timestamptz IS NULL OR a.created_at < ${cursorIso}::timestamptz)
        AND a.visibility IN ('public', 'followers')
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = ${viewer}::uuid AND b.blocked_id = a.actor_id)
             OR (b.blocker_id = a.actor_id AND b.blocked_id = ${viewer}::uuid)
        )
        AND NOT EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.user_id = ${viewer}::uuid
            AND (
              (m.target_type = 'user' AND m.target_id = a.actor_id)
              OR (m.target_type = 'work' AND a.work_id IS NOT NULL AND m.target_id = a.work_id)
            )
        )
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${Math.max(limit * 3, 60)}
    `);

    const candidateItems: FeedActivityItem[] = rows.map((r) => ({
      id: r.id,
      actor_id: r.actor_id,
      actor: {
        id: r.actor_id,
        username: r.actor_username ?? 'reader',
        display_name: r.actor_display_name,
        avatar_url: r.actor_avatar_key ? `/avatars/${r.actor_avatar_key}` : null,
      },
      verb: r.verb as ActivityVerb,
      work_id: r.work_id,
      work: r.work_id
        ? {
            id: r.work_id,
            title: r.work_title ?? 'Untitled',
            author_name: r.author_name ?? null,
            cover_id: r.work_cover_id ?? null,
          }
        : null,
      object_type: r.object_type,
      object_id: r.object_id,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {}),
      visibility: r.visibility as Visibility,
      created_at: new Date(r.created_at).toISOString(),
    }));

    let allCandidates = [...candidateItems];
    let isColdStart = false;
    let coldStartReason: 'sparse_follows' | 'no_activity' | null = null;

    // 4. Scenario 2: 1–3 Follows -> Blend with Popular content (PRD §12.5)
    if (followingCount >= 1 && followingCount <= 3) {
      isColdStart = true;
      coldStartReason = 'sparse_follows';
      const popularFeed = await this.getPopularFeed(viewer, { limit });
      const existingIds = new Set(candidateItems.map((i) => i.id));
      const blendedPopular = popularFeed.items
        .filter((item) => !existingIds.has(item.id))
        .map((item) => ({
          ...item,
          metadata: {
            ...item.metadata,
            is_blended_popular: true,
            label: 'Popular on Flyleaf',
          },
        }));
      allCandidates.push(...blendedPopular);
    }
    // 5. Scenario 3: Follows > 3 but zero candidate activities -> Backfill with Popular content (Never Empty, PRD §12.5)
    else if (candidateItems.length === 0) {
      isColdStart = true;
      coldStartReason = 'no_activity';
      const popularFeed = await this.getPopularFeed(viewer, { limit });
      const existingIds = new Set(candidateItems.map((i) => i.id));
      const blendedPopular = popularFeed.items
        .filter((item) => !existingIds.has(item.id))
        .map((item) => ({
          ...item,
          metadata: {
            ...item.metadata,
            is_blended_popular: true,
            label: 'While you wait',
          },
        }));
      allCandidates.push(...blendedPopular);
    }

    const items = rankAndDiversifyFeed(allCandidates, limit, { now: new Date() });

    // 6. Guarantee Never Empty Feed fallback to editorial welcome item (PRD §12.5)
    if (items.length === 0) {
      items.push({
        id: '00000000-0000-0000-0000-000000000000',
        actor_id: '00000000-0000-0000-0000-000000000000',
        actor: {
          id: '00000000-0000-0000-0000-000000000000',
          username: 'flyleaf',
          display_name: 'Flyleaf',
          avatar_url: null,
        },
        verb: 'goal_reached',
        work_id: null,
        work: null,
        object_type: 'system',
        object_id: null,
        metadata: {
          title: 'Welcome to Flyleaf!',
          description: 'Start logging books, writing reviews, and following readers to build your feed.',
          is_editorial: true,
        },
        visibility: 'public',
        created_at: new Date().toISOString(),
      });
      isColdStart = true;
      coldStartReason = coldStartReason ?? 'no_activity';
    }

    const hasMore = rows.length > limit;
    const lastPageItem = items[items.length - 1];
    const nextCursor = hasMore && lastPageItem ? lastPageItem.created_at : null;

    return {
      items: await this.#withInteractions(viewer, items),
      next_cursor: nextCursor,
      has_more: hasMore,
      tab: 'friends',
      is_cold_start: isColdStart,
      following_count: followingCount,
      cold_start_reason: coldStartReason,
    };
  }

  /**
   * SO-11: Cursor-paginated Popular Feed query (Public activity platform-wide).
   * Strictly excludes blocked accounts and muted accounts/books for logged-in viewers.
   */
  async getPopularFeed(
    viewer?: string | null,
    opts: GetFeedOptions = {},
  ): Promise<FeedResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const cursorIso = cursorDate && !isNaN(cursorDate.getTime()) ? cursorDate.toISOString() : null;

    const rows = await this.db.execute<{
      id: string;
      actor_id: string;
      verb: string;
      work_id: string | null;
      object_type: string | null;
      object_id: string | null;
      metadata: any;
      visibility: string;
      created_at: string | Date;
      actor_username: string;
      actor_display_name: string | null;
      actor_avatar_key: string | null;
      work_title: string | null;
      work_cover_id: number | null;
      author_name: string | null;
    }>(sql`
      SELECT
        a.id,
        a.actor_id,
        a.verb,
        a.work_id,
        a.object_type,
        a.object_id,
        a.metadata,
        a.visibility,
        a.created_at,
        p.username AS actor_username,
        p.display_name AS actor_display_name,
        p.avatar_key AS actor_avatar_key,
        w.title AS work_title,
        w.ol_cover_id AS work_cover_id,
        (
          SELECT auth.name
          FROM work_authors wa
          JOIN authors auth ON auth.id = wa.author_id
          WHERE wa.work_id = a.work_id
          ORDER BY wa.position ASC
          LIMIT 1
        ) AS author_name
      FROM activity a
      JOIN profiles p ON p.user_id = a.actor_id
      -- Deleted accounts are hidden platform-wide (PRD §25.4, Audit 05).
      JOIN users au ON au.id = a.actor_id AND au.deleted_at IS NULL
      LEFT JOIN works w ON w.id = a.work_id
      WHERE a.visibility = 'public'
        AND (${cursorIso}::timestamptz IS NULL OR a.created_at < ${cursorIso}::timestamptz)
        AND (${viewer ?? null}::uuid IS NULL OR NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = ${viewer ?? null}::uuid AND b.blocked_id = a.actor_id)
             OR (b.blocker_id = a.actor_id AND b.blocked_id = ${viewer ?? null}::uuid)
        ))
        AND (${viewer ?? null}::uuid IS NULL OR NOT EXISTS (
          SELECT 1 FROM mutes m
          WHERE m.user_id = ${viewer ?? null}::uuid
            AND (
              (m.target_type = 'user' AND m.target_id = a.actor_id)
              OR (m.target_type = 'work' AND a.work_id IS NOT NULL AND m.target_id = a.work_id)
            )
        ))
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${Math.max(limit * 3, 60)}
    `);

    const candidateItems: FeedActivityItem[] = rows.map((r) => ({
      id: r.id,
      actor_id: r.actor_id,
      actor: {
        id: r.actor_id,
        username: r.actor_username ?? 'reader',
        display_name: r.actor_display_name,
        avatar_url: r.actor_avatar_key ? `/avatars/${r.actor_avatar_key}` : null,
      },
      verb: r.verb as ActivityVerb,
      work_id: r.work_id,
      work: r.work_id
        ? {
            id: r.work_id,
            title: r.work_title ?? 'Untitled',
            author_name: r.author_name ?? null,
            cover_id: r.work_cover_id ?? null,
          }
        : null,
      object_type: r.object_type,
      object_id: r.object_id,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {}),
      visibility: r.visibility as Visibility,
      created_at: new Date(r.created_at).toISOString(),
    }));

    const items = rankAndDiversifyFeed(candidateItems, limit, { now: new Date() });

    // Guarantee Never Empty Feed fallback to editorial welcome item (PRD §12.5)
    if (items.length === 0) {
      items.push({
        id: '00000000-0000-0000-0000-000000000000',
        actor_id: '00000000-0000-0000-0000-000000000000',
        actor: {
          id: '00000000-0000-0000-0000-000000000000',
          username: 'flyleaf',
          display_name: 'Flyleaf',
          avatar_url: null,
        },
        verb: 'goal_reached',
        work_id: null,
        work: null,
        object_type: 'system',
        object_id: null,
        metadata: {
          title: 'Welcome to Flyleaf Popular Feed!',
          description: 'Explore books, discover popular reviews, and connect with fellow readers.',
          is_editorial: true,
        },
        visibility: 'public',
        created_at: new Date().toISOString(),
      });
    }

    const hasMore = rows.length > limit;
    const lastPageItem = items[items.length - 1];
    const nextCursor = hasMore && lastPageItem
      ? lastPageItem.created_at
      : null;

    return {
      items: await this.#withInteractions(viewer ?? null, items),
      next_cursor: nextCursor,
      has_more: hasMore,
      tab: 'popular',
    };
  }
}

/**
 * Fastify route plugin for GET /feed and GET /v1/feed.
 */
export const activityPlugin: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const service = new ActivityService(opts.db);

  const handler = async (req: any) => {
    const query = req.query as { tab?: 'friends' | 'popular'; cursor?: string; limit?: number };
    const tab = query.tab ?? 'friends';

    if (tab === 'popular') {
      return service.getPopularFeed(req.viewer, {
        tab,
        cursor: query.cursor,
        limit: query.limit ? Number(query.limit) : 20,
      });
    }

    const viewer = requireViewer(req);
    return service.getFriendsFeed(viewer, {
      tab,
      cursor: query.cursor,
      limit: query.limit ? Number(query.limit) : 20,
    });
  };

  fastify.get('/feed', {
    schema: {
      querystring: feedQuerySchema,
      response: {
        200: feedResponseSchema,
        401: errorResponseSchema,
      },
    },
  }, handler);
};
