// Owner decisions on SO-3x (12 Oct 2026):
//
//   1. "Replies" (PRD §19.2 item 5): other people's comments on a read whose
//      thread you commented in. Never the read's owner (they get `comment`),
//      never the commenter. At most one push per thread per hour. Blocks,
//      mutes and visibility apply as on every other notification.
//   2. Notifications are kept 180 days, like activity, by the retention sweep.

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, PgRollingRateLimiter, type Db } from '../platform/index.js';
import { MemoryNotifyQueue, NOTIFICATION_CATEGORIES } from '../notify/index.js';
import { deliverNotification } from '../notify/delivery.js';
import { MemoryPushSender } from '../providers/push/index.js';
import { retentionSweep, NOTIFICATION_RETENTION_DAYS } from '../jobs/retention.js';
import { reads, users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, follow, block, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let queue: MemoryNotifyQueue;
let alice: TestUser; // the read's owner
let bob: TestUser;
let carol: TestUser;
let dave: TestUser;
let readId: string;

async function setup() {
  ({ db } = await freshDrizzle());
  queue = new MemoryNotifyQueue();
  app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, notifyQueue: queue });
  await app.ready();
  [alice, bob, carol, dave] = [await makeUser(db, 'alice'), await makeUser(db, 'bob'), await makeUser(db, 'carol'), await makeUser(db, 'dave')];
  readId = await makeRead(db, alice.id, await makeWork(db, 'Earthsea'), { status: 'finished' });
}

const req = (who: TestUser, method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: who.auth, ...(payload !== undefined ? { payload } : {}) });

async function comment(who: TestUser, body = 'A thought') {
  const res = await req(who, 'POST', `/v1/reads/${readId}/comments`, { body });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function items(who: TestUser) {
  const res = await req(who, 'GET', '/v1/notifications');
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ id: string; type: string; text: string; deep_link: string; actor_count: number }>;
}

const replies = async (who: TestUser) => (await items(who)).filter((i) => i.type === 'reply');

describe('replies (PRD §19.2 item 5): a thread you commented in', () => {
  beforeEach(setup);

  it('everyone else in the thread hears of a new comment; the owner gets "comment", the commenter nothing', async () => {
    await comment(bob);
    await comment(carol);
    await comment(dave);
    const [b] = await replies(bob);
    expect(b).toMatchObject({ text: "dave and 1 other also commented on alice's read of Earthsea", actor_count: 2 });
    expect(b!.deep_link).toBe(`flyleaf://read/${readId}/comments?work=${(await db.select().from(reads).where(eq(reads.id, readId)))[0]!.workId}`);
    expect((await replies(carol)).map((r) => r.actor_count)).toEqual([1]); // dave only
    expect(await replies(dave)).toEqual([]);
    // The owner: three `comment` rows and never a reply.
    expect((await items(alice)).map((i) => i.type)).toEqual(['comment', 'comment', 'comment']);
  });

  it('the owner commenting in their own thread is a reply for the others, and the owner is never a recipient', async () => {
    await comment(bob);
    await comment(alice, 'Thanks!');
    expect((await replies(bob))[0]).toMatchObject({ text: "alice also commented on alice's read of Earthsea" });
    await comment(carol);
    expect(await replies(alice)).toEqual([]);
  });

  it('one row per thread while unread; read rows close and the next reply opens a new one', async () => {
    await comment(bob);
    await comment(carol);
    await comment(dave);
    expect(await replies(bob)).toHaveLength(1);
    await req(bob, 'POST', '/v1/notifications/read', {});
    await comment(carol, 'again');
    expect((await replies(bob)).map((r) => r.actor_count)).toEqual([1, 2]);
  });

  it('switched off (comment_replies), nothing is written; the category is live', async () => {
    const prefs = (await req(bob, 'GET', '/v1/me/notification-preferences')).json();
    expect(prefs.categories.find((c: { key: string }) => c.key === 'comment_replies')).toMatchObject({ live: true, push: true, in_app: true });
    expect(NOTIFICATION_CATEGORIES.find((c) => c.key === 'comment_replies')?.emits).toBe(true);
    await req(bob, 'PATCH', '/v1/me/notification-preferences', { categories: { comment_replies: { in_app: false, push: false } } });
    await comment(bob);
    await comment(carol);
    expect(await db.execute(sql`SELECT 1 FROM notifications WHERE user_id = ${bob.id}::uuid`)).toHaveLength(0);
  });

  it('a block either way: no reply before it, and the actor disappears after it', async () => {
    await comment(bob);
    await block(db, bob.id, dave.id);
    await comment(dave);
    expect(await replies(bob)).toEqual([]);
    await comment(carol);
    expect((await replies(bob)).map((r) => r.text)).toEqual(["carol also commented on alice's read of Earthsea"]);
    // carol blocks bob afterwards: her reply goes from bob's list and badge.
    await block(db, carol.id, bob.id);
    expect(await replies(bob)).toEqual([]);
    expect((await req(bob, 'GET', '/v1/notifications/unread-count')).json().unread_count).toBe(0);
  });

  it('a muted commenter, or a muted read owner: no reply; a mute added later hides it until unmuted', async () => {
    await comment(bob);
    await req(bob, 'POST', `/v1/users/${dave.id}/mute`);
    await comment(dave);
    expect(await replies(bob)).toEqual([]);
    await comment(carol);
    expect((await replies(bob)).map((r) => r.text)).toEqual(["carol also commented on alice's read of Earthsea"]);
    // Muting the read's owner hides the thread's replies (read time) ...
    await req(bob, 'POST', `/v1/users/${alice.id}/mute`);
    expect(await replies(bob)).toEqual([]);
    // ... writes none while it lasts (write time) ...
    const erin = await makeUser(db, 'erin');
    await comment(erin);
    expect(await db.execute(sql`
      SELECT 1 FROM notification_actors na JOIN notifications n ON n.id = na.notification_id
      WHERE n.user_id = ${bob.id}::uuid AND na.actor_id = ${erin.id}::uuid`)).toHaveLength(0);
    // ... and unmuting shows what was there.
    await req(bob, 'DELETE', `/v1/users/${alice.id}/mute`);
    expect((await replies(bob)).map((r) => r.text)).toEqual(["carol also commented on alice's read of Earthsea"]);
  });

  it('visibility: a participant who can no longer see the read hears nothing more, and loses what they had', async () => {
    // A followers-only read: bob and carol follow alice and comment.
    await db.update(reads).set({ visibility: 'followers' }).where(eq(reads.id, readId));
    await follow(db, bob.id, alice.id);
    await follow(db, carol.id, alice.id);
    await comment(bob);
    await comment(carol);
    expect(await replies(bob)).toHaveLength(1);
    // bob unfollows: the read is no longer his to see.
    await req(bob, 'DELETE', `/v1/users/${alice.id}/follow`);
    expect(await replies(bob)).toEqual([]);
    await follow(db, dave.id, alice.id);
    await comment(dave);
    expect(await db.execute(sql`
      SELECT 1 FROM notification_actors na JOIN notifications n ON n.id = na.notification_id
      WHERE n.user_id = ${bob.id}::uuid AND na.actor_id = ${dave.id}::uuid`)).toHaveLength(0);
    expect((await replies(carol)).map((r) => r.actor_count)).toEqual([1]); // carol still hears of dave
    // The read made private: nobody but alice may see it.
    await db.update(reads).set({ visibility: 'private' }).where(eq(reads.id, readId));
    expect(await replies(carol)).toEqual([]);
  });

  it('a commenter who deletes their comment leaves the reply; the last one takes it from the list', async () => {
    await comment(bob);
    const c = await comment(carol);
    expect(await replies(bob)).toHaveLength(1);
    expect((await req(carol, 'DELETE', `/v1/comments/${c}`)).statusCode).toBe(204);
    expect(await replies(bob)).toEqual([]);
  });
});

