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
   * SO-11: Cursor-paginated Friends Feed query (Fan-out on read).
   * Strictly excludes blocked accounts (bidirectional) and muted accounts/books.
   */
  async getFriendsFeed(
    viewer: string,
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
      LIMIT ${limit + 1}
    `);

    const hasMore = rows.length > limit;
    const pageItems = hasMore ? rows.slice(0, limit) : rows;

    const items: FeedActivityItem[] = pageItems.map((r) => ({
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

    const lastItem = pageItems[pageItems.length - 1];
    const nextCursor = hasMore && lastItem
      ? new Date(lastItem.created_at).toISOString()
      : null;

    return {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
      tab: 'friends',
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
      LIMIT ${limit + 1}
    `);

    const hasMore = rows.length > limit;
    const pageItems = hasMore ? rows.slice(0, limit) : rows;

    const items: FeedActivityItem[] = pageItems.map((r) => ({
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

    const lastItem = pageItems[pageItems.length - 1];
    const nextCursor = hasMore && lastItem
      ? new Date(lastItem.created_at).toISOString()
      : null;

    return {
      items,
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
