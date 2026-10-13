// Push delivery: the worker's half of notifications (SO-30, SO-31, SO-32).
//
// Three jobs (architecture §9):
//   notify.send       one notification's push, enqueued by the Notifier in the
//                     transaction that created it. Every rule is applied HERE,
//                     at send time, against the state now: preferences, the
//                     new-user grace, quiet hours, aggregation, the per-thread
//                     hour, then the 5-a-day cap, in that order, so a push held
//                     back for any other reason never spends the day's budget.
//   notify.reminders  every 5 minutes: reading reminders that are due.
//   notify.receipts   every 15 minutes: Expo delivery receipts.
//
// The counting goes through the shared limiter layer (platform/rate-limits.ts,
// the 'rolling' store): push:day, push:thread, push:follow.

import { sql } from 'drizzle-orm';
import type { Db, RateLimiter } from '../platform/index.js';
import { checkWith, type LimitName } from '../platform/rate-limits.js';
import type { PushMessage, PushSender } from '../providers/push/index.js';
import {
  AGGREGATION_WINDOW_MS,
  NEW_USER_GRACE_MS,
  READING_REMINDER_CATEGORY,
  READING_REMINDER_TEXT,
  REMINDER_LAPSE_DAYS,
  REMINDER_SEND_WINDOW_MIN,
  channelsFor,
  isQuiet,
  quietHoursEnd,
  resolvePreferences,
  type ResolvedPreferences,
} from './preferences.js';
import { compose, loadPreferences, viewNotification, type NotifyQueue, type NotifySendJob } from './index.js';

export interface DeliveryDeps {
  db: Db;
  push: PushSender;
  /** The rolling store (PgRollingRateLimiter). */
  limiter: RateLimiter;
  /** To defer a push to the end of quiet hours, or to queue a digest. */
  queue: NotifyQueue;
  now?: () => Date;
}

export type DeliveryOutcome =
  | { status: 'sent'; devices: number }
  | { status: 'skipped'; reason: string }
  | { status: 'deferred'; until: string }
  | { status: 'aggregated'; until: string };

/** Android channel the app creates at startup. */
export const PUSH_CHANNEL = 'default';

const PUSH_TITLE = 'Flyleaf';

async function skip(db: Db, id: string, reason: string): Promise<DeliveryOutcome> {
  await db.execute(sql`UPDATE notifications SET push_state = 'skipped', push_reason = ${reason} WHERE id = ${id}::uuid`);
  return { status: 'skipped', reason };
}

async function tokensOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db.execute<{ token: string }>(sql`SELECT token FROM push_tokens WHERE user_id = ${userId}::uuid ORDER BY created_at`);
  return rows.map((r) => r.token);
}

async function counted(limiter: RateLimiter, name: LimitName, key: string): Promise<boolean> {
  return (await checkWith(limiter, name, key)).allowed;
}

/**
 * Sends one message to each of a user's devices. A token Expo says is dead is
 * deleted at once (PRD §19.5: pruned on delivery failure); every ticket is kept
 * for its receipt.
 */
async function sendToDevices(
  deps: DeliveryDeps,
  tokens: string[],
  message: Omit<PushMessage, 'to'>,
  notificationId: string | null,
): Promise<number> {
  const results = await deps.push.send(tokens.map((to) => ({ ...message, to })));
  let delivered = 0;
  for (const [i, r] of results.entries()) {
    const token = tokens[i]!;
    if (r.ok) {
      delivered++;
      if (r.id) {
        await deps.db.execute(sql`
          INSERT INTO push_tickets (ticket_id, token, notification_id)
          VALUES (${r.id}, ${token}, ${notificationId}::uuid) ON CONFLICT (ticket_id) DO NOTHING`);
      }
    } else if (r.error === 'device_not_registered' || r.error === 'invalid_token') {
      await deps.db.execute(sql`DELETE FROM push_tokens WHERE token = ${token}`);
    }
  }
  return delivered;
}

/** The new-user grace (PRD §19.3): no push in an account's first 24 hours except import completion. */
async function inGrace(db: Db, userId: string, now: Date): Promise<boolean> {
  const [u] = await db.execute<{ created_at: string | Date }>(sql`SELECT created_at FROM users WHERE id = ${userId}::uuid`);
  if (!u) return true;
  return now.getTime() - new Date(u.created_at).getTime() < NEW_USER_GRACE_MS;
}

