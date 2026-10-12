// Notifications (SO-30 to SO-33; PRD §19, §6.14, §24.2; architecture §3.6, §9).
//
// Governing rule (PRD §19.1): notify about people, never about behaviour.
// Nothing here is ever sent about the recipient's own reading.
//
// The shape:
//   - A domain write (follow, like, comment, import finished) calls the
//     Notifier INSIDE its own transaction. The Notifier decides whether the
//     recipient wants it at all, writes or extends the in-app row, and, if a
//     push is wanted, enqueues `notify.send` in the same transaction
//     (pg-boss, sendInTx): the push is never sent in the request path, and a
//     rolled-back write leaves neither a row nor a job.
//   - The worker (notify/delivery.ts) applies the frequency rules (quiet
//     hours, the 5-a-day cap, aggregation, the per-thread hour) and sends.
//   - Who and what a notification may show is decided at READ time, by one
//     query (`viewSql`), for the list and for the push alike: a block either
//     way, a mute, a deleted account, deleted content, or an actor who could no
//     longer see the read (a private account they do not follow) removes the
//     actor or the row. So a block made after the like still hides it, and
//     the push composed an hour later agrees with the list.

import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import type { Db } from '../platform/index.js';
import { ApiError, requireViewer } from '../http.js';
import { avatarUrl } from '../uploads/index.js';
import { canViewWith, loadRelationship } from '../authorization/index.js';
import { errorResponseSchema } from '../contract/schemas.js';
import {
  AGGREGATION_WINDOW_MS,
  NOTIFICATION_CATEGORIES,
  channelsFor,
  formatTime,
  isCategoryKey,
  parseTime,
  resolvePreferences,
  type NotificationType,
  type ResolvedPreferences,
  type StoredPreferences,
} from './preferences.js';

export * from './preferences.js';

// ---------------------------------------------------------------------------
// The queue: how a push gets from a request to the worker.
// ---------------------------------------------------------------------------

export const NOTIFY_QUEUES = {
  /** One notification's push: frequency rules, then delivery (notify/delivery.ts). */
  send: 'notify.send',
  /** Every 5 minutes: reading reminders that are due (PRD §19.2 item 14). */
  reminders: 'notify.reminders',
  /** Every 15 minutes: Expo delivery receipts; dead tokens deleted (PV-05 → SO-30). */
  receipts: 'notify.receipts',
} as const;

export interface NotifySendJob {
  notificationId: string;
  /**
   * 'single': this actor's own push (a follow, while under 3 an hour).
   * 'digest': everyone added since the last push ("Ana and 4 others").
   * Absent: the type's default (likes digest; the rest single).
   */
  mode?: 'single' | 'digest';
  actorId?: string;
}

export interface NotifyQueue {
  /** `db` is the caller's transaction when there is one: the job commits with it. */
  enqueue(db: Db, job: NotifySendJob, startAfter?: Date): Promise<void>;
}

/** No push at all: tools and tests that only care about the in-app rows. */
export const NO_PUSH_QUEUE: NotifyQueue = { enqueue: async () => {} };

/** Records what would have been enqueued (tests). */
export class MemoryNotifyQueue implements NotifyQueue {
  readonly jobs: { job: NotifySendJob; startAfter?: Date }[] = [];
  async enqueue(_db: Db, job: NotifySendJob, startAfter?: Date): Promise<void> {
    this.jobs.push({ job, startAfter });
  }
}

