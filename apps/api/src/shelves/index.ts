// Shelves & Lists Service & Routes (SH-01, SH-02).
// Governed by:
//   - PRD §6.35 (Create / edit shelf: name, description, privacy, ranked toggle)
//   - PRD §15.2–15.6 (Shelf model, constraints, slug uniqueness per user, soft delete)
//   - Architecture §3.5, §4 (shelves table, centralized canView authorization)

import { sql, eq, and } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Db } from '../platform/index.js';
import { shelves, users, profiles, follows, type Shelf } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { assertCanView } from '../authorization/index.js';
import {
  idParamSchema,
  shelfResponseSchema,
  createShelfBodySchema,
  updateShelfBodySchema,
  deleteShelfResponseSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

export interface ShelfOwner {
  id: string;
  username: string;
  displayName: string | null;
  avatarKey: string | null;
}

export interface ShelfDetail {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  is_ranked: boolean;
  privacy: 'public' | 'followers' | 'private';
  cover_work_ids: string[];
  item_count: number;
  save_count: number;
  created_at: string;
  owner: ShelfOwner;
}

export interface CreateShelfInput {
  name: string;
  description?: string | null;
  is_ranked?: boolean;
  privacy?: 'public' | 'followers' | 'private';
}

export interface UpdateShelfInput {
  name?: string;
  description?: string | null;
  is_ranked?: boolean;
  privacy?: 'public' | 'followers' | 'private';
}

/**
 * Normalizes shelf title to URL-safe slug.
 */
export function slugify(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'shelf';
}

/**
 * Generates unique slug scoped to user_id.
 * If base slug exists, appends numeric suffix (-1, -2, etc.).
 */
export async function generateUniqueSlug(
  db: Db,
  userId: string,
  name: string,
  excludeShelfId?: string,
): Promise<string> {
  const baseSlug = slugify(name);

  const existing = await db
    .select({ slug: shelves.slug })
    .from(shelves)
    .where(
      and(
        eq(shelves.userId, userId),
        excludeShelfId ? sql`${shelves.id} <> ${excludeShelfId}::uuid` : undefined,
        sql`(${shelves.slug} = ${baseSlug} OR ${shelves.slug} ~ ${`^${baseSlug}-[0-9]+$`})`,
      ),
    );

  const existingSlugs = new Set(existing.map((r) => r.slug));

  if (!existingSlugs.has(baseSlug)) {
    return baseSlug;
  }

  let counter = 1;
  while (existingSlugs.has(`${baseSlug}-${counter}`)) {
    counter++;
  }
  return `${baseSlug}-${counter}`;
}

export class ShelvesService {
  constructor(private db: Db) {}

  async create(viewer: string, input: CreateShelfInput): Promise<ShelfDetail> {
    const trimmedName = input.name?.trim();
    if (!trimmedName || trimmedName.length > 60) {
      throw new ApiError(400, 'invalid_shelf_name', 'Shelf name must be between 1 and 60 characters.', 'name');
    }

    if (input.description && input.description.length > 2000) {
      throw new ApiError(400, 'invalid_description', 'Description cannot exceed 2000 characters.', 'description');
    }

    const privacy = input.privacy ?? 'public';
    if (!['public', 'followers', 'private'].includes(privacy)) {
      throw new ApiError(400, 'invalid_privacy', 'Privacy must be public, followers, or private.', 'privacy');
    }

    const slug = await generateUniqueSlug(this.db, viewer, trimmedName);

    const [inserted] = await this.db
      .insert(shelves)
      .values({
        userId: viewer,
        name: trimmedName,
        slug,
        description: input.description?.trim() || null,
        isRanked: Boolean(input.is_ranked),
        privacy,
        coverWorkIds: [],
        itemCount: 0,
        saveCount: 0,
      })
      .returning();

    if (!inserted) {
      throw new ApiError(500, 'shelf_create_failed', 'Failed to create shelf.');
    }

    const owner = await this.getOwnerProfile(viewer);
    return this.formatShelf(inserted, owner);
  }

  async get(viewer: string | null, id: string): Promise<ShelfDetail> {
    const [shelf] = await this.db
      .select()
      .from(shelves)
      .where(eq(shelves.id, id))
      .limit(1);

    if (!shelf) {
      throw ApiError.notFound('Shelf not found.');
    }

    // Soft-deleted shelves return 404 to all users except owner
    if (shelf.deletedAt && shelf.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    const owner = await this.getOwnerProfile(shelf.userId);

    // Enforce authorization
    let isFollower = false;
    if (viewer && viewer !== shelf.userId) {
      const [follow] = await this.db
        .select({ state: follows.state })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, viewer),
            eq(follows.followeeId, shelf.userId),
            eq(follows.state, 'accepted'),
          ),
        )
        .limit(1);
      isFollower = Boolean(follow);
    }

    assertCanView({
      viewer,
      ownerId: shelf.userId,
      visibility: shelf.privacy,
      isFollower,
    });

    return this.formatShelf(shelf, owner);
  }

  async update(viewer: string, id: string, input: UpdateShelfInput): Promise<ShelfDetail> {
    const [existing] = await this.db
      .select()
      .from(shelves)
      .where(and(eq(shelves.id, id), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!existing || existing.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    let nextName = existing.name;
    let nextSlug = existing.slug;

    if (input.name !== undefined) {
      const trimmedName = input.name.trim();
      if (!trimmedName || trimmedName.length > 60) {
        throw new ApiError(400, 'invalid_shelf_name', 'Shelf name must be between 1 and 60 characters.', 'name');
      }
      nextName = trimmedName;
      if (trimmedName !== existing.name) {
        nextSlug = await generateUniqueSlug(this.db, viewer, trimmedName, existing.id);
      }
    }

    let nextDesc = existing.description;
    if (input.description !== undefined) {
      if (input.description && input.description.length > 2000) {
        throw new ApiError(400, 'invalid_description', 'Description cannot exceed 2000 characters.', 'description');
      }
      nextDesc = input.description?.trim() || null;
    }

    let nextPrivacy = existing.privacy;
    if (input.privacy !== undefined) {
      if (!['public', 'followers', 'private'].includes(input.privacy)) {
        throw new ApiError(400, 'invalid_privacy', 'Privacy must be public, followers, or private.', 'privacy');
      }
      nextPrivacy = input.privacy;
    }

    const nextIsRanked = input.is_ranked !== undefined ? Boolean(input.is_ranked) : existing.isRanked;

    const [updated] = await this.db
      .update(shelves)
      .set({
        name: nextName,
        slug: nextSlug,
        description: nextDesc,
        privacy: nextPrivacy,
        isRanked: nextIsRanked,
      })
      .where(eq(shelves.id, id))
      .returning();

    if (!updated) {
      throw new ApiError(500, 'shelf_update_failed', 'Failed to update shelf.');
    }

    const owner = await this.getOwnerProfile(viewer);
    return this.formatShelf(updated, owner);
  }

  async delete(viewer: string, id: string): Promise<{ deleted: true; id: string }> {
    const [existing] = await this.db
      .select({ id: shelves.id, userId: shelves.userId })
      .from(shelves)
      .where(and(eq(shelves.id, id), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!existing || existing.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    await this.db
      .update(shelves)
      .set({ deletedAt: new Date() })
      .where(eq(shelves.id, id));

    return { deleted: true, id };
  }

  private async getOwnerProfile(userId: string): Promise<ShelfOwner> {
    const [row] = await this.db
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
      })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);

    return (
      row ?? {
        id: userId,
        username: 'reader',
        displayName: null,
        avatarKey: null,
      }
    );
  }

  private formatShelf(shelf: Shelf, owner: ShelfOwner): ShelfDetail {
    return {
      id: shelf.id,
      user_id: shelf.userId,
      name: shelf.name,
      slug: shelf.slug,
      description: shelf.description,
      is_ranked: shelf.isRanked,
      privacy: shelf.privacy as 'public' | 'followers' | 'private',
      cover_work_ids: shelf.coverWorkIds ?? [],
      item_count: shelf.itemCount,
      save_count: shelf.saveCount,
      created_at: shelf.createdAt.toISOString(),
      owner,
    };
  }
}

