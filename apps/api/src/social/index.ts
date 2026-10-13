// Social Graph Service & Routes (SO-01, SO-02).
//
// Manages follow/unfollow, private account follow request workflow, and status resolution.
// Features:
//   - Asymmetric follow model (PRD §11.1).
//   - Private account requests: follow attempts to private profiles create 'pending' state.
//   - Approved followers / auto-accept on public profiles create 'accepted' state.
//   - DB triggers automatically maintain profiles.follower_count and following_count.
//   - Complete block invisibility: follow operations targeting a blocked user return 404.

import { RateLimits } from '../platform/rate-limits.js';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Cache, Db } from '../platform/index.js';
import { users, profiles, follows, blocks, mutes, works } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { FollowSuggestions, SUGGESTION_DEFAULT, SUGGESTION_MAX } from './suggestions.js';
import { resolveWorkId } from '../catalog/resolve.js';
import { canViewWith, loadRelationship, requireNotSuspended, requireVerified } from '../authorization/index.js';
import { Notifier } from '../notify/index.js';
import {
  errorResponseSchema,
  followResponseSchema,
  pendingFollowRequestsResponseSchema,
  blockUserResponseSchema,
  blockedUsersResponseSchema,
  muteResponseSchema,
  mutesResponseSchema,
  followUserListResponseSchema,
} from '../contract/schemas.js';

export type FollowState = 'pending' | 'accepted' | 'none';
export type FollowStatus = 'none' | 'pending' | 'accepted' | 'self';
export type BlockState = 'blocked' | 'unblocked';
export type MuteState = 'muted' | 'unmuted';
export type MuteTargetType = 'user' | 'work';

export interface FollowResult {
  status: FollowState;
  follower_id: string;
  followee_id: string;
}

export interface BlockResult {
  status: BlockState;
  blocker_id: string;
  blocked_id: string;
}

export interface MuteResult {
  status: MuteState;
  target_type: MuteTargetType;
  target_id: string;
  user_id: string;
}

export interface PendingFollowRequest {
  id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  requested_at: string;
}

export interface BlockedUserItem {
  id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  blocked_at: string;
}

export interface MutedUserItem {
  id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  muted_at: string;
}

export interface MutedWorkItem {
  id: string;
  title: string;
  author_name: string | null;
  cover_id: number | null;
  muted_at: string;
}

export interface MutesResponse {
  users: MutedUserItem[];
  works: MutedWorkItem[];
}

export interface FollowUserListItem {
  id: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
  isPrivate: boolean;
  followedByViewer: boolean;
  followsViewer: boolean;
  followedAt: string;
}

export interface FollowUserListResponse {
  users: FollowUserListItem[];
  total: number;
}

import { ActivityService } from '../activity/index.js';

export class SocialService {
  private activityService: ActivityService;

  constructor(
    private readonly db: Db,
    /** §11.7 follow limits (Audit 15). Default: none, as before. */
    private readonly limits: RateLimits = RateLimits.off(),
    /** SO-30: follow and request notifications, written with the follow. */
    private readonly notifier: Notifier = new Notifier(),
  ) {
    this.activityService = new ActivityService(db);
  }

