// The SO-4x owner decisions (13 Oct 2026), built with SO-5x:
//   1. report limits: 5 new reports an hour, 20 a day, per account, through
//      the shared limiter (a repeat of an open report costs nothing);
//   2. cross-account duplicates (review rings): the same text of 100+
//      characters from another account goes to the queue, never blocked;
//   3. a banned account appeals through an emailed one-time link: single
//      use, expiring, no sign-in.
// (The confirmation copy is the mobile app's: moderation.test.ts there.)

import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';

import { buildApp } from '../app.js';
import { createAdminUser, signAdminToken } from '../admin/auth.js';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { MemoryRateLimiter, RateLimits } from '../platform/rate-limits.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { MemoryNotifyQueue } from '../notify/index.js';
import { APPEAL_LINK_DAYS, hashAppealToken } from '../moderation/index.js';
import { CROSS_ACCOUNT_DUPLICATE_MIN_CHARS } from '../moderation/filters.js';
import { moderationAppealLinks, reviews, users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeRead, makeUser, makeWork, unlimited, type TestUser } from './interaction-fixtures.js';

let seq = 0;
const uname = (p: string) => `${p}_${++seq}`;

// ---------------------------------------------------------------------------
// 1. Report limits
// ---------------------------------------------------------------------------

describe('owner decision: reports are limited to 5 an hour and 20 a day per account', () => {
  let db: Db;
  let app: FastifyInstance;
  let now = 1_000_000_000;

  beforeAll(async () => {
    ({ db } = await freshDrizzle());
    // The exact store in memory with a clock the test moves: the numbers, not Postgres, are under test here.
    const limits = new RateLimits({ exact: new MemoryRateLimiter(() => now), fast: new MemoryRateLimiter(() => now), enabled: new Set(['reports:hour', 'reports:day']) });
    app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, rateLimits: limits });
    await app.ready();
  }, 60_000);

  const report = (who: TestUser, id: string) =>
    app.inject({ method: 'POST', url: '/v1/reports', headers: who.auth, payload: { subject_type: 'user', subject_id: id, reason: 'spam' } });

  it('the 6th new report in an hour is a 429 naming the limit; a repeat of an open report is not counted', async () => {
    const reporter = await makeUser(db, uname('rep'));
    const targets: TestUser[] = [];
    for (let i = 0; i < 7; i++) targets.push(await makeUser(db, uname('t')));
    for (let i = 0; i < 5; i++) expect((await report(reporter, targets[i]!.id)).statusCode).toBe(201);
    // Double taps and offline replays of the same open report: the same report, free.
    for (let i = 0; i < 5; i++) expect((await report(reporter, targets[0]!.id)).statusCode).toBe(200);
    const sixth = await report(reporter, targets[5]!.id);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toMatchObject({ code: 'rate_limited', message: 'You have sent a lot of reports. Try again later.' });
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM reports WHERE reporter_id = ${reporter.id}::uuid`);
    expect(row!.n).toBe(5);
    // Another account is untouched.
    expect((await report(await makeUser(db, uname('other')), targets[5]!.id)).statusCode).toBe(201);
  });

  it('the 21st in a day is a 429 even when no hour has more than 5', async () => {
    const reporter = await makeUser(db, uname('daily'));
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      if (i > 0 && i % 5 === 0) now += 3_601_000; // the next hour
      statuses.push((await report(reporter, (await makeUser(db, uname('d'))).id)).statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-account duplicates
// ---------------------------------------------------------------------------

describe('owner decision: the same review text from different accounts (100+ characters) is queued, never blocked', () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ db } = await freshDrizzle());
    app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited });
    await app.ready();
  }, 60_000);

  const LONG = 'An absolute triumph of a novel. Every page sings, every character breathes, and I could not put it down at all. Five stars!';
  const SHORT = 'Loved it. A masterpiece of the genre, truly.';

  async function publish(u: TestUser, body: string) {
    const workId = await makeWork(db, uname('Book'));
    const readId = await makeRead(db, u.id, workId, { status: 'finished' });
    const res = await app.inject({ method: 'POST', url: `/v1/reads/${readId}/review`, headers: u.auth, payload: { body } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const [rv] = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.readId, readId));
    return rv!.id;
  }

  const ringReports = (subjectId: string) => db.execute<{ reason: string; detail: string; snapshot: any }>(sql`
    SELECT reason, detail, snapshot FROM reports
    WHERE source = 'automated' AND auto_rule = 'duplicate_across_accounts' AND subject_id = ${subjectId}::uuid AND state = 'open'`);

  it('the threshold is the owner\'s number', () => {
    expect(CROSS_ACCOUNT_DUPLICATE_MIN_CHARS).toBe(100);
    expect([...LONG].length).toBeGreaterThanOrEqual(100);
    expect([...SHORT].length).toBeLessThan(100);
  });

  it('a second account posting the same long text (any case and spacing) is queued as fake_review, and the review is published', async () => {
    const a = await makeUser(db, uname('ringa'));
    const b = await makeUser(db, uname('ringb'));
    const first = await publish(a, LONG);
    expect(await ringReports(first)).toEqual([]);
    const second = await publish(b, `  ${LONG.toUpperCase().replace(/ /g, '   ')}  `);
    const [r] = await ringReports(second);
    expect(r).toMatchObject({ reason: 'fake_review', detail: 'The same text is in 1 review by 1 other account.' });
    expect(r!.snapshot.same_text_review_ids).toEqual([first]);
    // Never blocked: the review is live and readable.
    const [live] = await db.select({ deletedAt: reviews.deletedAt }).from(reviews).where(eq(reviews.id, second));
    expect(live!.deletedAt).toBeNull();
  });

  it('short texts, the same author on fewer than 3 works, and deleted copies are not counted', async () => {
    const a = await makeUser(db, uname('sa'));
    const b = await makeUser(db, uname('sb'));
    await publish(a, SHORT);
    expect(await ringReports(await publish(b, SHORT))).toEqual([]);
    const solo = await makeUser(db, uname('solo'));
    const text = `${LONG} Solo copy.`;
    await publish(solo, text);
    expect(await ringReports(await publish(solo, text))).toEqual([]);
    const c = await makeUser(db, uname('sc'));
    const d = await makeUser(db, uname('sd'));
    const gone = await publish(c, `${LONG} Deleted original.`);
    await db.update(reviews).set({ deletedAt: new Date() }).where(eq(reviews.id, gone));
    expect(await ringReports(await publish(d, `${LONG} Deleted original.`))).toEqual([]);
  });

  it('the check uses reviews_body_norm_idx (0045): the expression in the query matches the index', async () => {
    const [idx] = await db.execute<{ def: string }>(sql`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'reviews_body_norm_idx'`);
    expect(idx!.def).toMatch(/md5\(lower\(regexp_replace\(btrim\(body\)/);
    expect(idx!.def).toMatch(/WHERE \(deleted_at IS NULL\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. A banned account's emailed one-time appeal link
// ---------------------------------------------------------------------------

describe('owner decision: a banned account appeals through an emailed one-time link, without signing in', () => {
  let db: Db;
  let app: FastifyInstance;
  let mailer: MemoryEmailSender;
  let adminBearer: { authorization: string; host: string };
  const HOST = 'admin.flyleaf.app';

  beforeAll(async () => {
    ({ db } = await freshDrizzle());
    mailer = new MemoryEmailSender();
    app = await buildApp({
      db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, mailer, notifyQueue: new MemoryNotifyQueue(),
    });
    await app.ready();
    const created = await createAdminUser(db, { email: 'appeal_admin@flyleaf.app', password: 'Moderation-Console-Passphrase-1', role: 'admin', username: 'appeal_admin' });
    adminBearer = { authorization: `Bearer ${await signAdminToken(created.user)}`, host: HOST };
  }, 60_000);

  /** A hate-speech review, reported and enforced: removal + ban at once (§27.3). Returns the emailed link's token. */
  async function ban() {
    const owner = await makeUser(db, uname('banned'));
    const reporter = await makeUser(db, uname('reporter'));
    const workId = await makeWork(db, uname('Book'));
    const readId = await makeRead(db, owner.id, workId);
    const [rv] = await db.insert(reviews).values({ readId, userId: owner.id, workId, body: 'Something hateful.' }).returning({ id: reviews.id });
    await app.inject({ method: 'POST', url: '/v1/reports', headers: reporter.auth, payload: { subject_type: 'review', subject_id: rv!.id, reason: 'hate_speech' } });
    mailer.clear();
    const res = await app.inject({
      method: 'POST', url: `/v1/admin/reports/review/${rv!.id}/action`, headers: adminBearer,
      payload: { decision: 'enforce', rule: 'hate_speech', reason: 'Slur in the review body.' },
    });
    expect(res.statusCode, res.body).toBe(200);
    await new Promise((r) => setImmediate(r)); // the email is sent after commit
    const mail = mailer.sentMessages.find((m) => m.to === `${owner.username}@example.com`);
    expect(mail, 'the banned account is emailed').toBeTruthy();
    const token = /\/appeal\?token=([A-Za-z0-9_-]+)/.exec(mail!.text)![1]!;
    return { owner, actionId: res.json().id as string, token, mail: mail! };
  }

  const getPage = (token: string) => app.inject({ method: 'GET', url: `/appeal?token=${encodeURIComponent(token)}` });
  const postAppeal = (token: string, body: string) => app.inject({
    method: 'POST', url: '/appeal', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ token, body }).toString(),
  });

  it('the ban emails a link (only its hash is stored, expiring in 30 days); the account cannot sign in', async () => {
    const { owner, actionId, token, mail } = await ban();
    expect(mail.subject).toBe('Your Flyleaf account has been banned');
    expect(mail.text).toContain('Hate speech');
    expect(mail.text).toContain(`expires in ${APPEAL_LINK_DAYS} days`);
    expect(APPEAL_LINK_DAYS).toBe(30);
    const [link] = await db.select().from(moderationAppealLinks).where(eq(moderationAppealLinks.actionId, actionId));
    expect(link!.tokenHash).toBe(hashAppealToken(token));
    expect(link!.tokenHash).not.toContain(token);
    const days = (link!.expiresAt.getTime() - link!.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    const [u] = await db.select({ bannedAt: users.bannedAt, deletedAt: users.deletedAt }).from(users).where(eq(users.id, owner.id));
    expect(u!.bannedAt).not.toBeNull();
  });

  it('GET shows the decision and the form and never spends the link; POST appeals once and spends it', async () => {
    const { actionId, token } = await ban();
    for (let i = 0; i < 2; i++) {
      const page = await getPage(token);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Hate speech');
      expect(page.body).toContain('<form method="post" action="/appeal"');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      expect(String(page.headers['content-security-policy'])).toMatch(/script-src 'nonce-/);
    }
    // An empty appeal spends nothing.
    expect((await postAppeal(token, '   ')).statusCode).toBe(422);
    const sent = await postAppeal(token, 'I quoted the word to condemn it.');
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('Appeal sent');
    const [a] = await db.execute<{ appeal_state: string; appeal_body: string }>(sql`SELECT appeal_state, appeal_body FROM moderation_actions WHERE id = ${actionId}::uuid`);
    expect(a).toMatchObject({ appeal_state: 'pending', appeal_body: 'I quoted the word to condemn it.' });
    // Single use: a second POST is refused and changes nothing; GET says it was used.
    const again = await postAppeal(token, 'A second appeal.');
    expect(again.statusCode).toBe(400);
    const [b] = await db.execute<{ appeal_body: string }>(sql`SELECT appeal_body FROM moderation_actions WHERE id = ${actionId}::uuid`);
    expect(b!.appeal_body).toBe('I quoted the word to condemn it.');
    expect((await getPage(token)).body).toContain('Already appealed');
    // It is in the admin appeals queue like any other appeal.
    const queue = await app.inject({ method: 'GET', url: '/v1/admin/appeals', headers: adminBearer });
    expect(queue.json().appeals.map((x: { id: string }) => x.id)).toContain(actionId);
  });

  it('an expired, unknown, incomplete or tampered link is refused and appeals nothing', async () => {
    const { actionId, token } = await ban();
    await db.update(moderationAppealLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(moderationAppealLinks.actionId, actionId));
    expect((await getPage(token)).statusCode).toBe(400);
    expect((await postAppeal(token, 'Too late?')).statusCode).toBe(400);
    expect((await postAppeal(`${token}x`, 'Guessing')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/appeal' })).statusCode).toBe(400);
    const evil = '"><script>alert(1)</script>';
    const page = await getPage(evil);
    expect(page.body).not.toContain(evil);
    const [a] = await db.execute<{ appeal_state: string | null }>(sql`SELECT appeal_state FROM moderation_actions WHERE id = ${actionId}::uuid`);
    expect(a!.appeal_state).toBeNull();
  });

  it('the outcome is emailed too: an overturn lifts the ban, an uphold keeps it', async () => {
    for (const decision of ['overturn', 'uphold'] as const) {
      const { owner, actionId, token } = await ban();
      expect((await postAppeal(token, 'Please look again.')).statusCode).toBe(200);
      mailer.clear();
      const res = await app.inject({
        method: 'POST', url: `/v1/admin/appeals/${actionId}/resolve`, headers: adminBearer,
        payload: { decision, reason: 'Reviewed the appeal carefully.' },
      });
      expect(res.statusCode, res.body).toBe(200);
      await new Promise((r) => setImmediate(r));
      const mail = mailer.sentMessages.find((m) => m.to === `${owner.username}@example.com`);
      expect(mail?.subject).toBe(decision === 'overturn' ? 'Your Flyleaf appeal: the ban is lifted' : 'Your Flyleaf appeal');
      const [u] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, owner.id));
      expect(u!.deletedAt === null).toBe(decision === 'overturn');
    }
  });

  it('only a ban sends a link: a removal or warning is appealed in the app', async () => {
    const owner = await makeUser(db, uname('spam'));
    const reporter = await makeUser(db, uname('rep2'));
    const workId = await makeWork(db, uname('Book'));
    const readId = await makeRead(db, owner.id, workId);
    const [rv] = await db.insert(reviews).values({ readId, userId: owner.id, workId, body: 'Buy cheap pills.' }).returning({ id: reviews.id });
    await app.inject({ method: 'POST', url: '/v1/reports', headers: reporter.auth, payload: { subject_type: 'review', subject_id: rv!.id, reason: 'spam' } });
    mailer.clear();
    const res = await app.inject({
      method: 'POST', url: `/v1/admin/reports/review/${rv!.id}/action`, headers: adminBearer,
      payload: { decision: 'enforce', rule: 'spam', reason: 'Spam link in the review.' },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(mailer.sentMessages).toEqual([]);
    expect(await db.select().from(moderationAppealLinks).where(eq(moderationAppealLinks.actionId, res.json().id))).toEqual([]);
  });
});
