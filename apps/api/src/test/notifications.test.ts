// SO-30 and SO-32 (API side): notifications are written with the event,
// pushes are queued (never sent in the request), and every row respects
// blocks, mutes, private accounts and deleted content, at write time and at
// read time. PRD §19, §6.14, §24.2; AC-19.

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { MemoryNotifyQueue, Notifier, NOTIFICATION_CATEGORIES } from '../notify/index.js';
import { blocks, follows, imports, mutes, profiles, reads, users } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, follow, block, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let queue: MemoryNotifyQueue;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let workId: string;
let readId: string;

async function setup() {
  ({ db } = await freshDrizzle());
  queue = new MemoryNotifyQueue();
  app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, notifyQueue: queue });
  await app.ready();
  alice = await makeUser(db, 'alice');
  bob = await makeUser(db, 'bob');
  carol = await makeUser(db, 'carol');
  workId = await makeWork(db, 'A Wizard of Earthsea');
  readId = await makeRead(db, alice.id, workId, { status: 'finished' });
  // Accounts that already had their first follower (ST-10's warm note is
  // tested in milestones.test.ts): these tests count follow rows only.
  await db.execute(sql`INSERT INTO milestones (user_id, key, seen_at)
    SELECT id, 'first_follower', now() FROM users ON CONFLICT DO NOTHING`);
}

const req = (who: TestUser | null, method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, headers: who ? who.auth : {}, ...(payload !== undefined ? { payload } : {}) });

