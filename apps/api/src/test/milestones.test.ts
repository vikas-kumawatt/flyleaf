// ST-10: milestone moments (PRD §18.4, §19.2 item 12, §8.6).
//
// Each fires once, in-app only: a moment the app shows and a row in the
// notification list under `milestones`, never a push (the category has no
// push channel) and never a feed card. Only the in-app action that reaches a
// milestone celebrates it; one passed by an import is stored silently.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';

import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import type { Db } from '../platform/index.js';
import { goals, notificationPreferences, reads } from '../db/schema.js';
import { MemoryNotifyQueue, compose, viewNotification } from '../notify/index.js';
import { freshDrizzle } from './pg.js';
import { block, makeRead, makeUser, makeWork, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let reading: ReadingService;
const queue = new MemoryNotifyQueue();

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  reading = new ReadingService(db);
  app = await buildApp({ db, identity: new IdentityService(db, unlimited), reading, limiter: unlimited, notifyQueue: queue });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await close?.();
});

const unseen = async (u: TestUser, q = '') => (await app.inject({ method: 'GET', url: `/v1/me/milestones${q}`, headers: u.auth })).json();
const keys = async (u: TestUser) => (await unseen(u)).milestones.map((m: { key: string }) => m.key);
const stored = async (u: TestUser) => (await db.execute<{ key: string; seen: boolean }>(sql`
  SELECT key, seen_at IS NOT NULL AS seen FROM milestones WHERE user_id = ${u.id}::uuid ORDER BY key`)).map((r) => `${r.key}${r.seen ? ':seen' : ''}`);
const milestoneRows = async (u: TestUser) => db.execute<{ id: string; key: string; push_state: string; in_app: boolean }>(sql`
  SELECT id, data->>'key' AS key, push_state, in_app FROM notifications WHERE user_id = ${u.id}::uuid AND type = 'milestone' ORDER BY created_at`);

/** A finish through the app's own path (ReadingService), dated. */
async function finishInApp(u: TestUser, title: string, on = '2026-05-01'): Promise<string> {
  const w = await makeWork(db, title);
  const r = await reading.upsert(u.id, w, 'finished', null, null, 'public', { finishedAt: on, startedAt: on });
  return r.id;
}

/** Imported finishes: written by the import, never through the app's finish. */
async function imported(u: TestUser, n: number) {
  for (let i = 0; i < n; i++) {
    const id = await makeRead(db, u.id, await makeWork(db, `Imported ${i}`));
    await db.update(reads).set({ source: 'import' } as never).where(eq(reads.id, id));
  }
}

describe('ST-10: book milestones', () => {
  it('the first book: a full moment and a list row, never a push, never a feed card', async () => {
    const u = await makeUser(db, 'ms_first');
    const readId = await finishInApp(u, 'First of many');
    const body = await unseen(u);
    expect(body.milestones).toEqual([
      expect.objectContaining({ key: 'books_1', treatment: 'full', data: expect.objectContaining({ count: 1, read_id: readId }) }),
    ]);
    const rows = await milestoneRows(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'books_1', push_state: 'none', in_app: true });
    expect(compose((await viewNotification(db, rows[0]!.id))!)).toEqual({ text: 'You finished your first book on Flyleaf.', deepLink: 'flyleaf://stats' });
    // Nothing queued for a push, and the only activity is the finish itself.
    expect(queue.jobs.filter((j) => j.job.notificationId === rows[0]!.id)).toEqual([]);
    const verbs = await db.execute<{ verb: string }>(sql`SELECT verb FROM activity WHERE actor_id = ${u.id}::uuid`);
    expect(verbs.map((v) => v.verb)).toEqual(['finished']);
    // In the list the app shows.
    const list = (await app.inject({ method: 'GET', url: '/v1/notifications', headers: u.auth })).json();
    expect(list.items.map((i: { type: string; text: string }) => [i.type, i.text])).toContainEqual(['milestone', 'You finished your first book on Flyleaf.']);
  });

  it('the 10th book is subtle; the first, passed by an import, stays silent', async () => {
    const u = await makeUser(db, 'ms_tenth');
    await imported(u, 9);
    await finishInApp(u, 'Tenth');
    expect(await keys(u)).toEqual(['books_10']);
    expect((await unseen(u)).milestones[0].treatment).toBe('subtle');
    expect(await stored(u)).toEqual(['books_1:seen', 'books_10']);
    expect((await milestoneRows(u)).map((r) => r.key)).toEqual(['books_10']);
  });

  it('a library imported past 100 celebrates nothing it did not reach in the app', async () => {
    const u = await makeUser(db, 'ms_import');
    await imported(u, 120);
    await finishInApp(u, 'After the import');
    expect(await keys(u)).toEqual([]);
    expect(await stored(u)).toEqual(['books_1:seen', 'books_10:seen', 'books_100:seen']);
    expect(await milestoneRows(u)).toHaveLength(0);
  });

  it('fires once: reaching 10 again after a delete writes nothing', async () => {
    const u = await makeUser(db, 'ms_once');
    await imported(u, 9);
    const tenth = await finishInApp(u, 'Ten');
    await reading.delete(u.id, tenth);
    await finishInApp(u, 'Ten again');
    expect((await milestoneRows(u)).map((r) => r.key)).toEqual(['books_10']);
    // A rating edit on a finished read is not a finish.
    await reading.finish(u.id, (await finishInApp(u, 'Eleven')), { rating: 4 });
    expect((await milestoneRows(u)).map((r) => r.key)).toEqual(['books_10']);
  });

  it('the app marks moments shown; bad keys are 422, others\' keys change nothing', async () => {
    const u = await makeUser(db, 'ms_seen');
    await finishInApp(u, 'Seen');
    expect(await keys(u)).toEqual(['books_1']);
    const bad = await app.inject({ method: 'POST', url: '/v1/me/milestones/seen', headers: u.auth, payload: { keys: ['books_2'] } });
    expect(bad.statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url: '/v1/me/milestones/seen', headers: u.auth, payload: { keys: ['books_1'] } });
    expect(ok.statusCode).toBe(204);
    expect(await keys(u)).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/me/milestones' })).statusCode).toBe(401);
  });
});