describe('replies push at most once per thread per hour', () => {
  beforeEach(setup);

  it('the second reply in the hour stays in the list; an hour later it pushes again', async () => {
    const push = new MemoryPushSender();
    const clock = new Date('2026-10-12T14:00:00Z');
    const deps = { db, push, limiter: new PgRollingRateLimiter(db), queue, now: () => clock };
    await db.update(users).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) });
    await db.execute(sql`INSERT INTO push_tokens (token, user_id, platform) VALUES ('ExponentPushToken[bob]', ${bob.id}::uuid, 'android')`);
    await comment(bob);
    queue.jobs.splice(0);
    await comment(carol);
    await comment(dave);
    const bobJobs = async () => {
      const out = [];
      for (const j of queue.jobs.splice(0)) {
        const [n] = await db.execute<{ user_id: string }>(sql`SELECT user_id FROM notifications WHERE id = ${j.job.notificationId}::uuid`);
        if (n?.user_id === bob.id) out.push(await deliverNotification(deps, j.job));
      }
      return out.map((r) => (r.status === 'skipped' ? r.reason : r.status));
    };
    expect(await bobJobs()).toEqual(['sent', 'thread_hourly']);
    expect(push.sent.map((m) => m.body)).toEqual(["carol also commented on alice's read of Earthsea"]);
    await db.execute(sql`UPDATE rate_limit_events SET at = at - interval '61 minutes'`);
    await req(bob, 'POST', '/v1/notifications/read', {});
    await comment(carol, 'later');
    expect(await bobJobs()).toEqual(['sent']);
  });
});

describe('notification retention: 180 days, like activity (owner decision on SO-3x)', () => {
  beforeEach(setup);

  it('the retention sweep deletes notifications not touched for 180 days, with their actors, and keeps the rest', async () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(180);
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    await req(carol, 'POST', `/v1/reads/${readId}/like`);
    await comment(dave);
    const rows = await db.execute<{ id: string; type: string }>(sql`SELECT id, type FROM notifications ORDER BY type`);
    const id = (t: string) => rows.find((r) => r.type === t)!.id;
    // 181 days: gone. 179 days: kept. Created long ago but updated recently (a group still gaining actors): kept.
    await db.execute(sql`UPDATE notifications SET created_at = now() - interval '181 days', updated_at = now() - interval '181 days' WHERE id = ${id('follow')}::uuid`);
    await db.execute(sql`UPDATE notifications SET created_at = now() - interval '179 days', updated_at = now() - interval '179 days' WHERE id = ${id('like')}::uuid`);
    await db.execute(sql`UPDATE notifications SET created_at = now() - interval '400 days', updated_at = now() - interval '1 day' WHERE id = ${id('comment')}::uuid`);
    const r = await retentionSweep(db, null);
    expect(r.notifications).toBe(1);
    const left = await db.execute<{ type: string }>(sql`SELECT type FROM notifications ORDER BY type`);
    expect(left.map((x) => x.type)).toEqual(['comment', 'like']);
    expect(await db.execute(sql`SELECT 1 FROM notification_actors WHERE notification_id = ${id('follow')}::uuid`)).toHaveLength(0);
  });
});
