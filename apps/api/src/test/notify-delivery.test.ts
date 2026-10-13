// SO-31 and SO-32: the worker's rules, each with its own test.
//
//   SO-31  5 a day (rolling, a hard ceiling) · quiet hours (held, not dropped)
//          · aggregation: likes in one hourly digest, follows singly up to 3
//          an hour then a digest · comments at most once a thread an hour ·
//          no push in an account's first 24 hours except import completion
//   SO-32  per-category push switches and the master switch, at send time ·
//          the reading reminder's six bounds (PRD §19.2 item 14)
//   SO-30  delivery receipts (PV-05 left them here) and dead-token pruning
//
// The handlers run directly with a clock the test sets; the limiter is the
// real rolling store on PGlite.

import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { PgRollingRateLimiter, type Db } from '../platform/index.js';
import { MemoryPushSender } from '../providers/push/index.js';
import { MemoryNotifyQueue, NotificationService, Notifier, READING_REMINDER_TEXT } from '../notify/index.js';
import { deliverNotification, processReceipts, sendDueReminders, type DeliveryDeps } from '../notify/delivery.js';
import { imports, users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, block, follow, type TestUser } from './interaction-fixtures.js';

let db: Db;
let queue: MemoryNotifyQueue;
let push: MemoryPushSender;
let notifier: Notifier;
let alice: TestUser;
let readId: string;
let clock: Date;
let deps: DeliveryDeps;

/** 14:00 UTC: outside the default quiet hours in UTC. */
const AFTERNOON = new Date('2026-10-12T14:00:00Z');

async function aged(userId: string, days = 30) {
  await db.update(users).set({ createdAt: new Date(Date.now() - days * 86_400_000) }).where(eq(users.id, userId));
}

async function device(userId: string, token = `ExponentPushToken[${userId.slice(0, 8)}]`, lastSeen?: Date) {
  await db.execute(sql`
    INSERT INTO push_tokens (token, user_id, platform, last_seen_at)
    VALUES (${token}, ${userId}::uuid, 'android', ${(lastSeen ?? new Date()).toISOString()}::timestamptz)
    ON CONFLICT (token) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`);
  return token;
}

async function user(name: string): Promise<TestUser> {
  const u = await makeUser(db, name);
  await aged(u.id);
  return u;
}

/** A real follow and its notification, as SocialService writes them. */
async function followed(actor: TestUser, recipientId = alice.id) {
  await follow(db, actor.id, recipientId);
  await notifier.follow(db, actor.id, recipientId, 'accepted');
}

/** Runs every queued job (as the worker would), oldest first, and clears the queue. */
async function drain() {
  const jobs = queue.jobs.splice(0);
  const out = [];
  for (const j of jobs) out.push(await deliverNotification(deps, j.job));
  return out;
}

async function prefs(userId: string, set: Record<string, unknown>) {
  await db.execute(sql`INSERT INTO notification_preferences (user_id) VALUES (${userId}::uuid) ON CONFLICT DO NOTHING`);
  for (const [k, v] of Object.entries(set)) {
    await db.execute(sql`UPDATE notification_preferences SET ${sql.raw(k)} = ${v} WHERE user_id = ${userId}::uuid`);
  }
}

beforeEach(async () => {
  ({ db } = await freshDrizzle());
  queue = new MemoryNotifyQueue();
  push = new MemoryPushSender();
  notifier = new Notifier(queue);
  clock = AFTERNOON;
  deps = { db, push, limiter: new PgRollingRateLimiter(db), queue, now: () => clock };
  alice = await user('alice');
  await device(alice.id);
  readId = await makeRead(db, alice.id, await makeWork(db, 'Earthsea'), { status: 'finished' });
});