const list = async (who: TestUser, query = '') => {
  const res = await req(who, 'GET', `/v1/notifications${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as {
    items: Array<{ id: string; type: string; text: string; deep_link: string; read: boolean; actor: { id: string; username: string } | null; actor_count: number }>;
    next_cursor: string | null;
    unread_count: number;
  };
};

describe('SO-30: notifications are written with the event', () => {
  beforeEach(setup);

  it('a follow notifies the followee, with a deep link to the follower, and queues one push', async () => {
    expect((await req(bob, 'POST', `/v1/users/${alice.id}/follow`)).statusCode).toBe(200);
    const body = await list(alice);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ type: 'follow', text: 'bob followed you', read: false, actor_count: 1 });
    expect(body.items[0]!.deep_link).toBe(`flyleaf://user/${bob.id}`);
    expect(body.unread_count).toBe(1);
    expect(queue.jobs).toEqual([{ job: { notificationId: body.items[0]!.id, mode: 'single', actorId: bob.id }, startAfter: undefined }]);
    // Bob is told nothing about his own follow (PRD §19.1).
    expect((await list(bob)).items).toHaveLength(0);
  });

  it('follows aggregate into one row while unread: "carol and 1 other followed you"', async () => {
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    await req(carol, 'POST', `/v1/users/${alice.id}/follow`);
    const { items } = await list(alice);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'carol and 1 other followed you', actor_count: 2 });
    expect(items[0]!.deep_link).toBe(`flyleaf://user/${alice.id}/followers`);
    // Each follow has its own job: the worker decides single or digest (≤ 3 an hour).
    expect(queue.jobs.map((j) => j.job.actorId)).toEqual([bob.id, carol.id]);
  });

  it('a replayed follow writes no second actor and no second job; an unfollow takes the actor out', async () => {
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    expect(queue.jobs).toHaveLength(1);
    await req(bob, 'DELETE', `/v1/users/${alice.id}/follow`);
    expect((await list(alice)).items).toHaveLength(0);
  });

  it('a private account gets a follow request, not a follower; accept or reject clears it', async () => {
    const dana = await makeUser(db, 'dana', { isPrivate: true });
    await req(bob, 'POST', `/v1/users/${dana.id}/follow`);
    await req(carol, 'POST', `/v1/users/${dana.id}/follow`);
    let items = (await list(dana)).items;
    expect(items.map((i) => [i.type, i.text]).sort()).toEqual([
      ['follow_request', 'bob asked to follow you'],
      ['follow_request', 'carol asked to follow you'],
    ]);
    expect(items[0]!.deep_link).toBe('flyleaf://profile/requests');

    await req(dana, 'POST', `/v1/me/follow-requests/${bob.id}/accept`);
    await req(dana, 'POST', `/v1/me/follow-requests/${carol.id}/reject`);
    items = (await list(dana)).items;
    // Accepting is the recipient's own act: no "new follower" either.
    expect(items).toHaveLength(0);
  });

  it('a cancelled request leaves no row', async () => {
    const dana = await makeUser(db, 'dana', { isPrivate: true });
    await req(bob, 'POST', `/v1/users/${dana.id}/follow`);
    await req(bob, 'DELETE', `/v1/users/${dana.id}/follow`);
    expect((await list(dana)).items).toHaveLength(0);
  });

  it('likes aggregate per read, and queue ONE digest an hour out (PRD §19.3)', async () => {
    const before = Date.now();
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    await req(carol, 'POST', `/v1/reads/${readId}/like`);
    const { items } = await list(alice);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'like', text: 'carol and 1 other liked your read of A Wizard of Earthsea', actor_count: 2 });
    expect(items[0]!.deep_link).toBe(`flyleaf://read/${readId}/comments?work=${workId}`);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]!.job).toEqual({ notificationId: items[0]!.id, mode: 'digest' });
    const delay = queue.jobs[0]!.startAfter!.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5_000);
    expect(delay).toBeLessThanOrEqual(60 * 60 * 1000 + 5_000);
  });

  it('a like on a reviewed read says "review" and links to the review', async () => {
    const [rv] = await db.execute<{ id: string }>(sql`
      INSERT INTO reviews (read_id, user_id, work_id, body) VALUES (${readId}::uuid, ${alice.id}::uuid, ${workId}::uuid, 'Good.') RETURNING id`);
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    const [item] = (await list(alice)).items;
    expect(item!.text).toBe('bob liked your review of A Wizard of Earthsea');
    expect(item!.deep_link).toBe(`flyleaf://review/${rv!.id}?work=${workId}`);
  });

  it('a replayed like is silent; an unlike takes the liker out, and the last one takes the row', async () => {
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    await req(carol, 'POST', `/v1/reads/${readId}/like`);
    await req(carol, 'DELETE', `/v1/reads/${readId}/like`);
    expect((await list(alice)).items[0]).toMatchObject({ text: 'bob liked your read of A Wizard of Earthsea', actor_count: 1 });
    await req(bob, 'DELETE', `/v1/reads/${readId}/like`);
    expect((await list(alice)).items).toHaveLength(0);
  });

  it('a read group is closed: the next like opens a new row', async () => {
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    await req(alice, 'POST', '/v1/notifications/read', {});
    await req(carol, 'POST', `/v1/reads/${readId}/like`);
    const { items, unread_count } = await list(alice);
    expect(items.map((i) => [i.text, i.read])).toEqual([
      ['carol liked your read of A Wizard of Earthsea', false],
      ['bob liked your read of A Wizard of Earthsea', true],
    ]);
    expect(unread_count).toBe(1);
  });

  it('a comment notifies the read\'s owner with a link to the thread; deleting it removes the row', async () => {
    const c = (await req(bob, 'POST', `/v1/reads/${readId}/comments`, { body: 'Loved this' })).json();
    let { items } = await list(alice);
    expect(items[0]).toMatchObject({ type: 'comment', text: 'bob commented on your read of A Wizard of Earthsea' });
    expect(items[0]!.deep_link).toBe(`flyleaf://read/${readId}/comments?work=${workId}`);
    expect(queue.jobs.at(-1)!.job).toMatchObject({ mode: 'single', actorId: bob.id });
    await req(bob, 'DELETE', `/v1/comments/${c.id}`);
    ({ items } = await list(alice));
    expect(items).toHaveLength(0);
  });

  it('never about your own behaviour: liking or commenting on your own read notifies nobody', async () => {
    await req(alice, 'POST', `/v1/reads/${readId}/like`);
    await req(alice, 'POST', `/v1/reads/${readId}/comments`, { body: 'Note to self' });
    expect((await list(alice)).items).toHaveLength(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it('import complete: sent once, however often the job retries', async () => {
    const [imp] = await db.insert(imports).values({ userId: alice.id, source: 'goodreads', state: 'completed', matched: 812, unmatched: 3 }).returning({ id: imports.id });
    const notifier = new Notifier(queue);
    await notifier.importCompleted(db, alice.id, imp!.id);
    await notifier.importCompleted(db, alice.id, imp!.id);
    const { items } = await list(alice);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'import_complete', text: 'Your Goodreads import is done: 812 books added, 3 to review', actor: null });
    expect(items[0]!.deep_link).toBe(`flyleaf://import/unmatched?id=${imp!.id}`);
    expect(queue.jobs).toHaveLength(1);
  });

  it('the push is queued in the write\'s transaction: a rolled-back like leaves no row and no job', async () => {
    const notifier = new Notifier(queue);
    const jobsBefore = queue.jobs.length;
    await db.transaction(async (tx) => {
      await notifier.like(tx as unknown as Db, bob.id, readId);
      tx.rollback();
    }).catch(() => undefined);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications`);
    expect(n!.n).toBe(0);
    // MemoryNotifyQueue records the call; with pg-boss the job rides the same
    // transaction (bossNotifyQueue → sendInTx), proven in notify-jobs.test.ts.
    expect(queue.jobs.length - jobsBefore).toBe(1);
  });
});

describe('SO-30: blocks, mutes, private accounts and deleted accounts, on every notification', () => {
  beforeEach(setup);

  it('a block either way before the event: no notification at all', async () => {
    const notifier = new Notifier(queue);
    await block(db, alice.id, bob.id);
    await notifier.like(db, bob.id, readId);
    await notifier.follow(db, bob.id, alice.id, 'accepted');
    await db.delete(blocks);
    await block(db, bob.id, alice.id);
    await notifier.comment(db, bob.id, readId, crypto.randomUUID());
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications`);
    expect(n!.n).toBe(0);
    expect(queue.jobs).toHaveLength(0);
  });

  it('a block after the event hides the actor from the list and the badge, and the other actors stay', async () => {
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    await req(carol, 'POST', `/v1/reads/${readId}/like`);
    await req(bob, 'POST', `/v1/reads/${readId}/comments`, { body: 'Hi' });
    await block(db, bob.id, alice.id); // Bob blocks Alice: she must not see him either.
    const body = await list(alice);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ type: 'like', text: 'carol liked your read of A Wizard of Earthsea', actor_count: 1 });
    expect(body.unread_count).toBe(1);
    expect((await req(alice, 'GET', '/v1/notifications/unread-count')).json()).toEqual({ unread_count: 1 });
  });

  it('a muted actor: no notification; a mute added later hides the old ones, and unmuting shows them', async () => {
    await db.insert(mutes).values({ userId: alice.id, targetType: 'user', targetId: bob.id });
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    expect((await list(alice)).items).toHaveLength(0);
    await db.delete(mutes);

    await req(carol, 'POST', `/v1/users/${alice.id}/follow`);
    await db.insert(mutes).values({ userId: alice.id, targetType: 'user', targetId: carol.id });
    expect((await list(alice)).items).toHaveLength(0);
    await db.delete(mutes).where(and(eq(mutes.userId, alice.id), eq(mutes.targetId, carol.id)));
    expect((await list(alice)).items).toHaveLength(1);
  });

  it('private account: an actor who cannot see the read is never notified about, and one who loses access disappears', async () => {
    const notifier = new Notifier(queue);
    // A followers-only read, a non-follower: the like path would 404, and the notifier refuses too.
    const fo = await makeRead(db, alice.id, await makeWork(db, 'Tehanu'), { status: 'finished', visibility: 'followers' });
    await notifier.like(db, bob.id, fo);
    expect((await list(alice)).items).toHaveLength(0);

    // Carol liked a public read; then Alice goes private and Carol does not follow her.
    await req(carol, 'POST', `/v1/reads/${readId}/like`);
    expect((await list(alice)).items).toHaveLength(1);
    await db.update(profiles).set({ isPrivate: true }).where(eq(profiles.userId, alice.id));
    expect((await list(alice)).items).toHaveLength(0);
    // Once Carol is an accepted follower she can see it again, and so can the row.
    await follow(db, carol.id, alice.id);
    expect((await list(alice)).items).toHaveLength(1);
  });

  it('a deleted account\'s notifications go with it, both as actor and as recipient', async () => {
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    await req(alice, 'POST', `/v1/users/${carol.id}/follow`);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bob.id));
    expect((await list(alice)).items).toHaveLength(0);
  });

  it('deleted content: a read that is no longer finished, or is gone, takes its rows', async () => {
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    await req(carol, 'POST', `/v1/reads/${readId}/comments`, { body: 'Yes' });
    await db.update(reads).set({ status: 'reading' }).where(eq(reads.id, readId));
    expect((await list(alice)).items).toHaveLength(0);
    await db.update(reads).set({ status: 'finished' }).where(eq(reads.id, readId));
    expect((await list(alice)).items).toHaveLength(2);
    await db.delete(reads).where(eq(reads.id, readId));
    expect((await list(alice)).items).toHaveLength(0);
  });

  it('an unfollow after a follow notification removes it; a block severs it too', async () => {
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    await req(carol, 'POST', `/v1/users/${alice.id}/follow`);
    await db.delete(follows).where(and(eq(follows.followerId, carol.id), eq(follows.followeeId, alice.id)));
    expect((await list(alice)).items[0]).toMatchObject({ text: 'bob followed you', actor_count: 1 });
  });
});

