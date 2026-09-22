// Social Graph Service & Routes (SO-01, SO-02).
//
// Manages follow/unfollow, private account follow request workflow, and status resolution.
// Features:
//   - Asymmetric follow model (PRD §11.1).
//   - Private account requests: follow attempts to private profiles create 'pending' state.
//   - Approved followers / auto-accept on public profiles create 'accepted' state.
//   - DB triggers automatically maintain profiles.follower_count and following_count.
//   - Complete block invisibility: follow operations targeting a blocked user return 404.

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { users, profiles, follows, blocks } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import {
  followResponseSchema,
  pendingFollowRequestsResponseSchema,
  blockUserResponseSchema,
  blockedUsersResponseSchema,
} from '../contract/schemas.js';

export type FollowState = 'pending' | 'accepted' | 'none';
export type FollowStatus = 'none' | 'pending' | 'accepted' | 'self';
export type BlockState = 'blocked' | 'unblocked';

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

export class SocialService {
  constructor(private readonly db: Db) {}

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
    if (!viewer) {
      return { followStatus: 'none', followedBy: false, isBlocked: false };
    }

    if (viewer === targetUserId) {
      return { followStatus: 'self', followedBy: false, isBlocked: false };
    }

    // Check block status (bidirectional)
    const [blockRow] = await this.db
      .select({ blockerId: blocks.blockerId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, viewer), eq(blocks.blockedId, targetUserId)),
          and(eq(blocks.blockerId, targetUserId), eq(blocks.blockedId, viewer)),
        ),
      )
      .limit(1);

    if (blockRow) {
      return { followStatus: 'none', followedBy: false, isBlocked: true };
    }

    // Check follow status (viewer -> target)
    const [followRow] = await this.db
      .select({ state: follows.state })
      .from(follows)
      .where(
        and(eq(follows.followerId, viewer), eq(follows.followeeId, targetUserId)),
      )
      .limit(1);

    const followStatus: FollowStatus = followRow
      ? followRow.state === 'accepted'
        ? 'accepted'
        : 'pending'
      : 'none';

    // Check reverse follow status (target -> viewer)
    const [reverseRow] = await this.db
      .select({ state: follows.state })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, targetUserId),
          eq(follows.followeeId, viewer),
          eq(follows.state, 'accepted'),
        ),
      )
      .limit(1);

    const followedBy = Boolean(reverseRow);

    return { followStatus, followedBy, isBlocked: false };
  }

  /**
   * Follow a user (or request to follow if target account is private).
   */
  async followUser(viewer: string, targetUserId: string): Promise<FollowResult> {
    if (viewer === targetUserId) {
      throw ApiError.badRequest('cannot_follow_self', 'You cannot follow yourself.');
    }

    // Check block status
    const rel = await this.getFollowStatus(viewer, targetUserId);
    if (rel.isBlocked) {
      // Indistinguishable from non-existent account per PRD §11.4
      throw ApiError.notFound('User not found.');
    }

    // Verify target profile exists
    const [targetProfile] = await this.db
      .select({ userId: profiles.userId, isPrivate: profiles.isPrivate })
      .from(profiles)
      .where(eq(profiles.userId, targetUserId))
      .limit(1);

    if (!targetProfile) {
      throw ApiError.notFound('User not found.');
    }

    const state: FollowState = targetProfile.isPrivate ? 'pending' : 'accepted';

    await this.db
      .insert(follows)
      .values({
        followerId: viewer,
        followeeId: targetUserId,
        state,
      })
      .onConflictDoUpdate({
        target: [follows.followerId, follows.followeeId],
        set: { state },
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

    const [targetUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      throw ApiError.notFound('User not found.');
    }

    await this.db
      .delete(follows)
      .where(
        and(eq(follows.followerId, viewer), eq(follows.followeeId, targetUserId)),
      );

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
        and(eq(follows.followeeId, viewer), eq(follows.state, 'pending')),
      )
      .orderBy(sql`${follows.createdAt} DESC`);

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
    const [existing] = await this.db
      .select()
      .from(follows)
      .where(
        and(
          eq(follows.followerId, requesterId),
          eq(follows.followeeId, viewer),
          eq(follows.state, 'pending'),
        ),
      )
      .limit(1);

    if (!existing) {
      throw ApiError.notFound('Pending follow request not found.');
    }

    await this.db
      .update(follows)
      .set({ state: 'accepted' })
      .where(
        and(
          eq(follows.followerId, requesterId),
          eq(follows.followeeId, viewer),
        ),
      );

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
    await this.db
      .delete(follows)
      .where(
        and(
          eq(follows.followerId, requesterId),
          eq(follows.followeeId, viewer),
          eq(follows.state, 'pending'),
        ),
      );

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

    // Verify target user exists
    const [targetUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      throw ApiError.notFound('User not found.');
    }

    // Insert block record
    await this.db
      .insert(blocks)
      .values({
        blockerId: viewer,
        blockedId: targetUserId,
      })
      .onConflictDoNothing();

    // Sever existing follows in BOTH directions (PRD §11.4)
    // Note: DB trigger follows_counter_trigger_fn automatically updates follower_count & following_count
    await this.db
      .delete(follows)
      .where(
        or(
          and(eq(follows.followerId, viewer), eq(follows.followeeId, targetUserId)),
          and(eq(follows.followerId, targetUserId), eq(follows.followeeId, viewer)),
        ),
      );

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
      .where(eq(blocks.blockerId, viewer))
      .orderBy(sql`${blocks.createdAt} DESC`);

    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      display_name: r.displayName,
      avatar_key: r.avatarKey,
      blocked_at: r.blockedAt.toISOString(),
    }));
  }
}