/** notify.send: one notification's push. */
export async function deliverNotification(deps: DeliveryDeps, job: NotifySendJob): Promise<DeliveryOutcome> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const view = await viewNotification(db, job.notificationId, job.actorId ?? null);
  if (!view) {
    // Deleted content, every actor blocked, muted or gone, or the row itself
    // gone (an unlike took the last actor out): nothing to say (PRD §19.5).
    const [exists] = await db.execute<{ id: string }>(sql`SELECT id FROM notifications WHERE id = ${job.notificationId}::uuid`);
    return exists ? skip(db, job.notificationId, 'suppressed') : { status: 'skipped', reason: 'gone' };
  }
  // Seen in the app already: a push would only repeat it.
  if (view.readAt) return skip(db, view.id, 'already_read');

  const prefs = await loadPreferences(db, view.userId);
  if (!channelsFor(prefs, view.type).push) return skip(db, view.id, 'preference');
  if (view.type !== 'import_complete' && (await inGrace(db, view.userId, now))) return skip(db, view.id, 'new_user_grace');

  const tokens = await tokensOf(db, view.userId);
  if (tokens.length === 0) return skip(db, view.id, 'no_device');

  // PRD §19.3 / AC-19: nothing is delivered in quiet hours. Held, not dropped:
  // the same job runs again when they end, and every rule is checked again then.
  if (isQuiet(prefs, now)) {
    const until = quietHoursEnd(now, prefs.timezone, prefs.quietEnd);
    await deps.queue.enqueue(db, job, until);
    await db.execute(sql`UPDATE notifications SET push_reason = 'quiet_hours' WHERE id = ${view.id}::uuid`);
    return { status: 'deferred', until: until.toISOString() };
  }

  const mode = job.mode ?? (view.type === 'like' ? 'digest' : 'single');
  let who = { actor: view.actor as { username: string; displayName: string | null } | null, others: 0 };

  if (view.type === 'follow' && mode === 'single') {
    // PRD §19.2 item 1: a follow pushes on its own up to 3 an hour; beyond
    // that the hour's follows are one digest.
    if (!job.actorId || !view.focusVisible) return { status: 'skipped', reason: 'actor_gone' };
    if (!(await counted(deps.limiter, 'push:follow', view.userId))) {
      const [d] = await db.execute<{ digest_at: string }>(sql`
        UPDATE notifications SET digest_at = ${new Date(now.getTime() + AGGREGATION_WINDOW_MS).toISOString()}::timestamptz
        WHERE id = ${view.id}::uuid AND digest_at IS NULL RETURNING digest_at`);
      if (d) await deps.queue.enqueue(db, { notificationId: view.id, mode: 'digest' }, new Date(d.digest_at));
      return { status: 'aggregated', until: new Date(d?.digest_at ?? view.digestAt ?? now).toISOString() };
    }
    const [a] = await db.execute<{ username: string; display_name: string | null }>(sql`
      SELECT username, display_name FROM profiles WHERE user_id = ${job.actorId}::uuid`);
    who = { actor: a ? { username: a.username, displayName: a.display_name } : null, others: 0 };
  } else if (mode === 'digest') {
    // Everyone not yet named in a push: "Ana and 4 others liked your review".
    if (view.newCount === 0 || !view.newActor) {
      await db.execute(sql`UPDATE notifications SET digest_at = NULL WHERE id = ${view.id}::uuid`);
      return skip(db, view.id, 'nothing_new');
    }
    who = { actor: view.newActor, others: view.newCount - 1 };
  } else if (view.type === 'reply') {
    // A reply's push is about its own comment: the job's commenter, alone,
    // while they are still in the row (the list names the whole thread).
    if (!job.actorId || !view.focusVisible) return skip(db, view.id, 'actor_gone');
    const [a] = await db.execute<{ username: string; display_name: string | null }>(sql`
      SELECT username, display_name FROM profiles WHERE user_id = ${job.actorId}::uuid`);
    who = { actor: a ? { username: a.username, displayName: a.display_name } : null, others: 0 };
  } else {
    who = { actor: view.actor, others: Math.max(0, view.actorCount - 1) };
  }

  // PRD §19.2 item 4: a thread pushes at most once an hour. The comment is in
  // the list either way.
  // Replies too (owner decision on SO-3x): a thread you commented in.
  if ((view.type === 'comment' || view.type === 'reply') && view.readId
    && !(await counted(deps.limiter, 'push:thread', `${view.userId}:${view.readId}`))) {
    return skip(db, view.id, 'thread_hourly');
  }

  // PRD §19.3: 5 a day, hard ceiling. Last, so nothing else spends it.
  if (!(await counted(deps.limiter, 'push:day', view.userId))) {
    if (mode === 'digest') await db.execute(sql`UPDATE notifications SET digest_at = NULL WHERE id = ${view.id}::uuid`);
    return skip(db, view.id, 'daily_cap');
  }

  const c = compose(view, who);
  const delivered = await sendToDevices(
    deps,
    tokens,
    {
      title: PUSH_TITLE,
      body: c.text,
      data: { notification_id: view.id, type: view.type, url: c.deepLink },
      channelId: PUSH_CHANNEL,
    },
    view.id,
  );
  if (delivered > 0) {
    // These actors have now been named; a later digest counts only the rest.
    const named = mode === 'digest' ? view.newActorIds : job.actorId ? [job.actorId] : [];
    if (named.length > 0) {
      await db.execute(sql`
        UPDATE notification_actors SET pushed_at = now()
        WHERE notification_id = ${view.id}::uuid
          AND actor_id IN (${sql.join(named.map((id) => sql`${id}::uuid`), sql`, `)})`);
    }
  }
  await db.execute(sql`
    UPDATE notifications SET push_state = ${delivered > 0 ? 'sent' : 'skipped'},
      push_reason = ${delivered > 0 ? null : 'delivery_failed'},
      pushed_at = ${delivered > 0 ? now.toISOString() : null}::timestamptz,
      digest_at = ${mode === 'digest' ? null : view.digestAt?.toISOString() ?? null}::timestamptz
    WHERE id = ${view.id}::uuid`);
  return delivered > 0 ? { status: 'sent', devices: delivered } : { status: 'skipped', reason: 'delivery_failed' };
}

