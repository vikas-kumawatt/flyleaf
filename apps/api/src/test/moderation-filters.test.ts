// SO-41: automated layer 1 (PRD §27.2), one block per rule. Each test drives
// the real route, so removing the rule's line turns its test red.
//
//   1. Slur and hate-term list: blocked at submission, with a clear reason, on
//      reviews, comments, profile text, shelf names and usernames.
//   2. Link rules: none for accounts under 7 days; at most 2 in a review.
//   3. Duplicate content: the same text on 3+ works queues for review.
//   4. Rate limits: the shared layer (§24.4, §10.6): reviews 10/hour.
//   5. New-account restriction: no reviews before email verification.
//   (+) §27.3 spoilers, 3rd strike: the account's reviews queue for 30 days.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { RateLimits } from '../platform/rate-limits.js';
import {
  blockedTerms, containsBlockedTerm, countLinks, hashTerm, DUPLICATE_WORKS, MAX_REVIEW_LINKS, NEW_ACCOUNT_LINK_DAYS,
} from '../moderation/filters.js';
import { BLOCKED_TERM_HASHES } from '../moderation/terms.data.js';
import { users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, unlimited, type TestUser } from './interaction-fixtures.js';

/** A harmless made-up word stands in for a listed term; the list holds hashes only. */
const STAND_IN = 'grimbleshank';

let db: Db;
let app: FastifyInstance;
let alice: TestUser;
let bob: TestUser;

async function setup(opts: { rateLimits?: RateLimits } = {}) {
  ({ db } = await freshDrizzle());
  app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, ...opts });
  await app.ready();
  alice = await makeUser(db, 'alice');
  bob = await makeUser(db, 'bob');
  await age(alice.id, 30);
  await age(bob.id, 30);
}

async function age(userId: string, days: number) {
  await db.update(users).set({ createdAt: new Date(Date.now() - days * 86_400_000) }).where(eq(users.id, userId));
}

const req = (who: TestUser, method: 'POST' | 'PATCH', url: string, payload: object) =>
  app.inject({ method, url, headers: who.auth, payload });

async function postReview(who: TestUser, body: string, title = `Book ${Math.random()}`) {
  const read = await makeRead(db, who.id, await makeWork(db, title));
  return { read, res: await req(who, 'POST', `/v1/reads/${read}/review`, { body }) };
}

const automated = () => db.execute<{ auto_rule: string; reason: string; subject_type: string; subject_id: string }>(sql`
  SELECT auto_rule, reason, subject_type, subject_id FROM reports WHERE source = 'automated' ORDER BY created_at`);