/** pg-boss, in the caller's transaction (architecture §9: jobs commit with their data). */
export function bossNotifyQueue(boss: PgBoss): NotifyQueue {
  return {
    async enqueue(db, job, startAfter) {
      await boss.send(NOTIFY_QUEUES.send, job, {
        db: fromDrizzle(db as never, sql as never),
        ...(startAfter ? { startAfter } : {}),
        // A push that cannot be delivered within a day is not worth sending.
        expireInSeconds: 60 * 60,
        retentionSeconds: 24 * 60 * 60,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Preferences, as stored.
// ---------------------------------------------------------------------------

export async function loadPreferences(db: Db, userId: string): Promise<ResolvedPreferences> {
  const [row] = await db.execute<{
    push_enabled: boolean;
    categories: unknown;
    quiet_enabled: boolean;
    quiet_start: number;
    quiet_end: number;
    timezone: string;
    reminder_time: number | null;
  }>(sql`
    SELECT push_enabled, categories, quiet_enabled, quiet_start, quiet_end, timezone, reminder_time
    FROM notification_preferences WHERE user_id = ${userId}::uuid`);
  return resolvePreferences(row ? storedFrom(row) : null);
}

function storedFrom(row: {
  push_enabled: boolean;
  categories: unknown;
  quiet_enabled: boolean;
  quiet_start: number;
  quiet_end: number;
  timezone: string;
  reminder_time: number | null;
}): StoredPreferences {
  return {
    pushEnabled: row.push_enabled,
    categories: typeof row.categories === 'string' ? JSON.parse(row.categories) : row.categories,
    quietEnabled: row.quiet_enabled,
    quietStart: Number(row.quiet_start),
    quietEnd: Number(row.quiet_end),
    timezone: row.timezone,
    reminderTime: row.reminder_time === null ? null : Number(row.reminder_time),
  };
}

/** True when Postgres knows the zone: the reminder query runs `AT TIME ZONE` on it. */
export async function isKnownTimezone(db: Db, tz: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  const [row] = await db.execute<{ ok: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${tz}) AS ok`);
  return Boolean(row?.ok);
}

// ---------------------------------------------------------------------------
// The Notifier: what domain writes call, inside their transaction.
// ---------------------------------------------------------------------------

interface Emit {
  type: NotificationType;
  recipientId: string;
  actorId: string | null;
  objectType: 'user' | 'read' | 'comment' | 'import';
  objectId: string;
  /** Aggregating types: the open group this joins. */
  groupKey?: string;
  data?: Record<string, unknown>;
}

export class Notifier {
  constructor(private readonly queue: NotifyQueue = NO_PUSH_QUEUE) {}

  /** A follow that took effect (`accepted`) or a request to a private account (`pending`). */
  async follow(t: Db, actorId: string, recipientId: string, state: 'accepted' | 'pending'): Promise<void> {
    if (state === 'pending') {
      // One request row per requester: a re-request replaces the old one.
      await this.#removeActor(t, recipientId, actorId, sql`n.type = 'follow_request'`);
      await this.#emit(t, { type: 'follow_request', recipientId, actorId, objectType: 'user', objectId: actorId });
      return;
    }
    await this.#emit(t, { type: 'follow', recipientId, actorId, objectType: 'user', objectId: recipientId, groupKey: 'follow' });
  }

  /** Unfollow or a cancelled request: the actor leaves the follow group and any request row. */
  async unfollow(t: Db, actorId: string, recipientId: string): Promise<void> {
    await this.#removeActor(t, recipientId, actorId, sql`n.type IN ('follow', 'follow_request')`);
  }

  /** The recipient accepted or rejected the request: its row is done. */
  async requestResolved(t: Db, requesterId: string, recipientId: string): Promise<void> {
    await this.#removeActor(t, recipientId, requesterId, sql`n.type = 'follow_request'`);
  }

  async like(t: Db, actorId: string, readId: string): Promise<void> {
    const owner = await this.#readOwner(t, readId);
    if (!owner) return;
    await this.#emit(t, { type: 'like', recipientId: owner, actorId, objectType: 'read', objectId: readId, groupKey: `like:${readId}` });
  }

  async unlike(t: Db, actorId: string, readId: string): Promise<void> {
    const owner = await this.#readOwner(t, readId);
    if (!owner) return;
    await this.#removeActor(t, owner, actorId, sql`n.type = 'like' AND n.object_id = ${readId}::uuid`);
  }

  async comment(t: Db, actorId: string, readId: string, commentId: string): Promise<void> {
    const owner = await this.#readOwner(t, readId);
    if (!owner) return;
    await this.#emit(t, {
      type: 'comment', recipientId: owner, actorId, objectType: 'comment', objectId: commentId, data: { readId },
    });
  }

  /** PRD §19.5: a notification for deleted content is removed from the list. */
  async commentDeleted(t: Db, commentId: string): Promise<void> {
    await t.execute(sql`DELETE FROM notifications WHERE object_type = 'comment' AND object_id = ${commentId}::uuid`);
  }

  /** PRD §19.2 item 7: once (a unique index holds that across job retries). */
  async importCompleted(t: Db, userId: string, importId: string): Promise<void> {
    await this.#emit(t, { type: 'import_complete', recipientId: userId, actorId: null, objectType: 'import', objectId: importId });
  }

  async #readOwner(t: Db, readId: string): Promise<string | null> {
    const [row] = await t.execute<{ user_id: string }>(sql`SELECT user_id FROM reads WHERE id = ${readId}::uuid`);
    return row?.user_id ?? null;
  }

  async #emit(t: Db, e: Emit): Promise<void> {
    // PRD §19.1 / AC-19: never about your own behaviour.
    if (e.actorId !== null && e.actorId === e.recipientId) return;

    if (e.actorId !== null) {
      // Blocks either way, a deleted recipient, a mute, and an actor who
      // cannot see the read (a private account, a followers-only read): no
      // notification. The same rules run again at read time (viewSql).
      const rel = await loadRelationship(t, e.actorId, e.recipientId);
      if (!rel.ownerExists || rel.isBlocked) return;
      const [m] = await t.execute<{ muted: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM mutes WHERE user_id = ${e.recipientId}::uuid
          AND target_type = 'user' AND target_id = ${e.actorId}::uuid) AS muted`);
      if (m?.muted) return;
      if (e.type === 'like' || e.type === 'comment') {
        const readId = e.type === 'like' ? e.objectId : String(e.data?.readId);
        const [r] = await t.execute<{ visibility: string; status: string }>(sql`
          SELECT visibility, status FROM reads WHERE id = ${readId}::uuid`);
        if (!r || !canViewWith(e.actorId, e.recipientId, rel, r.visibility)) return;
      }
    } else {
      const [u] = await t.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM users WHERE id = ${e.recipientId}::uuid AND deleted_at IS NULL) AS ok`);
      if (!u?.ok) return;
    }

    const prefs = await loadPreferences(t, e.recipientId);
    const channels = channelsFor(prefs, e.type);
    if (!channels.inApp && !channels.push) return;

    const data = JSON.stringify(e.data ?? {});
    let row: { id: string; push_state: string } | undefined;
    if (e.groupKey) {
      [row] = await t.execute<{ id: string; push_state: string }>(sql`
        INSERT INTO notifications (user_id, type, object_type, object_id, group_key, data, in_app)
        VALUES (${e.recipientId}::uuid, ${e.type}, ${e.objectType}, ${e.objectId}::uuid, ${e.groupKey}, ${data}::jsonb, ${channels.inApp})
        ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
        DO UPDATE SET updated_at = now(), in_app = EXCLUDED.in_app
        RETURNING id, push_state`);
    } else if (e.type === 'import_complete') {
      [row] = await t.execute<{ id: string; push_state: string }>(sql`
        INSERT INTO notifications (user_id, type, object_type, object_id, data, in_app)
        VALUES (${e.recipientId}::uuid, ${e.type}, ${e.objectType}, ${e.objectId}::uuid, ${data}::jsonb, ${channels.inApp})
        ON CONFLICT (object_id) WHERE type = 'import_complete' DO NOTHING
        RETURNING id, push_state`);
      if (!row) return; // already sent once
    } else {
      [row] = await t.execute<{ id: string; push_state: string }>(sql`
        INSERT INTO notifications (user_id, type, object_type, object_id, data, in_app)
        VALUES (${e.recipientId}::uuid, ${e.type}, ${e.objectType}, ${e.objectId}::uuid, ${data}::jsonb, ${channels.inApp})
        RETURNING id, push_state`);
    }
    if (!row) return;

    if (e.actorId !== null) {
      await t.execute(sql`
        INSERT INTO notification_actors (notification_id, actor_id) VALUES (${row.id}::uuid, ${e.actorId}::uuid)
        ON CONFLICT (notification_id, actor_id) DO NOTHING`);
    }

    if (!channels.push) return;
    if (e.type === 'like') {
      // PRD §19.3: likes aggregate over an hour. The first like of a quiet
      // group queues one digest an hour out; likes inside that hour join it.
      const [queued] = await t.execute<{ id: string }>(sql`
        UPDATE notifications SET push_state = 'queued'
        WHERE id = ${row.id}::uuid AND push_state <> 'queued' RETURNING id`);
      if (queued) {
        await this.queue.enqueue(t, { notificationId: row.id, mode: 'digest' }, new Date(Date.now() + AGGREGATION_WINDOW_MS));
      }
      return;
    }
    await t.execute(sql`UPDATE notifications SET push_state = 'queued' WHERE id = ${row.id}::uuid AND push_state <> 'queued'`);
    await this.queue.enqueue(t, {
      notificationId: row.id,
      mode: 'single',
      ...(e.actorId ? { actorId: e.actorId } : {}),
    });
  }

  /** Takes an actor out of the recipient's matching rows; a row left with nobody goes. */
  async #removeActor(t: Db, recipientId: string, actorId: string, match: SQL): Promise<void> {
    const rows = await t.execute<{ id: string }>(sql`
      DELETE FROM notification_actors na USING notifications n
      WHERE na.notification_id = n.id AND n.user_id = ${recipientId}::uuid
        AND na.actor_id = ${actorId}::uuid AND ${match}
      RETURNING n.id`);
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    await t.execute(sql`
      DELETE FROM notifications n
      WHERE n.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        AND NOT EXISTS (SELECT 1 FROM notification_actors na WHERE na.notification_id = n.id)`);
  }
}

// ---------------------------------------------------------------------------
// The view: what a notification may show, decided now.
// ---------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  userId: string;
  type: NotificationType;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** updated_at as Postgres text, microseconds kept (the cursor; A-14-020). */
  cursorAt: string;
  pushedAt: Date | null;
  pushState: string;
  digestAt: Date | null;
  actorCount: number;
  actor: { id: string; username: string; displayName: string | null; avatarKey: string | null } | null;
  /** Actors not yet named in a push, newest first, and the newest of them. */
  newCount: number;
  newActorIds: string[];
  newActor: { id: string; username: string; displayName: string | null } | null;
  /** The job's actor is still visible in the row. */
  focusVisible: boolean;
  readId: string | null;
  workId: string | null;
  workTitle: string | null;
  reviewId: string | null;
  commentId: string | null;
  importId: string | null;
  importMatched: number | null;
  importUnmatched: number | null;
  importSource: string | null;
}

type ViewRow = {
  id: string; user_id: string; type: NotificationType; read_at: string | Date | null; created_at: string | Date;
  updated_at: string | Date; cursor_at: string; pushed_at: string | Date | null; push_state: string; digest_at: string | Date | null;
  actor_count: number | null; actor_id: string | null; new_count: number | null; new_actor_id: string | null;
  new_actor_ids: string[] | string | null;
  focus_visible: boolean | null;
  actor_username: string | null; actor_display_name: string | null; actor_avatar_key: string | null;
  new_actor_username: string | null; new_actor_display_name: string | null;
  read_id: string | null; work_id: string | null; work_title: string | null; review_id: string | null;
  comment_id: string | null; import_id: string | null; import_matched: number | null; import_unmatched: number | null;
  import_source: string | null;
};

/** A uuid[] as either driver returns it: an array, or Postgres's '{a,b}' text. */
function parseUuidArray(v: string[] | string | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
}

const asDate = (v: string | Date | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/**
 * The one query behind the list, the unread count and every push.
 *
 * An actor counts only while: their account is live; no block either way;
 * the recipient has not muted them; and the thing still holds — the follow is
 * still accepted (or the request still pending), and they can still see the
 * read the like or comment is on, by canView()'s rules for a non-owner (a
 * private read: nobody; a private account or a followers-only read: accepted
 * followers only). `notify-visibility.test.ts` checks this against canView()
 * over the matrix. A row with no actor left, or whose read, comment or import
 * is gone, is not shown and not pushed (PRD §19.5).
 */
export function viewSql(where: SQL, limit: number, focusActor: string | null = null): SQL {
  const actorCanSeeRead = sql`(r.visibility <> 'private' AND (
    (r.visibility = 'public' AND NOT rp.is_private)
    OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = na.actor_id AND f.followee_id = n.user_id AND f.state = 'accepted')))`;
  return sql`
    SELECT n.id, n.user_id, n.type, n.read_at, n.created_at, n.updated_at, n.updated_at::text AS cursor_at,
      n.pushed_at, n.push_state, n.digest_at,
      act.actor_count, act.actor_id, act.new_count, act.new_actor_ids, act.new_actor_ids[1] AS new_actor_id, act.focus_visible,
      pa.username AS actor_username, pa.display_name AS actor_display_name, pa.avatar_key AS actor_avatar_key,
      pn.username AS new_actor_username, pn.display_name AS new_actor_display_name,
      r.id AS read_id, r.work_id, w.title AS work_title, rv.id AS review_id, c.id AS comment_id,
      i.id AS import_id, i.matched AS import_matched, i.unmatched AS import_unmatched, i.source AS import_source
    FROM notifications n
    JOIN users ru ON ru.id = n.user_id AND ru.deleted_at IS NULL
    JOIN profiles rp ON rp.user_id = n.user_id
    LEFT JOIN read_comments c ON n.object_type = 'comment' AND c.id = n.object_id AND c.deleted_at IS NULL
    LEFT JOIN reads r ON r.id = (CASE n.object_type WHEN 'read' THEN n.object_id WHEN 'comment' THEN c.read_id END)
      AND r.user_id = n.user_id AND r.status IN ('finished', 'dnf')
    LEFT JOIN works w ON w.id = r.work_id
    LEFT JOIN reviews rv ON rv.read_id = r.id AND rv.deleted_at IS NULL
    LEFT JOIN imports i ON n.object_type = 'import' AND i.id = n.object_id AND i.user_id = n.user_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS actor_count,
        (array_agg(na.actor_id ORDER BY na.created_at DESC, na.actor_id DESC))[1] AS actor_id,
        (count(*) FILTER (WHERE na.pushed_at IS NULL))::int AS new_count,
        array_agg(na.actor_id ORDER BY na.created_at DESC, na.actor_id DESC) FILTER (WHERE na.pushed_at IS NULL) AS new_actor_ids,
        coalesce(bool_or(na.actor_id = ${focusActor}::uuid), false) AS focus_visible
      FROM notification_actors na
      JOIN users au ON au.id = na.actor_id AND au.deleted_at IS NULL
      WHERE na.notification_id = n.id
        AND NOT EXISTS (SELECT 1 FROM blocks b
          WHERE (b.blocker_id = n.user_id AND b.blocked_id = na.actor_id)
             OR (b.blocker_id = na.actor_id AND b.blocked_id = n.user_id))
        AND NOT EXISTS (SELECT 1 FROM mutes m
          WHERE m.user_id = n.user_id AND m.target_type = 'user' AND m.target_id = na.actor_id)
        AND CASE n.type
          WHEN 'follow' THEN EXISTS (SELECT 1 FROM follows f
            WHERE f.follower_id = na.actor_id AND f.followee_id = n.user_id AND f.state = 'accepted')
          WHEN 'follow_request' THEN EXISTS (SELECT 1 FROM follows f
            WHERE f.follower_id = na.actor_id AND f.followee_id = n.user_id AND f.state = 'pending')
          WHEN 'like' THEN ${actorCanSeeRead}
          WHEN 'comment' THEN ${actorCanSeeRead}
          ELSE true END
    ) act ON true
    LEFT JOIN profiles pa ON pa.user_id = act.actor_id
    LEFT JOIN profiles pn ON pn.user_id = act.new_actor_ids[1]
    WHERE ${where}
      AND CASE n.type
        WHEN 'import_complete' THEN i.id IS NOT NULL
        WHEN 'like' THEN r.id IS NOT NULL AND act.actor_count > 0
        WHEN 'comment' THEN r.id IS NOT NULL AND c.id IS NOT NULL AND act.actor_count > 0
        ELSE act.actor_count > 0 END
    ORDER BY n.updated_at DESC, n.id DESC
    LIMIT ${limit}`;
}

function toView(r: ViewRow): NotificationView {
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    readAt: asDate(r.read_at),
    createdAt: asDate(r.created_at)!,
    updatedAt: asDate(r.updated_at)!,
    cursorAt: r.cursor_at,
    pushedAt: asDate(r.pushed_at),
    pushState: r.push_state,
    digestAt: asDate(r.digest_at),
    actorCount: Number(r.actor_count ?? 0),
    actor: r.actor_id
      ? { id: r.actor_id, username: r.actor_username ?? 'reader', displayName: r.actor_display_name, avatarKey: r.actor_avatar_key }
      : null,
    newCount: Number(r.new_count ?? 0),
    newActorIds: parseUuidArray(r.new_actor_ids),
    newActor: r.new_actor_id
      ? { id: r.new_actor_id, username: r.new_actor_username ?? 'reader', displayName: r.new_actor_display_name }
      : null,
    focusVisible: Boolean(r.focus_visible),
    readId: r.read_id,
    workId: r.work_id,
    workTitle: r.work_title,
    reviewId: r.review_id,
    commentId: r.comment_id,
    importId: r.import_id,
    importMatched: r.import_matched === null ? null : Number(r.import_matched),
    importUnmatched: r.import_unmatched === null ? null : Number(r.import_unmatched),
    importSource: r.import_source,
  };
}

/** One notification as it may be shown now, or null when nothing of it may. */
export async function viewNotification(db: Db, id: string, focusActor: string | null = null): Promise<NotificationView | null> {
  const [row] = await db.execute<ViewRow>(viewSql(sql`n.id = ${id}::uuid`, 1, focusActor));
  return row ? toView(row) : null;
}

// ---------------------------------------------------------------------------
// Composition: the words and the deep link, the same for the list and push.
// ---------------------------------------------------------------------------

const SOURCE_NAMES: Record<string, string> = {
  goodreads: 'Goodreads',
  storygraph: 'StoryGraph',
  librarything: 'LibraryThing',
  calibre: 'Calibre',
  openlibrary: 'Open Library',
  openreads: 'Openreads',
};

const nameOf = (a: { username: string; displayName: string | null }) => a.displayName?.trim() || a.username;
const andOthers = (n: number) => (n <= 0 ? '' : n === 1 ? ' and 1 other' : ` and ${n} others`);

export interface Composed {
  text: string;
  /** flyleaf:// URL of the exact screen (PRD §19.5, §35.3). */
  deepLink: string;
}

/**
 * `who`: the actor to lead with and how many others to mention. The list
 * names the newest actor and everyone else; a digest push names the newest
 * actor not yet pushed, and only those.
 */
export function compose(
  v: NotificationView,
  who: { actor: { username: string; displayName: string | null } | null; others: number } = {
    actor: v.actor,
    others: Math.max(0, v.actorCount - 1),
  },
): Composed {
  const lead = who.actor ? nameOf(who.actor) + andOthers(who.others) : 'Someone';
  const title = v.workTitle ?? 'a book';
  const what = v.reviewId ? `your review of ${title}` : `your read of ${title}`;
  const work = v.workId ? `work=${v.workId}` : '';
  const q = (...parts: string[]) => {
    const s = parts.filter(Boolean).join('&');
    return s ? `?${s}` : '';
  };
  switch (v.type) {
    case 'follow':
      return {
        text: `${lead} followed you`,
        deepLink: v.actorCount === 1 && v.actor ? `flyleaf://user/${v.actor.id}` : `flyleaf://user/${v.userId}/followers`,
      };
    case 'follow_request':
      return { text: `${lead} asked to follow you`, deepLink: 'flyleaf://profile/requests' };
    case 'like':
      return {
        text: `${lead} liked ${what}`,
        deepLink: v.reviewId
          ? `flyleaf://review/${v.reviewId}${q(work)}`
          : `flyleaf://read/${v.readId}/comments${q(work)}`,
      };
    case 'comment':
      return {
        text: `${lead} commented on ${what}`,
        deepLink: `flyleaf://read/${v.readId}/comments${q(work, v.reviewId ? `review=${v.reviewId}` : '')}`,
      };
    case 'import_complete': {
      const source = SOURCE_NAMES[v.importSource ?? ''] ?? 'library';
      const matched = v.importMatched ?? 0;
      const unmatched = v.importUnmatched ?? 0;
      const books = matched === 1 ? '1 book' : `${matched} books`;
      return {
        text: `Your ${source} import is done: ${books} added${unmatched > 0 ? `, ${unmatched} to review` : ''}`,
        deepLink: unmatched > 0 ? `flyleaf://import/unmatched?id=${v.importId}` : 'flyleaf://import',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The recipient's side: list, unread count, mark read, preferences, tokens.
// ---------------------------------------------------------------------------

export interface NotificationItem {
  id: string;
  type: NotificationType;
  text: string;
  deep_link: string;
  read: boolean;
  created_at: string;
  updated_at: string;
  actor: { id: string; username: string; display_name: string | null; avatar_url: string | null } | null;
  actor_count: number;
  read_id: string | null;
  review_id: string | null;
  work_id: string | null;
  comment_id: string | null;
  import_id: string | null;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || !CURSOR_AT.test(at) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw ApiError.badRequest('invalid_cursor', 'Cursor is not valid.', 'cursor');
  }
  return { at, id };
}

/** The bell's badge stops counting here; "99+" is all it shows. */
export const UNREAD_COUNT_CAP = 99;

export interface PreferencesBody {
  push_enabled?: boolean;
  categories?: Record<string, { push?: boolean; in_app?: boolean }>;
  quiet_hours?: { enabled?: boolean; start?: string; end?: string };
  timezone?: string;
  reading_reminder?: { time: string | null };
}

export class NotificationService {
  constructor(private readonly db: Db) {}

  async list(viewer: string, query: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const cursor = decodeCursor(query.cursor);
    const where = sql`n.user_id = ${viewer}::uuid AND n.in_app${
      cursor ? sql` AND (n.updated_at, n.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``
    }`;
    const rows = (await this.db.execute<ViewRow>(viewSql(where, limit + 1))).map(toView);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((v) => this.#item(v)),
      next_cursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null,
      unread_count: await this.unreadCount(viewer),
    };
  }

  #item(v: NotificationView): NotificationItem {
    const c = compose(v);
    return {
      id: v.id,
      type: v.type,
      text: c.text,
      deep_link: c.deepLink,
      read: v.readAt !== null,
      created_at: v.createdAt.toISOString(),
      updated_at: v.updatedAt.toISOString(),
      actor: v.actor
        ? { id: v.actor.id, username: v.actor.username, display_name: v.actor.displayName, avatar_url: avatarUrl(v.actor.avatarKey) }
        : null,
      actor_count: v.actorCount,
      read_id: v.readId,
      review_id: v.reviewId,
      work_id: v.workId,
      comment_id: v.commentId,
      import_id: v.importId,
    };
  }

  /** Unread rows that would show, up to UNREAD_COUNT_CAP + 1 (the badge shows "99+"). */
  async unreadCount(viewer: string): Promise<number> {
    const [row] = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (${viewSql(
        sql`n.user_id = ${viewer}::uuid AND n.in_app AND n.read_at IS NULL`,
        UNREAD_COUNT_CAP + 1,
      )}) v`);
    return Number(row?.n ?? 0);
  }

  /** Marks the given rows read (all when `ids` is absent). Ids that are not the viewer's change nothing. */
  async markRead(viewer: string, ids?: string[]): Promise<{ unread_count: number }> {
    if (ids && ids.length === 0) return { unread_count: await this.unreadCount(viewer) };
    await this.db.execute(sql`
      UPDATE notifications SET read_at = now()
      WHERE user_id = ${viewer}::uuid AND read_at IS NULL${
        ids ? sql` AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``
      }`);
    return { unread_count: await this.unreadCount(viewer) };
  }

  async getPreferences(viewer: string) {
    return this.#preferencesBody(await loadPreferences(this.db, viewer));
  }

  #preferencesBody(p: ResolvedPreferences) {
    return {
      push_enabled: p.pushEnabled,
      categories: NOTIFICATION_CATEGORIES.map((c) => p.categories[c.key]),
      quiet_hours: { enabled: p.quietEnabled, start: formatTime(p.quietStart), end: formatTime(p.quietEnd) },
      timezone: p.timezone,
      reading_reminder: { enabled: p.reminderTime !== null, time: p.reminderTime === null ? null : formatTime(p.reminderTime) },
    };
  }

  async updatePreferences(viewer: string, body: PreferencesBody) {
    const current = await loadPreferences(this.db, viewer);
    const [stored] = await this.db.execute<{ categories: unknown }>(sql`
      SELECT categories FROM notification_preferences WHERE user_id = ${viewer}::uuid`);
    const raw = stored?.categories;
    const categories: Record<string, { push?: boolean; in_app?: boolean }> = {
      ...((typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as Record<string, { push?: boolean; in_app?: boolean }>),
    };

    for (const [key, change] of Object.entries(body.categories ?? {})) {
      if (!isCategoryKey(key)) throw ApiError.badRequest('unknown_category', `Unknown notification category: ${key}.`, 'categories');
      const def = NOTIFICATION_CATEGORIES.find((c) => c.key === key)!;
      if (change.push !== undefined && def.push === null) {
        throw ApiError.badRequest('channel_unavailable', `${key} has no push channel.`, 'categories');
      }
      if (change.in_app !== undefined && def.inApp === null) {
        throw ApiError.badRequest('channel_unavailable', `${key} has no in-app channel.`, 'categories');
      }
      categories[key] = { ...categories[key], ...change };
    }

    let quietStart = current.quietStart;
    let quietEnd = current.quietEnd;
    if (body.quiet_hours?.start !== undefined) {
      const m = parseTime(body.quiet_hours.start);
      if (m === null) throw ApiError.badRequest('invalid_time', 'Use HH:MM, 24-hour.', 'quiet_hours.start');
      quietStart = m;
    }
    if (body.quiet_hours?.end !== undefined) {
      const m = parseTime(body.quiet_hours.end);
      if (m === null) throw ApiError.badRequest('invalid_time', 'Use HH:MM, 24-hour.', 'quiet_hours.end');
      quietEnd = m;
    }

    let timezone = current.timezone;
    if (body.timezone !== undefined) {
      if (!(await isKnownTimezone(this.db, body.timezone))) {
        throw ApiError.badRequest('invalid_timezone', 'Unknown time zone.', 'timezone');
      }
      timezone = body.timezone;
    }

    // PRD §19.2 item 14 bound 2: only the user sets the time. There is no
    // default and no suggestion; turning it on means sending a time.
    let reminderTime = current.reminderTime;
    let reminderChanged = false;
    if (body.reading_reminder !== undefined) {
      const t = body.reading_reminder.time;
      if (t === null) reminderTime = null;
      else {
        const m = parseTime(t);
        if (m === null) throw ApiError.badRequest('invalid_time', 'Use HH:MM, 24-hour.', 'reading_reminder.time');
        reminderTime = m;
      }
      reminderChanged = reminderTime !== current.reminderTime;
    }

    await this.db.execute(sql`
      INSERT INTO notification_preferences
        (user_id, push_enabled, categories, quiet_enabled, quiet_start, quiet_end, timezone, reminder_time, updated_at)
      VALUES (${viewer}::uuid, ${body.push_enabled ?? current.pushEnabled}, ${JSON.stringify(categories)}::jsonb,
        ${body.quiet_hours?.enabled ?? current.quietEnabled}, ${quietStart}, ${quietEnd}, ${timezone}, ${reminderTime}, now())
      ON CONFLICT (user_id) DO UPDATE SET
        push_enabled = EXCLUDED.push_enabled, categories = EXCLUDED.categories,
        quiet_enabled = EXCLUDED.quiet_enabled, quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
        timezone = EXCLUDED.timezone, reminder_time = EXCLUDED.reminder_time,
        -- A new time today may fire today: forget that today's was sent.
        reminder_last_sent_on = CASE WHEN ${reminderChanged} THEN NULL ELSE notification_preferences.reminder_last_sent_on END,
        updated_at = now()`);
    return this.getPreferences(viewer);
  }

  /**
   * PRD §19.5: tokens refresh on app launch. Upsert by token (a device that
   * signs in as someone else moves to them); `last_seen_at` is the app's last
   * open, which suspends the reading reminder after 14 days (bound 4).
   */
  async registerToken(viewer: string, body: { token: string; platform: 'android' | 'ios'; timezone?: string }) {
    const token = body.token.trim();
    if (!/^Expo(?:nent)?PushToken\[[^\]\s]+\]$/.test(token)) {
      throw ApiError.badRequest('invalid_token', 'Not an Expo push token.', 'token');
    }
    await this.db.execute(sql`
      INSERT INTO push_tokens (token, user_id, platform) VALUES (${token}, ${viewer}::uuid, ${body.platform})
      ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = now()`);
    if (body.timezone !== undefined && (await isKnownTimezone(this.db, body.timezone))) {
      // The device's zone is what quiet hours and the reminder are read in.
      await this.db.execute(sql`
        INSERT INTO notification_preferences (user_id, timezone) VALUES (${viewer}::uuid, ${body.timezone})
        ON CONFLICT (user_id) DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now()
        WHERE notification_preferences.timezone <> EXCLUDED.timezone`);
    }
    return { registered: true as const };
  }

  /** Sign-out or permission revoked. Someone else's token: nothing happens, and nothing is said. */
  async unregisterToken(viewer: string, token: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM push_tokens WHERE token = ${token} AND user_id = ${viewer}::uuid`);
  }
}

