// SO-42: the admin report queue, actions, the enforcement ladder and appeals
// (PRD §27.3, §27.5 [LOCKED], §27.6), through the Part 06 admin patterns:
// staff auth, the cookie + same-Origin CSRF guard, role gating, escaped
// pages with a script nonce, and an audit row in the action's transaction.
//
// The first block is the Phase 4 exit criterion as one test: a report reaches
// the admin queue and is actioned end to end.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { createAdminUser, signAdminToken } from '../admin/auth.js';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { MemoryNotifyQueue } from '../notify/index.js';
import { LADDER, stepFor, needsAdmin, RULES } from '../moderation/index.js';
import { retentionSweep } from '../jobs/retention.js';
import { profiles, reads, reviews, shelves, users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, unlimited, type TestUser } from './interaction-fixtures.js';

const PW = 'Moderation-Console-Passphrase-1';
const HOST = 'admin.flyleaf.app';
const ORIGIN = `https://${HOST}`;

type Staff = { id: string; token: string; bearer: { authorization: string }; cookie: { cookie: string } };

let db: Db;
let app: FastifyInstance;
let admin: Staff;
let mod: Staff;
let owner: TestUser;
let reporter: TestUser;
let workId: string;
let readId: string;
let reviewId: string;

async function staff(email: string, role: 'admin' | 'moderator'): Promise<Staff> {
  const created = await createAdminUser(db, { email, password: PW, role, username: email.split('@')[0]!.replace(/\W/g, '_') });
  const token = await signAdminToken(created.user);
  return { id: created.user.id, token, bearer: { authorization: `Bearer ${token}` }, cookie: { cookie: `flyleaf_admin_session=${encodeURIComponent(token)}` } };
}

async function boot() {
  ({ db } = await freshDrizzle());
  app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, notifyQueue: new MemoryNotifyQueue() });
  await app.ready();
  admin = await staff('mod_admin@flyleaf.app', 'admin');
  mod = await staff('mod_moderator@flyleaf.app', 'moderator');
}

/** A fresh owner with a public, rated, reviewed finish, and a reporter. */
async function scene(tag = Math.random().toString(36).slice(2, 8)) {
  owner = await makeUser(db, `owner_${tag}`);
  reporter = await makeUser(db, `rep_${tag}`);
  workId = await makeWork(db, `Book ${tag}`);
  readId = await makeRead(db, owner.id, workId, { rating: '1.0' });
  const [r] = await db.insert(reviews).values({ readId, userId: owner.id, workId, body: 'You are all idiots for liking this.' }).returning({ id: reviews.id });
  reviewId = r!.id;
}

const report = (who: TestUser, type: string, id: string, reason = 'harassment') =>
  app.inject({ method: 'POST', url: '/v1/reports', headers: who.auth, payload: { subject_type: type, subject_id: id, reason } });

const act = (who: Staff, type: string, id: string, payload: object, headers: object = who.bearer) =>
  app.inject({ method: 'POST', url: `/v1/admin/reports/${type}/${id}/action`, headers: { host: HOST, ...headers }, payload });

const enforce = (who: Staff, type: string, id: string, rule: string) =>
  act(who, type, id, { decision: 'enforce', rule, reason: `Applying ${rule} after review.` });