describe('layer 1 rule 1: the slur and hate-term list', () => {
  beforeEach(async () => {
    await setup();
    blockedTerms.add(hashTerm(STAND_IN));
  });
  afterEach(() => void blockedTerms.delete(hashTerm(STAND_IN)));

  it('the shipped list exists and holds hashes, never words', () => {
    expect(BLOCKED_TERM_HASHES.length).toBeGreaterThan(0);
    for (const h of BLOCKED_TERM_HASHES) expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(BLOCKED_TERM_HASHES).size).toBe(BLOCKED_TERM_HASHES.length);
  });

  it('matches whole tokens through case, accents, look-alikes, spacing and plurals; never inside another word', () => {
    for (const hit of ['a GRIMBLESHANK wrote this', 'gr1mbl3shank', 'grímbleshank', 'g r i m b l e s h a n k', 'g.r.i.m.b.l.e.s.h.a.n.k',
      'grimbleshanks everywhere', 'grimbleshank!', '$grimbleshank$']) {
      expect(containsBlockedTerm(hit), hit).toBe(true);
    }
    for (const miss of ['grimbleshankery is a craft', 'ungrimbleshank', 'grimble shank', 'A chink in the armour; Niger; Scunthorpe']) {
      expect(containsBlockedTerm(miss), miss).toBe(false);
    }
  });

  it('a review is refused with a clear reason and nothing is written', async () => {
    const { read, res } = await postReview(alice, `What a ${STAND_IN} of a book.`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'content_rejected', field: 'body' });
    expect(res.json().error.message).toMatch(/not allowed/);
    expect(await db.execute(sql`SELECT 1 FROM reviews WHERE read_id = ${read}::uuid`)).toHaveLength(0);
    // Editing a clean review into one is refused too.
    const ok = await postReview(alice, 'Clean.');
    const edit = await req(alice, 'PATCH', `/v1/reviews/${ok.res.json().id}`, { body: STAND_IN });
    expect(edit.statusCode).toBe(422);
  });

  it('a comment, profile text, a shelf name or description, and a username are refused', async () => {
    const read = await makeRead(db, bob.id, await makeWork(db, 'Thread'));
    const c = await req(alice, 'POST', `/v1/reads/${read}/comments`, { body: `you ${STAND_IN}` });
    expect([c.statusCode, c.json().error.code]).toEqual([422, 'content_rejected']);
    const bio = await req(alice, 'PATCH', '/v1/me/profile', { bio: STAND_IN });
    expect([bio.statusCode, bio.json().error.field]).toEqual([422, 'bio']);
    const name = await req(alice, 'PATCH', '/v1/me/profile', { displayName: `Mr ${STAND_IN}` });
    expect([name.statusCode, name.json().error.field]).toEqual([422, 'displayName']);
    const shelf = await req(alice, 'POST', '/v1/shelves', { name: STAND_IN });
    expect([shelf.statusCode, shelf.json().error.field]).toEqual([422, 'name']);
    const desc = await req(alice, 'POST', '/v1/shelves', { name: 'Fine', description: `${STAND_IN}!` });
    expect([desc.statusCode, desc.json().error.field]).toEqual([422, 'description']);
    const user = await req(alice, 'PATCH', '/v1/me/username', { username: `the_${STAND_IN}` });
    expect(user.statusCode).toBe(422);
    expect(await db.execute(sql`SELECT 1 FROM read_comments`)).toHaveLength(0);
    expect(await db.execute(sql`SELECT 1 FROM shelves`)).toHaveLength(0);
  });

  it('strong criticism is untouched: nothing here deletes or blocks ordinary language', async () => {
    const { res } = await postReview(alice, 'Dreadful, lazy, cynical prose. A chink in every argument. I hated it.');
    expect(res.statusCode).toBe(200);
  });
});

describe('layer 1 rule 2: link rules', () => {
  beforeEach(setup);

  it('counts scheme, www and bare-host links; not ordinary dotted text', () => {
    expect(countLinks('see https://a.example/x, www.b.org and c.com/page')).toBe(3);
    expect(countLinks('Mr. Darcy. e.g. ... 3.5 stars')).toBe(0);
  });

  it(`an account under ${NEW_ACCOUNT_LINK_DAYS} days old may not post a link, anywhere`, async () => {
    await age(alice.id, NEW_ACCOUNT_LINK_DAYS - 1);
    const { res } = await postReview(alice, 'More at https://spam.example');
    expect([res.statusCode, res.json().error.code]).toEqual([422, 'links_not_allowed_yet']);
    const read = await makeRead(db, bob.id, await makeWork(db, 'T'));
    const c = await req(alice, 'POST', `/v1/reads/${read}/comments`, { body: 'buy at www.cheap.shop' });
    expect(c.json().error.code).toBe('links_not_allowed_yet');
    expect((await req(alice, 'PATCH', '/v1/me/profile', { bio: 'me: example.com' })).json().error.code).toBe('links_not_allowed_yet');
    // A day later the same review is fine.
    await age(alice.id, NEW_ACCOUNT_LINK_DAYS + 1);
    expect((await postReview(alice, 'More at https://spam.example')).res.statusCode).toBe(200);
  });

  it(`a review holds at most ${MAX_REVIEW_LINKS} links; a comment is not held to that`, async () => {
    const two = await postReview(alice, 'https://a.example and https://b.example');
    expect(two.res.statusCode).toBe(200);
    const three = await postReview(alice, 'https://a.example https://b.example https://c.example');
    expect([three.res.statusCode, three.res.json().error.code]).toEqual([422, 'too_many_links']);
    const read = await makeRead(db, bob.id, await makeWork(db, 'T'));
    const c = await req(alice, 'POST', `/v1/reads/${read}/comments`, { body: 'https://a.example https://b.example https://c.example' });
    expect(c.statusCode).toBe(201);
  });
});

