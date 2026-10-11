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
import { eq, and, sql, type SQL } from 'drizzle-orm';
import { activity, profiles, type Activity } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import type { Visibility } from '../authorization/index.js';
import { ApiError, requireViewer } from '../http.js';
import { avatarUrl } from '../uploads/index.js';
import {
  feedQuerySchema,
  feedResponseSchema,
  errorResponseSchema,
} from '../contract/schemas.js';
import { ACTIVITY_WEIGHTS, aggregationKey, memberIds, rankWindow } from './ranking.js';
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
   * Retroactively adjusts an actor's activity when account privacy changes (PRD §16.3, §26.1).
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
      return;
    }
    // Going public again (audit 14, A-14-007): a card returns to its item's
    // own visibility, as canView() already shows the item. Only cards whose
    // item is public widen; a followers-only read stays followers-only.
    await dbOrTx.execute(sql`
      UPDATE activity a SET visibility = 'public'
      WHERE a.actor_id = ${actorId}::uuid AND a.visibility = 'followers' AND (
        (a.object_type = 'read' AND EXISTS (
          SELECT 1 FROM reads r WHERE r.id = a.object_id AND r.visibility = 'public'))
        OR (a.object_type = 'review' AND EXISTS (
          SELECT 1 FROM reviews rv JOIN reads r ON r.id = rv.read_id
          WHERE rv.id = a.object_id AND rv.deleted_at IS NULL AND rv.visibility = 'public' AND r.visibility = 'public'))
        OR (a.object_type = 'shelf_item' AND EXISTS (
          SELECT 1 FROM shelves sh WHERE sh.id = a.object_id AND sh.deleted_at IS NULL AND sh.privacy = 'public'))
        OR a.verb = 'followed')`);
  }

  /**
   * Attach like/comment state to every card that is a social object, in one
   * query for the whole page (SO-21). Cards about a non-terminal read, and
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
   * affinity(viewer, actor) for §12.3 (audit 14, A-14-002), one statement for
   * the page's actors. 0.75 for someone the viewer follows but never engages
   * with (below LOW_AFFINITY: §12.4 rule 3's "someone you engage with
   * rarely"), +0.25 for a mutual follow, +0.1 per like or live comment the
   * viewer gave the actor's reads in the last 90 days (at most 5): 0.75–1.5.
   * Taps are not recorded server-side, so they do not count.
   */
  async affinitiesFor(viewer: string, actorIds: string[]): Promise<Record<string, number>> {
    const ids = [...new Set(actorIds)];
    if (ids.length === 0) return {};
    const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
    const rows = await this.db.execute<{ actor_id: string; engagements: number; mutual: boolean }>(sql`
      WITH actors(id) AS (VALUES ${sql.join(ids.map((id) => sql`(${id}::uuid)`), sql`, `)}),
      engaged AS (
        SELECT r.user_id AS actor_id, count(*)::int AS n
        FROM read_likes l JOIN reads r ON r.id = l.read_id
        WHERE l.user_id = ${viewer}::uuid AND l.created_at > now() - interval '90 days' AND r.user_id IN (${list})
        GROUP BY r.user_id
        UNION ALL
        SELECT r.user_id, count(*)::int
        FROM read_comments c JOIN reads r ON r.id = c.read_id
        WHERE c.user_id = ${viewer}::uuid AND c.deleted_at IS NULL AND c.created_at > now() - interval '90 days'
          AND r.user_id IN (${list})
        GROUP BY r.user_id
      )
      SELECT a.id AS actor_id,
        COALESCE((SELECT sum(e.n)::int FROM engaged e WHERE e.actor_id = a.id), 0) AS engagements,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = a.id AND f.followee_id = ${viewer}::uuid
                AND f.state = 'accepted') AS mutual
      FROM actors a`);
    const out: Record<string, number> = {};
    for (const r of rows) {
      out[r.actor_id] = 0.75 + (r.mutual ? 0.25 : 0) + 0.1 * Math.min(Number(r.engagements), 5);
    }
    return out;
  }

  /**
   * One window of feed rows (audit 14, A-14-001). Rows deferred by the
   * previous page (by id) come back first; then the newest rows after the
   * cursor, cut where the next row would start card `need + 1`, so a page holds
   * whole cards. `windows` (days back from the cursor) bound the first tries,
   * so a busy feed reads one day of index rather than 180 (A-14-008); a try
   * that comes back short widens to the next.
   */
  async #collect(
    filter: SQL,
    cursor: FeedCursor | null,
    need: number,
    windows: readonly number[],
  ): Promise<FeedWindow> {
    const forced = cursor && cursor.d.length > 0
      ? (await this.db.execute<FeedRow>(feedQuery(
          sql`${filter} AND a.id IN (${sql.join(cursor.d.map((id) => sql`${id}::uuid`), sql`, `)})`, null))).map(toFeedItem)
      : [];
    const forcedCards = new Set(forced.map(aggregationKey)).size;
    const cards = Math.max(need - forcedCards, 0);
    if (cards === 0) {
      return { forced, rows: [], next: cursor ? { t: cursor.t, i: cursor.i } : null, more: cursor !== null };
    }

    const fetch = cards * 3 + 1;
    const position = cursor
      ? sql`AND (a.created_at, a.id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)`
      : sql``;
    const base = cursor ? new Date(cursor.t) : new Date();
    let raw: FeedRow[] = [];
    for (const days of [...windows, null]) {
      const since = days === null ? sql`` : sql`AND a.created_at >= ${new Date(base.getTime() - days * DAY_MS).toISOString()}::timestamptz`;
      raw = await this.db.execute<FeedRow>(feedQuery(sql`${filter} ${position} ${since}`, fetch));
      if (raw.length === fetch) break;
    }

    const all = raw.map(toFeedItem);
    const keys = new Set<string>();
    let taken = 0;
    for (const item of all) {
      if (taken === fetch - 1) break;
      const key = aggregationKey(item);
      if (!keys.has(key) && keys.size === cards) break;
      keys.add(key);
      taken++;
    }
    const rows = all.slice(0, taken);
    const last = raw[taken - 1];
    return {
      forced,
      rows,
      next: last ? { t: last.created_at_us, i: last.id } : cursor ? { t: cursor.t, i: cursor.i } : null,
      more: taken < all.length,
    };
  }

  /** Rank a window into a page and work out the next cursor (A-14-001). */
  #finish(
    window: FeedWindow,
    extra: FeedActivityItem[],
    limit: number,
    source: 'f' | 'p',
    affinities?: Record<string, number>,
  ): { items: FeedActivityItem[]; next_cursor: string | null; has_more: boolean } {
    const forcedIds = new Set<string>(window.forced.map((i) => i.id));
    const ranked = rankWindow([...window.forced, ...window.rows, ...extra], limit, {
      now: new Date(),
      affinities,
      forcedIds,
    });
    const extraIds = new Set(extra.map((i) => i.id));
    // Blended cards are not part of this stream: one that does not fit is dropped, not deferred.
    const deferredCards = ranked.deferred.filter((card) => !memberIds(card).some((id) => extraIds.has(id)));
    const items = [...ranked.items];
    const deferred: string[] = [];
    for (const card of deferredCards) {
      const ids = memberIds(card);
      // A cursor stays small: past the cap, a card is shown now, out of order, rather than carried.
      if (deferred.length + ids.length > MAX_DEFERRED_IDS) items.push(card);
      else deferred.push(...ids);
    }
    const hasMore = window.more || deferred.length > 0;
    return {
      items,
      has_more: hasMore,
      next_cursor: hasMore && window.next ? encodeFeedCursor({ ...window.next, d: deferred, s: source }) : null,
    };
  }

  /**
   * SO-11 & SO-14: Cursor-paginated Friends Feed query with Cold Start handling.
   *  - 0 follows: auto-switches to Popular feed (PRD §12.5).
   *  - 1–3 follows: Friends feed blended with Popular content on page one (PRD §12.5).
   *  - >3 follows with no activity in 180 days: Popular, labelled "While you wait", so the feed is NEVER EMPTY.
   *  - Strictly excludes blocked accounts (bidirectional) and muted accounts/books.
   * Pages rank one chronological window each and every activity is served
   * exactly once (audit 14, A-14-001); the cursor is opaque.
   */
  async getFriendsFeed(
    viewer: string,
    opts: GetFeedOptions = {},
  ): Promise<FeedResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const cursor = decodeFeedCursor(opts.cursor);

    // 1. Accepted follows of live accounts, counted live (not the profile counter).
    const [followCountRow] = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM follows f
      JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
      WHERE f.follower_id = ${viewer}::uuid AND f.state = 'accepted'
    `);
    const followingCount = followCountRow?.count ?? 0;

    // 2. Scenario 1: 0 Follows -> Auto-switch to Popular Feed (PRD §12.5)
    if (followingCount === 0) {
      const popularFeed = await this.getPopularFeed(viewer, { ...opts, limit });
      return {
        ...popularFeed,
        tab: 'popular',
        is_cold_start: true,
        following_count: 0,
        cold_start_reason: 'no_follows',
      };
    }

    // A "While you wait" stream continues as popular until it ends.
    if (cursor?.s === 'p') {
      return this.#whileYouWait(viewer, opts.cursor ?? null, limit, followingCount);
    }

    const first = cursor === null;
    const sparse = followingCount <= 3;
    // Page one of a sparse feed keeps a quarter of its slots for Popular.
    const friendCards = sparse && first ? limit - Math.ceil(limit / 4) : limit;
    const window = await this.#collect(friendsFilter(viewer), cursor, friendCards + slackFor(limit),
      followingCount >= NARROW_WINDOWS_FROM ? FRIENDS_WINDOWS_DAYS : []);

    // 5. Scenario 3: follows but nothing from them in 180 days -> Popular (Never Empty, PRD §12.5)
    if (first && !sparse && window.rows.length === 0) {
      return this.#whileYouWait(viewer, null, limit, followingCount);
    }

    // 4. Scenario 2: 1–3 Follows -> Blend with Popular content (PRD §12.5), page one only,
    // from people the viewer does not follow, so nothing appears twice.
    let blended: FeedActivityItem[] = [];
    if (sparse && first) {
      const used = Math.min(new Set(window.rows.map(aggregationKey)).size, friendCards);
      const popular = await this.#popularPage(viewer, null, limit - used, { excludeFollowed: true });
      blended = popular.items.map((item) => ({
        ...item,
        metadata: { ...item.metadata, is_blended_popular: true, label: 'Popular on Flyleaf' },
      }));
    }

    const actors = [...window.forced, ...window.rows].map((i) => i.actor_id);
    const page = this.#finish(window, blended, limit, 'f', await this.affinitiesFor(viewer, actors));

    const isColdStart = sparse;
    if (page.items.length === 0 && first) {
      return {
        items: [editorialCard('Welcome to Flyleaf!', 'Start logging books, writing reviews, and following readers to build your feed.')],
        next_cursor: null,
        has_more: false,
        tab: 'friends',
        is_cold_start: true,
        following_count: followingCount,
        cold_start_reason: sparse ? 'sparse_follows' : 'no_activity',
      };
    }

    await this.#countExposures(page.items.filter((i) => i.metadata?.is_blended_popular));
    return {
      items: await this.#withInteractions(viewer, page.items),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
      tab: 'friends',
      is_cold_start: isColdStart,
      following_count: followingCount,
      cold_start_reason: sparse ? 'sparse_follows' : null,
    };
  }

  /** Follows with nothing to show: Popular, labelled "While you wait" (PRD §12.5). */
  async #whileYouWait(viewer: string, cursor: string | null, limit: number, followingCount: number): Promise<FeedResponse> {
    const popular = await this.getPopularFeed(viewer, { cursor, limit });
    return {
      ...popular,
      items: popular.items.map((item) => item.metadata?.is_editorial ? item : ({
        ...item,
        metadata: { ...item.metadata, is_blended_popular: true, label: 'While you wait' },
      })),
      tab: 'friends',
      is_cold_start: true,
      following_count: followingCount,
      cold_start_reason: 'no_activity',
    };
  }

  /**
   * SO-11, D-14-1: the Popular feed. Public reviews and finishes from the
   * last 14 days, ranked by engagement (PRD §12.1 "highly-engaged reviews"):
   * weight (§12.2) × recency (72 h half-life) × (1 + ln(1 + likes + 2 ×
   * comments)) on the card's read, never by rating (§12.6 "negative ratings
   * are never amplified"), with a per-card exposure ceiling (§12.6). Blocks
   * and mutes apply for a signed-in viewer; private accounts never appear
   * (their activity is never public).
   */
  async getPopularFeed(
    viewer?: string | null,
    opts: GetFeedOptions = {},
  ): Promise<FeedResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const cursor = decodeFeedCursor(opts.cursor);
    if (cursor && cursor.s !== 'p') throw ApiError.badRequest('invalid_cursor', 'Cursor is not valid.', 'cursor');
    const page = await this.#popularPage(viewer ?? null, cursor, limit, {});

    // Guarantee Never Empty Feed fallback to editorial welcome item (PRD §12.5), on page one only.
    if (page.items.length === 0 && cursor === null) {
      return {
        items: [editorialCard('Welcome to Flyleaf Popular Feed!', 'Explore books, discover popular reviews, and connect with fellow readers.')],
        next_cursor: null,
        has_more: false,
        tab: 'popular',
      };
    }

    await this.#countExposures(page.items);
    return {
      items: await this.#withInteractions(viewer ?? null, page.items),
      next_cursor: page.next ? encodeFeedCursor(page.next) : null,
      has_more: page.next !== null,
      tab: 'popular',
    };
  }

  /**
   * One page of Popular (D-14-1). Keyset-paged on (score, created_at, id).
   * The score is computed "as of" the first page's instant, carried in the
   * cursor (`n`): only cards and likes/comments from before it count, so a
   * later like cannot move an unserved card above the cursor (nothing is
   * skipped). An unlike or a deleted comment can only lower a score; a card
   * already served may then come round again, which the app de-duplicates.
   * Diversity (§12.4) is a deterministic penalty, so it pages with the score:
   * an author's third and later cards, and a book's fourth and later, halve
   * per step.
   */
  async #popularPage(
    viewer: string | null,
    cursor: FeedCursor | null,
    limit: number,
    opts: { excludeFollowed?: boolean },
  ): Promise<{ items: FeedActivityItem[]; next: FeedCursor | null }> {
    if (limit <= 0) return { items: [], next: null };
    const asOf = cursor?.n ?? new Date().toISOString();
    const after = cursor
      ? sql`WHERE (score, created_at, id) < (${cursor.v}::numeric, ${cursor.t}::timestamptz, ${cursor.i}::uuid)`
      : sql``;
    const ranked = await this.db.execute<{ id: string; score: string; created_at_us: string }>(sql`
      WITH cand AS (
        SELECT a.id, a.actor_id, a.work_id, a.verb, a.created_at,
          (a.verb = 'finished' AND a.metadata ? 'rating' AND a.metadata->'rating' <> 'null'::jsonb) AS rated,
          CASE WHEN a.object_type = 'read' THEN a.object_id
               WHEN a.object_type = 'review' AND a.metadata->>'readId' ~* ${UUID_RE.source}
                 THEN (a.metadata->>'readId')::uuid END AS read_id
        FROM activity a
        JOIN users au ON au.id = a.actor_id AND au.deleted_at IS NULL
        LEFT JOIN popular_exposures e ON e.activity_id = a.id
        WHERE a.visibility = 'public' AND a.verb IN ('reviewed', 'finished')
          AND a.created_at <= ${asOf}::timestamptz
          AND a.created_at > ${asOf}::timestamptz - make_interval(days => ${POPULAR_WINDOW_DAYS})
          AND COALESCE(e.served, 0) < ${POPULAR_EXPOSURE_CAP}
          ${viewer ? sql`AND ${notBlockedOrMuted(viewer)}` : sql``}
          ${viewer && opts.excludeFollowed ? sql`
          AND a.actor_id <> ${viewer}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM follows fx
            WHERE fx.follower_id = ${viewer}::uuid AND fx.followee_id = a.actor_id AND fx.state = 'accepted')` : sql``}
      ),
      scored AS (
        SELECT c.id, c.actor_id, c.work_id, c.created_at,
          (CASE WHEN c.verb = 'reviewed' THEN ${ACTIVITY_WEIGHTS.reviewed}::float8
                WHEN c.rated THEN ${ACTIVITY_WEIGHTS.finished}::float8 ELSE 0.7::float8 END)
          * power(0.5::float8, (extract(epoch FROM (${asOf}::timestamptz - c.created_at)) / ${POPULAR_HALF_LIFE_HOURS * 3600})::float8)
          * (1 + ln(1 + COALESCE(lk.n, 0) + 2 * COALESCE(cm.n, 0))::float8) AS base
        FROM cand c
        LEFT JOIN LATERAL (
          SELECT count(*) AS n FROM read_likes l
          WHERE l.read_id = c.read_id AND l.created_at <= ${asOf}::timestamptz) lk ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS n FROM read_comments rc
          WHERE rc.read_id = c.read_id AND rc.created_at <= ${asOf}::timestamptz AND rc.deleted_at IS NULL) cm ON true
      ),
      ranked AS (
        SELECT s.id, s.created_at,
          round((s.base
            * power(0.5::float8, greatest(row_number() OVER (PARTITION BY s.actor_id ORDER BY s.base DESC, s.created_at DESC, s.id DESC) - 2, 0))
            * power(0.5::float8, greatest(row_number() OVER (PARTITION BY s.work_id ORDER BY s.base DESC, s.created_at DESC, s.id DESC) - 3, 0))
          )::numeric, 12) AS score
        FROM scored s
      )
      SELECT id, score::text AS score,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us
      FROM ranked
      ${after}
      ORDER BY score DESC, created_at DESC, id DESC
      LIMIT ${limit + 1}`);

    const page = ranked.slice(0, limit);
    if (page.length === 0) return { items: [], next: null };
    const rows = await this.db.execute<FeedRow>(feedQuery(
      sql`a.id IN (${sql.join(page.map((r) => sql`${r.id}::uuid`), sql`, `)})`, null));
    const byId = new Map(rows.map((r) => [r.id, toFeedItem(r)]));
    const items = page.map((r) => byId.get(r.id)).filter((i): i is FeedActivityItem => i !== undefined);
    const last = page[page.length - 1]!;
    return {
      items,
      next: ranked.length > limit ? { t: last.created_at_us, i: last.id, d: [], s: 'p', n: asOf, v: last.score } : null,
    };
  }

  /** §12.6 exposure ceiling (D-14-1): one statement per page served. */
  async #countExposures(items: FeedActivityItem[]): Promise<void> {
    const ids = items.map((i) => i.id).filter((id) => id !== NIL_UUID);
    if (ids.length === 0) return;
    await this.db.execute(sql`
      INSERT INTO popular_exposures (activity_id, served)
      SELECT id, 1 FROM unnest(${sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`}) AS t(id)
      WHERE EXISTS (SELECT 1 FROM activity WHERE activity.id = t.id)
      ON CONFLICT (activity_id) DO UPDATE SET served = popular_exposures.served + 1`);
  }
}

