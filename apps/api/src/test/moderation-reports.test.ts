// SO-40: reports from every surface the PRD lists (§6.26 review, §6.28
// comment, §6.37 profile, §27.1 shelf names and the catalog), through the
// existing layers: canView() and blocks decide what can be reported (404 like
// a random id), the shared limiter counts reports as writes (§24.4), and a
// reporter sees status, never outcome (§27.6).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { buildApp, routeLimitGroups } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { MemoryRateLimiter, RateLimits } from '../platform/rate-limits.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { reads, reviews, shelves, works } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, follow, block, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let owner: TestUser;
let reporter: TestUser;
let workId: string;
let readId: string;
let reviewId: string;
let commentId: string;
let shelfId: string;

async function review(userId: string, read: string, work: string, body = 'A careful review of the book.') {
  const [r] = await db.insert(reviews).values({ readId: read, userId, workId: work, body }).returning({ id: reviews.id });
  return r!.id;
}

async function setup() {
  ({ db } = await freshDrizzle());
  app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited });
  await app.ready();
  owner = await makeUser(db, 'owner');
  reporter = await makeUser(db, 'reporter');
  workId = await makeWork(db, 'The Dispossessed');
  readId = await makeRead(db, owner.id, workId);
  reviewId = await review(owner.id, readId, workId);
  const [c] = await db.execute<{ id: string }>(sql`
    INSERT INTO read_comments (read_id, user_id, body) VALUES (${readId}::uuid, ${owner.id}::uuid, 'my own thread') RETURNING id`);
  commentId = c!.id;
  const [s] = await db.insert(shelves).values({ userId: owner.id, name: 'Favourites', slug: 'favourites' }).returning({ id: shelves.id });
  shelfId = s!.id;
}

const post = (who: TestUser | null, payload: object) =>
  app.inject({ method: 'POST', url: '/v1/reports', headers: who ? who.auth : {}, payload });

const RANDOM = '00000000-0000-4000-8000-000000000000';