describe(`layer 1 rule 3: the same text on ${DUPLICATE_WORKS}+ works queues for review`, () => {
  beforeEach(setup);

  it('two works: nothing; the third: one automated spam report on the third review; never blocked', async () => {
    const text = 'Five stars. Buy it now from my favourite seller.';
    await postReview(alice, text);
    await postReview(alice, `  ${text.toUpperCase()}  `);
    expect(await automated()).toHaveLength(0);
    const third = await postReview(alice, text.replace(/ /g, '   '));
    expect(third.res.statusCode).toBe(200);
    const q = await automated();
    expect(q).toEqual([{ auto_rule: 'duplicate_content', reason: 'spam', subject_type: 'review', subject_id: third.res.json().id }]);
    // Someone else posting the same words does not count towards alice's.
    await postReview(bob, text);
    expect(await automated()).toHaveLength(1);
  });

  it('an edit that makes a third copy queues it too', async () => {
    await postReview(alice, 'Same words.');
    await postReview(alice, 'Same words.');
    const other = await postReview(alice, 'Different words.');
    await req(alice, 'PATCH', `/v1/reviews/${other.res.json().id}`, { body: 'Same words.' });
    expect((await automated()).map((r) => r.auto_rule)).toEqual(['duplicate_content']);
  });
});

describe('layer 1 rule 4: rate limits are the shared layer\'s (PRD §10.6)', () => {
  it('the 11th new review in an hour is a 429, counted only when the review is written', async () => {
    ({ db } = await freshDrizzle());
    const limits = new RateLimits({ exact: new PgRateLimiter(db), enabled: new Set(['reviews:hour']) });
    app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, rateLimits: limits });
    await app.ready();
    alice = await makeUser(db, 'alice');
    await age(alice.id, 30);
    blockedTerms.add(hashTerm(STAND_IN));
    try {
      // A refused review spends nothing.
      expect((await postReview(alice, STAND_IN)).res.statusCode).toBe(422);
    } finally {
      blockedTerms.delete(hashTerm(STAND_IN));
    }
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await postReview(alice, `Review number ${i}`)).res.statusCode);
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
  });
});

describe('layer 1 rule 5: no reviews before email verification', () => {
  beforeEach(setup);

  it('an unverified account cannot publish a review (403), and nothing is written', async () => {
    const carol = await makeUser(db, 'carol', { verified: false });
    const { read, res } = await postReview(carol, 'Hello');
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'email_unverified']);
    expect(await db.execute(sql`SELECT 1 FROM reviews WHERE read_id = ${read}::uuid`)).toHaveLength(0);
  });
});

describe('§27.3 spoilers, 3rd strike: an account\'s reviews queue for 30 days', () => {
  beforeEach(setup);

  it('while review_flag_until is in the future, every new or edited review queues; after it, none', async () => {
    await db.update(users).set({ reviewFlagUntil: new Date(Date.now() + 86_400_000) }).where(eq(users.id, alice.id));
    const a = await postReview(alice, 'It all ends when the father dies.');
    expect(a.res.statusCode).toBe(200);
    expect(await automated()).toEqual([{ auto_rule: 'flagged_account', reason: 'spoilers', subject_type: 'review', subject_id: a.res.json().id }]);
    await db.update(users).set({ reviewFlagUntil: new Date(Date.now() - 1000) }).where(eq(users.id, alice.id));
    await postReview(alice, 'Another.');
    expect(await automated()).toHaveLength(1);
  });
});