/** Every attribute NAME in every tag (values skipped, so escaped text inside one cannot match), as in admin-security. */
function attributeNames(html: string): string[] {
  const names: string[] = [];
  for (const [, attrs] of html.matchAll(/<[a-zA-Z][\w-]*((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    for (const [, name] of attrs!.matchAll(/\s+([^\s=>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)) names.push(name!);
  }
  return names;
}

const auditRows = (action: string) => db.execute<{ subject_id: string; payload: Record<string, unknown>; actor_id: string; reason: string }>(sql`
  SELECT subject_id, payload, actor_id, reason FROM admin_audit_log WHERE action = ${action} ORDER BY id`);

describe('Phase 4 exit: a report reaches the admin queue and is actioned end to end', () => {
  beforeAll(boot);

  it('report → queue → case → enforce from the console → owner told → appeal → overturned → restored', async () => {
    await scene('e2e');
    const stranger = await makeUser(db, 'stranger_e2e');

    // 1. A reader reports the review from the app.
    const filed = await report(reporter, 'review', reviewId);
    expect(filed.statusCode).toBe(201);

    // 2. It is in the queue, with its reporter's weight and the reported text.
    const queue = await app.inject({ method: 'GET', url: '/v1/admin/reports', headers: mod.bearer });
    expect(queue.statusCode).toBe(200);
    const kase = queue.json().cases.find((c: { subject_id: string }) => c.subject_id === reviewId);
    expect(kase).toMatchObject({ subject_type: 'review', report_count: 1, weight: 0.5, reasons: ['harassment'], owner: { id: owner.id } });
    expect(kase.snapshot.body).toContain('idiots');
    // The console page lists it too.
    const page = await app.inject({ method: 'GET', url: '/admin/reports', headers: { host: HOST, ...mod.cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`/admin/reports/review/${reviewId}`);

    // 3. The case, in context, with the ladder's next step for each rule.
    const detail = (await app.inject({ method: 'GET', url: `/v1/admin/reports/review/${reviewId}`, headers: mod.bearer })).json();
    expect(detail.subject.body).toContain('idiots');
    expect(detail.ladder.find((l: { rule: string }) => l.rule === 'harassment')).toMatchObject({ strikes: 0, step: 1, needs_admin: false });

    // 4. A moderator enforces Harassment from the console: cookie + same Origin (Part 06 CSRF guard).
    const csrf = await act(mod, 'review', reviewId, { decision: 'enforce', rule: 'harassment', reason: 'Insults other readers.' },
      { ...mod.cookie, origin: 'https://evil.example' });
    expect(csrf.statusCode).toBe(401);
    const done = await act(mod, 'review', reviewId, { decision: 'enforce', rule: 'harassment', reason: 'Insults other readers.' },
      { ...mod.cookie, origin: ORIGIN });
    expect(done.statusCode).toBe(200);
    const action = done.json();
    expect(action).toMatchObject({ decision: 'enforce', rule: 'harassment', step: 1, target_user_id: owner.id });

    // 5. Its effects: the review is gone for everyone, the report reviewed, the queue empty, the audit row written.
    expect((await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}`, headers: stranger.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/me/reports', headers: reporter.auth })).json().reports[0].status).toBe('reviewed');
    expect((await app.inject({ method: 'GET', url: '/v1/admin/reports', headers: mod.bearer })).json().open_cases).toBe(0);
    const [audit] = await auditRows('moderation.enforce');
    expect(audit).toMatchObject({ subject_id: reviewId, actor_id: mod.id, reason: 'Insults other readers.' });
    expect(audit!.payload).toMatchObject({ actionId: action.id, rule: 'harassment', step: 1, targetUserId: owner.id });

    // 6. The owner is told which rule applied, and that they may appeal (PRD §27.6).
    const notes = (await app.inject({ method: 'GET', url: '/v1/notifications', headers: owner.auth })).json().items;
    expect(notes[0]).toMatchObject({ type: 'moderation', deep_link: `flyleaf://moderation/${action.id}` });
    expect(notes[0].text).toMatch(/Harassment rule .* removed\. This is a warning|Harassment rule to your review\. Your review was removed\./);
    const notice = (await app.inject({ method: 'GET', url: `/v1/me/moderation/${action.id}`, headers: owner.auth })).json();
    expect(notice).toMatchObject({ rule: 'harassment', rule_label: 'Harassment', can_appeal: true, appeal: null });
    expect(notice.consequences).toEqual(['Your review was removed.', 'This is a warning.']);
    // Nobody else can see it.
    expect((await app.inject({ method: 'GET', url: `/v1/me/moderation/${action.id}`, headers: reporter.auth })).statusCode).toBe(404);

    // 7. The owner appeals once; a second appeal is refused.
    const appeal = await app.inject({ method: 'POST', url: `/v1/me/moderation/${action.id}/appeal`, headers: owner.auth, payload: { body: 'It was a joke between friends.' } });
    expect(appeal.json()).toMatchObject({ can_appeal: false, appeal: { state: 'pending' } });
    expect((await app.inject({ method: 'POST', url: `/v1/me/moderation/${action.id}/appeal`, headers: owner.auth, payload: { body: 'Again' } })).statusCode).toBe(409);

    // 8. A person reviews it from the appeals queue and overturns it: everything comes back.
    const appeals = (await app.inject({ method: 'GET', url: '/v1/admin/appeals', headers: admin.bearer })).json().appeals;
    expect(appeals.map((a: { id: string }) => a.id)).toEqual([action.id]);
    const overturn = await app.inject({
      method: 'POST', url: `/v1/admin/appeals/${action.id}/resolve`, headers: admin.bearer,
      payload: { decision: 'overturn', reason: 'Context shows it was banter.' },
    });
    expect(overturn.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/reviews/${reviewId}`, headers: stranger.auth })).statusCode).toBe(200);
    expect((await auditRows('moderation.appeal_overturned')).map((r) => r.subject_id)).toEqual([reviewId]);
    const after = (await app.inject({ method: 'GET', url: `/v1/me/moderation/${action.id}`, headers: owner.auth })).json();
    expect(after).toMatchObject({ reversed: true, appeal: { state: 'overturned' } });
    // The strike no longer counts on the ladder.
    await report(reporter, 'review', reviewId);
    const again = (await app.inject({ method: 'GET', url: `/v1/admin/reports/review/${reviewId}`, headers: mod.bearer })).json();
    expect(again.ladder.find((l: { rule: string }) => l.rule === 'harassment')).toMatchObject({ strikes: 0, step: 1 });
  });
});

describe('the enforcement ladder (PRD §27.3), rule by rule', () => {
  beforeAll(boot);
  beforeEach(() => scene());

  /** Three strikes of a rule on three reviews by the same owner. */
  async function strike(rule: string, by: Staff = admin) {
    const read = await makeRead(db, owner.id, await makeWork(db, `w ${Math.random()}`));
    const [r] = await db.insert(reviews).values({ readId: read, userId: owner.id, workId, body: 'x' }).returning({ id: reviews.id });
    await report(reporter, 'review', r!.id, 'spam');
    const res = await enforce(by, 'review', r!.id, rule);
    return { res, reviewId: r!.id, readId: read };
  }

  const userRow = async () => (await db.select().from(users).where(eq(users.id, owner.id)))[0]!;
  const reviewRow = async (id: string) => (await db.select().from(reviews).where(eq(reviews.id, id)))[0]!;

  it('the table: every rule\'s steps, and which need an admin', () => {
    expect(LADDER.spoilers.length).toBe(3);
    expect(LADDER.spam.map((s) => [s.content, s.suspendDays ?? null, s.ban ?? null])).toEqual([['remove', null, null], ['remove', 7, null], ['remove', null, true]]);
    expect(LADDER.harassment.map((s) => [s.warn ?? null, s.suspendDays ?? null, s.ban ?? null])).toEqual([[true, null, null], [null, 30, null], [null, null, true]]);
    expect(LADDER.hate_speech).toEqual([{ content: 'remove', ban: true }]);
    expect(LADDER.fake_review).toEqual([{ content: 'remove', excludeRatings: 'read' }, { content: 'remove', ban: true }]);
    expect(LADDER.vote_manipulation).toEqual([{ excludeRatings: 'account' }, { ban: true }]);
    expect(stepFor('spam', 9).index).toBe(2); // past the end, the last step repeats
    expect(RULES.filter((r) => needsAdmin('review', LADDER[r][0]!))).toEqual(['hate_speech', 'vote_manipulation']);
  });

  it('spam: removed; then 7 days without posting (admin only); then a ban', async () => {
    const one = await strike('spam', mod);
    expect(one.res.statusCode).toBe(200);
    const r1 = await reviewRow(one.reviewId);
    expect(r1.hiddenAt).not.toBeNull();
    expect(r1.deletedAt).not.toBeNull();
    // Step 2 suspends: a moderator is refused (and audited), nothing changes.
    const denied = await strike('spam', mod);
    expect(denied.res.statusCode).toBe(403);
    expect((await reviewRow(denied.reviewId)).hiddenAt).toBeNull();
    expect((await userRow()).suspendedUntil).toBeNull();
    expect((await auditRows('admin.denied')).length).toBeGreaterThan(0);
    const two = await enforce(admin, 'review', denied.reviewId, 'spam');
    expect(two.statusCode).toBe(200);
    const until = (await userRow()).suspendedUntil!;
    expect(Math.round((until.getTime() - Date.now()) / 86_400_000)).toBe(7);
    // The suspension holds: no comment, no review, no follow, no shelf; reading and liking are fine.
    const other = await makeUser(db, `o_${Math.random().toString(36).slice(2, 7)}`);
    const otherRead = await makeRead(db, other.id, workId);
    const c = await app.inject({ method: 'POST', url: `/v1/reads/${otherRead}/comments`, headers: owner.auth, payload: { body: 'hi' } });
    expect([c.statusCode, c.json().error.code]).toEqual([403, 'account_suspended']);
    expect((await app.inject({ method: 'POST', url: `/v1/users/${other.id}/follow`, headers: owner.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/shelves', headers: owner.auth, payload: { name: 'New' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/reads/${otherRead}/like`, headers: owner.auth })).statusCode).toBe(200);
    const three = await strike('spam');
    expect(three.res.json().step).toBe(3);
    const u = await userRow();
    expect(u.bannedAt).not.toBeNull();
    expect(u.deletedAt).not.toBeNull();
  });

  it('harassment: removed with a warning; then a 30-day suspension; then a ban', async () => {
    const a = await strike('harassment');
    expect(a.res.json().effects.consequences).toEqual(['Your review was removed.', 'This is a warning.']);
    await strike('harassment');
    expect(Math.round(((await userRow()).suspendedUntil!.getTime() - Date.now()) / 86_400_000)).toBe(30);
    await strike('harassment');
    expect((await userRow()).bannedAt).not.toBeNull();
  });

  it('hate speech: removed and banned at once; the account vanishes, its sessions end, retention keeps it', async () => {
    await db.execute(sql`INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
      VALUES (${owner.id}::uuid, 'h', gen_random_uuid(), now() + interval '1 day')`);
    const { res, reviewId: rid } = await strike('hate_speech');
    expect(res.json().step).toBe(1);
    expect((await reviewRow(rid)).hiddenAt).not.toBeNull();
    const u = await userRow();
    expect(u.bannedAt).not.toBeNull();
    expect((await app.inject({ method: 'GET', url: `/v1/users/${owner.id}`, headers: reporter.auth })).statusCode).toBe(404);
    expect(await db.execute(sql`SELECT 1 FROM refresh_tokens WHERE user_id = ${owner.id}::uuid AND revoked_at IS NULL`)).toHaveLength(0);
    // 31 days later the retention sweep still does not hard-delete a banned account.
    await db.execute(sql`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = ${owner.id}::uuid`);
    await retentionSweep(db, null);
    expect(await db.execute(sql`SELECT 1 FROM users WHERE id = ${owner.id}::uuid`)).toHaveLength(1);
    expect(await db.execute(sql`SELECT 1 FROM reviews WHERE id = ${rid}::uuid`)).toHaveLength(1);
  });

  it('unmarked spoilers: the review is marked as spoilers (not removed); then a warning; then reviews queue for 30 days', async () => {
    const a = await strike('spoilers', mod);
    const r = await reviewRow(a.reviewId);
    expect([r.hasSpoilers, r.hiddenAt]).toEqual([true, null]);
    const b = await strike('spoilers', mod);
    expect(b.res.json().effects.consequences).toContain('This is a warning.');
    await strike('spoilers', mod);
    expect(Math.round(((await userRow()).reviewFlagUntil!.getTime() - Date.now()) / 86_400_000)).toBe(30);
  });

  it('fake review: removed and that read\'s rating leaves the book\'s average; then a ban', async () => {
    const other = await makeUser(db, `rater_${Math.random().toString(36).slice(2, 7)}`);
    await makeRead(db, other.id, workId, { rating: '5.0' });
    await db.execute(sql`SELECT recompute_work_stats_for_work(${workId}::uuid)`);
    const before = await db.execute<{ rating_count: number }>(sql`SELECT rating_count FROM work_stats WHERE work_id = ${workId}::uuid`);
    expect(Number(before[0]!.rating_count)).toBe(2);
    await report(reporter, 'review', reviewId, 'fake_review');
    const res = await enforce(mod, 'review', reviewId, 'fake_review');
    expect(res.statusCode).toBe(200);
    const [r] = await db.select().from(reads).where(eq(reads.id, readId));
    expect(r!.ratingExcluded).toBe(true);
    const [ws] = await db.execute<{ rating_count: number; avg_rating: string }>(sql`SELECT rating_count, avg_rating FROM work_stats WHERE work_id = ${workId}::uuid`);
    expect([Number(ws!.rating_count), Number(ws!.avg_rating)]).toEqual([1, 5]);
  });

  it('impersonation on a profile: name, bio and photo reset with a warning (admin only); then a ban', async () => {
    await db.update(profiles).set({ displayName: 'Ursula K. Le Guin', bio: 'The real one' }).where(eq(profiles.userId, owner.id));
    await report(reporter, 'user', owner.id, 'other');
    expect((await enforce(mod, 'user', owner.id, 'impersonation')).statusCode).toBe(403);
    const res = await enforce(admin, 'user', owner.id, 'impersonation');
    expect(res.statusCode).toBe(200);
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, owner.id));
    expect([p!.displayName, p!.bio, p!.avatarKey]).toEqual([null, null, null]);
    expect(p!.username).toBe(owner.username);
  });

  it('vote manipulation: every rating of the account leaves the aggregates (admin only)', async () => {
    await db.execute(sql`SELECT recompute_work_stats_for_work(${workId}::uuid)`);
    await report(reporter, 'user', owner.id, 'other');
    const res = await enforce(admin, 'user', owner.id, 'vote_manipulation');
    expect(res.statusCode).toBe(200);
    expect((await userRow()).ratingsExcludedAt).not.toBeNull();
    const [ws] = await db.execute<{ rating_count: number }>(sql`SELECT rating_count FROM work_stats WHERE work_id = ${workId}::uuid`);
    expect(Number(ws!.rating_count)).toBe(0);
  });

  it('a comment and a shelf are hidden; the owner cannot restore a hidden shelf, and retention does not purge them', async () => {
    const [c] = await db.execute<{ id: string }>(sql`
      INSERT INTO read_comments (read_id, user_id, body) VALUES (${readId}::uuid, ${owner.id}::uuid, 'rude') RETURNING id`);
    await report(reporter, 'comment', c!.id);
    const hid = await enforce(mod, 'comment', c!.id, 'harassment');
    expect(hid.statusCode, hid.body).toBe(200);
    const [s] = await db.insert(shelves).values({ userId: owner.id, name: 'Slurs', slug: `s-${Math.random().toString(36).slice(2, 7)}` }).returning({ id: shelves.id });
    await report(reporter, 'shelf', s!.id, 'hate_speech');
    // spam, not harassment again: a second harassment strike would suspend (admin only).
    expect((await enforce(mod, 'shelf', s!.id, 'spam')).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/shelves/${s!.id}`, headers: reporter.auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/shelves/${s!.id}/restore`, headers: owner.auth })).statusCode).toBe(404);
    const [counts] = await db.execute<{ n: number }>(sql`SELECT comment_count AS n FROM reads WHERE id = ${readId}::uuid`);
    expect(Number(counts!.n)).toBe(0);
    await db.execute(sql`UPDATE read_comments SET deleted_at = now() - interval '40 days' WHERE id = ${c!.id}::uuid`);
    await db.execute(sql`UPDATE shelves SET deleted_at = now() - interval '40 days' WHERE id = ${s!.id}::uuid`);
    await retentionSweep(db, null);
    expect(await db.execute(sql`SELECT 1 FROM read_comments WHERE id = ${c!.id}::uuid`)).toHaveLength(1);
    expect(await db.execute(sql`SELECT 1 FROM shelves WHERE id = ${s!.id}::uuid`)).toHaveLength(1);
  });

  it('a removed review cannot be republished by its owner over the top', async () => {
    await report(reporter, 'review', reviewId);
    await enforce(mod, 'review', reviewId, 'harassment');
    const res = await app.inject({ method: 'POST', url: `/v1/reads/${readId}/review`, headers: owner.auth, payload: { body: 'back again' } });
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'review_removed']);
  });

  it('a book report is resolved (catalog tools act), never enforced', async () => {
    await report(reporter, 'work', workId, 'nsfw');
    expect((await enforce(mod, 'work', workId, 'spam')).statusCode).toBe(422);
    const res = await act(mod, 'work', workId, { decision: 'resolve', reason: 'Maturity overridden to explicit.' });
    expect(res.json()).toMatchObject({ decision: 'resolve', target_user_id: null });
  });
});

