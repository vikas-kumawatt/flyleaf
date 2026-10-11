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
import { and, eq, getTableColumns, sql, inArray, type SQL } from 'drizzle-orm';
import { config, Db } from '../platform/index.js';
import { ApiError, requireViewer } from '../http.js';
import { resolveWorkId } from '../catalog/resolve.js';
import { avatarUrl } from '../uploads/index.js';
import { canViewSql, canViewWith, loadRelationship, type Visibility } from '../authorization/index.js';
import {
  shelves,
  shelfItems,
  shelfSaves,
  shelfSlugs,
  usernameClaims,
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
  savedShelvesQuerySchema,
  savedShelvesResponseSchema,
  deletedShelvesResponseSchema,
  browseShelvesQuerySchema,
  browseShelvesResponseSchema,
  userShelvesResponseSchema,
  shelfSlugParamsSchema,
  slugMovedResponseSchema,
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
  /** A-11-029: the URL to load the avatar from, as on every other person object. */
  avatarUrl: string | null;
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

/** PRD §15.6. */
export const MAX_SHELVES_PER_USER = 200;
export const MAX_ITEMS_PER_SHELF = 1000;
/** PRD §15.6: a deleted shelf can be restored for 30 days. */
export const SHELF_RECOVERY_DAYS = 30;

/**
 * Length in characters (code points), as `char_length` and the request
 * schema count it. JS `.length` counts UTF-16 units, so an emoji is 2
 * (audit 11, A-11-007).
 */
function charLength(s: string): number {
  return [...s].length;
}

/**
 * Normalizes a shelf title to a URL-safe slug. Letters and digits of every
 * script are kept (`Книги 2026` → `книги-2026`); only Latin diacritics are
 * folded (`Café` → `cafe`). A name with no letters or digits is `shelf`.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/([A-Za-z])[̀-ͯ]+/g, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'shelf';
}

/**
 * Generates a unique slug for a user, appending -1, -2 etc on collision.
 * Every slug a shelf of this user has ever had stays taken (D-11-2): deleted
 * shelves keep theirs (they can be restored), and a renamed shelf keeps its
 * old ones so old links still reach it. A shelf may take back its own old
 * slug (`excludeShelfId`).
 */
export async function generateUniqueSlug(
  db: Db,
  userId: string,
  name: string,
  excludeShelfId?: string,
): Promise<string> {
  const baseSlug = slugify(name);

  const existing = await db
    .select({ slug: shelfSlugs.slug })
    .from(shelfSlugs)
    .where(
      and(
        eq(shelfSlugs.userId, userId),
        excludeShelfId ? sql`${shelfSlugs.shelfId} <> ${excludeShelfId}::uuid` : undefined,
        sql`(${shelfSlugs.slug} = ${baseSlug} OR ${shelfSlugs.slug} ~ ${`^${baseSlug}-[0-9]+$`})`,
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

/** A unique violation (SQLSTATE 23505), through Drizzle's `cause` wrapping. */
function isUniqueViolation(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < 5 && node; depth++) {
    if ((node as { code?: unknown }).code === '23505') return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/** Serializes one user's shelf creates, renames and restores (limit and slug). */
export async function lockUserShelves(tx: Db, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`shelves:${userId}`}, 0))`);
}

const uuidArray = (ids: string[]) =>
  ids.length === 0 ? sql`'{}'::uuid[]` : sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

/** A shelf row as the card queries return it: the shelf, its owner and its covers. */
type ShelfCardRow = {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  is_ranked: boolean;
  privacy: string;
  cover_work_ids: string[] | string | null;
  cover_ids: (number | null)[] | string | null;
  item_count: number;
  save_count: number;
  created_at: string | Date;
  deleted_at?: string | Date | null;
  username: string;
  display_name: string | null;
  avatar_key: string | null;
  is_saved: boolean;
  total?: number | string;
};

/** `{a,b}` text arrays (a driver that does not parse uuid[]) or real arrays. */
function pgArray<T>(v: T[] | string | null | undefined, parse: (s: string) => T): T[] {
  if (Array.isArray(v)) return v;
  if (!v || v === '{}') return [];
  return v.slice(1, -1).split(',').map((s) => parse(s));
}

/**
 * A work with no cover is a NULL in the mosaic. postgres.js passes that NULL
 * to the int4 parser and returns NaN (PGlite returns null), so anything that
 * is not a number becomes null (A-15-024).
 */
export function coverIdsFromRow(v: ShelfCardRow['cover_ids']): (number | null)[] {
  return pgArray(v, (s) => (s === 'NULL' ? null : Number(s))).map((c) => {
    const n = Number(c);
    return c === null || Number.isNaN(n) ? null : n;
  });
}

/**
 * The columns every shelf card needs, in one row: the owner from profiles and
 * the cover ids in mosaic order. Replaces a query per owner and a query for
 * the covers (L-10, audit 11).
 */
function shelfCardColumns(viewer: string | null) {
  return sql`
    s.id, s.user_id, s.name, s.slug, s.description, s.is_ranked, s.privacy,
    s.cover_work_ids, s.item_count, s.save_count, s.created_at, s.deleted_at,
    p.username, p.display_name, p.avatar_key,
    ARRAY(
      SELECT cw.ol_cover_id
      FROM unnest(s.cover_work_ids) WITH ORDINALITY AS c(work_id, ord)
      LEFT JOIN works cw ON cw.id = c.work_id
      ORDER BY c.ord
    ) AS cover_ids,
    ${viewer
      ? sql`EXISTS (SELECT 1 FROM shelf_saves vs WHERE vs.shelf_id = s.id AND vs.user_id = ${viewer}::uuid)`
      : sql`false`} AS is_saved`;
}

function cardFromRow(r: ShelfCardRow): ShelfDetail {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    is_ranked: r.is_ranked,
    privacy: r.privacy as ShelfDetail['privacy'],
    cover_work_ids: pgArray(r.cover_work_ids, (s) => s),
    cover_ids: coverIdsFromRow(r.cover_ids),
    item_count: Number(r.item_count),
    save_count: Number(r.save_count),
    is_saved: Boolean(r.is_saved),
    created_at: new Date(r.created_at).toISOString(),
    owner: {
      id: r.user_id,
      username: r.username,
      displayName: r.display_name,
      avatarKey: r.avatar_key,
      avatarUrl: avatarUrl(r.avatar_key),
    },
  };
}

import { ActivityService } from '../activity/index.js';

export class ShelvesService {
  private activityService: ActivityService;

  constructor(private db: Db) {
    this.activityService = new ActivityService(db);
  }

  /** A transaction as a Db (the services' common type), as elsewhere in the codebase. */
  #tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.db.transaction((t) => fn(t as unknown as Db));
  }

  #validName(name: string | undefined): string {
    const trimmed = name?.trim();
    if (!trimmed || charLength(trimmed) > 60) {
      throw new ApiError(400, 'invalid_shelf_name', 'Shelf name must be between 1 and 60 characters.', 'name');
    }
    return trimmed;
  }

  #checkDescription(description: string | null | undefined): void {
    if (description && charLength(description.trim()) > 2000) {
      throw new ApiError(400, 'invalid_description', 'Description cannot exceed 2000 characters.', 'description');
    }
  }

  #checkNote(note: string | null | undefined): void {
    if (note && charLength(note.trim()) > 280) {
      throw new ApiError(400, 'invalid_note', 'Note cannot exceed 280 characters.', 'note');
    }
  }

  async #assertUnderShelfLimit(tx: Db, viewer: string): Promise<void> {
    const [row] = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM shelves WHERE user_id = ${viewer}::uuid AND deleted_at IS NULL`);
    if (Number(row?.n ?? 0) >= MAX_SHELVES_PER_USER) {
      throw new ApiError(409, 'shelf_limit_reached', `You can have up to ${MAX_SHELVES_PER_USER} shelves. Delete one to make room.`);
    }
  }

  /**
   * Runs a write that picks a slug. The user lock serializes this user's
   * creates and renames; a unique violation can still come from a write that
   * does not take it, so the slug is recomputed and the write retried
   * (A-11-005).
   */
  async #withSlugRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt < 4 && isUniqueViolation(err)) continue;
        throw err;
      }
    }
  }

  /** The viewer's live shelf, row-locked for this transaction; anyone else's is 404. */
  async #lockOwnShelf(tx: Db, viewer: string, shelfId: string): Promise<Shelf> {
    const [shelf] = await tx
      .select()
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), sql`${shelves.deletedAt} IS NULL`))
      .for('update')
      .limit(1);
    if (!shelf || shelf.userId !== viewer) {
      throw ApiError.notFound('Shelf not found.');
    }
    return shelf;
  }

  /** Positions 1..n in the given order, in one statement (one counter refresh). */
  async #writeOrder(tx: Db, shelfId: string, workIds: string[]): Promise<void> {
    if (workIds.length === 0) return;
    await tx.execute(sql`
      UPDATE shelf_items si SET position = o.ord
      FROM unnest(${uuidArray(workIds)}) WITH ORDINALITY AS o(work_id, ord)
      WHERE si.shelf_id = ${shelfId}::uuid AND si.work_id = o.work_id
        AND si.position IS DISTINCT FROM o.ord::int`);
  }

  /** The shelf's books in display order. */
  async #currentOrder(tx: Db, shelfId: string): Promise<string[]> {
    const rows = await tx.execute<{ work_id: string }>(sql`
      SELECT work_id FROM shelf_items WHERE shelf_id = ${shelfId}::uuid
      ORDER BY position, added_at, work_id`);
    return rows.map((r) => r.work_id);
  }

  /**
   * The feed visibility of a shelf's activity: the shelf's privacy, narrowed
   * to followers on a private account (as recordActivity writes it).
   */
  async #activityVisibility(tx: Db, ownerId: string, privacy: string): Promise<Visibility> {
    if (privacy === 'private') return 'private';
    const [p] = await tx
      .select({ isPrivate: profiles.isPrivate })
      .from(profiles)
      .where(eq(profiles.userId, ownerId))
      .limit(1);
    return p?.isPrivate ? 'followers' : (privacy as Visibility);
  }

  async create(viewer: string, input: CreateShelfInput): Promise<ShelfDetail> {
    const trimmedName = this.#validName(input.name);
    this.#checkDescription(input.description);

    const privacy = input.privacy ?? 'public';
    if (!['public', 'followers', 'private'].includes(privacy)) {
      throw new ApiError(400, 'invalid_privacy', 'Privacy must be public, followers, or private.', 'privacy');
    }

    const inserted = await this.#withSlugRetry(() =>
      this.#tx(async (tx) => {
        await lockUserShelves(tx, viewer);
        await this.#assertUnderShelfLimit(tx, viewer);
        const slug = await generateUniqueSlug(tx, viewer, trimmedName);
        const [row] = await tx
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
        return row;
      }),
    );

    if (!inserted) {
      throw new ApiError(500, 'shelf_create_failed', 'Failed to create shelf.');
    }

    const owner = await this.getOwnerProfile(viewer);
    return this.formatShelf(inserted, owner, false, []);
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

    // Enforce authorization
    const rel = await loadRelationship(this.db, viewer, shelf.userId);
    if (!canViewWith(viewer, shelf.userId, rel, shelf.privacy)) throw ApiError.notFound('Shelf not found.');
    const owner = await this.getOwnerProfile(shelf.userId);

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
    const nextName = input.name !== undefined ? this.#validName(input.name) : undefined;
    this.#checkDescription(input.description);

    if (input.privacy !== undefined && !['public', 'followers', 'private'].includes(input.privacy)) {
      throw new ApiError(400, 'invalid_privacy', 'Privacy must be public, followers, or private.', 'privacy');
    }

    await this.#withSlugRetry(() =>
      this.#tx(async (tx) => {
        const existing = await this.#lockOwnShelf(tx, viewer, id);

        let nextSlug = existing.slug;
        if (nextName !== undefined && nextName !== existing.name) {
          await lockUserShelves(tx, viewer);
          nextSlug = await generateUniqueSlug(tx, viewer, nextName, existing.id);
        }
        const nextPrivacy = input.privacy ?? existing.privacy;

        await tx
          .update(shelves)
          .set({
            name: nextName ?? existing.name,
            slug: nextSlug,
            description: input.description !== undefined ? input.description?.trim() || null : existing.description,
            isRanked: input.is_ranked !== undefined ? Boolean(input.is_ranked) : existing.isRanked,
            privacy: nextPrivacy,
          })
          .where(eq(shelves.id, id));

        // The shelf's feed activity follows its privacy: private removes it,
        // followers narrows it (A-11-001), as a read's does (PRD §26.2).
        if (nextPrivacy !== existing.privacy) {
          await this.activityService.updateActivityVisibility(
            tx, 'shelf_item', id, await this.#activityVisibility(tx, viewer, nextPrivacy));
        }
        if (nextSlug !== existing.slug || (nextName !== undefined && nextName !== existing.name)) {
          await tx.execute(sql`
            UPDATE activity
            SET metadata = metadata || jsonb_build_object('shelfName', ${nextName ?? existing.name}::text, 'shelfSlug', ${nextSlug}::text)
            WHERE object_type = 'shelf_item' AND object_id = ${id}::uuid`);
        }
      }),
    );

    return this.getById(viewer, id);
  }

  async delete(viewer: string, id: string): Promise<{ deleted: true; id: string }> {
    await this.#tx(async (tx) => {
      await this.#lockOwnShelf(tx, viewer, id);
      await tx.update(shelves).set({ deletedAt: new Date() }).where(eq(shelves.id, id));
      // A deleted shelf leaves the feed with it (A-11-001).
      await this.activityService.deleteActivity(tx, 'shelf_item', id);
    });

    return { deleted: true, id };
  }

  /** The viewer's shelves deleted in the last 30 days, newest deletion first (A-11-004). */
  async listDeleted(viewer: string): Promise<{ shelves: (ShelfDetail & { deleted_at: string; purge_after: string })[] }> {
    const rows = await this.db.execute<ShelfCardRow>(sql`
      SELECT ${shelfCardColumns(viewer)}
      FROM shelves s
      JOIN profiles p ON p.user_id = s.user_id
      WHERE s.user_id = ${viewer}::uuid
        AND s.deleted_at IS NOT NULL
        AND s.deleted_at > now() - make_interval(days => ${SHELF_RECOVERY_DAYS})
      ORDER BY s.deleted_at DESC, s.id DESC`);
    return {
      shelves: rows.map((r) => {
        const deletedAt = new Date(r.deleted_at as string | Date);
        return {
          ...cardFromRow(r),
          deleted_at: deletedAt.toISOString(),
          purge_after: new Date(deletedAt.getTime() + SHELF_RECOVERY_DAYS * 86_400_000).toISOString(),
        };
      }),
    };
  }

  /**
   * Undoes a delete within 30 days (PRD §15.6). The slug was never released,
   * so share links work again. Feed activity removed at deletion stays gone.
   */
  async restore(viewer: string, id: string): Promise<ShelfDetail> {
    await this.#tx(async (tx) => {
      await lockUserShelves(tx, viewer);
      const [row] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM shelves
        WHERE id = ${id}::uuid AND user_id = ${viewer}::uuid
          AND deleted_at IS NOT NULL
          AND deleted_at > now() - make_interval(days => ${SHELF_RECOVERY_DAYS})
        FOR UPDATE`);
      if (!row) throw ApiError.notFound('Shelf not found.');
      await this.#assertUnderShelfLimit(tx, viewer);
      await tx.update(shelves).set({ deletedAt: null }).where(eq(shelves.id, id));
    });
    return this.getById(viewer, id);
  }

  /** Item rows with their work, in display order; `workId` selects one. */
  async #itemRows(
    viewer: string | null,
    shelfId: string,
    page: { limit: number; offset: number } | { workId: string },
  ): Promise<ShelfItemDetail[]> {
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
        -- The work page's rating (work_stats), not an average over every
        -- attempt and private read (A-11-013).
        round(ws.avg_rating, 1)::text AS rating,
        ${viewer ? sql`ur.status` : sql`NULL`} AS user_status,
        ${viewer ? sql`ur.rating::text` : sql`NULL`} AS user_rating,
        ${viewer ? sql`ur.hearted` : sql`NULL`} AS user_hearted
      FROM shelf_items si
      JOIN works w ON w.id = si.work_id
      LEFT JOIN work_stats ws ON ws.work_id = w.id
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
      ${'workId' in page ? sql`AND si.work_id = ${page.workId}::uuid` : sql``}
      ORDER BY si.position ASC, si.added_at ASC, si.work_id ASC
      ${'workId' in page ? sql`` : sql`LIMIT ${page.limit} OFFSET ${page.offset}`}
    `);

    return rows.map((r) => ({
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

    const rel = await loadRelationship(this.db, viewer, shelf.userId);
    if (!canViewWith(viewer, shelf.userId, rel, shelf.privacy)) throw ApiError.notFound('Shelf not found.');

    const [countRow] = await this.db.execute<{ count: string }>(sql`
      SELECT count(*)::text as count
      FROM shelf_items
      WHERE shelf_id = ${shelfId}::uuid
    `);
    const total = countRow ? parseInt(countRow.count, 10) : 0;

    const data = await this.#itemRows(viewer, shelfId, { limit, offset });
    return { data, total };
  }

  async addItem(viewer: string, shelfId: string, input: AddShelfItemInput): Promise<ShelfItemDetail> {
    this.#checkNote(input.note);

    // One transaction under the shelf's row lock: the cap, the position and
    // the insert cannot race another add, a reorder or a move (A-11-009).
    const workId = await this.#tx(async (tx) => {
      const shelf = await this.#lockOwnShelf(tx, viewer, shelfId);

      // D3: a merged work's id shelves the survivor. Resolved under the
      // merge's lock, so a shelf add racing a merge cannot land on the tombstone.
      const resolved = await resolveWorkId(tx, input.work_id, { lock: true });
      if (!resolved) throw ApiError.notFound('Work not found.');

      const [state] = await tx.execute<{ n: number; max_pos: number | null; present: boolean }>(sql`
        SELECT count(*)::int AS n, max(position) AS max_pos,
               bool_or(work_id = ${resolved}::uuid) AS present
        FROM shelf_items WHERE shelf_id = ${shelfId}::uuid`);
      const n = Number(state?.n ?? 0);
      if (state?.present) {
        throw new ApiError(409, 'duplicate_shelf_item', 'This book is already on the shelf.', 'work_id');
      }
      if (n >= MAX_ITEMS_PER_SHELF) {
        throw new ApiError(409, 'shelf_full', `A shelf can hold up to ${MAX_ITEMS_PER_SHELF} books.`, 'work_id');
      }

      let position = Number(state?.max_pos ?? 0) + 1;
      if (input.position && input.position <= n) {
        // Insert at that rank: everything from there down moves one place.
        position = input.position;
        await tx.execute(sql`
          UPDATE shelf_items SET position = position + 1
          WHERE shelf_id = ${shelfId}::uuid AND position >= ${position}`);
      }

      await tx.insert(shelfItems).values({
        shelfId,
        workId: resolved,
        position,
        note: input.note?.trim() || null,
        addedBy: viewer,
      });

      await this.activityService.recordActivity(tx, {
        actorId: viewer,
        verb: 'shelved',
        workId: resolved,
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
      return resolved;
    });

    // The item itself, wherever it sits: the old code looked for it in the
    // first 100 items and answered 500 for the 101st (A-11-002).
    const [created] = await this.#itemRows(viewer, shelfId, { workId });
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

    // D3: a merged work's id asks about the survivor, which the merge moved
    // the items to (A-11-014).
    if (workId) workId = (await resolveWorkId(this.db, workId)) ?? workId;

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
    // D3: the merge moved the item to the survivor.
    workId = (await resolveWorkId(this.db, workId)) ?? workId;

    await this.#tx(async (tx) => {
      await this.#lockOwnShelf(tx, viewer, shelfId);

      const deleted = await tx
        .delete(shelfItems)
        .where(and(eq(shelfItems.shelfId, shelfId), eq(shelfItems.workId, workId)))
        .returning({ position: shelfItems.position });

      if (deleted.length === 0) {
        throw ApiError.notFound('Book not found in shelf.');
      }

      // Close the gap, so a ranked shelf still reads #1..#n.
      await tx.execute(sql`
        UPDATE shelf_items SET position = position - 1
        WHERE shelf_id = ${shelfId}::uuid AND position > ${deleted[0]!.position}`);

      // The book is no longer on the shelf, so neither is its feed card.
      await tx.execute(sql`
        DELETE FROM activity
        WHERE object_type = 'shelf_item' AND object_id = ${shelfId}::uuid AND work_id = ${workId}::uuid`);
    });

    return { deleted: true, shelf_id: shelfId, work_id: workId };
  }

  async updateItem(
    viewer: string,
    shelfId: string,
    workId: string,
    input: UpdateShelfItemInput,
  ): Promise<ShelfItemDetail> {
    // D3: the merge moved the item to the survivor.
    workId = (await resolveWorkId(this.db, workId)) ?? workId;
    this.#checkNote(input.note);

    await this.#tx(async (tx) => {
      await this.#lockOwnShelf(tx, viewer, shelfId);

      const order = await this.#currentOrder(tx, shelfId);
      const from = order.indexOf(workId);
      if (from === -1) {
        throw ApiError.notFound('Book not found in shelf.');
      }

      if (input.note !== undefined) {
        await tx
          .update(shelfItems)
          .set({ note: input.note?.trim() || null })
          .where(and(eq(shelfItems.shelfId, shelfId), eq(shelfItems.workId, workId)));
      }

      // A position is a move: the others shift, so the shelf stays 1..n
      // (A-11-011). Past the end means the end.
      if (input.position !== undefined) {
        const to = Math.min(Math.max(input.position, 1), order.length) - 1;
        order.splice(from, 1);
        order.splice(to, 0, workId);
        await this.#writeOrder(tx, shelfId, order);
      }
    });

    const [item] = await this.#itemRows(viewer, shelfId, { workId });
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
    await this.#tx(async (tx) => {
      await this.#lockOwnShelf(tx, viewer, shelfId);

      // D3: an order sent with a merged work's id moves the survivor's item,
      // which is where the merge put it. One query for the whole list.
      const merged = workIds.length === 0 ? [] : await tx.execute<{ id: string; survivor: string }>(sql`
        SELECT id, merged_into_id AS survivor FROM works
        WHERE id = ANY (${uuidArray(workIds)})
          AND merged_into_id IS NOT NULL`);
      const survivorOf = new Map(merged.map((m) => [m.id, m.survivor]));
      workIds = workIds.map((w) => survivorOf.get(w) ?? w);

      const uniqueIds = new Set(workIds);
      if (uniqueIds.size !== workIds.length) {
        throw new ApiError(400, 'duplicate_work_ids', 'work_ids array cannot contain duplicate IDs.', 'work_ids');
      }

      // Exactly the books on the shelf: a missing one kept its old position
      // (two books at #1) and an extra one was ignored (A-11-008). A client
      // with a stale list reloads and tries again.
      const current = await this.#currentOrder(tx, shelfId);
      if (current.length !== workIds.length || current.some((w) => !uniqueIds.has(w))) {
        throw new ApiError(409, 'order_mismatch', 'The order must list exactly the books on the shelf. Reload and try again.', 'work_ids');
      }

      await this.#writeOrder(tx, shelfId, workIds);
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

  /**
   * Removes the viewer's save. A shelf they can no longer see (made private,
   * a block, deleted) still loses the save, but answers the random-id 404 and
   * no save count (A-11-015).
   */
  async unsave(
    viewer: string,
    shelfId: string,
  ): Promise<{ saved: false; shelf_id: string; save_count: number }> {
    await this.db
      .delete(shelfSaves)
      .where(and(eq(shelfSaves.shelfId, shelfId), eq(shelfSaves.userId, viewer)));

    const [shelf] = await this.db
      .select({ id: shelves.id, userId: shelves.userId, privacy: shelves.privacy, saveCount: shelves.saveCount })
      .from(shelves)
      .where(and(eq(shelves.id, shelfId), sql`${shelves.deletedAt} IS NULL`))
      .limit(1);

    if (!shelf) {
      throw ApiError.notFound('Shelf not found.');
    }
    const rel = await loadRelationship(this.db, viewer, shelf.userId);
    if (!canViewWith(viewer, shelf.userId, rel, shelf.privacy)) throw ApiError.notFound('Shelf not found.');

    return {
      saved: false,
      shelf_id: shelfId,
      save_count: shelf.saveCount,
    };
  }

  /** The total for a page with no rows to carry it: 0 on the first page, else counted. */
  async #count(fromWhere: SQL, offset: number): Promise<number> {
    if (offset === 0) return 0;
    const [c] = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n ${fromWhere}`);
    return Number(c?.n ?? 0);
  }

  /**
   * The viewer's saved shelves, newest save first, in one statement: owners
   * and covers are joined, not fetched per owner (L-10, A-11-016).
   */
  async getSavedShelves(
    viewer: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ shelves: ShelfDetail[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);

    const fromWhere = sql`
      FROM shelf_saves ss
      JOIN shelves s ON s.id = ss.shelf_id AND s.deleted_at IS NULL
      JOIN profiles p ON p.user_id = s.user_id
      WHERE ss.user_id = ${viewer}::uuid
        -- Blocks, deleted owners, private accounts: canView() in SQL (Audit 05).
        AND ${canViewSql(viewer, { ownerId: sql`s.user_id`, visibility: sql`s.privacy`, ownerIsPrivate: sql`p.is_private` })}`;

    const rows = await this.db.execute<ShelfCardRow>(sql`
      SELECT ${shelfCardColumns(viewer)}, count(*) OVER () AS total
      ${fromWhere}
      ORDER BY ss.created_at DESC, s.id DESC
      LIMIT ${limit} OFFSET ${offset}`);

    const total = rows.length ? Number(rows[0]!.total) : await this.#count(fromWhere, offset);
    return { shelves: rows.map(cardFromRow), total };
  }

  /**
   * Public shelves of public, live accounts, ranked by the PRD §15.5 formula
   * (or by saves / recency), in one statement: candidates, score, sort, page
   * and total are all computed in SQL (L-18, A-11-019).
   */
  async browse(
    viewer: string | null,
    input: BrowseShelvesInput,
  ): Promise<{ shelves: ShelfDetail[]; total: number }> {
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    const offset = Math.max(0, input.offset ?? 0);
    const sort = input.sort ?? 'ranked';
    const query = input.query?.trim();

    // % _ and \ are literal in the search, not wildcards (A-11-018).
    const pattern = query ? `%${query.replace(/[\\%_]/g, '\\$&')}%` : null;

    // PRD §15.5:
    //   0.30·ln(1+saves) + 0.20·ln(1+views) + 0.20·social_proximity
    //   + 0.15·curation_quality + 0.15·freshness
    // views: there is no view counter, so the term is 0 for every shelf
    // (A-11-024, a recorded spec gap).
    // social_proximity: 1.0 for a followed owner, 0.5 for the viewer's own.
    // curation_quality: description +0.25, per-entry notes +0.25, 5–100 books
    // +0.30 (1–4: +0.15, >100: +0.10), a full mosaic +0.20.
    // freshness: 1 / (1 + age_days / 30).
    const score = sql`round((
      0.30 * ln(1 + greatest(s.save_count, 0))
      + 0.20 * 0
      + 0.20 * ${viewer
        ? sql`(CASE WHEN s.user_id = ${viewer}::uuid THEN 0.5
                    WHEN EXISTS (SELECT 1 FROM follows f
                                 WHERE f.follower_id = ${viewer}::uuid AND f.followee_id = s.user_id
                                   AND f.state = 'accepted') THEN 1.0
                    ELSE 0 END)`
        : sql`0`}
      + 0.15 * (
          (CASE WHEN s.description ~ '\\S' THEN 0.25 ELSE 0 END)
        + (CASE WHEN EXISTS (SELECT 1 FROM shelf_items n WHERE n.shelf_id = s.id AND n.note IS NOT NULL)
                THEN 0.25 ELSE 0 END)
        + (CASE WHEN s.item_count BETWEEN 5 AND 100 THEN 0.30
                WHEN s.item_count BETWEEN 1 AND 4 THEN 0.15
                WHEN s.item_count > 100 THEN 0.10
                ELSE 0 END)
        + (CASE WHEN cardinality(s.cover_work_ids) >= least(4, greatest(1, s.item_count)) THEN 0.20 ELSE 0 END))
      + 0.15 * (1.0 / (1 + greatest(0, extract(epoch FROM now() - s.created_at)) / 86400.0 / 30.0))
    )::numeric, 4)`;

    // Every order ends on id, so pages never overlap or skip (A-11-020).
    const orderBy = (t: string) => {
      const c = sql.raw(t);
      return sort === 'popular' ? sql`${c}.save_count DESC, ${c}.created_at DESC, ${c}.id DESC`
        : sort === 'recent' ? sql`${c}.created_at DESC, ${c}.id DESC`
        : sql`${c}.score DESC, ${c}.save_count DESC, ${c}.created_at DESC, ${c}.id DESC`;
    };

    const fromWhere = sql`
      FROM shelves s
      JOIN profiles p ON p.user_id = s.user_id AND p.is_private = false
      -- Deleted accounts are hidden platform-wide (PRD §25.4).
      JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL
      WHERE s.privacy = 'public'
        AND s.deleted_at IS NULL
        ${pattern
          ? sql`AND (s.name ILIKE ${pattern} ESCAPE '\\' OR s.description ILIKE ${pattern} ESCAPE '\\')`
          : sql``}
        ${viewer ? sql`
          -- Blocks either way (PRD §11.4) and the viewer's mutes (A-11-017).
          AND s.user_id NOT IN (
            SELECT b.blocked_id FROM blocks b WHERE b.blocker_id = ${viewer}::uuid
            UNION ALL
            SELECT b.blocker_id FROM blocks b WHERE b.blocked_id = ${viewer}::uuid
            UNION ALL
            SELECT m.target_id FROM mutes m WHERE m.user_id = ${viewer}::uuid AND m.target_type = 'user'
          )` : sql``}`;

    // Rank and page on the bare rows, then build cards for the page only:
    // the window total makes Postgres project every candidate, so the cover
    // and saved lookups must not be in that projection.
    const rows = await this.db.execute<ShelfCardRow>(sql`
      SELECT ${shelfCardColumns(viewer)}, x.total
      FROM (
        SELECT c.* FROM (
          SELECT s.id, s.save_count, s.created_at,
                 ${sort === 'ranked' ? score : sql`0`} AS score,
                 count(*) OVER () AS total
          ${fromWhere}
        ) c
        ORDER BY ${orderBy('c')}
        LIMIT ${limit} OFFSET ${offset}
      ) x
      JOIN shelves s ON s.id = x.id
      JOIN profiles p ON p.user_id = s.user_id
      ORDER BY ${orderBy('x')}`);

    const total = rows.length ? Number(rows[0]!.total) : await this.#count(fromWhere, offset);
    return { shelves: rows.map(cardFromRow), total };
  }

  async getUserShelves(
    viewer: string | null,
    targetUserId: string,
  ): Promise<{ shelves: ShelfDetail[] }> {
    // Missing, deleted, blocked and not-allowed-to-see are one 404 (never 403).
    const rel = await loadRelationship(this.db, viewer, targetUserId);
    if (!canViewWith(viewer, targetUserId, rel)) throw ApiError.notFound('User not found.');

    const owner = await this.getOwnerProfile(targetUserId);

    const rows = await this.db
      .select()
      .from(shelves)
      .where(and(eq(shelves.userId, targetUserId), sql`${shelves.deletedAt} IS NULL`))
      .orderBy(sql`${shelves.createdAt} DESC`);

    const visibleShelves = rows.filter((shelf) => canViewWith(viewer, targetUserId, rel, shelf.privacy));

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

  /**
   * A shelf by its owner's username and its slug, following renames (D-11-2):
   * a username the owner used to have and a slug the shelf used to have
   * still find it, and come back as `moved` with the current pair so the
   * route can redirect. A redirect is only ever issued for a shelf the viewer
   * may see; anything else is the random slug's 404.
   */
  async resolveSlug(
    viewer: string | null,
    username: string,
    slug: string,
  ): Promise<{ shelf: ShelfDetail } | { moved: { username: string; slug: string } }> {
    const trimmedUsername = username.trim().toLowerCase();
    const trimmedSlug = slug.trim().toLowerCase();
    const profileColumns = {
      userId: profiles.userId,
      username: profiles.username,
      displayName: profiles.displayName,
      avatarKey: profiles.avatarKey,
      isPrivate: profiles.isPrivate,
    };

    // 1. The owner: by current username, else by one the account used to have.
    let movedUser = false;
    let [profile] = await this.db
      .select(profileColumns)
      .from(profiles)
      .where(sql`lower(${profiles.username}) = ${trimmedUsername}`)
      .limit(1);
    if (!profile) {
      [profile] = await this.db
        .select(profileColumns)
        .from(usernameClaims)
        .innerJoin(profiles, eq(profiles.userId, usernameClaims.userId))
        .where(eq(usernameClaims.username, trimmedUsername))
        .limit(1);
      movedUser = Boolean(profile);
    }

    if (!profile) {
      throw ApiError.notFound('Shelf not found.');
    }

    // 2. The shelf: by current slug, else by one it used to have.
    let movedSlug = false;
    let [shelf] = await this.db
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
      [shelf] = await this.db
        .select(getTableColumns(shelves))
        .from(shelfSlugs)
        .innerJoin(shelves, eq(shelves.id, shelfSlugs.shelfId))
        .where(
          and(
            eq(shelfSlugs.userId, profile.userId),
            eq(shelfSlugs.slug, trimmedSlug),
            sql`${shelves.deletedAt} IS NULL`,
          ),
        )
        .limit(1);
      movedSlug = Boolean(shelf);
    }

    if (!shelf) {
      throw ApiError.notFound('Shelf not found.');
    }

    // 3–4. Authorization: the same 404 as a missing shelf (the old default
    // message, "Not found.", told a blocked or unapproved viewer it exists).
    const rel = await loadRelationship(this.db, viewer, profile.userId);
    if (!canViewWith(viewer, profile.userId, rel, shelf.privacy)) throw ApiError.notFound('Shelf not found.');

    // Seen, so the current address may be told (D-11-2).
    if (movedUser || movedSlug) return { moved: { username: profile.username, slug: shelf.slug } };

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
      avatarUrl: avatarUrl(profile.avatarKey),
    };

    return { shelf: this.formatShelf(shelf, owner, isSaved, coverIds) };
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

    return row
      ? { ...row, avatarUrl: avatarUrl(row.avatarKey) }
      : {
          id: userId,
          username: 'reader',
          displayName: null,
          avatarKey: null,
          avatarUrl: null,
          isPrivate: false,
        };
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
        description: 'Creates a user-curated shelf with name, description, privacy, and ranked list toggle (SH-02). 409 shelf_limit_reached at 200 live shelves (PRD §15.6).',
        body: createShelfBodySchema,
        response: {
          201: shelfResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
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
        description: 'Returns shelves saved/bookmarked by the authenticated user, newest save first, paged (SH-07). Shelves the viewer can no longer see are left out.',
        querystring: savedShelvesQuerySchema,
        response: {
          200: savedShelvesResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { limit, offset } = (request.query as { limit?: number; offset?: number }) || {};
      const result = await service.getSavedShelves(viewer, { limit, offset });
      return reply.send(result);
    },
  );

  fastify.get(
    '/shelves/deleted',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'List my recently deleted shelves',
        description: 'The viewer\'s shelves deleted in the last 30 days, which can still be restored (PRD §15.6).',
        response: {
          200: deletedShelvesResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      return reply.send(await service.listDeleted(viewer));
    },
  );

  fastify.post(
    '/shelves/:id/restore',
    {
      schema: {
        tags: ['Shelves'],
        summary: 'Restore a deleted shelf',
        description: 'Undoes a delete within 30 days (PRD §15.6). Its feed activity is not restored. 404 for a shelf that is not the viewer\'s, not deleted, or deleted over 30 days ago; 409 at the 200-shelf limit.',
        params: idParamSchema,
        response: {
          200: shelfResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      return reply.send({ shelf: await service.restore(viewer, id) });
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
        description: 'Appends a book to the shelf with an optional note, or inserts it at `position` (the items from there down shift). 409 for a book already on the shelf or a full shelf (1,000 books). Only owner can add items.',
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
        description: 'Updates the note (up to 280 chars) or moves the item to a position; the other items shift so positions stay 1..n. Only owner can update.',
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
        description: 'Sets positions 1..n in the order given. work_ids must list exactly the books on the shelf (409 order_mismatch otherwise; reload and retry). Only the shelf owner can reorder items (SH-05).',
        params: idParamSchema,
        body: reorderShelfBodySchema,
        response: {
          200: reorderShelfResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
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
          301: slugMovedResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { username, slug } = request.params as { username: string; slug: string };
      const found = await service.resolveSlug(request.viewer, username, slug);
      if ('moved' in found) return sendMoved(request, reply, found.moved);
      return reply.send({ shelf: found.shelf });
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
          301: slugMovedResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { username, slug } = request.params as { username: string; slug: string };
      const found = await service.resolveSlug(request.viewer, username, slug);
      if ('moved' in found) return sendMoved(request, reply, found.moved);
      return reply.send({ shelf: found.shelf });
    },
  );
};

/**
 * The 301 for a renamed shelf or owner (D-11-2): the same route with the
 * current username and slug. `no-store`, because a browser that cached
 * `a → b` would loop once the shelf is renamed back to `a`.
 */
function sendMoved(request: { routeOptions: { url?: string } }, reply: any, moved: { username: string; slug: string }) {
  const location = (request.routeOptions.url ?? '')
    .replace(':username', encodeURIComponent(moved.username))
    .replace(':slug', encodeURIComponent(moved.slug));
  return reply.code(301).header('location', location).header('cache-control', 'no-store').send();
}

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
export function renderShelfHtml(shelf: ShelfDetail, baseUrl = config.appBaseUrl): string {
  const canonicalUrl = escapeHtml(`${baseUrl}/u/${encodeURIComponent(shelf.owner.username)}/shelves/${encodeURIComponent(shelf.slug)}`);
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
  <link rel="canonical" href="${canonicalUrl}" />

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
  <meta property="al:ios:url" content="flyleaf://shelf/${escapeHtml(shelf.id)}" />
  <meta property="al:ios:app_name" content="Flyleaf" />
  <meta property="al:android:url" content="flyleaf://shelf/${escapeHtml(shelf.id)}" />
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
    <a href="flyleaf://shelf/${escapeHtml(shelf.id)}" class="app-button">Open in Flyleaf App</a>
    <div class="footer">flyleaf.app — A social reading tracker</div>
  </div>
</body>
</html>`;
}