describe('ST-10: the goal (§8.6: a single celebratory moment)', () => {
  it('the finish that reaches the goal celebrates it, once a year', async () => {
    const u = await makeUser(db, 'ms_goal');
    await db.insert(goals).values({ userId: u.id, year: 2026, targetBooks: 3 });
    await finishInApp(u, 'G1', '2026-02-01');
    await finishInApp(u, 'G2', '2026-03-01');
    expect((await keys(u)).filter((k: string) => k.startsWith('goal'))).toEqual([]);
    await finishInApp(u, 'G3', '2026-04-01');
    expect(await keys(u)).toEqual(['books_1', 'goal_2026']);
    const row = (await milestoneRows(u)).find((r) => r.key === 'goal_2026')!;
    expect(compose((await viewNotification(db, row.id))!).text).toBe('You reached your 2026 reading goal.');
    // Lowered and raised and passed again: still once.
    await db.update(goals).set({ targetBooks: 4 }).where(eq(goals.userId, u.id));
    await finishInApp(u, 'G4', '2026-05-01');
    expect((await milestoneRows(u)).filter((r) => r.key === 'goal_2026')).toHaveLength(1);
    // A finish dated in another year does not touch this year's goal.
    await finishInApp(u, 'Old', '2025-05-01');
    expect(await stored(u)).not.toContain('goal_2025');
  });

  it('a goal set below what is already read is stored silently by the next finish', async () => {
    const u = await makeUser(db, 'ms_goal_low');
    for (const t of ['A', 'B', 'C']) await finishInApp(u, t, '2026-01-01');
    await app.inject({ method: 'POST', url: '/v1/me/milestones/seen', headers: u.auth, payload: { keys: ['books_1'] } });
    await db.insert(goals).values({ userId: u.id, year: 2026, targetBooks: 2 });
    await finishInApp(u, 'D', '2026-01-02');
    expect(await keys(u)).toEqual([]);
    expect(await stored(u)).toContain('goal_2026:seen');
  });
});