describe('SO-40: a report from every surface', () => {
  beforeEach(setup);

  it.each([
    ['review', () => reviewId, 'spoilers'],
    ['comment', () => commentId, 'harassment'],
    ['user', () => owner.id, 'spam'],
    ['shelf', () => shelfId, 'hate_speech'],
    ['work', () => workId, 'nsfw'],
  ] as const)('%s: 201 with status open, a snapshot of the text, and the owner recorded', async (type, id, reason) => {
    const res = await post(reporter, { subject_type: type, subject_id: id(), reason, detail: '  see the third paragraph  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json().report).toMatchObject({ subject_type: type, subject_id: id(), reason, status: 'open', reviewed_at: null });
    const [row] = await db.execute<{ subject_owner_id: string | null; detail: string; snapshot: Record<string, unknown>; source: string }>(sql`
      SELECT subject_owner_id, detail, snapshot, source FROM reports WHERE id = ${res.json().report.id}::uuid`);
    expect(row!.subject_owner_id).toBe(type === 'work' ? null : owner.id);
    expect(row!.detail).toBe('see the third paragraph');
    expect(row!.source).toBe('user');
    expect(Object.keys(row!.snapshot).length).toBeGreaterThan(0);
  });

  it('a second report of the same open subject is the same report (200), not a second one', async () => {
    const a = await post(reporter, { subject_type: 'review', subject_id: reviewId, reason: 'spam' });
    const b = await post(reporter, { subject_type: 'review', subject_id: reviewId, reason: 'harassment' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().report.id).toBe(a.json().report.id);
    expect(b.json().report.reason).toBe('spam');
    expect(await db.execute(sql`SELECT 1 FROM reports`)).toHaveLength(1);
  });

  it('two people reporting the same thing are two reports', async () => {
    const third = await makeUser(db, 'third');
    await post(reporter, { subject_type: 'review', subject_id: reviewId, reason: 'spam' });
    await post(third, { subject_type: 'review', subject_id: reviewId, reason: 'spam' });
    expect(await db.execute(sql`SELECT 1 FROM reports`)).toHaveLength(2);
  });

  it('a merged book is reported as the work the reader sees', async () => {
    const survivor = await makeWork(db, 'The Dispossessed (survivor)');
    await db.update(works).set({ mergedIntoId: survivor }).where(eq(works.id, workId));
    const res = await post(reporter, { subject_type: 'work', subject_id: workId, reason: 'other' });
    expect(res.json().report.subject_id).toBe(survivor);
  });

  it('your own content cannot be reported', async () => {
    const res = await post(owner, { subject_type: 'review', subject_id: reviewId, reason: 'spam' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_report_self');
  });

  it('guests cannot report; malformed input is refused and stores nothing', async () => {
    expect((await post(null, { subject_type: 'review', subject_id: reviewId, reason: 'spam' })).statusCode).toBe(401);
    for (const bad of [
      { subject_type: 'review', subject_id: reviewId, reason: 'boring' },
      { subject_type: 'quote', subject_id: reviewId, reason: 'spam' },
      { subject_type: 'review', subject_id: 'not-a-uuid', reason: 'spam' },
      { subject_type: 'review', subject_id: reviewId, reason: 'spam', detail: 'x'.repeat(1001) },
      { subject_type: 'review', subject_id: reviewId },
    ]) {
      expect((await post(reporter, bad)).statusCode).toBe(422); // schema validation, as everywhere in the API
    }
    expect(await db.execute(sql`SELECT 1 FROM reports`)).toHaveLength(0);
  });
});

describe('SO-40: what you cannot see, you cannot report (404 identical to a random id)', () => {
  beforeEach(setup);

  const notFoundBody = async (type: string) => (await post(reporter, { subject_type: type, subject_id: RANDOM, reason: 'spam' })).json();

  it.each(['review', 'comment', 'user', 'shelf'] as const)('%s, blocked either way', async (type) => {
    const id = { review: reviewId, comment: commentId, user: owner.id, shelf: shelfId }[type];
    for (const [a, b] of [[owner.id, reporter.id], [reporter.id, owner.id]] as const) {
      await db.execute(sql`DELETE FROM blocks`);
      await block(db, a, b);
      const res = await post(reporter, { subject_type: type, subject_id: id, reason: 'spam' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(await notFoundBody(type));
    }
    expect(await db.execute(sql`SELECT 1 FROM reports`)).toHaveLength(0);
  });

  it('a private review, a followers-only read for a stranger, a private account\'s shelf, a deleted review', async () => {
    const expected = await notFoundBody('review');
    await db.update(reviews).set({ visibility: 'private' }).where(eq(reviews.id, reviewId));
    expect((await post(reporter, { subject_type: 'review', subject_id: reviewId, reason: 'spam' })).json()).toEqual(expected);
    await db.update(reviews).set({ visibility: 'public' }).where(eq(reviews.id, reviewId));
    await db.update(reads).set({ visibility: 'followers' }).where(eq(reads.id, readId));
    expect((await post(reporter, { subject_type: 'review', subject_id: reviewId, reason: 'spam' })).statusCode).toBe(404);
    expect((await post(reporter, { subject_type: 'comment', subject_id: commentId, reason: 'spam' })).statusCode).toBe(404);
    // A follower may see, and so report, both.
    await follow(db, reporter.id, owner.id);
    expect((await post(reporter, { subject_type: 'review', subject_id: reviewId, reason: 'spam' })).statusCode).toBe(201);
    expect((await post(reporter, { subject_type: 'comment', subject_id: commentId, reason: 'spam' })).statusCode).toBe(201);
    await db.update(shelves).set({ privacy: 'private' }).where(eq(shelves.id, shelfId));
    expect((await post(reporter, { subject_type: 'shelf', subject_id: shelfId, reason: 'spam' })).json()).toEqual(await notFoundBody('shelf'));
    await db.update(reviews).set({ deletedAt: new Date() }).where(eq(reviews.id, reviewId));
    const other = await makeUser(db, 'other');
    expect((await post(other, { subject_type: 'review', subject_id: reviewId, reason: 'spam' })).json()).toEqual(expected);
  });

  it('a comment by someone in a block with the reporter is hidden from them, so not reportable', async () => {
    const troll = await makeUser(db, 'troll');
    const [c] = await db.execute<{ id: string }>(sql`
      INSERT INTO read_comments (read_id, user_id, body) VALUES (${readId}::uuid, ${troll.id}::uuid, 'rude') RETURNING id`);
    await block(db, reporter.id, troll.id);
    const res = await post(reporter, { subject_type: 'comment', subject_id: c!.id, reason: 'harassment' });
    expect(res.json()).toEqual(await notFoundBody('comment'));
  });

  it('a deleted account\'s profile, and a book that does not exist', async () => {
    await db.execute(sql`UPDATE users SET deleted_at = now() WHERE id = ${owner.id}::uuid`);
    expect((await post(reporter, { subject_type: 'user', subject_id: owner.id, reason: 'spam' })).json()).toEqual(await notFoundBody('user'));
    expect((await post(reporter, { subject_type: 'work', subject_id: RANDOM, reason: 'spam' })).statusCode).toBe(404);
  });
});

describe('SO-40: reports go through the shared rate limiter (PRD §24.4 Writes)', () => {
  it('POST /v1/reports is in the writes group, and the 121st in a minute is a 429', async () => {
    expect(routeLimitGroups('POST', '/v1/reports')).toEqual(['writes']);
    ({ db } = await freshDrizzle());
    const limits = new RateLimits({ exact: unlimited, fast: new MemoryRateLimiter(), enabled: new Set(['writes']) });
    app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, rateLimits: limits });
    await app.ready();
    owner = await makeUser(db, 'owner');
    reporter = await makeUser(db, 'reporter');
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      statuses.push((await post(reporter, { subject_type: 'user', subject_id: owner.id, reason: 'spam' })).statusCode);
    }
    expect(statuses.slice(0, 120).every((s) => s === 201 || s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});

describe('SO-40: the reporter sees status, never the outcome (PRD §27.6)', () => {
  beforeAll(setup);

  it('lists your own reports only, open or reviewed', async () => {
    const r = (await post(reporter, { subject_type: 'review', subject_id: reviewId, reason: 'spam' })).json().report;
    const other = await makeUser(db, 'someone');
    await post(other, { subject_type: 'user', subject_id: owner.id, reason: 'spam' });
    let mine = (await app.inject({ method: 'GET', url: '/v1/me/reports', headers: reporter.auth })).json().reports;
    expect(mine).toEqual([r]);
    await db.execute(sql`UPDATE reports SET state = 'actioned', resolved_at = now() WHERE id = ${r.id}::uuid`);
    mine = (await app.inject({ method: 'GET', url: '/v1/me/reports', headers: reporter.auth })).json().reports;
    expect(mine[0]).toMatchObject({ status: 'reviewed' });
    expect(JSON.stringify(mine)).not.toMatch(/actioned|dismissed|enforce|rule/);
    expect((await app.inject({ method: 'GET', url: '/v1/me/reports' })).statusCode).toBe(401);
  });
});
