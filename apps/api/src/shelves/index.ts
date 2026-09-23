// Shelves & Lists Service & Fastify Routes (SH-01, SH-02, SH-03, PRD §15).
//
// Governed by:
// 1. Slugs scoped per-user (UNIQUE(user_id, slug)), with auto-disambiguation (-1, -2).
// 2. Strict privacy authorization matrix: public / followers / private.
// 3. 404, never 403: unauthorized access returns 404 to avoid enumeration.
// 4. Soft deletion with 30-day recovery window (deleted_at).
// 5. Paginated items retrieval with joined works, authors, ratings, and positions.
// 6. Per-entry notes (up to 280 characters).

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { and, eq, sql, inArray, or } from 'drizzle-orm';
import { Db } from '../platform/index.js';
import { ApiError, requireViewer } from '../http.js';
import { canView, assertCanView } from '../authorization/index.js';
import {
  shelves,
  shelfItems,
  shelfSaves,
  profiles,
  users,
  follows,
  blocks,
  works,
  workAuthors,
  authors,
  reads,
  type Shelf,
} from '../db/schema.js';
import {
  createShelfBodySchema,
  updateShelfBodySchema,
  shelfResponseSchema,
  deleteShelfResponseSchema,
  idParamSchema,
  errorResponseSchema,
  shelfItemsResponseSchema,
  addShelfItemBodySchema,
  shelfItemResponseSchema,
  shelfWithWorkStateSchema,
  myShelvesQuerySchema,
  myShelvesResponseSchema,
  shelfItemParamSchema,
  deleteShelfItemResponseSchema,
  updateShelfItemBodySchema,
  reorderShelfBodySchema,
  reorderShelfResponseSchema,
  saveShelfResponseSchema,
  savedShelvesResponseSchema,
  browseShelvesQuerySchema,
  browseShelvesResponseSchema,
  userShelvesResponseSchema,
  shelfSlugParamsSchema,
} from '../contract/schemas.js';

export interface BrowseShelvesInput {
  query?: string;
  sort?: 'ranked' | 'popular' | 'recent';
  limit?: number;
  offset?: number;
}

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
  cover_ids: (number | null)[];
  item_count: number;
  save_count: number;
  is_saved: boolean;
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

export interface ShelfItemWork {
  id: string;
  title: string;
  author_name: string;
  cover_id: number | null;
  first_publish_year: number | null;
  log_count: number;
  rating: number | null;
  your_read?: {
    status: string;
    rating: number | null;
    hearted: boolean;
  } | null;
}

export interface ShelfItemDetail {
  shelf_id: string;
  work_id: string;
  position: number;
  note: string | null;
  added_at: string;
  work: ShelfItemWork;
}

export interface AddShelfItemInput {
  work_id: string;
  note?: string | null;
  position?: number;
}

export interface ShelfWithWorkState extends ShelfDetail {
  contains_work: boolean;
  item_note: string | null;
  position: number | null;
}

export interface UpdateShelfItemInput {
  note?: string | null;
  position?: number;
}

