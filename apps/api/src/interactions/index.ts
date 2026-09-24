// Read interactions: likes and comments (SO-21, SO-22).
//
// Governed by:
//   - PRD §10.3 [LOCKED]: likes and comments target the READ, not the review.
//     A finish with no review is the second-highest-weight feed card and must
//     be likeable. Only terminal reads (finished, dnf) are social objects.
//   - PRD §6.28: comment threads are single-level; 5 comments/minute; a thread
//     whose review was deleted becomes read-only.
//   - PRD §11.4: blocking hides the other party's likes and comments from you,
//     and a blocked caller sees the read as non-existent (404, never 403).
//   - Architecture §3.9: counters are trigger-maintained (0018). Nothing in
//     this file writes reads.like_count or reads.comment_count.
//
// Every read-scoped method takes the viewer first (FN-70) and resolves access
// through canView() — the one place authorization lives (FN-71).

import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Db, RateLimiter } from '../platform/index.js';
import { PgRateLimiter } from '../platform/index.js';
import { reads, readLikes, readComments, profiles, blocks, follows } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { canView, type Visibility } from '../authorization/index.js';
import {
  readIdParamsSchema,
  likeResponseSchema,
  readLikersQuerySchema,
  readLikersResponseSchema,
  readCommentsQuerySchema,
  readCommentsResponseSchema,
  readCommentSchema,
  createCommentBodySchema,
  commentIdParamsSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

/** Only these statuses are social objects (PRD §10.3). */
export const INTERACTIVE_STATUSES = ['finished', 'dnf'] as const;

/** Feed verbs whose card represents an interactive read. */
export const INTERACTIVE_VERBS = ['finished', 'dnf', 'reviewed'] as const;

/** PRD §6.28, §11.7, §24 rate-limit table: 5 comments per minute. */
export const COMMENT_RATE_LIMIT = { limit: 5, windowSeconds: 60 } as const;

export const COMMENT_MAX_LENGTH = 2000;

export function isInteractiveStatus(status: string): boolean {
  return (INTERACTIVE_STATUSES as readonly string[]).includes(status);
}

export interface InteractionUser {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ReadComment {
  id: string;
  read_id: string;
  body: string;
  created_at: string;
  author: InteractionUser;
  viewer_can_delete: boolean;
}

export interface ReadInteraction {
  read_id: string;
  like_count: number;
  comment_count: number;
  viewer_has_liked: boolean;
}

interface AccessibleRead {
  id: string;
  userId: string;
  status: string;
  likeCount: number;
  commentCount: number;
}

// Opaque, total-order cursor: created_at alone is not unique.
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at))) throw new Error('bad cursor');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad cursor');
    return { at, id };
  } catch {
    throw ApiError.badRequest('invalid_cursor', 'Cursor is not valid.', 'cursor');
  }
}

function toUser(row: {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarKey: string | null;
}): InteractionUser {
  return {
    id: row.userId,
    username: row.username ?? 'reader',
    display_name: row.displayName,
    avatar_url: row.avatarKey ? `/avatars/${row.avatarKey}` : null,
  };
}

/**
 * SQL fragment: true when `col` (a user id) and the viewer are in a block
 * relationship in either direction. Guests are never blocked.
 */