  /**
   * PRD §11.7 / §24.4 follow limits, checked only for a follow or request
   * that creates a row: a replay of an accepted or pending follow (the
   * offline queue resends desired state) costs nothing. A request re-sent
   * after a reject creates a row again, so it counts toward the pair's 3 a
   * day (A-13-008).
   */
  async #enforceFollowLimits(t: Db, viewer: string, target: string): Promise<void> {
    if (this.limits.isOn('follow:new')) {
      const [u] = await t.execute<{ is_new: boolean }>(sql`
        SELECT created_at > now() - interval '24 hours' AS is_new FROM users WHERE id = ${viewer}::uuid`);
      if (u?.is_new) await this.limits.enforce('follow:new', viewer, t);
    }
    await this.limits.enforce('follow:pair', `${viewer}:${target}`, t);
    await this.limits.enforce('follow:h', viewer, t);
    await this.limits.enforce('follow:d', viewer, t);
  }

  /**
   * Resolves relationship state between viewer and target user.
   * If viewer and target blocked each other in either direction, returns isBlocked = true.
   */
  async getFollowStatus(
    viewer: string | null,
    targetUserId: string,
  ): Promise<{
    followStatus: FollowStatus;
    followedBy: boolean;
    isBlocked: boolean;
  }> {
    const rel = await loadRelationship(this.db, viewer, targetUserId);
    if (rel.isBlocked) return { followStatus: 'none', followedBy: false, isBlocked: true };
    return { followStatus: rel.followStatus, followedBy: rel.followedBy, isBlocked: false };
  }

  /**
   * The (viewer, target) relationship for a write aimed at another user. A
   * missing or soft-deleted user, and one blocked either way, are the same
   * 404 as a random id (PRD §11.4): a 200 for "exists but blocked" would
   * confirm the block (audit 13, A-13-005).
   */
  async #requireReachable(db: Db, viewer: string, targetUserId: string) {
    const rel = await loadRelationship(db, viewer, targetUserId);
    if (!rel.ownerExists || rel.isBlocked) throw ApiError.notFound('User not found.');
    return rel;
  }

  /**
   * Follow a user (or request to follow if target account is private).
   */
  async followUser(viewer: string, targetUserId: string): Promise<FollowResult> {
    // D-04-1: first, so the refusal says nothing about the target.
    await requireVerified(this.db, viewer);
    // SO-42: a suspension stops follows too (§27.3 harassment).
    await requireNotSuspended(this.db, viewer);

    if (viewer === targetUserId) {
      throw ApiError.badRequest('cannot_follow_self', 'You cannot follow yourself.');
    }

    // One transaction under the pair lock (audit 13, A-13-006): a follow
    // racing a block can no longer land after the block severed follows, and
    // the follow and its activity are written together.
    const state = await this.db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await lockPair(t, viewer, targetUserId);
      // Missing, deleted and blocked (either way) are indistinguishable (PRD §11.4).
      const rel = await this.#requireReachable(t, viewer, targetUserId);

      // Idempotent: a replayed or double-submitted follow never demotes an
      // accepted follow to a request (the account may have gone private since),
      // and records no second 'followed' activity (Audit 05).
      if (rel.followStatus === 'accepted') return 'accepted' as const;
      if (rel.followStatus === 'none') await this.#enforceFollowLimits(t, viewer, targetUserId);

      const wanted: FollowState = rel.isOwnerPrivate ? 'pending' : 'accepted';
      // RETURNING only when this statement made (or changed) the row: a follow
      // that is already accepted returns nothing, so a concurrent duplicate
      // writes no second activity.
      const [row] = await t.execute<{ state: FollowState }>(sql`
        INSERT INTO follows (follower_id, followee_id, state)
        VALUES (${viewer}::uuid, ${targetUserId}::uuid, ${wanted})
        ON CONFLICT (follower_id, followee_id) DO UPDATE SET state = EXCLUDED.state
        WHERE follows.state <> 'accepted'
        RETURNING state`);
      if (!row) return 'accepted' as const;

      if (row.state === 'accepted') {
        await this.activityService.recordActivity(t, {
          actorId: viewer,
          verb: 'followed',
          objectType: 'user',
          objectId: targetUserId,
          metadata: { followeeId: targetUserId },
          visibility: 'public',
        });
      }
      // PRD §19.2 items 1 and 2: a new follower, or a request to a private
      // account. Only when this statement made the row, so a replay is silent.
      if (row.state !== 'none') await this.notifier.follow(t, viewer, targetUserId, row.state);
      return row.state;
    });

    return {
      status: state,
      follower_id: viewer,
      followee_id: targetUserId,
    };
  }

  /**
   * Unfollow a user or cancel a pending follow request.
   */
  async unfollowUser(viewer: string, targetUserId: string): Promise<FollowResult> {
    if (viewer === targetUserId) {
      throw ApiError.badRequest('cannot_unfollow_self', 'You cannot unfollow yourself.');
    }

    // The follow row and its activity go together (audit 13, A-13-006).
    await this.db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await this.#requireReachable(t, viewer, targetUserId);
      await t
        .delete(follows)
        .where(
          and(eq(follows.followerId, viewer), eq(follows.followeeId, targetUserId)),
        );
      await this.activityService.deleteFollowActivity(t, viewer, targetUserId);
      await this.notifier.unfollow(t, viewer, targetUserId);
    });

    return {
      status: 'none',
      follower_id: viewer,
      followee_id: targetUserId,
    };
  }

  /**
   * List pending follow requests sent to the viewer.
   */
  async getPendingRequests(viewer: string): Promise<PendingFollowRequest[]> {
    const rows = await this.db
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
        bio: profiles.bio,
        requestedAt: follows.createdAt,
      })
      .from(follows)
      .innerJoin(users, eq(follows.followerId, users.id))
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(
        // A deleted account is hidden everywhere (PRD §25.4; audit 13, A-13-011).
        and(eq(follows.followeeId, viewer), eq(follows.state, 'pending'), isNull(users.deletedAt)),
      )
      .orderBy(desc(follows.createdAt), desc(follows.followerId));

    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      display_name: r.displayName,
      avatar_key: r.avatarKey,
      bio: r.bio,
      requested_at: r.requestedAt.toISOString(),
    }));
  }

  /**
   * Accept a pending follow request.
   */
  async acceptFollowRequest(viewer: string, requesterId: string): Promise<FollowResult> {
    await this.db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      // Under the pair lock, so an accept cannot race a block (A-13-006).
      await lockPair(t, viewer, requesterId);
      const [row] = await t.execute<{ follower_id: string }>(sql`
        UPDATE follows SET state = 'accepted'
        WHERE follower_id = ${requesterId}::uuid AND followee_id = ${viewer}::uuid AND state = 'pending'
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = ${requesterId}::uuid AND u.deleted_at IS NULL)
        RETURNING follower_id`);
      if (!row) throw ApiError.notFound('Pending follow request not found.');
      // D-13-1 (owner, 2026-10-10): a single accept is when the follow starts,
      // so it gets the requester's card, dated now. The bulk accept when an
      // account goes public writes none (identity/index.ts).
      await this.activityService.recordActivity(t, {
        actorId: requesterId,
        verb: 'followed',
        objectType: 'user',
        objectId: viewer,
        metadata: { followeeId: viewer },
        visibility: 'public',
      });
      // The request is answered. No "new follower" either: the recipient
      // accepted it themselves.
      await this.notifier.requestResolved(t, requesterId, viewer);
    });

    return {
      status: 'accepted',
      follower_id: requesterId,
      followee_id: viewer,
    };
  }

  /**
   * Reject a pending follow request.
   */
  async rejectFollowRequest(viewer: string, requesterId: string): Promise<FollowResult> {
    await this.db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await t
        .delete(follows)
        .where(
          and(
            eq(follows.followerId, requesterId),
            eq(follows.followeeId, viewer),
            eq(follows.state, 'pending'),
          ),
        );
      await this.notifier.requestResolved(t, requesterId, viewer);
    });

    return {
      status: 'none',
      follower_id: requesterId,
      followee_id: viewer,
    };
  }

  /**
   * Block a user (SO-03).
   * Bidirectional, complete, silent invisibility. Immediately severs follows in both directions.
   */
  async blockUser(viewer: string, targetUserId: string): Promise<BlockResult> {
    if (viewer === targetUserId) {
      throw ApiError.badRequest('cannot_block_self', 'You cannot block yourself.');
    }

    await this.db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await lockPair(t, viewer, targetUserId);
      // A missing or deleted user, and one who has blocked the viewer, are the
      // same 404 as a random id: a 200 would confirm the account exists behind
      // their block (audit 13, A-13-005). The viewer's own block stays
      // idempotent. Their block already hides both ways (PRD §11.4).
      const rel = await loadRelationship(t, viewer, targetUserId);
      if (!rel.ownerExists || rel.blockedByOwner) throw ApiError.notFound('User not found.');

      await t
        .insert(blocks)
        .values({
          blockerId: viewer,
          blockedId: targetUserId,
        })
        .onConflictDoNothing();

      // Sever existing follows and requests in BOTH directions (PRD §11.4);
      // the counter trigger updates follower_count and following_count.
      await t
        .delete(follows)
        .where(
          or(
            and(eq(follows.followerId, viewer), eq(follows.followeeId, targetUserId)),
            and(eq(follows.followerId, targetUserId), eq(follows.followeeId, viewer)),
          ),
        );
      // ... and the 'followed' cards they made, as an unfollow does (A-13-004).
      await this.activityService.deleteFollowActivity(t, viewer, targetUserId);
      await this.activityService.deleteFollowActivity(t, targetUserId, viewer);
    });

    return {
      status: 'blocked',
      blocker_id: viewer,
      blocked_id: targetUserId,
    };
  }

  /**
   * Unblock a user (SO-03).
   */
  async unblockUser(viewer: string, targetUserId: string): Promise<BlockResult> {
    if (viewer === targetUserId) {
      throw ApiError.badRequest('cannot_unblock_self', 'You cannot unblock yourself.');
    }

    await this.db
      .delete(blocks)
      .where(
        and(eq(blocks.blockerId, viewer), eq(blocks.blockedId, targetUserId)),
      );

    return {
      status: 'unblocked',
      blocker_id: viewer,
      blocked_id: targetUserId,
    };
  }

  /**
   * List users blocked by the viewer (SO-03).
   */
  async getBlockedUsers(viewer: string): Promise<BlockedUserItem[]> {
    const rows = await this.db
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
        blockedAt: blocks.createdAt,
      })
      .from(blocks)
      .innerJoin(users, eq(blocks.blockedId, users.id))
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(and(eq(blocks.blockerId, viewer), isNull(users.deletedAt)))
      .orderBy(desc(blocks.createdAt), desc(blocks.blockedId));

    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      display_name: r.displayName,
      avatar_key: r.avatarKey,
      blocked_at: r.blockedAt.toISOString(),
    }));
  }

  /**
   * Mute a user (SO-04).
   * Low-stakes, silent tool. Hides activity from feed without unfollowing.
   */
  async muteUser(viewer: string, targetUserId: string): Promise<MuteResult> {
    if (viewer === targetUserId) {
      throw ApiError.badRequest('cannot_mute_self', 'You cannot mute yourself.');
    }

    // Missing, deleted and blocked either way: the same 404 (A-13-005).
    await this.#requireReachable(this.db, viewer, targetUserId);

    await this.db
      .insert(mutes)
      .values({
        userId: viewer,
        targetType: 'user',
        targetId: targetUserId,
      })
      .onConflictDoNothing();

    return {
      status: 'muted',
      target_type: 'user',
      target_id: targetUserId,
      user_id: viewer,
    };
  }

  /**
   * Unmute a user (SO-04).
   */
  async unmuteUser(viewer: string, targetUserId: string): Promise<MuteResult> {
    if (viewer === targetUserId) {
      throw ApiError.badRequest('cannot_unmute_self', 'You cannot unmute yourself.');
    }

    await this.db
      .delete(mutes)
      .where(
        and(
          eq(mutes.userId, viewer),
          eq(mutes.targetType, 'user'),
          eq(mutes.targetId, targetUserId),
        ),
      );

    return {
      status: 'unmuted',
      target_type: 'user',
      target_id: targetUserId,
      user_id: viewer,
    };
  }

  /**
   * Mute a book / work (SO-04).
   * Low-stakes, silent tool. Hides book activity from feeds.
   */
  async muteWork(viewer: string, workId: string): Promise<MuteResult> {
    // D3: a merged work's id mutes the survivor, resolved under the merge's
    // lock so a mute racing a merge cannot land on the tombstone.
    workId = await this.db.transaction(async (tx) => {
      const resolved = await resolveWorkId(tx as unknown as Db, workId, { lock: true });
      if (!resolved) throw ApiError.notFound('Book not found.');
      await tx
        .insert(mutes)
        .values({
          userId: viewer,
          targetType: 'work',
          targetId: resolved,
        })
        .onConflictDoNothing();
      return resolved;
    });

    return {
      status: 'muted',
      target_type: 'work',
      target_id: workId,
      user_id: viewer,
    };
  }

  /**
   * Unmute a book / work (SO-04).
   */
  async unmuteWork(viewer: string, workId: string): Promise<MuteResult> {
    // D3: the merge moved the mute to the survivor.
    workId = (await resolveWorkId(this.db, workId)) ?? workId;
    await this.db
      .delete(mutes)
      .where(
        and(
          eq(mutes.userId, viewer),
          eq(mutes.targetType, 'work'),
          eq(mutes.targetId, workId),
        ),
      );

    return {
      status: 'unmuted',
      target_type: 'work',
      target_id: workId,
      user_id: viewer,
    };
  }

  /**
   * List all muted users and muted books for the viewer (SO-04).
   */
  async getMutes(viewer: string): Promise<MutesResponse> {
    const userMuteRows = await this.db
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
        mutedAt: mutes.createdAt,
      })
      .from(mutes)
      .innerJoin(users, eq(mutes.targetId, users.id))
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(and(eq(mutes.userId, viewer), eq(mutes.targetType, 'user'), isNull(users.deletedAt)))
      .orderBy(desc(mutes.createdAt), desc(mutes.targetId));

    const workMuteRows = await this.db
      .select({
        id: works.id,
        title: works.title,
        coverId: works.olCoverId,
        mutedAt: mutes.createdAt,
        authorName: sql<string>`COALESCE((
          SELECT a.name
          FROM work_authors wa JOIN authors a ON a.id = wa.author_id
          WHERE wa.work_id = works.id
          ORDER BY wa.position, a.name
          LIMIT 1
        ), 'Unknown Author')`.as('author_name'),
      })
      .from(mutes)
      .innerJoin(works, eq(mutes.targetId, works.id))
      .where(and(eq(mutes.userId, viewer), eq(mutes.targetType, 'work')))
      .orderBy(desc(mutes.createdAt), desc(mutes.targetId));

    return {
      users: userMuteRows.map((r) => ({
        id: r.id,
        username: r.username,
        display_name: r.displayName,
        avatar_key: r.avatarKey,
        muted_at: r.mutedAt.toISOString(),
      })),
      works: workMuteRows.map((r) => ({
        id: r.id,
        title: r.title,
        author_name: r.authorName,
        cover_id: r.coverId,
        muted_at: r.mutedAt.toISOString(),
      })),
    };
  }

  /**
   * List followers of a target user (SO-05).
   * Enforces privacy: private profile follower list returns 404 Not Found for non-followers/guests.
   * Excludes blocked accounts in both directions.
   */
  async getFollowers(
    viewer: string | null,
    targetUserId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<FollowUserListResponse> {
    return this.#followList('followers', viewer, targetUserId, opts);
  }

  /**
   * List users followed by a target user (SO-05).
   * Enforces privacy: private profile following list returns 404 Not Found for non-followers/guests.
   * Excludes blocked accounts in both directions.
   */
  async getFollowing(
    viewer: string | null,
    targetUserId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<FollowUserListResponse> {
    return this.#followList('following', viewer, targetUserId, opts);
  }

  /**
   * One page of a followers / following list, paged in SQL (audit 13,
   * A-13-010). It used to load every follower, filter blocks in memory and
   * slice: a 2,000-follower account read and sorted 2,000 joined rows for
   * every page. Now: the page's ids from the list index (newest first, ties
   * broken by id, so pages never overlap or skip), then their profiles and
   * the viewer's two indicators in the same statement; the total is one
   * count over the same filter. Deleted accounts and anyone blocked either
   * way with the viewer are left out of both.
   */
  async #followList(
    kind: 'followers' | 'following',
    viewer: string | null,
    targetUserId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<FollowUserListResponse> {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);
    const offset = Math.max(opts?.offset ?? 0, 0);

    // One relationship query; missing, deleted, blocked and private
    // (non-follower) are the same 404, never 403 (Audit 05).
    const rel = await loadRelationship(this.db, viewer, targetUserId);
    if (!canViewWith(viewer, targetUserId, rel)) throw ApiError.notFound('User not found.');

    // The list's own end of the edge, and the other one (the listed user).
    const [own, other] = kind === 'followers'
      ? [sql.raw('f.followee_id'), sql.raw('f.follower_id')]
      : [sql.raw('f.follower_id'), sql.raw('f.followee_id')];
    const filter = sql`
      ${own} = ${targetUserId}::uuid AND f.state = 'accepted'
      AND NOT EXISTS (SELECT 1 FROM users d WHERE d.id = ${other} AND d.deleted_at IS NOT NULL)
      ${viewer === null ? sql`` : sql`AND ${other} NOT IN (
        SELECT b.blocked_id FROM blocks b WHERE b.blocker_id = ${viewer}::uuid
        UNION ALL
        SELECT b.blocker_id FROM blocks b WHERE b.blocked_id = ${viewer}::uuid
      )`}`;
    const flags = viewer === null
      ? sql`false AS followed_by_viewer, false AS follows_viewer`
      : sql`
        (page.id <> ${viewer}::uuid AND EXISTS (SELECT 1 FROM follows v
          WHERE v.follower_id = ${viewer}::uuid AND v.followee_id = page.id AND v.state = 'accepted')) AS followed_by_viewer,
        (page.id <> ${viewer}::uuid AND EXISTS (SELECT 1 FROM follows v
          WHERE v.follower_id = page.id AND v.followee_id = ${viewer}::uuid AND v.state = 'accepted')) AS follows_viewer`;

    const [rows, [count]] = await Promise.all([
      this.db.execute<{
        id: string; username: string; display_name: string | null; avatar_key: string | null;
        is_private: boolean; followed_at: string | Date; followed_by_viewer: boolean; follows_viewer: boolean;
      }>(sql`
        WITH page AS (
          SELECT ${other} AS id, f.created_at
          FROM follows f
          WHERE ${filter}
          ORDER BY f.created_at DESC, ${other} DESC
          LIMIT ${limit} OFFSET ${offset}
        )
        SELECT page.id, p.username, p.display_name, p.avatar_key, p.is_private,
          page.created_at AS followed_at, ${flags}
        FROM page JOIN profiles p ON p.user_id = page.id
        ORDER BY page.created_at DESC, page.id DESC`),
      this.db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM follows f WHERE ${filter}`),
    ]);

    return {
      users: rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        avatarKey: r.avatar_key,
        isPrivate: Boolean(r.is_private),
        followedByViewer: Boolean(r.followed_by_viewer),
        followsViewer: Boolean(r.follows_viewer),
        followedAt: new Date(r.followed_at).toISOString(),
      })),
      total: Number(count?.total ?? 0),
    };
  }
}

/**
 * Serializes writes between two users, in either direction (audit 13,
 * A-13-006): a follow, an accept and a block of the same pair take the same
 * lock, so a follow can never commit after a block severed the pair's follows.
 */
export async function lockPair(tx: Db, a: string, b: string): Promise<void> {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`social:${key}`}, 0))`);
}

export interface SocialPluginOptions {
  db: Db;
  prefix?: string;
  limits?: RateLimits;
  notifier?: Notifier;
  /** The follow suggestions' shared pool (SO-52). Without one, nothing is cached. */
  cache?: Cache;
}

export const socialPlugin: FastifyPluginAsync<SocialPluginOptions> = async (app, options) => {
  const service = new SocialService(options.db, options.limits, options.notifier);

  // Follow / request to follow
  const followHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.followUser(viewer, targetId);
  };

  const unfollowHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.unfollowUser(viewer, targetId);
  };

  app.post(
    '/users/:id/follow',
    {
      schema: {
        tags: ['Social'],
        summary: 'Follow or request to follow a user',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: followResponseSchema },
      },
    },
    followHandler,
  );

  app.delete(
    '/users/:id/follow',
    {
      schema: {
        tags: ['Social'],
        summary: 'Unfollow user or cancel pending request',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: followResponseSchema },
      },
    },
    unfollowHandler,
  );

  // Pending follow requests management
  const getRequestsHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const requests = await service.getPendingRequests(viewer);
    return { requests };
  };

  app.get(
    '/me/follow-requests',
    {
      schema: {
        tags: ['Social'],
        summary: 'List incoming pending follow requests',
        response: { 200: pendingFollowRequestsResponseSchema },
      },
    },
    getRequestsHandler,
  );

  const acceptHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const requesterId = req.params.requesterId;
    return service.acceptFollowRequest(viewer, requesterId);
  };

  app.post(
    '/me/follow-requests/:requesterId/accept',
    {
      schema: {
        tags: ['Social'],
        summary: 'Accept an incoming pending follow request',
        params: {
          type: 'object',
          properties: { requesterId: { type: 'string', format: 'uuid' } },
          required: ['requesterId'],
        },
        response: { 200: followResponseSchema },
      },
    },
    acceptHandler,
  );

  const rejectHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const requesterId = req.params.requesterId;
    return service.rejectFollowRequest(viewer, requesterId);
  };

  app.post(
    '/me/follow-requests/:requesterId/reject',
    {
      schema: {
        tags: ['Social'],
        summary: 'Reject an incoming pending follow request',
        params: {
          type: 'object',
          properties: { requesterId: { type: 'string', format: 'uuid' } },
          required: ['requesterId'],
        },
        response: { 200: followResponseSchema },
      },
    },
    rejectHandler,
  );

  // Block / Unblock / List Blocked Users (SO-03)
  const blockHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.blockUser(viewer, targetId);
  };

  const unblockHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.unblockUser(viewer, targetId);
  };

  const getBlocksHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const blocks = await service.getBlockedUsers(viewer);
    return { blocks };
  };

  app.post(
    '/users/:id/block',
    {
      schema: {
        tags: ['Social'],
        summary: 'Block a user',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: blockUserResponseSchema },
      },
    },
    blockHandler,
  );

  app.delete(
    '/users/:id/block',
    {
      schema: {
        tags: ['Social'],
        summary: 'Unblock a user',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: blockUserResponseSchema },
      },
    },
    unblockHandler,
  );

  app.get(
    '/me/blocks',
    {
      schema: {
        tags: ['Social'],
        summary: 'List users blocked by viewer',
        response: { 200: blockedUsersResponseSchema },
      },
    },
    getBlocksHandler,
  );

  // Mute / Unmute / List Muted Items (SO-04)
  const muteUserHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.muteUser(viewer, targetId);
  };

  const unmuteUserHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.unmuteUser(viewer, targetId);
  };

  const muteWorkHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.muteWork(viewer, targetId);
  };

  const unmuteWorkHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id;
    return service.unmuteWork(viewer, targetId);
  };

  const getMutesHandler = async (req: any) => {
    const viewer = requireViewer(req);
    return service.getMutes(viewer);
  };

  app.post(
    '/users/:id/mute',
    {
      schema: {
        tags: ['Social'],
        summary: 'Mute a user',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: muteResponseSchema },
      },
    },
    muteUserHandler,
  );

  app.delete(
    '/users/:id/mute',
    {
      schema: {
        tags: ['Social'],
        summary: 'Unmute a user',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: muteResponseSchema },
      },
    },
    unmuteUserHandler,
  );

  app.post(
    '/works/:id/mute',
    {
      schema: {
        tags: ['Social'],
        summary: 'Mute a book',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: muteResponseSchema },
      },
    },
    muteWorkHandler,
  );

  app.delete(
    '/works/:id/mute',
    {
      schema: {
        tags: ['Social'],
        summary: 'Unmute a book',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        response: { 200: muteResponseSchema },
      },
    },
    unmuteWorkHandler,
  );

  app.get(
    '/me/mutes',
    {
      schema: {
        tags: ['Social'],
        summary: 'List muted users and muted books',
        response: { 200: mutesResponseSchema },
      },
    },
    getMutesHandler,
  );

  // Followers & Following Lists (SO-05)
  const getFollowersHandler = async (req: any) => {
    const targetId = req.params.id;
    const limit = req.query?.limit ? Number(req.query.limit) : undefined;
    const offset = req.query?.offset ? Number(req.query.offset) : undefined;
    return service.getFollowers(req.viewer, targetId, { limit, offset });
  };

  const getFollowingHandler = async (req: any) => {
    const targetId = req.params.id;
    const limit = req.query?.limit ? Number(req.query.limit) : undefined;
    const offset = req.query?.offset ? Number(req.query.offset) : undefined;
    return service.getFollowing(req.viewer, targetId, { limit, offset });
  };

  const listQuerySchema = {
    type: 'object',
    properties: {
      limit: { type: 'integer', default: 50, minimum: 1, maximum: 100 },
      offset: { type: 'integer', default: 0, minimum: 0 },
    },
  } as const;

  app.get(
    '/users/:id/followers',
    {
      schema: {
        tags: ['Social'],
        summary: 'List followers of a user',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        querystring: listQuerySchema,
        response: { 200: followUserListResponseSchema },
      },
    },
    getFollowersHandler,
  );

  app.get(
    '/users/:id/following',
    {
      schema: {
        tags: ['Social'],
        summary: 'List users followed by a user',
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        querystring: listQuerySchema,
        response: { 200: followUserListResponseSchema },
      },
    },
    getFollowingHandler,
  );

  // SO-52: onboarding follow suggestions (PRD §6.11).
  const suggestions = new FollowSuggestions(options.db, options.cache);
  app.get<{ Querystring: { limit?: number } }>(
    '/me/follow-suggestions',
    {
      schema: {
        tags: ['Social'],
        summary: 'Readers to follow, for onboarding (PRD §6.11)',
        description:
          'Ranked by genre overlap, then favourite-book overlap, then active reviewers, then most followed. ' +
          'Never the caller, anyone they follow or requested, anyone in a block with them either way, anyone they muted, ' +
          'or a private, deleted, banned, unverified or suspended account. Overlap counts public reads and favourites only.',
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: SUGGESTION_MAX, default: SUGGESTION_DEFAULT } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              users: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    username: { type: 'string' },
                    display_name: { type: ['string', 'null'] },
                    avatar_url: { type: ['string', 'null'] },
                    follower_count: { type: 'integer' },
                    favourites: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string', format: 'uuid' },
                          title: { type: 'string' },
                          cover_id: { type: ['integer', 'null'] },
                        },
                        required: ['id', 'title', 'cover_id'],
                      },
                    },
                    reason: { type: 'string', enum: ['favourites', 'genres', 'reviewer', 'popular'] },
                  },
                  required: ['id', 'username', 'display_name', 'avatar_url', 'follower_count', 'favourites', 'reason'],
                },
              },
            },
            required: ['users'],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (req) => ({ users: await suggestions.forViewer(requireViewer(req), req.query.limit) }),
  );
};
