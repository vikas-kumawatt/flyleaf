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
import { and, eq, sql, inArray } from 'drizzle-orm';
import { Db } from '../platform/index.js';
import { ApiError, requireViewer } from '../http.js';
import { assertCanView } from '../authorization/index.js';
import {
  shelves,
  shelfItems,
  shelfSaves,
  profiles,
  users,
  follows,
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
    return this.formatShelf(inserted, owner, false, []);
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
        .where(and(eq(shelfSaves.shelfId, id), eq(shelfSaves.userId, viewer)))
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
    return this.get(viewer, id);
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
    const shelf = await this.get(viewer, shelfId);

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

    const ownersMap = new Map<string, ShelfOwner>();
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
      const isOwner = shelf.userId === viewer;
      const isFollower = followedOwners.has(shelf.userId);

      if (shelf.privacy === 'private' && !isOwner) {
        continue;
      }
      if (shelf.privacy === 'followers' && !isOwner && !isFollower) {
        continue;
      }

      const owner = ownersMap.get(shelf.userId) || {
        id: shelf.userId,
        username: 'user',
        displayName: null,
        avatarKey: null,
      };

      const coverIds = (shelf.coverWorkIds || []).map((wid) => coversMap.get(wid) ?? null);
      result.push(this.formatShelf(shelf, owner, true, coverIds));
    }

    return { shelves: result };
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
};