function blockedWith(viewer: string | null, col: unknown) {
  if (!viewer) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM blocks b
    WHERE (b.blocker_id = ${viewer}::uuid AND b.blocked_id = ${col})
       OR (b.blocked_id = ${viewer}::uuid AND b.blocker_id = ${col})
  )`;
}

export class InteractionService {
  constructor(
    private readonly db: Db,
    private readonly limiter: RateLimiter = new PgRateLimiter(db),
  ) {}

  /**
   * Resolve a read the viewer may see, or throw 404.
   *
   * Private read, private account, followers-only, blocked in either
   * direction, or simply absent — all five are the same 404, so a like
   * button can never be used to probe for a read's existence.
   */
  async #accessibleRead(viewer: string | null, readId: string): Promise<AccessibleRead> {
    const [row] = await this.db
      .select({
        id: reads.id,
        userId: reads.userId,
        status: reads.status,
        visibility: reads.visibility,
        likeCount: reads.likeCount,
        commentCount: reads.commentCount,
        isPrivate: profiles.isPrivate,
      })
      .from(reads)
      .leftJoin(profiles, eq(profiles.userId, reads.userId))
      .where(eq(reads.id, readId))
      .limit(1);

    if (!row) throw ApiError.notFound('Read not found.');

    let isBlocked = false;
    let isFollower = false;
    if (viewer && viewer !== row.userId) {
      const [block] = await this.db
        .select({ b: blocks.blockerId })
        .from(blocks)
        .where(
          or(
            and(eq(blocks.blockerId, viewer), eq(blocks.blockedId, row.userId)),
            and(eq(blocks.blockerId, row.userId), eq(blocks.blockedId, viewer)),
          ),
        )
        .limit(1);
      isBlocked = Boolean(block);
      if (!isBlocked) {
        const [f] = await this.db
          .select({ f: follows.followerId })
          .from(follows)
          .where(
            and(
              eq(follows.followerId, viewer),
              eq(follows.followeeId, row.userId),
              eq(follows.state, 'accepted'),
            ),
          )
          .limit(1);
        isFollower = Boolean(f);
      }
    }

    const allowed = canView({
      viewer,
      ownerId: row.userId,
      visibility: row.visibility as Visibility,
      isOwnerPrivate: row.isPrivate ?? false,
      isBlocked,
      isFollower,
    });
    if (!allowed) throw ApiError.notFound('Read not found.');

    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      likeCount: row.likeCount,
      commentCount: row.commentCount,
    };
  }

  async #currentCounts(readId: string): Promise<{ likeCount: number; commentCount: number }> {
    const [row] = await this.db
      .select({ likeCount: reads.likeCount, commentCount: reads.commentCount })
      .from(reads)
      .where(eq(reads.id, readId));
    return { likeCount: row?.likeCount ?? 0, commentCount: row?.commentCount ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Likes (SO-21)
  // -------------------------------------------------------------------------

  /**
   * Like a read. IDEMPOTENT: liking twice is one like.
   *
   * SL-64 shipped this as a toggle, which is wrong for an offline-first
   * client — the mutation queue replays on reconnect, and a replayed toggle
   * silently undoes the user's like. Like and unlike are now two verbs.
   */
  async like(viewer: string, readId: string): Promise<{ liked: true; like_count: number }> {
    const read = await this.#accessibleRead(viewer, readId);
    if (!isInteractiveStatus(read.status)) {
      throw ApiError.conflict(
        'not_likeable',
        'Only finished or abandoned reads can be liked.',
      );
    }
    await this.db
      .insert(readLikes)
      .values({ readId, userId: viewer })
      .onConflictDoNothing();
    const { likeCount } = await this.#currentCounts(readId);
    return { liked: true, like_count: likeCount };
  }

  /** Unlike a read. Idempotent; unliking something never liked is a no-op. */
  async unlike(viewer: string, readId: string): Promise<{ liked: false; like_count: number }> {
    // Visibility still applies: a blocked caller learns nothing, even here.
    await this.#accessibleRead(viewer, readId);
    await this.db
      .delete(readLikes)
      .where(and(eq(readLikes.readId, readId), eq(readLikes.userId, viewer)));
    const { likeCount } = await this.#currentCounts(readId);
    return { liked: false, like_count: likeCount };
  }

  /** Who liked this read. Users in a block relationship with the viewer are hidden (PRD §11.4). */
  async likers(
    viewer: string | null,
    readId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{ read_id: string; like_count: number; users: (InteractionUser & { liked_at: string })[] }> {
    const read = await this.#accessibleRead(viewer, readId);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);

    const rows = await this.db
      .select({
        userId: readLikes.userId,
        likedAt: readLikes.createdAt,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
      })
      .from(readLikes)
      .leftJoin(profiles, eq(profiles.userId, readLikes.userId))
      .where(and(eq(readLikes.readId, readId), sql`NOT ${blockedWith(viewer, readLikes.userId)}`))
      .orderBy(sql`${readLikes.createdAt} DESC`, readLikes.userId)
      .limit(limit)
      .offset(offset);

    return {
      read_id: readId,
      like_count: read.likeCount,
      users: rows.map((r) => ({ ...toUser(r), liked_at: r.likedAt.toISOString() })),
    };
  }

  /**
   * Batch like/comment state for many reads at once — what a feed page needs.
   * One query for counts and one for the viewer's likes, never one per card.
   * Non-interactive reads are simply absent from the result.
   */
  async interactionsFor(viewer: string | null, readIds: string[]): Promise<Map<string, ReadInteraction>> {
    const out = new Map<string, ReadInteraction>();
    const ids = [...new Set(readIds)];
    if (ids.length === 0) return out;

    const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await this.db.execute<{
      id: string;
      like_count: number;
      comment_count: number;
      viewer_has_liked: boolean;
    }>(sql`
      SELECT r.id, r.like_count, r.comment_count,
        ${viewer
          ? sql`EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = r.id AND l.user_id = ${viewer}::uuid)`
          : sql`false`} AS viewer_has_liked
      FROM reads r
      WHERE r.id IN (${idList})
        AND r.status IN ('finished', 'dnf')
    `);
    for (const r of rows) {
      out.set(r.id, {
        read_id: r.id,
        like_count: Number(r.like_count),
        comment_count: Number(r.comment_count),
        viewer_has_liked: Boolean(r.viewer_has_liked),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Comments (SO-22)
  // -------------------------------------------------------------------------

  /** A thread is read-only once the read's review has been deleted (PRD §6.28, §43). */
  async #isLocked(readId: string): Promise<boolean> {
    const [row] = await this.db.execute<{ locked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM reviews WHERE read_id = ${readId}::uuid AND deleted_at IS NOT NULL
      ) AS locked
    `);
    return Boolean(row?.locked);
  }

  async listComments(
    viewer: string | null,
    readId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{
    read_id: string;
    comment_count: number;
    locked: boolean;
    comments: ReadComment[];
    next_cursor: string | null;
  }> {
    const read = await this.#accessibleRead(viewer, readId);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const cursor = decodeCursor(opts.cursor);

    const rows = await this.db
      .select({
        id: readComments.id,
        readId: readComments.readId,
        userId: readComments.userId,
        body: readComments.body,
        createdAt: readComments.createdAt,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
      })
      .from(readComments)
      .leftJoin(profiles, eq(profiles.userId, readComments.userId))
      .where(
        and(
          eq(readComments.readId, readId),
          sql`${readComments.deletedAt} IS NULL`,
          sql`NOT ${blockedWith(viewer, readComments.userId)}`,
          cursor
            ? sql`(${readComments.createdAt}, ${readComments.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(readComments.createdAt, readComments.id)
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      read_id: readId,
      comment_count: read.commentCount,
      locked: await this.#isLocked(readId),
      comments: page.map((r) => ({
        id: r.id,
        read_id: r.readId,
        body: r.body,
        created_at: r.createdAt.toISOString(),
        author: toUser(r),
        viewer_can_delete: viewer !== null && viewer === r.userId,
      })),
      next_cursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /**
   * Post a comment. Single-level by construction: there is no parent_id
   * column, so a reply-to-a-reply is not a rule to enforce — it cannot be
   * expressed (PRD §6.28, §27 "structural prevention").
   */
  async addComment(viewer: string, readId: string, body: string): Promise<ReadComment> {
    const read = await this.#accessibleRead(viewer, readId);
    if (!isInteractiveStatus(read.status)) {
      throw ApiError.conflict(
        'not_commentable',
        'Only finished or abandoned reads can be commented on.',
      );
    }
    const trimmed = body.trim();
    if (!trimmed) throw ApiError.badRequest('empty_body', 'Comment cannot be empty.', 'body');
    if (trimmed.length > COMMENT_MAX_LENGTH) {
      throw ApiError.badRequest('body_too_long', 'Comment exceeds 2,000 characters.', 'body');
    }
    if (await this.#isLocked(readId)) {
      throw ApiError.conflict('thread_locked', 'This review was removed; its comments are read-only.');
    }
    // Counted only for comments that would otherwise be written, so a user
    // who fat-fingers a locked thread is not also throttled for it.
    const allowed = await this.limiter.allow(
      `comments:${viewer}`,
      COMMENT_RATE_LIMIT.limit,
      COMMENT_RATE_LIMIT.windowSeconds,
    );
    if (!allowed) throw ApiError.rateLimited('You are commenting too quickly. Try again in a minute.');

    const id = randomUUID();
    const [inserted] = await this.db
      .insert(readComments)
      .values({ id, readId, userId: viewer, body: trimmed })
      .returning({ createdAt: readComments.createdAt });

    const [author] = await this.db
      .select({
        userId: profiles.userId,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
      })
      .from(profiles)
      .where(eq(profiles.userId, viewer));

    return {
      id,
      read_id: readId,
      body: trimmed,
      created_at: inserted!.createdAt.toISOString(),
      author: toUser(author ?? { userId: viewer, username: null, displayName: null, avatarKey: null }),
      viewer_can_delete: true,
    };
  }

  /**
   * Soft-delete your own comment. Anyone else's comment is a 404 — including
   * the read owner's view of it; per-thread moderation is P1 (PRD §27.2).
   */
  async deleteComment(viewer: string, commentId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: readComments.id, userId: readComments.userId })
      .from(readComments)
      .where(and(eq(readComments.id, commentId), sql`${readComments.deletedAt} IS NULL`));
    if (!row || row.userId !== viewer) throw ApiError.notFound('Comment not found.');
    await this.db
      .update(readComments)
      .set({ deletedAt: new Date() })
      .where(eq(readComments.id, commentId));
  }
}

export interface InteractionsPluginOptions {
  db: Db;
  limiter?: RateLimiter;
}

/** Routes: PRD §24 — `/reads/{id}/like` and `/reads/{id}/comments`. */
export const interactionsPlugin: FastifyPluginAsync<InteractionsPluginOptions> = async (app, opts) => {
  const service = new InteractionService(opts.db, opts.limiter);
  const errors = { 404: errorResponseSchema, 409: errorResponseSchema };

  app.post<{ Params: { id: string } }>(
    '/reads/:id/like',
    {
      schema: {
        tags: ['interactions'],
        summary: 'Like a read (idempotent). Likes target the read, so a finish with no review is likeable.',
        params: readIdParamsSchema,
        response: { 200: likeResponseSchema, ...errors },
      },
    },
    async (req) => service.like(requireViewer(req), req.params.id),
  );

  app.delete<{ Params: { id: string } }>(
    '/reads/:id/like',
    {
      schema: {
        tags: ['interactions'],
        summary: 'Remove your like from a read (idempotent)',
        params: readIdParamsSchema,
        response: { 200: likeResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => service.unlike(requireViewer(req), req.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>(
    '/reads/:id/likes',
    {
      schema: {
        tags: ['interactions'],
        summary: 'Readers who liked this read',
        params: readIdParamsSchema,
        querystring: readLikersQuerySchema,
        response: { 200: readLikersResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => service.likers(req.viewer, req.params.id, req.query),
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: number } }>(
    '/reads/:id/comments',
    {
      schema: {
        tags: ['interactions'],
        summary: 'Comment thread on a read, oldest first, cursor-paginated',
        params: readIdParamsSchema,
        querystring: readCommentsQuerySchema,
        response: { 200: readCommentsResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => service.listComments(req.viewer, req.params.id, req.query),
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/reads/:id/comments',
    {
      schema: {
        tags: ['interactions'],
        summary: 'Comment on a read. Single-level; 5 per minute.',
        params: readIdParamsSchema,
        body: createCommentBodySchema,
        response: {
          201: readCommentSchema,
          400: errorResponseSchema,
          429: errorResponseSchema,
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const comment = await service.addComment(requireViewer(req), req.params.id, req.body.body);
      return reply.code(201).send(comment);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/comments/:id',
    {
      schema: {
        tags: ['interactions'],
        summary: 'Delete your own comment',
        params: commentIdParamsSchema,
        response: { 204: { type: 'null' }, 404: errorResponseSchema },
      },
    },
    async (req, reply) => {
      await service.deleteComment(requireViewer(req), req.params.id);
      return reply.code(204).send();
    },
  );
};