describe('SO-33 API: the list, read state, and who may touch what', () => {
  beforeEach(setup);

  it('guests get 401 on every route', async () => {
    for (const [method, url] of [
      ['GET', '/v1/notifications'],
      ['GET', '/v1/notifications/unread-count'],
      ['POST', '/v1/notifications/read'],
      ['GET', '/v1/me/notification-preferences'],
      ['PATCH', '/v1/me/notification-preferences'],
      ['PUT', '/v1/me/push-tokens'],
    ] as const) {
      const res = await req(null, method, url, method === 'GET' ? undefined : {});
      expect([401, 422]).toContain(res.statusCode);
      if (res.statusCode === 422) expect(method).toBe('PUT'); // schema runs first for a body that cannot be valid
    }
    expect((await req(null, 'GET', '/v1/notifications')).statusCode).toBe(401);
  });

  it('marks given ids read; someone else\'s id changes nothing and says nothing', async () => {
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    await req(alice, 'POST', `/v1/users/${carol.id}/follow`);
    const aliceItem = (await list(alice)).items[0]!;
    const carolItem = (await list(carol)).items[0]!;
    const res = await req(alice, 'POST', '/v1/notifications/read', { ids: [carolItem.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unread_count: 1 });
    expect((await list(carol)).items[0]!.read).toBe(false);
    expect((await req(alice, 'POST', '/v1/notifications/read', { ids: [aliceItem.id] })).json()).toEqual({ unread_count: 0 });
    expect((await list(alice)).items[0]!.read).toBe(true);
  });

  it('a malformed id or cursor is refused', async () => {
    expect((await req(alice, 'POST', '/v1/notifications/read', { ids: ['nope'] })).statusCode).toBe(422);
    const bad = await req(alice, 'GET', '/v1/notifications?cursor=bm90LWEtY3Vyc29y');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_cursor');
  });

  it('pages newest activity first with an opaque cursor, no repeats and no gaps', async () => {
    const actors: TestUser[] = [];
    for (let i = 0; i < 5; i++) actors.push(await makeUser(db, `fan${i}`));
    // Five reads liked by one fan each: five rows.
    for (let i = 0; i < 5; i++) {
      const r = await makeRead(db, alice.id, await makeWork(db, `Book ${i}`), { status: 'finished' });
      await req(actors[i]!, 'POST', `/v1/reads/${r}/like`);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof list>> = await list(alice, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((i) => i.text));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual([4, 3, 2, 1, 0].map((i) => `fan${i} liked your read of Book ${i}`));
  });

  it('an aggregated row moves to the top when it gains an actor', async () => {
    const other = await makeRead(db, alice.id, await makeWork(db, 'Tehanu'), { status: 'finished' });
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    await req(bob, 'POST', `/v1/reads/${other}/like`);
    await req(carol, 'POST', `/v1/reads/${readId}/like`);
    expect((await list(alice)).items.map((i) => i.text)).toEqual([
      'carol and 1 other liked your read of A Wizard of Earthsea',
      'bob liked your read of Tehanu',
    ]);
  });
});

describe('SO-30: push tokens', () => {
  beforeEach(setup);

  it('registers, refreshes, moves with the device to another account, and deletes only your own', async () => {
    const token = 'ExponentPushToken[abc123]';
    expect((await req(alice, 'PUT', '/v1/me/push-tokens', { token, platform: 'android', timezone: 'Asia/Kolkata' })).json())
      .toEqual({ registered: true });
    expect((await req(alice, 'GET', '/v1/me/notification-preferences')).json().timezone).toBe('Asia/Kolkata');
    await req(bob, 'PUT', '/v1/me/push-tokens', { token, platform: 'android' });
    const rows = await db.execute<{ user_id: string }>(sql`SELECT user_id FROM push_tokens`);
    expect(rows).toEqual([{ user_id: bob.id }]);
    // Alice cannot delete what is now Bob's.
    expect((await req(alice, 'DELETE', `/v1/me/push-tokens/${encodeURIComponent(token)}`)).statusCode).toBe(204);
    expect(await db.execute(sql`SELECT 1 FROM push_tokens`)).toHaveLength(1);
    await req(bob, 'DELETE', `/v1/me/push-tokens/${encodeURIComponent(token)}`);
    expect(await db.execute(sql`SELECT 1 FROM push_tokens`)).toHaveLength(0);
  });

  it('refuses what is not an Expo token, and ignores an unknown time zone', async () => {
    const bad = await req(alice, 'PUT', '/v1/me/push-tokens', { token: 'fcm:xyz', platform: 'android' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_token');
    await req(alice, 'PUT', '/v1/me/push-tokens', { token: 'ExponentPushToken[x]', platform: 'ios', timezone: 'Mars/Olympus' });
    expect((await req(alice, 'GET', '/v1/me/notification-preferences')).json().timezone).toBe('UTC');
  });
});

describe('SO-32: per-category preferences', () => {
  beforeEach(setup);

  it('defaults: all 13 categories, PRD §19.2 defaults, quiet hours 22:00–08:00, reminder off', async () => {
    const body = (await req(alice, 'GET', '/v1/me/notification-preferences')).json();
    expect(body.categories).toHaveLength(13);
    expect(body.categories.map((c: { key: string }) => c.key)).toEqual(NOTIFICATION_CATEGORIES.map((c) => c.key));
    const by = Object.fromEntries(body.categories.map((c: { key: string }) => [c.key, c]));
    expect(by.new_follower).toMatchObject({ push: true, in_app: true, live: true });
    expect(by.friend_finished_want).toMatchObject({ push: false, in_app: null });
    expect(by.author_new_book).toMatchObject({ push: false, in_app: null });
    expect(by.weekly_summary).toMatchObject({ push: false, in_app: null });
    expect(by.milestones).toMatchObject({ push: null, in_app: true });
    expect(body).toMatchObject({
      push_enabled: true,
      quiet_hours: { enabled: true, start: '22:00', end: '08:00' },
      reading_reminder: { enabled: false, time: null },
    });
  });

  it('every category is individually switchable, per channel, and each switch is obeyed', async () => {
    const patch = await req(alice, 'PATCH', '/v1/me/notification-preferences', {
      categories: { likes: { in_app: false, push: false }, new_follower: { in_app: false } },
    });
    expect(patch.statusCode).toBe(200);
    // Likes off entirely: no row, no job.
    await req(bob, 'POST', `/v1/reads/${readId}/like`);
    // Follows push-only: a row exists for the push but the list leaves it out.
    await req(carol, 'POST', `/v1/users/${alice.id}/follow`);
    expect((await list(alice)).items).toHaveLength(0);
    const rows = await db.execute<{ type: string; in_app: boolean }>(sql`SELECT type, in_app FROM notifications`);
    expect(rows).toEqual([{ type: 'follow', in_app: false }]);
    expect(queue.jobs.map((j) => j.job.actorId)).toEqual([carol.id]);
    // Comments in-app only: a row, no job.
    await req(alice, 'PATCH', '/v1/me/notification-preferences', { categories: { comments: { push: false } } });
    await req(bob, 'POST', `/v1/reads/${readId}/comments`, { body: 'x' });
    expect((await list(alice)).items.map((i) => i.type)).toEqual(['comment']);
    expect(queue.jobs).toHaveLength(1);
  });

  it('the master switch stops every push and keeps the in-app list', async () => {
    await req(alice, 'PATCH', '/v1/me/notification-preferences', { push_enabled: false });
    await req(bob, 'POST', `/v1/users/${alice.id}/follow`);
    expect((await list(alice)).items).toHaveLength(1);
    expect(queue.jobs).toHaveLength(0);
  });

  it('refuses unknown categories, channels a category does not have, bad times and unknown zones', async () => {
    const cases: Array<[object, number, string?]> = [
      [{ categories: { spam: { push: true } } }, 400, 'unknown_category'],
      [{ categories: { milestones: { push: true } } }, 400, 'channel_unavailable'],
      [{ categories: { weekly_summary: { in_app: true } } }, 400, 'channel_unavailable'],
      [{ quiet_hours: { start: '25:00' } }, 422],
      [{ quiet_hours: { start: '7:00' } }, 422],
      [{ timezone: 'Not/AZone' }, 400, 'invalid_timezone'],
      [{ reading_reminder: {} }, 422],
      [{ reading_reminder: { time: '8pm' } }, 422],
    ];
    for (const [payload, status, code] of cases) {
      const res = await req(alice, 'PATCH', '/v1/me/notification-preferences', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(status);
      if (code) expect(res.json().error.code).toBe(code);
    }
    // Nothing was stored by any of them.
    expect(await db.execute(sql`SELECT 1 FROM notification_preferences`)).toHaveLength(0);
  });

  it('quiet hours and time zone are adjustable', async () => {
    const body = (await req(alice, 'PATCH', '/v1/me/notification-preferences', {
      quiet_hours: { enabled: true, start: '23:30', end: '06:15' },
      timezone: 'Europe/London',
    })).json();
    expect(body).toMatchObject({ quiet_hours: { enabled: true, start: '23:30', end: '06:15' }, timezone: 'Europe/London' });
  });
});

describe('api-client: the built client against the real app', () => {
  beforeEach(setup);

  it('lists, counts, marks read, reads and changes preferences, and registers a token', async () => {
    const { FlyleafClient } = await import('../../../../packages/api-client/dist/index.js');
    const as = (who: TestUser) =>
      new FlyleafClient({
        baseUrl: 'http://localhost/v1',
        getToken: () => who.token,
        fetch: (async (url: string | URL, init?: RequestInit) => {
          const u = new URL(url.toString());
          const res = await app.inject({
            method: (init?.method as 'GET') ?? 'GET',
            url: `${u.pathname}${u.search}`,
            headers: init?.headers as Record<string, string>,
            payload: init?.body ? String(init.body) : undefined,
          });
          return { ok: res.statusCode < 300, status: res.statusCode, headers: new Headers(), text: async () => res.payload } as unknown as Response;
        }) as typeof fetch,
      });
    await as(bob).followUser(alice.id);
    const client = as(alice);
    const page = await client.getNotifications({ limit: 10 });
    expect(page.items[0]).toMatchObject({ type: 'follow', text: 'bob followed you' });
    expect((await client.getUnreadNotificationCount()).unread_count).toBe(1);
    expect((await client.markNotificationsRead([page.items[0]!.id])).unread_count).toBe(0);
    expect((await client.markNotificationsRead()).unread_count).toBe(0);
    const prefs = await client.updateNotificationPreferences({ reading_reminder: { time: '20:30' }, categories: { likes: { push: false } } });
    expect(prefs.reading_reminder).toEqual({ enabled: true, time: '20:30' });
    expect((await client.getNotificationPreferences()).categories.find((c) => c.key === 'likes')!.push).toBe(false);
    expect(await client.registerPushToken({ token: 'ExponentPushToken[z]', platform: 'android', timezone: 'Asia/Kolkata' })).toEqual({ registered: true });
    await client.unregisterPushToken('ExponentPushToken[z]');
    expect(await db.execute(sql`SELECT 1 FROM push_tokens`)).toHaveLength(0);
  });
});