/**
 * Fastify plugin registering shelves endpoints.
 */
export const shelvesPlugin: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const service = new ShelvesService(opts.db);

  fastify.post(
    '/shelves',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Create a new shelf',
        description: 'Creates a user-curated shelf with name, description, privacy, and ranked list toggle (SH-02).',
        body: createShelfBodySchema,
        response: {
          201: shelfResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const shelf = await service.create(viewer, request.body as CreateShelfInput);
      return reply.status(201).send({ shelf });
    },
  );

  fastify.get(
    '/shelves/:id',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Get shelf by ID',
        description: 'Retrieves shelf details. Enforces privacy permissions (404 for unauthorized viewers).',
        params: idParamSchema,
        response: {
          200: shelfResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const shelf = await service.get(request.viewer, id);
      return reply.send({ shelf });
    },
  );

  fastify.patch(
    '/shelves/:id',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Update shelf details',
        description: 'Updates shelf name, description, privacy, or ranked toggle. Only the owner can edit.',
        params: idParamSchema,
        body: updateShelfBodySchema,
        response: {
          200: shelfResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const shelf = await service.update(viewer, id, request.body as UpdateShelfInput);
      return reply.send({ shelf });
    },
  );

  fastify.delete(
    '/shelves/:id',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Delete a shelf',
        description: 'Soft-deletes a shelf with a 30-day recovery window (PRD §15.6). Only the owner can delete.',
        params: idParamSchema,
        response: {
          200: deleteShelfResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const result = await service.delete(viewer, id);
      return reply.send(result);
    },
  );
};