describe('SO-31: 5 push notifications a day, a hard ceiling (PRD §19.3, AC-19)', () => {
  it('six push-worthy events in a day: five delivered, the sixth held back, all six in the list', async () => {
    for (let i = 0; i < 6; i++) {
      const fan = await user(`fan${i}`);
      const r = await makeRead(db, alice.id, await makeWork(db, `Book ${i}`), { status: 'finished' });
      await notifier.comment(db, fan.id, r, crypto.randomUUID());
    }
    // The comment rows point at comments that do not exist; give them real ones.
    await db.execute(sql`
      INSERT INTO read_comments (id, read_id, user_id, body)
      SELECT n.object_id, (n.data->>'readId')::uuid, na.actor_id, 'hi'
      FROM notifications n JOIN notification_actors na ON na.notification_id = n.id`);
    const results = await drain();
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(5);
    expect(results.at(-1)).toEqual({ status: 'skipped', reason: 'daily_cap' });
    expect(push.sent).toHaveLength(5);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE in_app`);
    expect(n!.n).toBe(6);
  });

  it('the day is any 24 hours, not a window that restarts', async () => {
    const limiter = new PgRollingRateLimiter(db);
    for (let i = 0; i < 5; i++) expect((await limiter.hit('push:day:u', 5, 86_400)).allowed).toBe(true);
    expect((await limiter.hit('push:day:u', 5, 86_400)).allowed).toBe(false);
    // 23 hours later the five are still inside the last 24 hours.
    await db.execute(sql`UPDATE rate_limit_events SET at = at - interval '23 hours'`);
    expect((await limiter.hit('push:day:u', 5, 86_400)).allowed).toBe(false);
    // Once the oldest is past 24 hours, there is room again, for exactly as many as left.
    await db.execute(sql`UPDATE rate_limit_events SET at = at - interval '2 hours'`);
    for (let i = 0; i < 5; i++) expect((await limiter.hit('push:day:u', 5, 86_400)).allowed).toBe(true);
    expect((await limiter.hit('push:day:u', 5, 86_400)).allowed).toBe(false);
  });

  it('a refused attempt is not counted, so it cannot push the window forward', async () => {
    const limiter = new PgRollingRateLimiter(db);
    for (let i = 0; i < 8; i++) await limiter.hit('push:day:v', 5, 86_400);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rate_limit_events WHERE bucket = 'push:day:v'`);
    expect(n!.n).toBe(5);
  });
});

describe('SO-31: quiet hours (default 22:00–08:00 local; nothing delivered inside them)', () => {
  const bob = () => user('bob');

  it('a push due at 23:30 local is held until 08:00 local, then delivered', async () => {
    await prefs(alice.id, { timezone: 'Asia/Kolkata' });
    const b = await bob();
    await followed(b);
    clock = new Date('2026-10-12T18:00:00Z'); // 23:30 in Kolkata
    const [held] = await drain();
    expect(held).toEqual({ status: 'deferred', until: '2026-10-13T02:30:00.000Z' }); // 08:00 IST
    expect(push.sent).toHaveLength(0);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.startAfter!.toISOString()).toBe('2026-10-13T02:30:00.000Z');
    // Holding it spent none of the day's five.
    expect(await db.execute(sql`SELECT 1 FROM rate_limit_events`)).toHaveLength(0);
    clock = new Date('2026-10-13T02:30:00Z');
    expect((await drain())[0]).toMatchObject({ status: 'sent' });
    expect(push.sent[0]!.body).toBe('bob followed you');
  });

  it('respects the edges: 21:59 and 08:00 deliver, 22:00 and 07:59 hold', async () => {
    const b = await bob();
    const at = async (iso: string) => {
      await db.execute(sql`DELETE FROM rate_limit_events`);
      await db.execute(sql`UPDATE notifications SET push_state = 'queued', push_reason = NULL`);
      clock = new Date(iso);
      queue.jobs.splice(0);
      const [row] = await db.execute<{ id: string }>(sql`SELECT id FROM notifications LIMIT 1`);
      return (await deliverNotification(deps, { notificationId: row!.id, mode: 'single', actorId: b.id })).status;
    };
    await followed(b);
    queue.jobs.splice(0);
    expect(await at('2026-10-12T21:59:00Z')).toBe('sent');
    expect(await at('2026-10-12T22:00:00Z')).toBe('deferred');
    expect(await at('2026-10-13T07:59:00Z')).toBe('deferred');
    expect(await at('2026-10-13T08:00:00Z')).toBe('sent');
  });

  it('user-adjusted hours apply, and switching them off delivers at night', async () => {
    const b = await bob();
    await prefs(alice.id, { quiet_start: 13 * 60, quiet_end: 15 * 60 });
    await followed(b);
    expect((await drain())[0]).toMatchObject({ status: 'deferred', until: '2026-10-12T15:00:00.000Z' });
    await prefs(alice.id, { quiet_enabled: false });
    expect((await drain())[0]).toMatchObject({ status: 'sent' });
  });
});