describe('actions: one at a time, a reason, and the audit row in the same transaction', () => {
  beforeAll(async () => {
    await boot();
    await db.execute(sql`CREATE TABLE refuse_audit_action (action text)`);
    await db.execute(sql.raw(`
      CREATE FUNCTION refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM refuse_audit_action r WHERE r.action = NEW.action) THEN RAISE EXCEPTION 'audit refused'; END IF;
        RETURN NEW;
      END $$`));
    await db.execute(sql`CREATE TRIGGER refuse_audit BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION refuse_audit()`);
  });
  afterAll(() => db.execute(sql`DROP TRIGGER refuse_audit ON admin_audit_log`));
  beforeEach(async () => {
    await scene();
    await db.execute(sql`DELETE FROM refuse_audit_action`);
  });

  it('a failed audit insert rolls the whole action back: content, reports, strike and notice', async () => {
    await db.execute(sql`INSERT INTO refuse_audit_action VALUES ('moderation.enforce')`);
    await report(reporter, 'review', reviewId);
    const res = await enforce(mod, 'review', reviewId, 'harassment');
    expect(res.statusCode).toBe(500);
    const r = (await db.select().from(reviews).where(eq(reviews.id, reviewId)))[0]!;
    expect([r.hiddenAt, r.deletedAt]).toEqual([null, null]);
    expect(await db.execute(sql`SELECT 1 FROM reports WHERE state = 'open' AND subject_id = ${reviewId}::uuid`)).toHaveLength(1);
    expect(await db.execute(sql`SELECT 1 FROM moderation_actions WHERE subject_id = ${reviewId}::uuid`)).toHaveLength(0);
    expect(await db.execute(sql`SELECT 1 FROM notifications WHERE user_id = ${owner.id}::uuid AND type = 'moderation'`)).toHaveLength(0);
  });

  it('an overturn whose audit row fails is rolled back too', async () => {
    await report(reporter, 'review', reviewId);
    const action = (await enforce(mod, 'review', reviewId, 'harassment')).json();
    await app.inject({ method: 'POST', url: `/v1/me/moderation/${action.id}/appeal`, headers: owner.auth, payload: { body: 'please' } });
    await db.execute(sql`INSERT INTO refuse_audit_action VALUES ('moderation.appeal_overturned')`);
    const res = await app.inject({ method: 'POST', url: `/v1/admin/appeals/${action.id}/resolve`, headers: admin.bearer, payload: { decision: 'overturn', reason: 'Long enough reason' } });
    expect(res.statusCode).toBe(500);
    expect((await db.select().from(reviews).where(eq(reviews.id, reviewId)))[0]!.hiddenAt).not.toBeNull();
    const [a] = await db.execute<{ appeal_state: string; reversed_at: string | null }>(sql`SELECT appeal_state, reversed_at FROM moderation_actions WHERE id = ${action.id}::uuid`);
    expect(a).toMatchObject({ appeal_state: 'pending', reversed_at: null });
  });

  it('two moderators acting at once: one wins, the other gets 409 and nothing is applied twice', async () => {
    await report(reporter, 'review', reviewId);
    const [a, b] = await Promise.all([enforce(mod, 'review', reviewId, 'spam'), enforce(admin, 'review', reviewId, 'harassment')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await db.execute(sql`SELECT 1 FROM moderation_actions WHERE subject_id = ${reviewId}::uuid`)).toHaveLength(1);
  });

  it('a reason of at least 10 characters, a rule only when enforcing, and only on what it fits', async () => {
    await report(reporter, 'review', reviewId);
    expect((await act(mod, 'review', reviewId, { decision: 'dismiss', reason: 'short' })).statusCode).toBe(422);
    expect((await act(mod, 'review', reviewId, { decision: 'enforce', reason: 'No rule given here' })).statusCode).toBe(400);
    expect((await act(mod, 'review', reviewId, { decision: 'dismiss', rule: 'spam', reason: 'Dismiss with a rule?' })).statusCode).toBe(400);
    const [c] = await db.execute<{ id: string }>(sql`INSERT INTO read_comments (read_id, user_id, body) VALUES (${readId}::uuid, ${owner.id}::uuid, 'x') RETURNING id`);
    await report(reporter, 'comment', c!.id);
    expect((await enforce(mod, 'comment', c!.id, 'fake_review')).statusCode).toBe(422);
    const ok = await act(mod, 'review', reviewId, { decision: 'dismiss', reason: 'Strong opinion, not harassment.' });
    expect(ok.json()).toMatchObject({ decision: 'dismiss', rule: null, step: null });
    expect((await auditRows('moderation.dismiss')).at(-1)!.reason).toBe('Strong opinion, not harassment.');
    expect(await db.execute(sql`SELECT 1 FROM notifications WHERE user_id = ${owner.id}::uuid AND type = 'moderation'`)).toHaveLength(0);
    expect((await act(mod, 'review', reviewId, { decision: 'dismiss', reason: 'Nothing left open here' })).statusCode).toBe(409);
  });

  it('an upheld appeal changes nothing but tells the owner; overturning a suspension needs an admin', async () => {
    await report(reporter, 'review', reviewId);
    const first = (await enforce(mod, 'review', reviewId, 'spam')).json();
    const read2 = await makeRead(db, owner.id, await makeWork(db, 'Second'));
    const [r2] = await db.insert(reviews).values({ readId: read2, userId: owner.id, workId, body: 'spam again' }).returning({ id: reviews.id });
    await report(reporter, 'review', r2!.id, 'spam');
    const second = (await enforce(admin, 'review', r2!.id, 'spam')).json();
    for (const a of [first, second]) {
      await app.inject({ method: 'POST', url: `/v1/me/moderation/${a.id}/appeal`, headers: owner.auth, payload: { body: 'Not spam.' } });
    }
    const uphold = await app.inject({ method: 'POST', url: `/v1/admin/appeals/${first.id}/resolve`, headers: mod.bearer, payload: { decision: 'uphold', reason: 'It is plainly spam.' } });
    expect(uphold.json()).toMatchObject({ appeal: { state: 'upheld' }, reversed_at: null });
    const texts = (await app.inject({ method: 'GET', url: '/v1/notifications', headers: owner.auth })).json().items.map((i: { text: string }) => i.text);
    expect(texts).toContain('We reviewed your appeal about your review. The decision stands.');
    const denied = await app.inject({ method: 'POST', url: `/v1/admin/appeals/${second.id}/resolve`, headers: mod.bearer, payload: { decision: 'overturn', reason: 'Not spam after all.' } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/v1/admin/appeals/${second.id}/resolve`, headers: admin.bearer, payload: { decision: 'overturn', reason: 'Not spam after all.' } });
    expect(ok.statusCode).toBe(200);
    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(u!.suspendedUntil).toBeNull();
    expect((await db.select().from(reviews).where(eq(reviews.id, r2!.id)))[0]!.hiddenAt).toBeNull();
  });

  it('overturning a ban brings the account back', async () => {
    await report(reporter, 'review', reviewId, 'hate_speech');
    const a = (await enforce(admin, 'review', reviewId, 'hate_speech')).json();
    await db.execute(sql`UPDATE moderation_actions SET appeal_state = 'pending', appeal_body = 'by email', appealed_at = now() WHERE id = ${a.id}::uuid`);
    await app.inject({ method: 'POST', url: `/v1/admin/appeals/${a.id}/resolve`, headers: admin.bearer, payload: { decision: 'overturn', reason: 'Quoted the book, not hate.' } });
    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    expect([u!.bannedAt, u!.deletedAt]).toEqual([null, null]);
    expect((await app.inject({ method: 'GET', url: `/v1/users/${owner.id}`, headers: reporter.auth })).statusCode).toBe(200);
  });
});

describe('role gating and the console pages', () => {
  beforeAll(async () => {
    await boot();
    await scene('pages');
  });

  it('every moderation route: guest and app user 401, moderator and admin through', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/v1/admin/reports'],
      ['GET', `/v1/admin/reports/review/${reviewId}`],
      ['POST', `/v1/admin/reports/review/${reviewId}/action`],
      ['GET', '/v1/admin/appeals'],
      ['POST', `/v1/admin/appeals/${reviewId}/resolve`],
    ];
    for (const [method, url] of routes) {
      const payload = method !== 'POST' ? undefined : url.includes('/appeals/') ? { decision: 'uphold', reason: 'role gating probe' } : { decision: 'dismiss', reason: 'role gating probe' };
      expect((await app.inject({ method: method as 'GET', url, payload })).statusCode, url).toBe(401);
      expect((await app.inject({ method: method as 'GET', url, headers: owner.auth, payload })).statusCode, url).toBe(401);
      expect((await app.inject({ method: method as 'GET', url, headers: mod.bearer, payload })).statusCode, url).not.toBe(401);
    }
    for (const page of ['/admin/reports', '/admin/appeals', `/admin/reports/review/${reviewId}`]) {
      const res = await app.inject({ method: 'GET', url: page });
      expect([res.statusCode, res.headers.location]).toEqual([302, '/admin/login']);
    }
  });

  it('pages escape every value and run only nonced script', async () => {
    const evil = '"><img src=x onerror=alert(1)></script><script>alert(2)</script>';
    await db.update(reviews).set({ body: evil }).where(eq(reviews.id, reviewId));
    await db.update(profiles).set({ username: 'evil_pages' }).where(eq(profiles.userId, owner.id));
    await app.inject({ method: 'POST', url: '/v1/reports', headers: reporter.auth, payload: { subject_type: 'review', subject_id: reviewId, reason: 'other', detail: evil } });
    for (const url of ['/admin/reports', `/admin/reports/review/${reviewId}`, '/admin/appeals']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: HOST, ...mod.cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).not.toContain('<img src=x');
      expect(res.body).not.toContain('<script>alert');
      const nonce = /script-src 'nonce-([^']+)'/.exec(String(res.headers['content-security-policy']))?.[1];
      expect(nonce).toBeTruthy();
      for (const [, attrs] of res.body.matchAll(/<script([^>]*)>/g)) expect(attrs).toContain(`nonce="${nonce}"`);
      expect(attributeNames(res.body).filter((n) => /^on/i.test(n))).toEqual([]);
    }
    expect((await app.inject({ method: 'GET', url: `/admin/reports/review/${reviewId}`, headers: { host: HOST, ...mod.cookie } })).body).toContain('&lt;img src=x');
  });
});

describe('api-client: the built client against the real app', () => {
  beforeAll(async () => {
    await boot();
    await scene('client');
  });

  it('reports, lists, enforces, reads the notice, appeals and resolves through every new method', async () => {
    const { FlyleafClient } = await import('../../../../packages/api-client/dist/index.js');
    const as = (token: string) =>
      new FlyleafClient({
        baseUrl: 'http://localhost/v1',
        getToken: () => token,
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
    const rep = as(reporter.token);
    const filed = await rep.createReport({ subject_type: 'review', subject_id: reviewId, reason: 'harassment', detail: 'rude' });
    expect(filed.report.status).toBe('open');
    expect((await rep.getMyReports()).reports.map((r) => r.id)).toEqual([filed.report.id]);
    const staffClient = as(mod.token);
    const queue = await staffClient.adminGetReportQueue({ subject_type: 'review' });
    expect(queue.cases[0]!.subject_id).toBe(reviewId);
    expect((await staffClient.adminGetReportCase('review', reviewId)).open_reports).toBe(1);
    const action = await staffClient.adminActOnReport('review', reviewId, { decision: 'enforce', rule: 'harassment', reason: 'Insulting other readers.' });
    const own = as(owner.token);
    expect((await own.getModerationNotices()).notices.map((n) => n.id)).toEqual([action.id]);
    expect((await own.getModerationNotice(action.id)).can_appeal).toBe(true);
    expect((await own.appealModeration(action.id, 'Please look again.')).appeal?.state).toBe('pending');
    expect((await as(admin.token).adminGetAppeals()).appeals.map((a) => a.id)).toEqual([action.id]);
    expect((await as(admin.token).adminResolveAppeal(action.id, { decision: 'uphold', reason: 'Clearly insulting.' })).appeal?.state).toBe('upheld');
  });
});