export interface ReminderResult {
  due: number;
  sent: number;
  skipped: Record<string, number>;
}

/**
 * notify.reminders: PRD §19.2 item 14, every bound.
 *   1. Off by default: only rows with a reminder_time, which only the user sets.
 *   2. The user's time: due when local time is within 30 minutes after it.
 *   3. The copy is READING_REMINDER_TEXT, fixed: no guilt, streak, count or title.
 *   4. Not as re-engagement: no app open on any device for 14 days, no reminder;
 *      it resumes by itself once the app is opened (the token is refreshed).
 *   5. It counts against the 5-a-day cap.
 *   6. It carries the reading_reminder category, whose "Turn off" action the
 *      app turns into PATCH reading_reminder.time = null.
 * At most once a local day: the due users are claimed by setting
 * reminder_last_sent_on in the same statement that finds them, so two
 * overlapping runs cannot both send.
 */
export async function sendDueReminders(deps: DeliveryDeps): Promise<ReminderResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const claimed = await db.execute<{
    user_id: string; push_enabled: boolean; categories: unknown; quiet_enabled: boolean; quiet_start: number;
    quiet_end: number; timezone: string; reminder_time: number; last_open: string | Date | null; created_at: string | Date;
  }>(sql`
    WITH due AS (
      SELECT p.user_id,
        ((${at}::timestamptz AT TIME ZONE p.timezone) - make_interval(mins => (
          ((extract(hour FROM (${at}::timestamptz AT TIME ZONE p.timezone)) * 60 + extract(minute FROM (${at}::timestamptz AT TIME ZONE p.timezone)))::int
            - p.reminder_time + 1440) % 1440)))::date AS day
      FROM notification_preferences p
      JOIN users u ON u.id = p.user_id AND u.deleted_at IS NULL
      WHERE p.reminder_time IS NOT NULL
        AND (((extract(hour FROM (${at}::timestamptz AT TIME ZONE p.timezone)) * 60 + extract(minute FROM (${at}::timestamptz AT TIME ZONE p.timezone)))::int
              - p.reminder_time + 1440) % 1440) < ${REMINDER_SEND_WINDOW_MIN}
    )
    UPDATE notification_preferences p SET reminder_last_sent_on = due.day
    FROM due
    WHERE p.user_id = due.user_id AND p.reminder_last_sent_on IS DISTINCT FROM due.day
    RETURNING p.user_id, p.push_enabled, p.categories, p.quiet_enabled, p.quiet_start, p.quiet_end, p.timezone,
      p.reminder_time,
      (SELECT max(t.last_seen_at) FROM push_tokens t WHERE t.user_id = p.user_id) AS last_open,
      (SELECT created_at FROM users WHERE id = p.user_id) AS created_at`);

  const result: ReminderResult = { due: claimed.length, sent: 0, skipped: {} };
  const skipped = (reason: string) => void (result.skipped[reason] = (result.skipped[reason] ?? 0) + 1);

  for (const row of claimed) {
    const prefs: ResolvedPreferences = resolvePreferences({
      pushEnabled: row.push_enabled,
      categories: row.categories,
      quietEnabled: row.quiet_enabled,
      quietStart: Number(row.quiet_start),
      quietEnd: Number(row.quiet_end),
      timezone: row.timezone,
      reminderTime: Number(row.reminder_time),
    });
    if (!prefs.pushEnabled) { skipped('preference'); continue; }
    if (!row.last_open) { skipped('no_device'); continue; }
    if (now.getTime() - new Date(row.last_open).getTime() > REMINDER_LAPSE_DAYS * 86_400_000) { skipped('lapsed'); continue; }
    if (now.getTime() - new Date(row.created_at).getTime() < NEW_USER_GRACE_MS) { skipped('new_user_grace'); continue; }
    // A reminder is not held to the end of quiet hours: it is about a time.
    if (isQuiet(prefs, now)) { skipped('quiet_hours'); continue; }
    if (!(await counted(deps.limiter, 'push:day', row.user_id))) { skipped('daily_cap'); continue; }
    const tokens = await tokensOf(db, row.user_id);
    const delivered = await sendToDevices(
      deps,
      tokens,
      {
        title: PUSH_TITLE,
        body: READING_REMINDER_TEXT,
        data: { type: 'reading_reminder', url: 'flyleaf://reading' },
        categoryId: READING_REMINDER_CATEGORY,
        channelId: PUSH_CHANNEL,
      },
      null,
    );
    if (delivered > 0) result.sent++;
    else skipped('delivery_failed');
  }
  return result;
}

