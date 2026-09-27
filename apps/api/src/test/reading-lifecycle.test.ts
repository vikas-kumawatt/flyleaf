// Reading lifecycle, audited (Part 08): the status model, attempts, dates,
// activity and merged works, through the real app.
//
//   PRD §8.1 / §8.2 [LOCKED]  one row per attempt; finished and dnf terminal
//   PRD §6.17 / §6.18 / §34.2 finish, DNF, re-read, rating changed later
//   PRD §8.5                  finished_at >= started_at, a clear 422
//   D3 (A-03-008)             a merged work id keeps working

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';

import { MemoryCache, PgRateLimiter, type Db } from '../platform/index.js';
import { ReadingService, STATUSES, startsNewAttempt, type Status } from '../reading/index.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { mergeWorks } from '../catalog/dedupe.js';
import { buildApp } from '../app.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let client: { close: () => Promise<void> };
let alice: TestUser;
let work: string;

beforeEach(async () => {
  await app?.close();
  await client?.close();
  ({ db, client } = await freshDrizzle());
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();
  alice = await makeUser(db, 'alice');
  work = await makeWork(db, 'Piranesi');
});
afterAll(async () => { await app?.close(); await client?.close(); });

const post = (url: string, payload: object, who: TestUser = alice) =>
  app.inject({ method: 'POST', url: `/v1${url}`, headers: who.auth, payload });

async function log(status: Status, extra: object = {}, workId = work) {
  const res = await post('/reads', { work_id: workId, status, ...extra });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; status: string; attempt_no: number; started_at: string | null; finished_at: string | null; work_id: string };
}

const attempts = (workId = work) => db.execute<{ attempt_no: number; status: string }>(sql`
  SELECT attempt_no, status FROM reads WHERE user_id = ${alice.id} AND work_id = ${workId} ORDER BY attempt_no`);

const activityRows = (readId?: string) => db.execute<{ verb: string; object_id: string; visibility: string }>(sql`
  SELECT verb, object_id, visibility FROM activity WHERE actor_id = ${alice.id}
  ${readId ? sql`AND object_id = ${readId}` : sql``} ORDER BY created_at`);

describe('status transitions (PRD §8.2 [LOCKED]): every cell', () => {
  // From each current status (and from nothing) to each status. A terminal
  // attempt moved to a different status is a new attempt and stays as it
  // was; everything else edits the one attempt.
  const cells: [Status | null, Status][] = [null, ...STATUSES].flatMap(
    (from) => STATUSES.map((to) => [from as Status | null, to] as [Status | null, Status]));

  it.each(cells)('%s → %s', async (from, to) => {
    if (from) await log(from);
    const after = await log(to);
    const rows = await attempts();
    const expectNew = startsNewAttempt(from, to);

    expect(after.status).toBe(to);
    if (!from) {
      expect(rows).toEqual([{ attempt_no: 1, status: to }]);
    } else if (expectNew) {
      expect(rows.map((r) => [Number(r.attempt_no), r.status])).toEqual([[1, from], [2, to]]);
    } else {
      expect(rows.map((r) => [Number(r.attempt_no), r.status])).toEqual([[1, to]]);
    }
  });

  it('the rule itself: terminal to a different status is a new attempt, nothing else is', () => {
    expect(startsNewAttempt('finished', 'reading')).toBe(true);
    expect(startsNewAttempt('finished', 'dnf')).toBe(true);
    expect(startsNewAttempt('dnf', 'finished')).toBe(true);
    expect(startsNewAttempt('dnf', 'paused')).toBe(true);
    expect(startsNewAttempt('finished', 'finished')).toBe(false);
    expect(startsNewAttempt('dnf', 'dnf')).toBe(false);
    expect(startsNewAttempt('reading', 'want')).toBe(false);
    expect(startsNewAttempt('paused', 'finished')).toBe(false);
  });
});

describe('activity follows status changes only (PRD §34.2)', () => {
  it('a rating changed later writes no activity', async () => {
    await log('finished', { rating: 4 });
    await log('finished', { rating: 2.5 });
    const rows = await activityRows();
    expect(rows.map((r) => r.verb)).toEqual(['finished']);
  });

  it('want writes no "started" activity; reading does', async () => {
    await log('want');
    expect(await activityRows()).toEqual([]);
    await log('reading');
    expect((await activityRows()).map((r) => r.verb)).toEqual(['started']);
  });

  it('a double-tapped or replayed finish writes one activity and one row', async () => {
    const read = await log('reading');
    // Started today (UTC), so the finish is today too.
    const body = { finished_at: new Date().toISOString().slice(0, 10), rating: 4 };
    const [a, b] = [await post(`/reads/${read.id}/finish`, body), await post(`/reads/${read.id}/finish`, body)];
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(read.id);
    expect((await attempts()).length).toBe(1);
    expect((await activityRows()).map((r) => r.verb)).toEqual(['started', 'finished']);
  });
});