// ---------------------------------------------------------------------------
// Routes (PRD §24.2: GET /notifications?cursor=, POST /notifications/read).
// ---------------------------------------------------------------------------

const actorSchema = {
  type: ['object', 'null'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    username: { type: 'string' },
    display_name: { type: ['string', 'null'] },
    avatar_url: { type: ['string', 'null'] },
  },
  required: ['id', 'username', 'display_name', 'avatar_url'],
} as const;

const nullableUuid = { type: ['string', 'null'], format: 'uuid' } as const;

export const notificationItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: ['follow', 'follow_request', 'like', 'comment', 'import_complete'] },
    text: { type: 'string' },
    deep_link: { type: 'string', description: 'flyleaf:// URL of the screen this opens' },
    read: { type: 'boolean' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time', description: 'Moves when an aggregated row gains an actor; the sort key' },
    actor: actorSchema,
    actor_count: { type: 'integer', minimum: 0 },
    read_id: nullableUuid,
    review_id: nullableUuid,
    work_id: nullableUuid,
    comment_id: nullableUuid,
    import_id: nullableUuid,
  },
  required: ['id', 'type', 'text', 'deep_link', 'read', 'created_at', 'updated_at', 'actor', 'actor_count',
    'read_id', 'review_id', 'work_id', 'comment_id', 'import_id'],
} as const;