/**
 * Normalizes shelf title to URL-safe slug.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'shelf';
}

/**
 * Generates a unique slug for a user, appending -1, -2 etc on collision.
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

import { ActivityService } from '../activity/index.js';

export class ShelvesService {
  private activityService: ActivityService;

  constructor(private db: Db) {
    this.activityService = new ActivityService(db);
  }

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
    return this.formatShelf(inserted, owner, false, []);
  }

  async checkRelationship(
    viewer: string | null,
    targetUserId: string,
  ): Promise<{ isBlocked: boolean; isFollower: boolean }> {
    if (viewer === null || viewer === targetUserId) {
      return { isBlocked: false, isFollower: viewer === targetUserId };
    }

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
      return { isBlocked: true, isFollower: false };
    }

    const [followRow] = await this.db
      .select({ followerId: follows.followerId })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, viewer),
          eq(follows.followeeId, targetUserId),
          eq(follows.state, 'accepted'),
        ),
      )
      .limit(1);

    return { isBlocked: false, isFollower: Boolean(followRow) };
  }

  async getById(
    viewer: string | null,
    shelfId: string,
  ): Promise<ShelfDetail> {
    const [shelf] = await this.db
      .select()
      .from(shelves)
      .where(eq(shelves.id, shelfId))
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
    const { isBlocked, isFollower } = await this.checkRelationship(viewer, shelf.userId);

    assertCanView(
      {
        viewer,
        ownerId: shelf.userId,
        visibility: shelf.privacy,
        isOwnerPrivate: owner.isPrivate,
        isBlocked,
        isFollower,
      },
      'Shelf not found.',
    );

    let coverIds: (number | null)[] = [];
    if (shelf.coverWorkIds && shelf.coverWorkIds.length > 0) {
      const coverRows = await this.db
        .select({ id: works.id, coverId: works.olCoverId })
        .from(works)
        .where(inArray(works.id, shelf.coverWorkIds));
      const map = new Map(coverRows.map((r) => [r.id, r.coverId]));
      coverIds = shelf.coverWorkIds.map((wid) => map.get(wid) ?? null);
    }

    let isSaved = false;
    if (viewer) {
      const [saved] = await this.db
        .select({ shelfId: shelfSaves.shelfId })
        .from(shelfSaves)
        .where(and(eq(shelfSaves.shelfId, shelfId), eq(shelfSaves.userId, viewer)))
        .limit(1);
      isSaved = Boolean(saved);
    }

    return this.formatShelf(shelf, owner, isSaved, coverIds);
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

    if (input.description !== undefined && input.description && input.description.length > 2000) {
      throw new ApiError(400, 'invalid_description', 'Description cannot exceed 2000 characters.', 'description');
    }

    if (input.privacy !== undefined && !['public', 'followers', 'private'].includes(input.privacy)) {
      throw new ApiError(400, 'invalid_privacy', 'Privacy must be public, followers, or private.', 'privacy');
    }

    const [updated] = await this.db
      .update(shelves)
      .set({
        name: nextName,
        slug: nextSlug,
        description: input.description !== undefined ? input.description?.trim() || null : existing.description,
        isRanked: input.is_ranked !== undefined ? Boolean(input.is_ranked) : existing.isRanked,
        privacy: input.privacy ?? existing.privacy,
      })
      .where(eq(shelves.id, id))
      .returning();

    if (!updated) {
      throw new ApiError(500, 'shelf_update_failed', 'Failed to update shelf.');
    }

    const owner = await this.getOwnerProfile(viewer);
    return this.getById(viewer, id);
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

  async getItems(
    viewer: string | null,
    shelfId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ data: ShelfItemDetail[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const [shelf] = await this.db
      .select()
      .from(shelves)
      .where(eq(shelves.id, shelfId))
      .limit(1);

    if (!shelf) {
      throw ApiError.notFound('Shelf not found.');
    }

    if (shelf.deletedAt && shelf.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    const owner = await this.getOwnerProfile(shelf.userId);

    const { isBlocked, isFollower } = await this.checkRelationship(viewer, shelf.userId);

    assertCanView(
      {
        viewer,
        ownerId: shelf.userId,
        visibility: shelf.privacy,
        isOwnerPrivate: owner.isPrivate,
        isBlocked,
        isFollower,
      },
      'Shelf not found.',
    );

    const [countRow] = await this.db.execute<{ count: string }>(sql`
      SELECT count(*)::text as count
      FROM shelf_items
      WHERE shelf_id = ${shelfId}::uuid
    `);
    const total = countRow ? parseInt(countRow.count, 10) : 0;

    const rows = await this.db.execute<{
      shelf_id: string;
      work_id: string;
      position: number;
      note: string | null;
      added_at: string;
      title: string;
      author_name: string | null;
      first_publish_year: number | null;
      cover_id: number | null;
      log_count: number;
      rating: string | null;
      user_status: string | null;
      user_rating: string | null;
      user_hearted: boolean | null;
    }>(sql`
      SELECT
        si.shelf_id,
        si.work_id,
        si.position,
        si.note,
        si.added_at,
        w.title,
        w.first_publish_year,
        w.ol_cover_id as cover_id,
        w.log_count,
        (SELECT a.name
           FROM work_authors wa JOIN authors a ON a.id = wa.author_id
          WHERE wa.work_id = w.id
          ORDER BY wa.position, a.name
          LIMIT 1) AS author_name,
        (SELECT round(avg(r.rating)::numeric, 1)::text
           FROM reads r
          WHERE r.work_id = w.id AND r.rating IS NOT NULL) AS rating,
        ${viewer ? sql`ur.status` : sql`NULL`} AS user_status,
        ${viewer ? sql`ur.rating::text` : sql`NULL`} AS user_rating,
        ${viewer ? sql`ur.hearted` : sql`NULL`} AS user_hearted
      FROM shelf_items si
      JOIN works w ON w.id = si.work_id
      ${viewer ? sql`
        LEFT JOIN LATERAL (
          SELECT r.status, r.rating, r.hearted
          FROM reads r
          WHERE r.user_id = ${viewer}::uuid AND r.work_id = w.id
          ORDER BY r.updated_at DESC
          LIMIT 1
        ) ur ON true
      ` : sql``}
      WHERE si.shelf_id = ${shelfId}::uuid
      ORDER BY si.position ASC, si.added_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const data: ShelfItemDetail[] = rows.map((r) => ({
      shelf_id: r.shelf_id,
      work_id: r.work_id,
      position: r.position,
      note: r.note,
      added_at: new Date(r.added_at).toISOString(),
      work: {
        id: r.work_id,
        title: r.title,
        author_name: r.author_name ?? 'Unknown',
        cover_id: r.cover_id,
        first_publish_year: r.first_publish_year,
        log_count: Number(r.log_count),
        rating: r.rating ? parseFloat(r.rating) : null,
        your_read: r.user_status
          ? {
              status: r.user_status,
              rating: r.user_rating ? parseFloat(r.user_rating) : null,
              hearted: Boolean(r.user_hearted),
            }
          : null,
      },
    }));

    return { data, total };
  }

  async addItem(viewer: string, shelfId: string, input: AddShelfItemInput): Promise<ShelfItemDetail> {
    const [shelf] = await this.db
      .select()
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!shelf || shelf.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    const [work] = await this.db
      .select({ id: works.id })
      .from(works)
      .where(eq(works.id, input.work_id))
      .limit(1);

    if (!work) {
      throw ApiError.notFound('Work not found.');
    }

    if (input.note && input.note.trim().length > 280) {
      throw new ApiError(400, 'invalid_note', 'Note cannot exceed 280 characters.', 'note');
    }

    let nextPos = input.position;
    if (!nextPos) {
      const [maxPos] = await this.db.execute<{ max_pos: number | null }>(sql`
        SELECT max(position) as max_pos FROM shelf_items WHERE shelf_id = ${shelfId}::uuid
      `);
      nextPos = (maxPos?.max_pos ?? 0) + 1;
    }

    try {
      await this.db
        .insert(shelfItems)
        .values({
          shelfId,
          workId: input.work_id,
          position: nextPos,
          note: input.note?.trim() || null,
          addedBy: viewer,
        });
    } catch (err: any) {
      let node: any = err;
      let isDuplicate = false;
      for (let depth = 0; depth < 5 && node; depth++) {
        if (
          node.code === '23505' ||
          String(node.constraint_name || '').includes('shelf_items') ||
          String(node.message || '').includes('duplicate key')
        ) {
          isDuplicate = true;
          break;
        }
        node = node.cause;
      }
      if (isDuplicate) {
        throw new ApiError(409, 'duplicate_shelf_item', 'This book is already on the shelf.', 'work_id');
      }
      throw err;
    }

    const items = await this.getItems(viewer, shelfId, { limit: 100 });
    const created = items.data.find((item) => item.work_id === input.work_id);
    if (!created) {
      throw new ApiError(500, 'shelf_item_create_failed', 'Failed to retrieve created shelf item.');
    }

    await this.activityService.recordActivity(this.db, {
      actorId: viewer,
      verb: 'shelved',
      workId: input.work_id,
      objectType: 'shelf_item',
      objectId: shelfId,
      metadata: {
        shelfId,
        shelfName: shelf.name,
        shelfSlug: shelf.slug,
        note: input.note?.trim() || null,
      },
      visibility: shelf.privacy,
    });

    return created;
  }

  async getMyShelves(viewer: string, workId?: string): Promise<{ shelves: ShelfWithWorkState[] }> {
    const rows = await this.db
      .select()
      .from(shelves)
      .where(and(eq(shelves.userId, viewer), sql`${shelves.deletedAt} IS NULL`))
      .orderBy(sql`${shelves.createdAt} DESC`);

    if (rows.length === 0) {
      return { shelves: [] };
    }

    const owner = await this.getOwnerProfile(viewer);

    let workMembershipMap = new Map<string, { note: string | null; position: number }>();
    if (workId) {
      const itemRows = await this.db
        .select({
          shelfId: shelfItems.shelfId,
          note: shelfItems.note,
          position: shelfItems.position,
        })
        .from(shelfItems)
        .where(
          and(
            inArray(shelfItems.shelfId, rows.map((r) => r.id)),
            eq(shelfItems.workId, workId),
          ),
        );
      for (const item of itemRows) {
        workMembershipMap.set(item.shelfId, { note: item.note, position: item.position });
      }
    }

    const allCoverWorkIds = Array.from(new Set(rows.flatMap((s) => s.coverWorkIds ?? [])));
    let coverIdMap = new Map<string, number | null>();
    if (allCoverWorkIds.length > 0) {
      const coverRows = await this.db
        .select({ id: works.id, coverId: works.olCoverId })
        .from(works)
        .where(inArray(works.id, allCoverWorkIds));
      for (const cr of coverRows) {
        coverIdMap.set(cr.id, cr.coverId);
      }
    }

    const result: ShelfWithWorkState[] = rows.map((shelf) => {
      const coverIds = (shelf.coverWorkIds ?? []).map((wid) => coverIdMap.get(wid) ?? null);
      const membership = workMembershipMap.get(shelf.id);
      return {
        id: shelf.id,
        user_id: shelf.userId,
        name: shelf.name,
        slug: shelf.slug,
        description: shelf.description,
        is_ranked: shelf.isRanked,
        privacy: shelf.privacy as 'public' | 'followers' | 'private',
        cover_work_ids: shelf.coverWorkIds ?? [],
        cover_ids: coverIds,
        item_count: shelf.itemCount,
        save_count: shelf.saveCount,
        is_saved: false,
        created_at: shelf.createdAt.toISOString(),
        owner,
        contains_work: Boolean(membership),
        item_note: membership?.note ?? null,
        position: membership?.position ?? null,
      };
    });

    return { shelves: result };
  }

  async removeItem(viewer: string, shelfId: string, workId: string): Promise<{ deleted: true; shelf_id: string; work_id: string }> {
    const [shelf] = await this.db
      .select({ id: shelves.id, userId: shelves.userId })
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!shelf || shelf.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    const deleted = await this.db
      .delete(shelfItems)
      .where(and(eq(shelfItems.shelfId, shelfId), eq(shelfItems.workId, workId)))
      .returning({ workId: shelfItems.workId });

    if (deleted.length === 0) {
      throw ApiError.notFound('Book not found in shelf.');
    }

    return { deleted: true, shelf_id: shelfId, work_id: workId };
  }

  async updateItem(
    viewer: string,
    shelfId: string,
    workId: string,
    input: UpdateShelfItemInput,
  ): Promise<ShelfItemDetail> {
    const [shelf] = await this.db
      .select({ id: shelves.id, userId: shelves.userId })
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!shelf || shelf.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    if (input.note && input.note.trim().length > 280) {
      throw new ApiError(400, 'invalid_note', 'Note cannot exceed 280 characters.', 'note');
    }

    const updates: Partial<{ note: string | null; position: number }> = {};
    if (input.note !== undefined) {
      updates.note = input.note?.trim() || null;
    }
    if (input.position !== undefined) {
      updates.position = input.position;
    }

    if (Object.keys(updates).length > 0) {
      const updated = await this.db
        .update(shelfItems)
        .set(updates)
        .where(and(eq(shelfItems.shelfId, shelfId), eq(shelfItems.workId, workId)))
        .returning();

      if (updated.length === 0) {
        throw ApiError.notFound('Book not found in shelf.');
      }
    }

    const items = await this.getItems(viewer, shelfId, { limit: 100 });
    const item = items.data.find((i) => i.work_id === workId);
    if (!item) {
      throw ApiError.notFound('Book not found in shelf.');
    }
    return item;
  }

  async reorder(
    viewer: string,
    shelfId: string,
    workIds: string[],
  ): Promise<{ reordered: true; shelf_id: string; count: number }> {
    const [shelf] = await this.db
      .select({ id: shelves.id, userId: shelves.userId })
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!shelf || shelf.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }

    const uniqueIds = new Set(workIds);
    if (uniqueIds.size !== workIds.length) {
      throw new ApiError(400, 'duplicate_work_ids', 'work_ids array cannot contain duplicate IDs.', 'work_ids');
    }

    await this.db.transaction(async (tx) => {
      for (let i = 0; i < workIds.length; i++) {
        const wid = workIds[i];
        if (wid) {
          await tx
            .update(shelfItems)
            .set({ position: i + 1 })
            .where(and(eq(shelfItems.shelfId, shelfId), eq(shelfItems.workId, wid)));
        }
      }
    });

    return { reordered: true, shelf_id: shelfId, count: workIds.length };
  }

  async save(
    viewer: string,
    shelfId: string,
  ): Promise<{ saved: true; shelf_id: string; save_count: number }> {
    const shelf = await this.getById(viewer, shelfId);

    if (shelf.user_id === viewer) {
      throw new ApiError(400, 'cannot_save_own_shelf', 'You cannot save your own shelf.');
    }

    await this.db
      .insert(shelfSaves)
      .values({
        shelfId,
        userId: viewer,
      })
      .onConflictDoNothing();

    const [updated] = await this.db
      .select({ saveCount: shelves.saveCount })
      .from(shelves)
      .where(eq(shelves.id, shelfId))
      .limit(1);

    return {
      saved: true,
      shelf_id: shelfId,
      save_count: updated?.saveCount ?? shelf.save_count,
    };
  }

  async unsave(
    viewer: string,
    shelfId: string,
  ): Promise<{ saved: false; shelf_id: string; save_count: number }> {
    const [shelf] = await this.db
      .select({ id: shelves.id, saveCount: shelves.saveCount })
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!shelf) {
      throw ApiError.notFound('Shelf not found.');
    }

    await this.db
      .delete(shelfSaves)
      .where(and(eq(shelfSaves.shelfId, shelfId), eq(shelfSaves.userId, viewer)));

    const [updated] = await this.db
      .select({ saveCount: shelves.saveCount })
      .from(shelves)
      .where(eq(shelves.id, shelfId))
      .limit(1);

    return {
      saved: false,
      shelf_id: shelfId,
      save_count: updated?.saveCount ?? Math.max(0, shelf.saveCount - 1),
    };
  }

  async getSavedShelves(viewer: string): Promise<{ shelves: ShelfDetail[] }> {
    const rows = await this.db
      .select({
        shelf: shelves,
        savedAt: shelfSaves.createdAt,
      })
      .from(shelfSaves)
      .innerJoin(shelves, eq(shelfSaves.shelfId, shelves.id))
      .where(and(eq(shelfSaves.userId, viewer), sql`${shelves.deletedAt} IS NULL`))
      .orderBy(sql`${shelfSaves.createdAt} DESC`);

    if (rows.length === 0) {
      return { shelves: [] };
    }

    const allCoverWorkIds = new Set<string>();
    const ownerIds = new Set<string>();
    for (const r of rows) {
      ownerIds.add(r.shelf.userId);
      if (r.shelf.coverWorkIds) {
        for (const wid of r.shelf.coverWorkIds) {
          allCoverWorkIds.add(wid);
        }
      }
    }

    const coversMap = new Map<string, number | null>();
    if (allCoverWorkIds.size > 0) {
      const coverRows = await this.db
        .select({ id: works.id, coverId: works.olCoverId })
        .from(works)
        .where(inArray(works.id, Array.from(allCoverWorkIds)));
      for (const cr of coverRows) {
        coversMap.set(cr.id, cr.coverId);
      }
    }

    const ownersMap = new Map<string, ShelfOwner & { isPrivate: boolean }>();
    for (const ownerId of ownerIds) {
      try {
        const owner = await this.getOwnerProfile(ownerId);
        ownersMap.set(ownerId, owner);
      } catch {
        ownersMap.set(ownerId, {
          id: ownerId,
          username: 'user',
          displayName: null,
          avatarKey: null,
          isPrivate: false,
        });
      }
    }

    const followRows = await this.db
      .select({ followeeId: follows.followeeId })
      .from(follows)
      .where(
        and(
          eq(follows.followerId, viewer),
          eq(follows.state, 'accepted'),
          inArray(follows.followeeId, Array.from(ownerIds)),
        ),
      );
    const followedOwners = new Set(followRows.map((f) => f.followeeId));

    const result: ShelfDetail[] = [];
    for (const r of rows) {
      const shelf = r.shelf;
      const owner = ownersMap.get(shelf.userId) || {
        id: shelf.userId,
        username: 'user',
        displayName: null,
        avatarKey: null,
        isPrivate: false,
      };
      const isFollower = followedOwners.has(shelf.userId);

      const allowed = canView({
        viewer,
        ownerId: shelf.userId,
        visibility: shelf.privacy,
        isOwnerPrivate: owner.isPrivate,
        isFollower,
      });

      if (!allowed) {
        continue;
      }

      const coverIds = (shelf.coverWorkIds || []).map((wid) => coversMap.get(wid) ?? null);
      result.push(this.formatShelf(shelf, owner, true, coverIds));
    }

    return { shelves: result };
  }

  async browse(
    viewer: string | null,
    input: BrowseShelvesInput,
  ): Promise<{ shelves: ShelfDetail[]; total: number }> {
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const offset = Math.max(0, input.offset ?? 0);
    const sort = input.sort ?? 'ranked';
    const query = input.query?.trim();

    // 1. Fetch candidate public shelves that are not soft-deleted and belong to public profiles
    const whereConditions = [
      eq(shelves.privacy, 'public'),
      sql`${shelves.deletedAt} IS NULL`,
      eq(profiles.isPrivate, false),
    ];

    if (query && query.length > 0) {
      const pattern = `%${query}%`;
      whereConditions.push(
        sql`(${shelves.name} ILIKE ${pattern} OR (${shelves.description} IS NOT NULL AND ${shelves.description} ILIKE ${pattern}))`,
      );
    }

    const candidateShelvesRows = await this.db
      .select({ shelf: shelves })
      .from(shelves)
      .innerJoin(profiles, eq(shelves.userId, profiles.userId))
    let candidateShelves = candidateShelvesRows.map((r) => r.shelf);
    if (viewer) {
      const blockRows = await this.db
        .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
        .from(blocks)
        .where(or(eq(blocks.blockerId, viewer), eq(blocks.blockedId, viewer)));
      const blockedSet = new Set<string>();
      for (const b of blockRows) {
        blockedSet.add(b.blockerId === viewer ? b.blockedId : b.blockerId);
      }
      candidateShelves = candidateShelves.filter((s) => !blockedSet.has(s.userId));
    }

    if (candidateShelves.length === 0) {
      return { shelves: [], total: 0 };
    }

    const shelfIds = candidateShelves.map((s) => s.id);
    const ownerIds = Array.from(new Set(candidateShelves.map((s) => s.userId)));

    // 2. Fetch social proximity (if viewer is authenticated)
    const followedOwners = new Set<string>();
    if (viewer) {
      const followedRows = await this.db
        .select({ followeeId: follows.followeeId })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, viewer),
            eq(follows.state, 'accepted'),
            inArray(follows.followeeId, ownerIds),
          ),
        );
      for (const r of followedRows) {
        followedOwners.add(r.followeeId);
      }
    }

    // 3. Fetch note presence to compute curation quality
    const notesRows = await this.db
      .select({ shelfId: shelfItems.shelfId })
      .from(shelfItems)
      .where(
        and(
          inArray(shelfItems.shelfId, shelfIds),
          sql`${shelfItems.note} IS NOT NULL AND char_length(trim(${shelfItems.note})) > 0`,
        ),
      )
      .groupBy(shelfItems.shelfId);
    const shelvesWithNotes = new Set(notesRows.map((r) => r.shelfId));

    // 4. Compute scores and sort
    const scoredShelves = candidateShelves.map((shelf) => {
      // Social proximity
      let socialProximity = 0;
      if (viewer) {
        if (shelf.userId === viewer) {
          socialProximity = 0.5;
        } else if (followedOwners.has(shelf.userId)) {
          socialProximity = 1.0;
        }
      }

      // Curation quality composite (PRD §15.5):
      // - has description (+0.25)
      // - has per-entry notes (+0.25)
      // - item count between 5 and 100 (+0.30; 1–4 items: +0.15; >100 items: +0.10)
      // - cover art completeness (+0.20)
      let curationQuality = 0;
      if (shelf.description && shelf.description.trim().length > 0) {
        curationQuality += 0.25;
      }
      if (shelvesWithNotes.has(shelf.id)) {
        curationQuality += 0.25;
      }
      if (shelf.itemCount >= 5 && shelf.itemCount <= 100) {
        curationQuality += 0.30;
      } else if (shelf.itemCount >= 1 && shelf.itemCount < 5) {
        curationQuality += 0.15;
      } else if (shelf.itemCount > 100) {
        curationQuality += 0.10;
      }
      const coverCount = shelf.coverWorkIds?.length ?? 0;
      if (coverCount >= Math.min(4, Math.max(1, shelf.itemCount))) {
        curationQuality += 0.20;
      }

      // Freshness: rational decay over 30 days
      const ageInDays = Math.max(0, (Date.now() - shelf.createdAt.getTime()) / (1000 * 60 * 60 * 24));
      const freshness = 1 / (1 + ageInDays / 30);

      // Saves and views
      const savesScore = Math.log1p(Math.max(0, shelf.saveCount));
      const viewsScore = 0;

      // Formula from PRD §15.5
      const shelfScore =
        0.30 * savesScore +
        0.20 * viewsScore +
        0.20 * socialProximity +
        0.15 * curationQuality +
        0.15 * freshness;

      return {
        shelf,
        shelfScore,
      };
    });

    if (sort === 'popular') {
      scoredShelves.sort((a, b) => {
        if (b.shelf.saveCount !== a.shelf.saveCount) {
          return b.shelf.saveCount - a.shelf.saveCount;
        }
        return b.shelf.createdAt.getTime() - a.shelf.createdAt.getTime();
      });
    } else if (sort === 'recent') {
      scoredShelves.sort((a, b) => b.shelf.createdAt.getTime() - a.shelf.createdAt.getTime());
    } else {
      // 'ranked' (PRD §15.5)
      scoredShelves.sort((a, b) => {
        if (Math.abs(b.shelfScore - a.shelfScore) > 0.0001) {
          return b.shelfScore - a.shelfScore;
        }
        if (b.shelf.saveCount !== a.shelf.saveCount) {
          return b.shelf.saveCount - a.shelf.saveCount;
        }
        return b.shelf.createdAt.getTime() - a.shelf.createdAt.getTime();
      });
    }

    const total = scoredShelves.length;
    const paged = scoredShelves.slice(offset, offset + limit);

    if (paged.length === 0) {
      return { shelves: [], total };
    }

    // 5. Hydrate covers, owners, and is_saved for paged shelves
    const pagedCoverWorkIds = new Set<string>();
    const pagedOwnerIds = new Set<string>();
    const pagedShelfIds = paged.map((p) => p.shelf.id);

    for (const p of paged) {
      pagedOwnerIds.add(p.shelf.userId);
      if (p.shelf.coverWorkIds) {
        for (const wid of p.shelf.coverWorkIds) {
          pagedCoverWorkIds.add(wid);
        }
      }
    }

    const coversMap = new Map<string, number | null>();
    if (pagedCoverWorkIds.size > 0) {
      const coverRows = await this.db
        .select({ id: works.id, coverId: works.olCoverId })
        .from(works)
        .where(inArray(works.id, Array.from(pagedCoverWorkIds)));
      for (const cr of coverRows) {
        coversMap.set(cr.id, cr.coverId);
      }
    }

    const ownersMap = new Map<string, ShelfOwner>();
    for (const ownerId of pagedOwnerIds) {
      try {
        const owner = await this.getOwnerProfile(ownerId);
        ownersMap.set(ownerId, owner);
      } catch {
        ownersMap.set(ownerId, {
          id: ownerId,
          username: 'reader',
          displayName: null,
          avatarKey: null,
        });
      }
    }

    const savedShelfIds = new Set<string>();
    if (viewer) {
      const savedRows = await this.db
        .select({ shelfId: shelfSaves.shelfId })
        .from(shelfSaves)
        .where(
          and(
            eq(shelfSaves.userId, viewer),
            inArray(shelfSaves.shelfId, pagedShelfIds),
          ),
        );
      for (const sr of savedRows) {
        savedShelfIds.add(sr.shelfId);
      }
    }

    const result: ShelfDetail[] = [];
    for (const p of paged) {
      const shelf = p.shelf;
      const owner = ownersMap.get(shelf.userId) || {
        id: shelf.userId,
        username: 'reader',
        displayName: null,
        avatarKey: null,
      };
      const coverIds = (shelf.coverWorkIds || []).map((wid) => coversMap.get(wid) ?? null);
      result.push(this.formatShelf(shelf, owner, savedShelfIds.has(shelf.id), coverIds));
    }

    return { shelves: result, total };
  }

  async getUserShelves(
    viewer: string | null,
    targetUserId: string,
  ): Promise<{ shelves: ShelfDetail[] }> {
    const [targetUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      throw ApiError.notFound('User not found.');
    }

    const owner = await this.getOwnerProfile(targetUserId);

    const { isBlocked, isFollower } = await this.checkRelationship(viewer, targetUserId);

    // Enforce private account hierarchy: unauthorized viewers receive 404 (never 403)
    assertCanView({
      viewer,
      ownerId: targetUserId,
      visibility: 'public',
      isOwnerPrivate: owner.isPrivate,
      isBlocked,
      isFollower,
    });

    const rows = await this.db
      .select()
      .from(shelves)
      .where(and(eq(shelves.userId, targetUserId), sql`${shelves.deletedAt} IS NULL`))
      .orderBy(sql`${shelves.createdAt} DESC`);

    const visibleShelves = rows.filter((shelf) =>
      canView({
        viewer,
        ownerId: targetUserId,
        visibility: shelf.privacy,
        isOwnerPrivate: owner.isPrivate,
        isFollower,
      }),
    );

    if (visibleShelves.length === 0) {
      return { shelves: [] };
    }

    const allCoverWorkIds = Array.from(new Set(visibleShelves.flatMap((s) => s.coverWorkIds ?? [])));
    let coversMap = new Map<string, number | null>();
    if (allCoverWorkIds.length > 0) {
      const coverRows = await this.db
        .select({ id: works.id, coverId: works.olCoverId })
        .from(works)
        .where(inArray(works.id, allCoverWorkIds));
      for (const cr of coverRows) {
        coversMap.set(cr.id, cr.coverId);
      }
    }

    const savedShelfIds = new Set<string>();
    if (viewer) {
      const shelfIds = visibleShelves.map((s) => s.id);
      const savedRows = await this.db
        .select({ shelfId: shelfSaves.shelfId })
        .from(shelfSaves)
        .where(
          and(
            eq(shelfSaves.userId, viewer),
            inArray(shelfSaves.shelfId, shelfIds),
          ),
        );
      for (const sr of savedRows) {
        savedShelfIds.add(sr.shelfId);
      }
    }

    const result = visibleShelves.map((shelf) => {
      const coverIds = (shelf.coverWorkIds || []).map((wid) => coversMap.get(wid) ?? null);
      return this.formatShelf(shelf, owner, savedShelfIds.has(shelf.id), coverIds);
    });

    return { shelves: result };
  }

  async getBySlug(
    viewer: string | null,
    username: string,
    slug: string,
  ): Promise<ShelfDetail> {
    const trimmedUsername = username.trim().toLowerCase();
    const trimmedSlug = slug.trim().toLowerCase();

    // 1. Look up profile by username
    const [profile] = await this.db
      .select({
        userId: profiles.userId,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
        isPrivate: profiles.isPrivate,
      })
      .from(profiles)
      .where(sql`lower(${profiles.username}) = ${trimmedUsername}`)
      .limit(1);

    if (!profile) {
      throw ApiError.notFound('Shelf not found.');
    }

    // 2. Look up shelf by user_id and slug
    const [shelf] = await this.db
      .select()
      .from(shelves)
      .where(
        and(
          eq(shelves.userId, profile.userId),
          eq(shelves.slug, trimmedSlug),
          sql`${shelves.deletedAt} IS NULL`,
        ),
      )
      .limit(1);

    if (!shelf) {
      throw ApiError.notFound('Shelf not found.');
    }

    // 3. Follow and block status
    const { isBlocked, isFollower } = await this.checkRelationship(viewer, profile.userId);

    // 4. Authorization (404 on access denial)
    assertCanView({
      viewer,
      ownerId: profile.userId,
      visibility: shelf.privacy,
      isOwnerPrivate: profile.isPrivate,
      isBlocked,
      isFollower,
    });

    // 5. Covers
    let coverIds: (number | null)[] = [];
    if (shelf.coverWorkIds && shelf.coverWorkIds.length > 0) {
      const coverRows = await this.db
        .select({ id: works.id, coverId: works.olCoverId })
        .from(works)
        .where(inArray(works.id, shelf.coverWorkIds));
      const map = new Map(coverRows.map((r) => [r.id, r.coverId]));
      coverIds = shelf.coverWorkIds.map((wid) => map.get(wid) ?? null);
    }

    // 6. isSaved
    let isSaved = false;
    if (viewer) {
      const [saved] = await this.db
        .select({ shelfId: shelfSaves.shelfId })
        .from(shelfSaves)
        .where(and(eq(shelfSaves.shelfId, shelf.id), eq(shelfSaves.userId, viewer)))
        .limit(1);
      isSaved = Boolean(saved);
    }

    const owner: ShelfOwner = {
      id: profile.userId,
      username: profile.username,
      displayName: profile.displayName,
      avatarKey: profile.avatarKey,
    };

    return this.formatShelf(shelf, owner, isSaved, coverIds);
  }

  private async getOwnerProfile(
    userId: string,
  ): Promise<ShelfOwner & { isPrivate: boolean }> {
    const [row] = await this.db
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        avatarKey: profiles.avatarKey,
        isPrivate: profiles.isPrivate,
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
        isPrivate: false,
      }
    );
  }

  private formatShelf(
    shelf: Shelf,
    owner: ShelfOwner,
    isSaved = false,
    coverIds: (number | null)[] = [],
  ): ShelfDetail {
    return {
      id: shelf.id,
      user_id: shelf.userId,
      name: shelf.name,
      slug: shelf.slug,
      description: shelf.description,
      is_ranked: shelf.isRanked,
      privacy: shelf.privacy as 'public' | 'followers' | 'private',
      cover_work_ids: shelf.coverWorkIds ?? [],
      cover_ids: coverIds,
      item_count: shelf.itemCount,
      save_count: shelf.saveCount,
      is_saved: isSaved,
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
    '/shelves/mine',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'List current user shelves',
        description: 'Returns all active shelves belonging to the authenticated viewer. Supports optional ?work_id to indicate membership status and note for that book (SH-04).',
        querystring: myShelvesQuerySchema,
        response: {
          200: myShelvesResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { work_id } = (request.query as { work_id?: string }) || {};
      const result = await service.getMyShelves(viewer, work_id);
      return reply.send(result);
    },
  );

  fastify.get(
    '/shelves/saved',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'List shelves saved by viewer',
        description: 'Returns shelves saved/bookmarked by the authenticated user (SH-07).',
        response: {
          200: savedShelvesResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const result = await service.getSavedShelves(viewer);
      return reply.send(result);
    },
  );

  fastify.get(
    '/shelves/browse',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Browse and discover public shelves',
        description: 'Discovers public shelves ranked by multi-signal curation formula (PRD §15.5) or sorted by saves / recency.',
        querystring: browseShelvesQuerySchema,
        response: {
          200: browseShelvesResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const query = (request.query as BrowseShelvesInput) || {};
      const result = await service.browse(request.viewer, query);
      return reply.send(result);
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
      const shelf = await service.getById(request.viewer, id);
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

  fastify.get(
    '/shelves/:id/items',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'List items in shelf',
        description: 'Returns paginated items in a shelf with joined book details, authors, notes, and positions (SH-03).',
        params: idParamSchema,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
        response: {
          200: shelfItemsResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit = 50, offset = 0 } = (request.query as { limit?: number; offset?: number }) || {};
      const result = await service.getItems(request.viewer, id, { limit, offset });
      return reply.send(result);
    },
  );

  fastify.post(
    '/shelves/:id/items',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Add item to shelf',
        description: 'Appends a book to the shelf with an optional note and position. Only owner can add items.',
        params: idParamSchema,
        body: addShelfItemBodySchema,
        response: {
          201: shelfItemResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const item = await service.addItem(viewer, id, request.body as AddShelfItemInput);
      return reply.status(201).send({ item });
    },
  );

  fastify.delete(
    '/shelves/:id/items/:workId',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Remove item from shelf',
        description: 'Removes a book from the shelf. Only the shelf owner can remove items.',
        params: shelfItemParamSchema,
        response: {
          200: deleteShelfItemResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id, workId } = request.params as { id: string; workId: string };
      const result = await service.removeItem(viewer, id, workId);
      return reply.send(result);
    },
  );

  fastify.patch(
    '/shelves/:id/items/:workId',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Update shelf item note or position',
        description: 'Updates note (up to 280 chars) or position for an existing item on the shelf. Only owner can update.',
        params: shelfItemParamSchema,
        body: updateShelfItemBodySchema,
        response: {
          200: shelfItemResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id, workId } = request.params as { id: string; workId: string };
      const item = await service.updateItem(viewer, id, workId, request.body as UpdateShelfItemInput);
      return reply.send({ item });
    },
  );

  fastify.put(
    '/shelves/:id/order',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Reorder shelf items',
        description: 'Updates sequential positions for items in a shelf. Only the shelf owner can reorder items (SH-05).',
        params: idParamSchema,
        body: reorderShelfBodySchema,
        response: {
          200: reorderShelfResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const { work_ids } = request.body as { work_ids: string[] };
      const result = await service.reorder(viewer, id, work_ids);
      return reply.send(result);
    },
  );

  fastify.post(
    '/shelves/:id/save',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Save a shelf to library',
        description: "Saves another user's shelf as a reference to viewer's library (SH-07). Shelf updates remain dynamically synced.",
        params: idParamSchema,
        response: {
          200: saveShelfResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const result = await service.save(viewer, id);
      return reply.send(result);
    },
  );

  fastify.delete(
    '/shelves/:id/save',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Unsave a shelf from library',
        description: "Removes a previously saved shelf from viewer's library (SH-07).",
        params: idParamSchema,
        response: {
          200: saveShelfResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const result = await service.unsave(viewer, id);
      return reply.send(result);
    },
  );

  fastify.get(
    '/users/:id/shelves',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'List user shelves by user ID',
        description: 'Returns shelves belonging to a target user, respecting viewer authorization and account privacy (SH-09).',
        params: idParamSchema,
        response: {
          200: userShelvesResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await service.getUserShelves(request.viewer, id);
      return reply.send(result);
    },
  );

  fastify.get(
    '/users/:username/shelves/slug/:slug',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Get shelf by username and slug',
        description: 'Retrieves shelf details by creator username and URL slug (SH-10). Enforces privacy permissions (404 for unauthorized viewers).',
        params: shelfSlugParamsSchema,
        response: {
          200: shelfResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { username, slug } = request.params as { username: string; slug: string };
      const shelf = await service.getBySlug(request.viewer, username, slug);
      return reply.send({ shelf });
    },
  );

  fastify.get(
    '/shelves/by-slug/:username/:slug',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Get shelf by username and slug (alias)',
        description: 'Retrieves shelf details by creator username and URL slug (SH-10).',
        params: shelfSlugParamsSchema,
        response: {
          200: shelfResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { username, slug } = request.params as { username: string; slug: string };
      const shelf = await service.getBySlug(request.viewer, username, slug);
      return reply.send({ shelf });
    },
  );
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Renders server-side HTML page with Open Graph and Twitter Card tags for public link sharing (PRD §6.45, §29.1).
 */