describe('SO-31: aggregation (PRD §19.2 items 1 and 3, §19.3)', () => {
  it('likes: one digest an hour out names the newest liker and the rest; later likes get the next digest, naming only themselves', async () => {
    const [b, c, d, e] = [await user('bob'), await user('carol'), await user('dan'), await user('eve')];
    for (const u of [b, c, d]) await notifier.like(db, u.id, readId);
    expect(queue.jobs).toHaveLength(1);
    expect((await drain())[0]).toMatchObject({ status: 'sent' });
    expect(push.sent.map((m) => m.body)).toEqual(['dan and 2 others liked your read of Earthsea']);

    await notifier.like(db, e.id, readId);
    expect(queue.jobs).toHaveLength(1);
    await drain();
    expect(push.sent.map((m) => m.body)).toEqual([
      'dan and 2 others liked your read of Earthsea',
      'eve liked your read of Earthsea',
    ]);
  });

  it('follows: the first 3 in an hour push one by one; the rest wait for one digest an hour later', async () => {
    const fans: TestUser[] = [];
    for (let i = 0; i < 6; i++) fans.push(await user(`fan${i}`));
    for (const f of fans) await followed(f);
    const results = await drain();
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'aggregated', 'aggregated', 'aggregated']);
    expect(push.sent.map((m) => m.body)).toEqual(['fan0 followed you', 'fan1 followed you', 'fan2 followed you']);
    // One digest queued, an hour after the first refusal.
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.job.mode).toBe('digest');
    expect(queue.jobs[0]!.startAfter!.getTime() - clock.getTime()).toBe(60 * 60 * 1000);
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    await drain();
    expect(push.sent.at(-1)!.body).toBe('fan5 and 2 others followed you');
  });

  it('a digest with nobody new sends nothing, and one whose likers all left is suppressed', async () => {
    const b = await user('bob');
    await notifier.like(db, b.id, readId);
    const [{ job }] = queue.jobs as [{ job: { notificationId: string; mode?: 'digest' } }];
    await drain();
    // The same digest again: bob was already named.
    expect(await deliverNotification(deps, job)).toEqual({ status: 'skipped', reason: 'nothing_new' });
    await notifier.unlike(db, b.id, readId);
    expect(await deliverNotification(deps, job)).toEqual({ status: 'skipped', reason: 'gone' });
  });
});

describe('SO-31: comments push at most once a thread an hour (PRD §19.2 item 4)', () => {
  async function comment(actor: TestUser, read: string) {
    const id = crypto.randomUUID();
    await db.execute(sql`INSERT INTO read_comments (id, read_id, user_id, body) VALUES (${id}::uuid, ${read}::uuid, ${actor.id}::uuid, 'x')`);
    await notifier.comment(db, actor.id, read, id);
  }

  it('the second comment in the hour stays in the list; another thread still pushes; an hour later it pushes again', async () => {
    const [b, c] = [await user('bob'), await user('carol')];
    // bob is in the thread too: since replies (SO-4x), carol's comment would
    // also queue one for him. This test is about alice's pushes only.
    await db.execute(sql`INSERT INTO notification_preferences (user_id, categories)
      VALUES (${b.id}::uuid, '{"comment_replies": {"push": false, "in_app": false}}'::jsonb)`);
    await comment(b, readId);
    await comment(c, readId);
    const other = await makeRead(db, alice.id, await makeWork(db, 'Tehanu'), { status: 'finished' });
    await comment(c, other);
    expect((await drain()).map((r) => r.status === 'skipped' ? r.reason : r.status)).toEqual(['sent', 'thread_hourly', 'sent']);
    await db.execute(sql`UPDATE rate_limit_events SET at = at - interval '61 minutes'`);
    await comment(b, readId);
    expect((await drain())[0]).toMatchObject({ status: 'sent' });
  });
});