const listQuerySchema = {
  type: 'object',
  properties: {
    cursor: { type: 'string', maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  },
} as const;

const listResponseSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: notificationItemSchema },
    next_cursor: { type: ['string', 'null'] },
    unread_count: { type: 'integer', minimum: 0 },
  },
  required: ['items', 'next_cursor', 'unread_count'],
} as const;

const unreadResponseSchema = {
  type: 'object',
  properties: { unread_count: { type: 'integer', minimum: 0, description: `Capped at ${UNREAD_COUNT_CAP + 1}` } },
  required: ['unread_count'],
} as const;

const markReadBodySchema = {
  type: ['object', 'null'],
  properties: {
    ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 100, description: 'Absent: mark every notification read' },
  },
  additionalProperties: false,
} as const;

const hhmm = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' } as const;

const categoryPreferenceSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', enum: NOTIFICATION_CATEGORIES.map((c) => c.key) },
    push: { type: ['boolean', 'null'], description: 'null: this category has no push channel (PRD §19.2)' },
    in_app: { type: ['boolean', 'null'], description: 'null: this category has no in-app channel' },
    live: { type: 'boolean', description: 'Something sends this category today' },
  },
  required: ['key', 'push', 'in_app', 'live'],
} as const;

export const preferencesResponseSchema = {
  type: 'object',
  properties: {
    push_enabled: { type: 'boolean', description: 'The master switch (PRD §19.4)' },
    categories: { type: 'array', items: categoryPreferenceSchema },
    quiet_hours: {
      type: 'object',
      properties: { enabled: { type: 'boolean' }, start: hhmm, end: hhmm },
      required: ['enabled', 'start', 'end'],
    },
    timezone: { type: 'string' },
    reading_reminder: {
      type: 'object',
      properties: { enabled: { type: 'boolean' }, time: { type: ['string', 'null'] } },
      required: ['enabled', 'time'],
    },
  },
  required: ['push_enabled', 'categories', 'quiet_hours', 'timezone', 'reading_reminder'],
} as const;