/**
 * Public Web / Open Graph landing routes for shared shelf URLs.
 */
/** Share pages run no script at all: nothing to allow but their own inline style and cover images. */
const SHARE_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * What a guest may see of a public shelf can be cached briefly by link
 * previewers and CDNs; anything that depended on who asked never is
 * (A-11-022). Five minutes bounds how long a shelf made private stays
 * visible in a shared cache (PRD §34.3).
 */
function shareCacheControl(viewer: string | null, shelf: ShelfDetail): string {
  return viewer === null && shelf.privacy === 'public' ? 'public, max-age=300' : 'private, no-store';
}

export const shelvesWebPlugin: FastifyPluginAsync<{ db: Db }> = async (fastify, opts) => {
  const service = new ShelvesService(opts.db);

  fastify.get<{ Params: { username: string; slug: string } }>(
    '/u/:username/shelves/:slug',
    // Server-rendered share page, not API: kept out of openapi.yaml.
    { schema: { hide: true } },
    async (request, reply) => {
      const { username, slug } = request.params;
      const found = await service.resolveSlug(request.viewer, username, slug);
      if ('moved' in found) return sendMoved(request, reply, found.moved);
      const shelf = found.shelf;
      if (request.headers.accept?.includes('application/json')) {
        return reply.header('cache-control', shareCacheControl(request.viewer, shelf)).send({ shelf });
      }
      return reply
        .type('text/html')
        .header('content-security-policy', SHARE_PAGE_CSP)
        .header('cache-control', shareCacheControl(request.viewer, shelf))
        .send(renderShelfHtml(shelf));
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/shelf/:id',
    { schema: { hide: true } },
    async (request, reply) => {
      const { id } = request.params;
      const shelf = await service.getById(request.viewer, id);
      if (request.headers.accept?.includes('application/json')) {
        return reply.header('cache-control', shareCacheControl(request.viewer, shelf)).send({ shelf });
      }
      return reply
        .type('text/html')
        .header('content-security-policy', SHARE_PAGE_CSP)
        .header('cache-control', shareCacheControl(request.viewer, shelf))
        .send(renderShelfHtml(shelf));
    },
  );
};