/** D-14-1 (owner, 2026-10-10): Popular is reviews and finishes from this many days. */
export const POPULAR_WINDOW_DAYS = 14;
/** D-14-1: Popular's recency half-life. */
const POPULAR_HALF_LIFE_HOURS = 72;
/**
 * §12.6 "Popular is capped by a per-item exposure ceiling": a card leaves
 * Popular after this many pages have shown it. The PRD gives no number;
 * D-15-3 in DECISIONS.md records this one (reversible, a constant).
 */
export const POPULAR_EXPOSURE_CAP = 1_000;

const DAY_MS = 86_400_000;
/** §23.5: activity is kept 180 days and "the feed never looks back further". */
export const FEED_HORIZON_DAYS = 180;
/**
 * Days back from the cursor tried before the whole horizon (A-14-008), for a
 * viewer following at least NARROW_WINDOWS_FROM people: their followees post
 * a page's worth in a day, and the whole horizon is a scan and a sort of
 * everything those people did in 180 days. Below that, one query over the
 * horizon is cheaper than a short try and a retry (each is ~8 ms of planning).
 */
const FRIENDS_WINDOWS_DAYS = [1, 7, 30] as const;
const NARROW_WINDOWS_FROM = 200;
/**
 * A page ranks a window a quarter larger than itself, so a card that breaks a
 * rule leaves room for one that does not; the cards that do not make the page
 * are deferred to the next (A-14-001).
 */