export interface SocialPluginOptions {
  db: Db;
  prefix?: string;
}

export const socialPlugin: FastifyPluginAsync<SocialPluginOptions> = async (app, options) => {
  const service = new SocialService(options.db);

  // Follow / request to follow
  const followHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id || req.params.userId;
    return service.followUser(viewer, targetId);
  };

  const unfollowHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id || req.params.userId;
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

  app.post(
    '/follows/:userId',
    {
      schema: {
        tags: ['Social'],
        summary: 'Follow or request to follow a user (alias)',
        params: {
          type: 'object',
          properties: { userId: { type: 'string', format: 'uuid' } },
          required: ['userId'],
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

  app.delete(
    '/follows/:userId',
    {
      schema: {
        tags: ['Social'],
        summary: 'Unfollow user or cancel pending request (alias)',
        params: {
          type: 'object',
          properties: { userId: { type: 'string', format: 'uuid' } },
          required: ['userId'],
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

  app.get(
    '/follows/requests',
    {
      schema: {
        tags: ['Social'],
        summary: 'List incoming pending follow requests (alias)',
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

  app.post(
    '/follows/requests/:requesterId/accept',
    {
      schema: {
        tags: ['Social'],
        summary: 'Accept an incoming pending follow request (alias)',
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

  app.post(
    '/follows/requests/:requesterId/reject',
    {
      schema: {
        tags: ['Social'],
        summary: 'Reject an incoming pending follow request (alias)',
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
    const targetId = req.params.id || req.params.userId;
    return service.blockUser(viewer, targetId);
  };

  const unblockHandler = async (req: any) => {
    const viewer = requireViewer(req);
    const targetId = req.params.id || req.params.userId;
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

  app.post(
    '/blocks/:userId',
    {
      schema: {
        tags: ['Social'],
        summary: 'Block a user (alias)',
        params: {
          type: 'object',
          properties: { userId: { type: 'string', format: 'uuid' } },
          required: ['userId'],
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

  app.delete(
    '/blocks/:userId',
    {
      schema: {
        tags: ['Social'],
        summary: 'Unblock a user (alias)',
        params: {
          type: 'object',
          properties: { userId: { type: 'string', format: 'uuid' } },
          required: ['userId'],
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

  app.get(
    '/blocks',
    {
      schema: {
        tags: ['Social'],
        summary: 'List users blocked by viewer (alias)',
        response: { 200: blockedUsersResponseSchema },
      },
    },
    getBlocksHandler,
  );
};