describe('SO-31: no push in an account\'s first 24 hours, except import completion (PRD §19.3)', () => {
  it('a new account gets the in-app row but no push; its import completion is pushed', async () => {
    const fresh = await makeUser(db, 'fresh');
    await device(fresh.id);
    const freshRead = await makeRead(db, fresh.id, await makeWork(db, 'Dune'), { status: 'finished' });
    await notifier.like(db, (await user('bob')).id, freshRead);
    const [imp] = await db.insert(imports).values({ userId: fresh.id, source: 'goodreads', state: 'completed', matched: 3 }).returning({ id: imports.id });
    await notifier.importCompleted(db, fresh.id, imp!.id);
    expect((await drain()).map((r) => r.status === 'skipped' ? r.reason : r.status)).toEqual(['new_user_grace', 'sent']);
    expect(push.sent.map((m) => m.body)).toEqual(['Your Goodreads import is done: 3 books added']);
  });
});

describe('SO-32: preferences are read again at send time', () => {
  it('a category switched off after the event, or the master switch, stops the push', async () => {
    const b = await user('bob');
    await followed(b);
    await prefs(alice.id, { categories: JSON.stringify({ new_follower: { push: false } }) });
    expect((await drain())[0]).toEqual({ status: 'skipped', reason: 'preference' });
    await prefs(alice.id, { categories: '{}', push_enabled: false });
    await followed(await user('carol'));
    // The master switch is off: nothing was even queued.
    expect(queue.jobs).toHaveLength(0);
  });

  it('read in the app before the push went out: no push', async () => {
    await followed(await user('bob'));
    await db.execute(sql`UPDATE notifications SET read_at = now()`);
    expect((await drain())[0]).toEqual({ status: 'skipped', reason: 'already_read' });
  });

  it('a block made after the event suppresses the push (PRD §11.4)', async () => {
    const b = await user('bob');
    await notifier.like(db, b.id, readId);
    await block(db, alice.id, b.id);
    expect((await drain())[0]).toEqual({ status: 'skipped', reason: 'suppressed' });
    expect(push.sent).toHaveLength(0);
  });
});