const slackFor = (limit: number) => Math.ceil(limit / 4);
/** Ids a cursor may carry for deferred cards (A-14-001). */
const MAX_DEFERRED_IDS = 60;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The feed cursor (audit 14, A-14-001): the last row the page consumed, at
 * microsecond precision, its id (created_at is not unique), the ids of cards
 * the page deferred, and which stream it belongs to ('p': a friends feed
 * showing Popular). Opaque to clients: base64url JSON.
 */
export interface FeedCursor {
  t: string;
  i: string;
  d: string[];
  s: 'f' | 'p';
  /** Popular (D-14-1): the instant the paging session scores "as of". */
  n?: string;
  /** Popular (D-14-1): the last served card's score, the keyset's first column. */
  v?: string;
}

export function encodeFeedCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeFeedCursor(raw: string | null | undefined): FeedCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<FeedCursor>;
    if (typeof c.t !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(c.t)
      || Number.isNaN(Date.parse(c.t))) throw new Error('t');
    if (typeof c.i !== 'string' || !UUID_RE.test(c.i)) throw new Error('i');
    const d = c.d ?? [];
    if (!Array.isArray(d) || d.length > MAX_DEFERRED_IDS || !d.every((id) => typeof id === 'string' && UUID_RE.test(id))) throw new Error('d');
    if (c.s !== 'f' && c.s !== 'p') throw new Error('s');
    if (c.s === 'p') {
      // Popular is keyset-paged on its score as of `n` (D-14-1).
      if (typeof c.n !== 'string' || Number.isNaN(Date.parse(c.n)) || !/^\d{4}-\d{2}-\d{2}T/.test(c.n)) throw new Error('n');
      if (typeof c.v !== 'string' || !/^\d{1,6}(\.\d{1,12})?$/.test(c.v)) throw new Error('v');
      return { t: c.t, i: c.i, d: [], s: 'p', n: c.n, v: c.v };
    }
    return { t: c.t, i: c.i, d, s: c.s };
  } catch {
    throw ApiError.badRequest('invalid_cursor', 'Cursor is not valid.', 'cursor');
  }
}