export interface ReceiptResult {
  checked: number;
  ok: number;
  failed: number;
  tokensDeleted: number;
  pending: number;
}

/** Expo asks for receipts no sooner than 15 minutes after the send, and keeps them 24 hours. */
const RECEIPT_MIN_AGE = '15 minutes';
const RECEIPT_MAX_AGE = '24 hours';

/**
 * notify.receipts (PV-05 left these to SO-30): a ticket only says Expo
 * accepted the message; the receipt says whether Apple or Google did. A
 * DeviceNotRegistered receipt deletes the token, as a ticket error does.
 * Tickets with a receipt, or older than Expo keeps receipts, are deleted.
 */
export async function processReceipts(deps: Pick<DeliveryDeps, 'db' | 'push'>, batch = 1000): Promise<ReceiptResult> {
  const { db } = deps;
  const tickets = await db.execute<{ ticket_id: string; token: string }>(sql`
    SELECT ticket_id, token FROM push_tickets
    WHERE created_at < now() - ${RECEIPT_MIN_AGE}::interval
    ORDER BY created_at LIMIT ${batch}`);
  const result: ReceiptResult = { checked: tickets.length, ok: 0, failed: 0, tokensDeleted: 0, pending: 0 };
  if (tickets.length === 0) return result;

  const receipts = await deps.push.receipts(tickets.map((t) => t.ticket_id));
  const done: string[] = [];
  for (const t of tickets) {
    const r = receipts.get(t.ticket_id) ?? { status: 'pending' as const };
    if (r.status === 'pending') {
      result.pending++;
      continue;
    }
    done.push(t.ticket_id);
    if (r.status === 'ok') {
      result.ok++;
      continue;
    }
    result.failed++;
    if (r.error === 'device_not_registered' || r.error === 'invalid_token') {
      const deleted = await db.execute<{ token: string }>(sql`DELETE FROM push_tokens WHERE token = ${t.token} RETURNING token`);
      result.tokensDeleted += deleted.length;
    }
  }
  if (done.length > 0) {
    await db.execute(sql`DELETE FROM push_tickets WHERE ticket_id IN (${sql.join(done.map((id) => sql`${id}`), sql`, `)})`);
  }
  // Receipts Expo no longer has will never come.
  await db.execute(sql`DELETE FROM push_tickets WHERE created_at < now() - ${RECEIPT_MAX_AGE}::interval`);
  return result;
}