describe('SO-30: devices, tickets and receipts', () => {
  it('a push goes to every device; an uninstalled app\'s token is deleted at once', async () => {
    await device(alice.id, 'ExponentPushToken[second]');
    push.unregister('ExponentPushToken[second]');
    await followed(await user('bob'));
    expect((await drain())[0]).toEqual({ status: 'sent', devices: 1 });
    expect((await db.execute<{ token: string }>(sql`SELECT token FROM push_tokens`)).map((r) => r.token)).toEqual([`ExponentPushToken[${alice.id.slice(0, 8)}]`]);
    expect(push.sent[0]).toMatchObject({ title: 'Flyleaf', data: { type: 'follow' }, channelId: 'default' });
    expect(String(push.sent[0]!.data!.url)).toMatch(/^flyleaf:\/\/user\//);
  });

  it('no device: skipped, and nothing spent', async () => {
    await db.execute(sql`DELETE FROM push_tokens`);
    await followed(await user('bob'));
    expect((await drain())[0]).toEqual({ status: 'skipped', reason: 'no_device' });
    expect(await db.execute(sql`SELECT 1 FROM rate_limit_events`)).toHaveLength(0);
  });

  it('receipts after 15 minutes: ok tickets are dropped, DeviceNotRegistered deletes the token, pending ones wait, 24-hour-old ones go', async () => {
    const t2 = await device(alice.id, 'ExponentPushToken[second]');
    await followed(await user('bob'));
    await drain();
    const tickets = await db.execute<{ ticket_id: string; token: string }>(sql`SELECT ticket_id, token FROM push_tickets ORDER BY token`);
    expect(tickets).toHaveLength(2);
    // Too young: Expo has no receipt for 15 minutes.
    expect((await processReceipts(deps)).checked).toBe(0);
    await db.execute(sql`UPDATE push_tickets SET created_at = now() - interval '20 minutes'`);
    const dead = tickets.find((t) => t.token === t2)!;
    push.setReceipt(dead.ticket_id, { status: 'error', error: 'device_not_registered' });
    expect(await processReceipts(deps)).toEqual({ checked: 2, ok: 1, failed: 1, tokensDeleted: 1, pending: 0 });
    expect(await db.execute(sql`SELECT 1 FROM push_tickets`)).toHaveLength(0);
    expect((await db.execute<{ token: string }>(sql`SELECT token FROM push_tokens`)).map((r) => r.token)).not.toContain(t2);

    await db.execute(sql`INSERT INTO push_tickets (ticket_id, token, created_at) VALUES ('p1', 'x', now() - interval '1 hour'), ('old', 'y', now() - interval '25 hours')`);
    push.setReceipt('p1', { status: 'pending' });
    push.setReceipt('old', { status: 'pending' });
    expect((await processReceipts(deps)).pending).toBe(2);
    expect((await db.execute<{ ticket_id: string }>(sql`SELECT ticket_id FROM push_tickets`)).map((r) => r.ticket_id)).toEqual(['p1']);
  });
});

describe('SO-32: the reading reminder, all six bounds (PRD §19.2 item 14 [LOCKED])', () => {
  /** 20:00 in Kolkata is 14:30 UTC. */
  const AT_8PM_IST = new Date('2026-10-12T14:30:00Z');

  async function reminderAt(time: number, extra: Record<string, unknown> = {}) {
    await prefs(alice.id, { timezone: 'Asia/Kolkata', reminder_time: time, quiet_enabled: true, ...extra });
  }

  it('bound 1: off by default — a user with a device and no setting gets nothing, ever', async () => {
    for (const iso of ['2026-10-12T00:00:00Z', '2026-10-12T12:00:00Z', '2026-10-12T14:30:00Z']) {
      clock = new Date(iso);
      expect(await sendDueReminders(deps)).toEqual({ due: 0, sent: 0, skipped: {} });
    }
    expect(push.sent).toHaveLength(0);
  });

  it('bound 2: the user\'s time only — due from that minute for 30 minutes, once a local day', async () => {
    await reminderAt(20 * 60);
    clock = new Date(AT_8PM_IST.getTime() - 60_000);
    expect((await sendDueReminders(deps)).due).toBe(0);
    clock = AT_8PM_IST;
    expect(await sendDueReminders(deps)).toEqual({ due: 1, sent: 1, skipped: {} });
    clock = new Date(AT_8PM_IST.getTime() + 5 * 60_000);
    expect((await sendDueReminders(deps)).due).toBe(0);
    // The next day, again once.
    clock = new Date(AT_8PM_IST.getTime() + 86_400_000 + 10 * 60_000);
    expect((await sendDueReminders(deps)).sent).toBe(1);
    clock = new Date(AT_8PM_IST.getTime() + 86_400_000 + 31 * 60_000);
    expect((await sendDueReminders(deps)).due).toBe(0);
    expect(push.sent).toHaveLength(2);
  });

  it('bound 2: there is no default time — off until the user sends one (the API refuses an empty setting: notifications.test.ts)', async () => {
    const svc = new NotificationService(db);
    expect((await svc.getPreferences(alice.id)).reading_reminder).toEqual({ enabled: false, time: null });
    expect((await svc.updatePreferences(alice.id, { reading_reminder: { time: '20:00' } })).reading_reminder)
      .toEqual({ enabled: true, time: '20:00' });
    // Other changes never switch it on.
    await svc.updatePreferences(alice.id, { reading_reminder: { time: null } });
    await svc.updatePreferences(alice.id, { push_enabled: true, quiet_hours: { enabled: false } });
    expect((await svc.getPreferences(alice.id)).reading_reminder).toEqual({ enabled: false, time: null });
  });

  it('bound 3: the copy is "Time to read." — no guilt, no streak, no count, no title', async () => {
    await reminderAt(20 * 60);
    clock = AT_8PM_IST;
    await sendDueReminders(deps);
    const m = push.sent[0]!;
    expect(m.body).toBe(READING_REMINDER_TEXT);
    expect(m.body).toBe('Time to read.');
    expect(m.title).toBe('Flyleaf');
    expect(`${m.title} ${m.body}`).not.toMatch(/\d|streak|Earthsea|haven't|miss|behind|!/i);
  });

  it('bound 4: no app open for 14 days suspends it silently; opening the app resumes it', async () => {
    await reminderAt(20 * 60);
    await device(alice.id, `ExponentPushToken[${alice.id.slice(0, 8)}]`, new Date(AT_8PM_IST.getTime() - 15 * 86_400_000));
    clock = AT_8PM_IST;
    expect(await sendDueReminders(deps)).toEqual({ due: 1, sent: 0, skipped: { lapsed: 1 } });
    // The app is opened (the token is refreshed); the next day's reminder goes.
    await device(alice.id, `ExponentPushToken[${alice.id.slice(0, 8)}]`, new Date(AT_8PM_IST.getTime() + 3_600_000));
    clock = new Date(AT_8PM_IST.getTime() + 86_400_000);
    expect((await sendDueReminders(deps)).sent).toBe(1);
  });

  it('bound 5: it counts against the 5-a-day ceiling, and is refused when the five are spent', async () => {
    await reminderAt(20 * 60);
    const limiter = new PgRollingRateLimiter(db);
    for (let i = 0; i < 5; i++) await limiter.hit(`push:day:${alice.id}`, 5, 86_400);
    clock = AT_8PM_IST;
    expect(await sendDueReminders(deps)).toEqual({ due: 1, sent: 0, skipped: { daily_cap: 1 } });

    // And a sent reminder uses one of the five.
    await db.execute(sql`DELETE FROM rate_limit_events`);
    clock = new Date(AT_8PM_IST.getTime() + 86_400_000);
    await sendDueReminders(deps);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rate_limit_events WHERE bucket = ${`push:day:${alice.id}`}`);
    expect(n!.n).toBe(1);
  });

  it('bound 6: one tap to turn it off — the push carries the reading_reminder category, and turning it off stops the next one', async () => {
    await reminderAt(20 * 60);
    clock = AT_8PM_IST;
    await sendDueReminders(deps);
    expect(push.sent[0]).toMatchObject({ categoryId: 'reading_reminder', data: { type: 'reading_reminder', url: 'flyleaf://reading' } });
    // What the app's "Turn off" action sends.
    await new NotificationService(db).updatePreferences(alice.id, { reading_reminder: { time: null } });
    clock = new Date(AT_8PM_IST.getTime() + 86_400_000);
    expect((await sendDueReminders(deps)).due).toBe(0);
  });

  it('quiet hours still apply to a reminder set inside them (dropped, not held), and new accounts get none', async () => {
    await reminderAt(23 * 60); // 23:00 IST, inside 22:00–08:00
    clock = new Date('2026-10-12T17:30:00Z');
    expect(await sendDueReminders(deps)).toEqual({ due: 1, sent: 0, skipped: { quiet_hours: 1 } });
    expect(queue.jobs).toHaveLength(0);
    clock = new Date(AT_8PM_IST.getTime() + 86_400_000);
    await db.update(users).set({ createdAt: new Date(clock.getTime() - 3_600_000) }).where(eq(users.id, alice.id));
    await reminderAt(20 * 60);
    expect(await sendDueReminders(deps)).toEqual({ due: 1, sent: 0, skipped: { new_user_grace: 1 } });
  });

  it('a time changed today may fire today; two overlapping runs send it once', async () => {
    await reminderAt(20 * 60);
    clock = AT_8PM_IST;
    await sendDueReminders(deps);
    await new NotificationService(db).updatePreferences(alice.id, { reading_reminder: { time: '21:00' } });
    clock = new Date(AT_8PM_IST.getTime() + 60 * 60_000);
    const [a, b] = await Promise.all([sendDueReminders(deps), sendDueReminders(deps)]);
    expect(a.sent + b.sent).toBe(1);
    expect(push.sent).toHaveLength(2);
  });
});