/** What #collect read: the deferred cards, the new rows, where the next page starts, and whether there is more. */
interface FeedWindow {
  forced: FeedActivityItem[];
  rows: FeedActivityItem[];
  next: { t: string; i: string } | null;
  more: boolean;
}

interface FeedRow extends Record<string, unknown> {
  id: string;
  actor_id: string;
  verb: string;
  work_id: string | null;
  object_type: string | null;
  object_id: string | null;
  metadata: any;
  visibility: string;
  created_at: string | Date;
  created_at_us: string;
  actor_username: string;
  actor_display_name: string | null;
  actor_avatar_key: string | null;
  work_title: string | null;
  work_cover_id: number | null;
  author_name: string | null;
  target_username: string | null;
  target_display_name: string | null;
}

/**
 * One statement shape for every feed read. The inner query filters, orders
 * and limits on `activity` (and the author's account) alone; the display
 * joins then run for the page's rows only, not for every candidate (A-14-008:
 * joining first cost a typical viewer 1,937 rows of joins for 76).
 */
function feedQuery(where: SQL, limit: number | null): SQL {
  return sql`
    SELECT
      a.id, a.actor_id, a.verb, a.work_id, a.object_type, a.object_id, a.metadata, a.visibility, a.created_at,
      to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us,
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
      ) AS author_name,
      tp.username AS target_username,
      tp.display_name AS target_display_name
    FROM (
      SELECT a.*
      FROM activity a
      -- Deleted accounts are hidden platform-wide (PRD §25.4, Audit 05).
      JOIN users au ON au.id = a.actor_id AND au.deleted_at IS NULL
      WHERE ${where}
      ORDER BY a.created_at DESC, a.id DESC
      ${limit === null ? sql`` : sql`LIMIT ${limit}`}
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC`;
}