describe('ST-10: first review and first follower', () => {
  it('the first review is a moment; the second is not', async () => {
    const u = await makeUser(db, 'ms_review');
    const r1 = await finishInApp(u, 'Reviewed');
    await app.inject({ method: 'POST', url: '/v1/me/milestones/seen', headers: u.auth, payload: { keys: ['books_1'] } });
    const res = await app.inject({ method: 'POST', url: `/v1/reads/${r1}/review`, headers: u.auth, payload: { body: 'Loved it.' } });
    expect(res.statusCode).toBeLessThan(300);
    const reviewId = res.json().id;
    expect((await unseen(u)).milestones).toEqual([expect.objectContaining({ key: 'first_review', treatment: 'full', data: expect.objectContaining({ review_id: reviewId }) })]);
    const row = (await milestoneRows(u)).find((r) => r.key === 'first_review')!;
    expect(compose((await viewNotification(db, row.id))!).deepLink).toMatch(new RegExp(`^flyleaf://review/${reviewId}\\?work=`));
    const r2 = await finishInApp(u, 'Second');
    await app.inject({ method: 'POST', url: `/v1/reads/${r2}/review`, headers: u.auth, payload: { body: 'Also good.' } });
    expect((await milestoneRows(u)).filter((r) => r.key === 'first_review')).toHaveLength(1);
  });

  it('the first follower: a warm note in the list naming them, no full moment; hidden if they are blocked later', async () => {
    const star = await makeUser(db, 'ms_star');
    const fan = await makeUser(db, 'ms_fan');
    const second = await makeUser(db, 'ms_fan2');
    expect((await app.inject({ method: 'POST', url: `/v1/users/${star.id}/follow`, headers: fan.auth })).statusCode).toBeLessThan(300);
    await app.inject({ method: 'POST', url: `/v1/users/${star.id}/follow`, headers: second.auth });
    expect(await keys(star)).toEqual([]);
    const rows = await milestoneRows(star);
    expect(rows.map((r) => r.key)).toEqual(['first_follower']);
    expect(compose((await viewNotification(db, rows[0]!.id))!)).toEqual({
      text: 'ms_fan is your first follower. Welcome to reading together.', deepLink: `flyleaf://user/${fan.id}`,
    });
    await block(db, star.id, fan.id);
    expect(await viewNotification(db, rows[0]!.id)).toBeNull();
  });

  it('a private account: the first accepted request is recorded without a note (accepting is their own act)', async () => {
    const shy = await makeUser(db, 'ms_shy', { isPrivate: true });
    const asker = await makeUser(db, 'ms_asker');
    await app.inject({ method: 'POST', url: `/v1/users/${shy.id}/follow`, headers: asker.auth });
    expect(await milestoneRows(shy)).toHaveLength(0);
    const ok = await app.inject({ method: 'POST', url: `/v1/me/follow-requests/${asker.id}/accept`, headers: shy.auth });
    expect(ok.statusCode).toBeLessThan(300);
    expect(await stored(shy)).toEqual(['first_follower:seen']);
    expect(await milestoneRows(shy)).toHaveLength(0);
  });
});

describe('ST-10: preferences and the inline note', () => {
  it('with milestones switched off: recorded, no row, no moment; the category has no push channel to switch on', async () => {
    const u = await makeUser(db, 'ms_off');
    await db.insert(notificationPreferences).values({ userId: u.id, categories: { milestones: { in_app: false } } } as never);
    await finishInApp(u, 'Quiet');
    expect(await stored(u)).toEqual(['books_1']);
    expect(await milestoneRows(u)).toHaveLength(0);
    expect(await keys(u)).toEqual([]);
    const prefs = (await app.inject({ method: 'GET', url: '/v1/me/notification-preferences', headers: u.auth })).json();
    expect(prefs.categories.find((c: { key: string }) => c.key === 'milestones')).toMatchObject({ push: null, in_app: false, live: true });
    const push = await app.inject({ method: 'PATCH', url: '/v1/me/notification-preferences', headers: u.auth, payload: { categories: { milestones: { push: true } } } });
    expect(push.statusCode).toBe(400); // SO-32: a channel the category does not have is refused
  });

  it('longest book yet: above every other finished book with a page count; not for the first, a shorter one, or someone else\'s', async () => {
    const u = await makeUser(db, 'ms_long');
    const other = await makeUser(db, 'ms_long_other');
    const withPages = async (title: string, pages: number) => {
      const w = await makeWork(db, title);
      await db.execute(sql`INSERT INTO editions (work_id, page_count, format) VALUES (${w}::uuid, ${pages}, 'paperback')`);
      return (await reading.upsert(u.id, w, 'finished', null, null, 'public', { finishedAt: '2026-01-01' })).id;
    };
    const first = await withPages('First', 300);
    expect((await unseen(u, `?read_id=${first}`)).longest_yet).toBe(false);
    const longer = await withPages('Longer', 500);
    expect((await unseen(u, `?read_id=${longer}`)).longest_yet).toBe(true);
    const shorter = await withPages('Shorter', 200);
    expect((await unseen(u, `?read_id=${shorter}`)).longest_yet).toBe(false);
    expect((await unseen(other, `?read_id=${longer}`)).longest_yet).toBe(false);
    expect((await unseen(u)).longest_yet).toBeNull();
  });
});
