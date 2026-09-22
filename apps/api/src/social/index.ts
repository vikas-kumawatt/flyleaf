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
} from '../contract/schemas.js';

export type FollowState = 'pending' | 'accepted' | 'none';
export type FollowStatus = 'none' | 'pending' | 'accepted' | 'self';

export interface FollowResult {
  status: FollowState;
  follower_id: string;
  followee_id: string;
}

export interface PendingFollowRequest {
  id: string;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  bio: string | null;
  requested_at: string;
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
};