const preferencesBodySchema = {
  type: 'object',
  properties: {
    push_enabled: { type: 'boolean' },
    categories: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { push: { type: 'boolean' }, in_app: { type: 'boolean' } },
        additionalProperties: false,
      },
    },
    quiet_hours: {
      type: 'object',
      properties: { enabled: { type: 'boolean' }, start: hhmm, end: hhmm },
      additionalProperties: false,
    },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    reading_reminder: {
      type: 'object',
      properties: { time: { anyOf: [hhmm, { type: 'null' }], description: 'HH:MM local, or null to turn it off' } },
      required: ['time'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const tokenBodySchema = {
  type: 'object',
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 255 },
    platform: { type: 'string', enum: ['android', 'ios'] },
    timezone: { type: 'string', minLength: 1, maxLength: 64, description: 'IANA zone of the device' },
  },
  required: ['token', 'platform'],
  additionalProperties: false,
} as const;

const errors = { 400: errorResponseSchema, 401: errorResponseSchema };

export interface NotificationsPluginOptions {
  db: Db;
}

export const notificationsPlugin: FastifyPluginAsync<NotificationsPluginOptions> = async (app, opts) => {
  const service = new NotificationService(opts.db);

  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Your notifications, newest activity first (PRD §6.14)',
        querystring: listQuerySchema,
        response: { 200: listResponseSchema, ...errors },
      },
    },
    async (req) => service.list(requireViewer(req), req.query),
  );

  app.get(
    '/notifications/unread-count',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Unread notifications for the bell badge',
        response: { 200: unreadResponseSchema, 401: errorResponseSchema },
      },
    },
    async (req) => ({ unread_count: await service.unreadCount(requireViewer(req)) }),
  );

  app.post<{ Body: { ids?: string[] } | null }>(
    '/notifications/read',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Mark notifications read: the given ids, or all',
        body: markReadBodySchema,
        response: { 200: unreadResponseSchema, ...errors },
      },
    },
    async (req) => service.markRead(requireViewer(req), req.body?.ids),
  );

  app.get(
    '/me/notification-preferences',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Notification settings: categories, master switch, quiet hours, reading reminder (PRD §19.4)',
        response: { 200: preferencesResponseSchema, 401: errorResponseSchema },
      },
    },
    async (req) => service.getPreferences(requireViewer(req)),
  );

  app.patch<{ Body: PreferencesBody }>(
    '/me/notification-preferences',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Change notification settings. The reading reminder is off until a time is sent.',
        body: preferencesBodySchema,
        response: { 200: preferencesResponseSchema, ...errors },
      },
    },
    async (req) => service.updatePreferences(requireViewer(req), req.body),
  );

  app.put<{ Body: { token: string; platform: 'android' | 'ios'; timezone?: string } }>(
    '/me/push-tokens',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Register or refresh this device\'s push token (on every app open)',
        body: tokenBodySchema,
        response: {
          200: { type: 'object', properties: { registered: { type: 'boolean' } }, required: ['registered'] },
          ...errors,
        },
      },
    },
    async (req) => service.registerToken(requireViewer(req), req.body),
  );

  app.delete<{ Params: { token: string } }>(
    '/me/push-tokens/:token',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Forget this device\'s push token (sign-out)',
        params: {
          type: 'object',
          properties: { token: { type: 'string', minLength: 1, maxLength: 255 } },
          required: ['token'],
        },
        response: { 204: { type: 'null' }, 401: errorResponseSchema },
      },
    },
    async (req, reply) => {
      await service.unregisterToken(requireViewer(req), req.params.token);
      return reply.code(204).send();
    },
  );
};