export function renderShelfHtml(shelf: ShelfDetail, baseUrl = 'https://flyleaf.app'): string {
  const canonicalUrl = `${baseUrl}/u/${encodeURIComponent(shelf.owner.username)}/shelves/${encodeURIComponent(shelf.slug)}`;
  const title = `${escapeHtml(shelf.name)} — Curated by @${escapeHtml(shelf.owner.username)}`;
  const description = shelf.description
    ? escapeHtml(shelf.description)
    : `A curated list of ${shelf.item_count} book${shelf.item_count === 1 ? '' : 's'} on Flyleaf by ${escapeHtml(shelf.owner.displayName || shelf.owner.username)}.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} | Flyleaf</title>
  <meta name="description" content="${description}" />

  <!-- Open Graph / Social Sharing -->
  <meta property="og:site_name" content="Flyleaf" />
  <meta property="og:type" content="books.book_list" />
  <meta property="og:url" content="${canonicalUrl}" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />

  <!-- Mobile App Links -->
  <meta property="al:ios:url" content="flyleaf://shelf/${shelf.id}" />
  <meta property="al:ios:app_name" content="Flyleaf" />
  <meta property="al:android:url" content="flyleaf://shelf/${shelf.id}" />
  <meta property="al:android:package" content="app.flyleaf.skeleton" />
  <meta property="al:android:app_name" content="Flyleaf" />

  <style>
    :root {
      --bg: #12100e;
      --card-bg: #1c1815;
      --border: #2c2520;
      --accent: #d4a373;
      --text: #f4ede4;
      --text-muted: #9c8e82;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      max-width: 480px;
      width: 100%;
      padding: 32px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 16px;
    }
    h1 {
      font-family: Georgia, serif;
      font-size: 26px;
      line-height: 1.3;
      margin-bottom: 12px;
      color: var(--text);
    }
    .meta {
      font-size: 14px;
      color: var(--text-muted);
      margin-bottom: 20px;
    }
    .meta b { color: var(--text); }
    .desc {
      font-size: 14px;
      line-height: 1.6;
      color: #cfc5bb;
      margin-bottom: 28px;
      text-align: left;
      background: rgba(0, 0, 0, 0.2);
      padding: 16px;
      border-radius: 10px;
      border-left: 3px solid var(--accent);
    }
    .app-button {
      display: inline-block;
      background: var(--accent);
      color: #12100e;
      font-weight: 600;
      font-size: 15px;
      padding: 14px 28px;
      border-radius: 12px;
      text-decoration: none;
      transition: opacity 0.2s;
    }
    .app-button:hover { opacity: 0.9; }
    .footer {
      margin-top: 24px;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Flyleaf Reading List</div>
    <h1>${escapeHtml(shelf.name)}</h1>
    <div class="meta">
      Curated by <b>@${escapeHtml(shelf.owner.username)}</b> · ${shelf.item_count} book${shelf.item_count === 1 ? '' : 's'}${shelf.is_ranked ? ' · Ranked list' : ''}
    </div>
    ${shelf.description ? `<div class="desc">${escapeHtml(shelf.description)}</div>` : ''}
    <a href="flyleaf://shelf/${shelf.id}" class="app-button">Open in Flyleaf App</a>
    <div class="footer">flyleaf.app — A social reading tracker</div>
  </div>
</body>
</html>`;
}

/**
 * Public Web / Open Graph landing routes for shared shelf URLs.
 */
export const shelvesWebPlugin: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const service = new ShelvesService(opts.db);

  fastify.get<{ Params: { username: string; slug: string } }>(
    '/u/:username/shelves/:slug',
    async (request, reply) => {
      const { username, slug } = request.params;
      const shelf = await service.getBySlug(request.viewer, username, slug);
      if (request.headers.accept?.includes('application/json')) {
        return reply.send({ shelf });
      }
      return reply.type('text/html').send(renderShelfHtml(shelf));
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/shelf/:id',
    async (request, reply) => {
      const { id } = request.params;
      const shelf = await service.getById(request.viewer, id);
      if (request.headers.accept?.includes('application/json')) {
        return reply.send({ shelf });
      }
      return reply.type('text/html').send(renderShelfHtml(shelf));
    },
  );
};