describe('finish and DNF keep terminal attempts (PRD §6.17, §6.18)', () => {
  it('finishing a DNF records a new finished attempt; the DNF stays', async () => {
    const read = await log('reading');
    const stopped = await post(`/reads/${read.id}/dnf`, { abandoned_page: 80, dnf_reason: 'Pacing' });
    expect(stopped.statusCode).toBe(200);

    const res = await post(`/reads/${read.id}/finish`, { finished_at: '2026-02-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json().attempt_no).toBe(2);
    expect((await attempts()).map((r) => r.status)).toEqual(['dnf', 'finished']);
  });

  it('finishing a finished read on another date is a re-read (§6.17)', async () => {
    const read = await log('finished', { finished_at: '2025-06-01' });
    const res = await post(`/reads/${read.id}/finish`, { finished_at: '2026-01-15' });
    expect(res.json().attempt_no).toBe(2);
    expect((await attempts()).map((r) => r.status)).toEqual(['finished', 'finished']);
  });

  it('stopping a finished read records a new DNF attempt; the finish stays', async () => {
    const read = await log('finished');
    const res = await post(`/reads/${read.id}/dnf`, {});
    expect(res.json().attempt_no).toBe(2);
    expect((await attempts()).map((r) => r.status)).toEqual(['finished', 'dnf']);
  });

  it('stores the DNF note (§6.18) instead of dropping it', async () => {
    const read = await log('reading');
    const res = await post(`/reads/${read.id}/dnf`, { note: 'Not the right time.' });
    expect(res.json().dnf_note).toBe('Not the right time.');
    const tooLong = await post(`/reads/${read.id}/dnf`, { note: 'x'.repeat(281) });
    expect(tooLong.statusCode).toBe(422);
  });

  it('refuses a review sent with the finish instead of dropping it (A-07-006)', async () => {
    const read = await log('reading');
    const refused = await post(`/reads/${read.id}/finish`, { review: 'Loved it.' });
    expect(refused.statusCode).toBe(422);
    expect((await attempts())[0]!.status).toBe('reading');
    const ok = await post(`/reads/${read.id}/finish`, { review: null });
    expect(ok.statusCode).toBe(200);
  });

  it('finishing someone else\'s read is a 404', async () => {
    const bob = await makeUser(db, 'bob');
    const read = await log('reading');
    const res = await post(`/reads/${read.id}/finish`, {}, bob);
    expect(res.statusCode).toBe(404);
  });
});

describe('dates (PRD §8.5)', () => {
  it('a finish before the start is a 422 invalid_date on every path (was a generic "out of range")', async () => {
    const viaLog = await post('/reads', { work_id: work, status: 'finished', started_at: '2026-03-10', finished_at: '2026-03-01' });
    expect(viaLog.statusCode).toBe(422);
    expect(viaLog.json().error.code).toBe('invalid_date');

    const read = await log('reading', { started_at: '2026-03-10' });
    const viaUpdate = await post('/reads', { work_id: work, status: 'finished', finished_at: '2026-03-01' });
    expect(viaUpdate.statusCode).toBe(422);
    const viaFinish = await post(`/reads/${read.id}/finish`, { finished_at: '2026-03-01' });
    expect(viaFinish.statusCode).toBe(422);
  });

  it('a date that does not exist, or a malformed one, is a 422 naming the field', async () => {
    for (const bad of ['2026-02-30', '26-01-01', 'yesterday']) {
      const res = await post('/reads', { work_id: work, status: 'finished', finished_at: bad });
      expect(res.statusCode, bad).toBe(422);
      expect(res.json().error.field, bad).toBe('finished_at');
    }
  });

  it('a date after tomorrow (UTC) is a 422; tomorrow is someone\'s today', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    expect((await post('/reads', { work_id: work, status: 'finished', finished_at: day(3) })).statusCode).toBe(422);
    expect((await post('/reads', { work_id: work, status: 'finished', finished_at: day(1) })).statusCode).toBe(200);
  });

  it('finishing a want with a past date starts it that day instead of failing', async () => {
    const want = await log('want');
    const res = await post(`/reads/${want.id}/finish`, { finished_at: '2024-05-05' });
    expect(res.statusCode).toBe(200);
    expect(res.json().started_at).toBe('2024-05-05');
    const logged = await log('finished', { finished_at: '2023-01-02' }, await makeWork(db, 'Jonathan Strange'));
    expect(logged.started_at).toBe('2023-01-02');
  });
});

describe('the work a read is logged against', () => {
  it('an id that names no work is a 404 (was a 422 invalid_reference from the foreign key)', async () => {
    const res = await post('/reads', { work_id: '00000000-0000-4000-8000-000000000000', status: 'want' });
    expect(res.statusCode).toBe(404);
  });

  it('a merged id is logged onto the survivor (D3): an offline replay survives a merge', async () => {
    const loser = await makeWork(db, 'Piranesi (duplicate record)');
    await mergeWorks(db, { survivorId: work, loserId: loser, stage: 2, reason: 'test' });

    const read = await log('finished', { rating: 4 }, loser);
    expect(read.work_id).toBe(work);
    const [onLoser] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM reads WHERE work_id = ${loser}`);
    expect(onLoser!.n).toBe(0);
  });

  it('GET /works/:merged answers 200 with the survivor and merged_into (D3)', async () => {
    const loser = await makeWork(db, 'Piranesi (duplicate record)');
    await mergeWorks(db, { survivorId: work, loserId: loser, stage: 2, reason: 'test' });

    const res = await app.inject({ method: 'GET', url: `/v1/works/${loser}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(work);
    expect(res.json().merged_into).toBe(work);
    const live = await app.inject({ method: 'GET', url: `/v1/works/${work}` });
    expect(live.json().merged_into).toBeUndefined();
  });
});

describe('every other write and read that takes a work id resolves a merged id (D3)', () => {
  let loser: string;
  beforeEach(async () => {
    loser = await makeWork(db, 'Piranesi (duplicate record)');
    await mergeWorks(db, { survivorId: work, loserId: loser, stage: 2, reason: 'test' });
  });

  it('a shelf add lands on the survivor', async () => {
    const shelf = await post('/shelves', { name: 'Best' });
    expect(shelf.statusCode, shelf.body).toBeLessThan(300);
    const res = await post(`/shelves/${shelf.json().shelf.id}/items`, { work_id: loser });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const [row] = await db.execute<{ work_id: string }>(sql`SELECT work_id FROM shelf_items`);
    expect(row!.work_id).toBe(work);
  });

  it('a mute lands on the survivor, and unmuting the old id removes it', async () => {
    expect((await post(`/works/${loser}/mute`, {})).statusCode).toBeLessThan(300);
    const [m] = await db.execute<{ target_id: string }>(sql`SELECT target_id FROM mutes WHERE user_id = ${alice.id}`);
    expect(m!.target_id).toBe(work);
    await app.inject({ method: 'DELETE', url: `/v1/works/${loser}/mute`, headers: alice.auth });
    expect(await db.execute(sql`SELECT 1 FROM mutes WHERE user_id = ${alice.id}`)).toHaveLength(0);
  });

  it('favourites store the survivor, once; an id that names no work is refused', async () => {
    const patch = (ids: string[]) => app.inject({
      method: 'PATCH', url: '/v1/me/profile', headers: alice.auth, payload: { favouriteWorkIds: ids } });
    const res = await patch([loser, work]);
    expect(res.statusCode, res.body).toBe(200);
    const [p] = await db.execute<{ favourite_work_ids: string[] }>(sql`
      SELECT favourite_work_ids FROM profiles WHERE user_id = ${alice.id}`);
    expect(p!.favourite_work_ids).toEqual([work]);
    expect((await patch(['00000000-0000-4000-8000-000000000000'])).statusCode).toBe(422);
  });

  it('a merged id lists the survivor reviews', async () => {
    const read = await log('finished', {}, work);
    await db.execute(sql`INSERT INTO reviews (read_id, user_id, work_id, body) VALUES (${read.id}, ${alice.id}, ${work}, 'Wonderful.')`);
    const res = await app.inject({ method: 'GET', url: `/v1/works/${loser}/reviews?sort=newest` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('progress on a read the merge moved keeps working, on the survivor', async () => {
    const other = await makeWork(db, 'Jonathan Strange');
    const oldCopy = await makeWork(db, 'Jonathan Strange (old record)');
    const read = await log('reading', {}, oldCopy);
    await mergeWorks(db, { survivorId: other, loserId: oldCopy, stage: 2, reason: 'test' });
    const res = await post(`/reads/${read.id}/progress`, { client_event_id: '6f1c2b1e-3c1a-4c55-9d7e-1a2b3c4d5e6f', page: 40 });
    expect(res.statusCode).toBe(200);
    expect(res.json().work_id).toBe(other);
  });

  it('undo still refuses only if something landed on the loser (safety net)', async () => {
    await log('want', {}, loser);  // resolved: lands on the survivor
    const [m] = await db.execute<{ id: string }>(sql`SELECT id FROM work_merges WHERE loser_id = ${loser}`);
    const { undoMerge } = await import('../catalog/dedupe.js');
    await expect(undoMerge(db, m!.id)).resolves.toMatchObject({ undone: true });
  });
});

describe('progress and the reads list', () => {
  it('minutes are optional and at most one day', async () => {
    const read = await log('reading');
    const ev = (minutes: number) => post(`/reads/${read.id}/progress`, {
      client_event_id: crypto.randomUUID(), page: 10, minutes });
    expect((await ev(1440)).statusCode).toBe(200);
    expect((await ev(1441)).statusCode).toBe(422);
  });

  it('the list shows the chosen edition’s cover and page count, else the work’s cover', async () => {
    await db.execute(sql`UPDATE works SET ol_cover_id = 111 WHERE id = ${work}`);
    const [ed] = await db.execute<{ id: string }>(sql`
      INSERT INTO editions (work_id, ol_cover_id, page_count, publish_year) VALUES (${work}, 222, 480, 2020) RETURNING id`);
    await db.execute(sql`INSERT INTO editions (work_id, ol_cover_id, page_count, publish_year) VALUES (${work}, 333, 20, 2024)`);
    await log('reading', { edition_id: ed!.id });
    const other = await makeWork(db, 'Jonathan Strange');
    await db.execute(sql`UPDATE works SET ol_cover_id = 444 WHERE id = ${other}`);
    await log('want', {}, other);

    const res = await app.inject({ method: 'GET', url: '/v1/reads', headers: alice.auth });
    const byWork = new Map((res.json().data as { work_id: string; cover_id: number; page_count: number | null }[])
      .map((r) => [r.work_id, r]));
    expect(byWork.get(work)).toMatchObject({ cover_id: 222, page_count: 480 });
    expect(byWork.get(other)!.cover_id).toBe(444);
  });
});

describe('deleting a read (PRD §34.2)', () => {
  const del = (id: string, who: TestUser = alice) =>
    app.inject({ method: 'DELETE', url: `/v1/reads/${id}`, headers: who.auth });

  it('takes its progress, review, likes, comments and activity with it, and uncounts the reader', async () => {
    const bob = await makeUser(db, 'bob');
    const read = await log('reading');
    await post(`/reads/${read.id}/progress`, { client_event_id: crypto.randomUUID(), page: 12 });
    await post(`/reads/${read.id}/finish`, { rating: 4, finished_at: new Date().toISOString().slice(0, 10) });
    const [review] = await db.execute<{ id: string }>(sql`
      INSERT INTO reviews (read_id, user_id, work_id, body) VALUES (${read.id}, ${alice.id}, ${work}, 'Wonderful.') RETURNING id`);
    await db.execute(sql`INSERT INTO activity (actor_id, verb, work_id, object_type, object_id)
                         VALUES (${alice.id}, 'reviewed', ${work}, 'review', ${review!.id})`);
    await db.execute(sql`INSERT INTO read_likes (read_id, user_id) VALUES (${read.id}, ${bob.id})`);
    await db.execute(sql`INSERT INTO read_comments (read_id, user_id, body) VALUES (${read.id}, ${bob.id}, 'Agreed')`);

    const res = await del(read.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ deleted: true, id: read.id });
    for (const table of ['reads', 'progress_events', 'reviews', 'read_likes', 'read_comments', 'activity']) {
      const [n] = await db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      expect(n!.n, table).toBe(0);
    }
    const [w] = await db.execute<{ reader_count: number }>(sql`SELECT reader_count FROM works WHERE id = ${work}`);
    expect(Number(w!.reader_count)).toBe(0);
    const [ws] = await db.execute<{ rating_count: number }>(sql`SELECT rating_count FROM work_stats WHERE work_id = ${work}`);
    expect(Number(ws!.rating_count)).toBe(0);
  });

  it('another user’s read, a deleted one and a random id are the same 404', async () => {
    const bob = await makeUser(db, 'bob');
    const read = await log('want');
    const theirs = await del(read.id, bob);
    const random = await del('00000000-0000-4000-8000-000000000000');
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).toBe(random.body);
    expect((await del(read.id)).statusCode).toBe(200);
    expect((await del(read.id)).statusCode).toBe(404);
  });
});

describe('visibility changed after the fact', () => {
  it('making a finished read private removes its activity', async () => {
    const read = await log('finished');
    expect(await activityRows(read.id)).toHaveLength(1);
    await post(`/reads/${read.id}/finish`, { visibility: 'private' });
    expect(await activityRows(read.id)).toEqual([]);
  });

  it('a private account making a read public keeps its activity followers-only (PRD §26.2)', async () => {
    const read = await log('reading', { visibility: 'followers' });
    await db.execute(sql`UPDATE profiles SET is_private = true WHERE user_id = ${alice.id}`);
    await post('/reads', { work_id: work, status: 'reading', visibility: 'public' });
    const rows = await activityRows(read.id);
    expect(rows.map((r) => r.visibility)).toEqual(['followers']);
  });
});