/**
 * A "followed" card names its target, so the target must be someone the
 * viewer may see: live, and in no block with the viewer, nor muted by them
 * (audit 14, A-14-004).
 */
function followedTargetVisible(viewer: string | null): SQL {
  return sql`(a.verb <> 'followed' OR a.object_id IS NULL OR (
    EXISTS (SELECT 1 FROM users tu WHERE tu.id = a.object_id AND tu.deleted_at IS NULL)
    ${viewer ? sql`
    AND NOT EXISTS (
      SELECT 1 FROM blocks tb
      WHERE (tb.blocker_id = ${viewer}::uuid AND tb.blocked_id = a.object_id)
         OR (tb.blocker_id = a.object_id AND tb.blocked_id = ${viewer}::uuid))
    AND NOT EXISTS (
      SELECT 1 FROM mutes tm
      WHERE tm.user_id = ${viewer}::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id)` : sql``}))`;
}

/** Blocks either way, muted readers and muted books (SO-11). */
function notBlockedOrMuted(viewer: string): SQL {
  return sql`NOT EXISTS (
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
    )`;
}

/** Fan-out on read (PRD §12.7): accepted follows only, public and followers activity. */
function friendsFilter(viewer: string): SQL {
  return sql`EXISTS (
      SELECT 1 FROM follows f
      WHERE f.followee_id = a.actor_id AND f.follower_id = ${viewer}::uuid AND f.state = 'accepted')
    AND a.visibility IN ('public', 'followers')
    AND a.created_at > now() - make_interval(days => ${FEED_HORIZON_DAYS})
    AND ${notBlockedOrMuted(viewer)}
    AND ${followedTargetVisible(viewer)}`;
}


function toFeedItem(r: FeedRow): FeedActivityItem {
  const metadata = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
  if (r.verb === 'followed' && r.target_username) {
    metadata.target_username = r.target_username;
    metadata.target_display_name = r.target_display_name;
  }
  return {
    id: r.id,
    actor_id: r.actor_id,
    actor: {
      id: r.actor_id,
      username: r.actor_username ?? 'reader',
      display_name: r.actor_display_name,
      avatar_url: avatarUrl(r.actor_avatar_key),
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
    metadata,
    visibility: r.visibility as Visibility,
    created_at: new Date(r.created_at).toISOString(),
  };
}

/** The never-empty fallback (PRD §12.5): no actor, no link, no interaction. */
function editorialCard(title: string, description: string): FeedActivityItem {
  return {
    id: NIL_UUID,
    actor_id: NIL_UUID,
    actor: { id: NIL_UUID, username: 'flyleaf', display_name: 'Flyleaf', avatar_url: null },
    verb: 'goal_reached',
    work_id: null,
    work: null,
    object_type: 'system',
    object_id: null,
    metadata: { title, description, is_editorial: true },
    visibility: 'public',
    created_at: new Date().toISOString(),
    interaction: null,
  };
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
