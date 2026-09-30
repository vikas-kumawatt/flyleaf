// Audit 09: ratings and reviews (SL-60 … SL-64).
//
// Probes for what the SL-6x suites never checked: the review's feed activity
// after edits (visibility, spoilers, text, private reads and accounts,
// resurrection), atomicity of the review write, the double-submit race,
// rating and body validation, the book reviews list's order, pagination and
// filter, and the work counters the write path leaves behind.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { MemoryCache, PgRateLimiter, type Db } from '../platform/index.js';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { ReadingService } from '../reading/index.js';
import { IdentityService } from '../identity/index.js';
import { ReviewService } from '../reviews/index.js';
import { activity, editions, reads, reviews } from '../db/schema.js';
import { follow, interactionHarness, makeRead, makeUser, makeWork, type TestUser } from './interaction-fixtures.js';

let db: Db;
let client: { close: () => Promise<void> };
let app: FastifyInstance;
/** The same database with the catalog mounted (interactionHarness has no /works/:id). */
let catalogApp: FastifyInstance;

beforeAll(async () => {
  ({ db, client, app } = await interactionHarness());
  catalogApp = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await catalogApp.ready();
}, 60_000);

afterAll(async () => {
  await catalogApp.close();
  await app.close();
  await client.close();
});

let seq = 0;
const uniq = (p: string) => `${p}${++seq}`;

async function postReview(u: TestUser, readId: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/v1/reads/${readId}/review`, headers: u.auth, payload });
}
async function patchReview(u: TestUser, id: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/v1/reviews/${id}`, headers: u.auth, payload });
}
async function reviewActivity(reviewId: string) {
  return db.select().from(activity).where(sql`${activity.objectType} = 'review' AND ${activity.objectId} = ${reviewId}`);
}
async function popularFeedIds(viewer?: TestUser) {
  const res = await app.inject({ method: 'GET', url: '/v1/feed?tab=popular&limit=50', headers: viewer?.auth ?? {} });
  expect(res.statusCode).toBe(200);
  return (res.json().items as { object_id: string | null }[]).map((i) => i.object_id);
}

describe('the review activity follows the review (feed privacy)', () => {
  it('PATCH to private removes the review from every feed', async () => {
    const author = await makeUser(db, uniq('pa'));
    const work = await makeWork(db, 'Private Later');
    const read = await makeRead(db, author.id, work);
    const created = (await postReview(author, read, { body: 'Visible at first.' })).json();
    expect(await popularFeedIds()).toContain(created.id);

    expect((await patchReview(author, created.id, { visibility: 'private' })).statusCode).toBe(200);
    expect(await popularFeedIds()).not.toContain(created.id);
    expect(await reviewActivity(created.id)).toHaveLength(0);
  });

  it('PATCH back to public (or followers) puts it in feeds again', async () => {
    const author = await makeUser(db, uniq('pb'));
    const work = await makeWork(db, 'Private First');
    const read = await makeRead(db, author.id, work);
    const created = (await postReview(author, read, { body: 'Kept to myself.', visibility: 'private' })).json();
    expect(await reviewActivity(created.id)).toHaveLength(0);

    await patchReview(author, created.id, { visibility: 'public' });
    const rows = await reviewActivity(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visibility).toBe('public');
    expect(await popularFeedIds()).toContain(created.id);
  });

  it('a private account never gets a public review activity, on create or edit', async () => {
    const author = await makeUser(db, uniq('pc'), { isPrivate: true });
    const work = await makeWork(db, 'Private Account');
    const read = await makeRead(db, author.id, work);
    const created = (await postReview(author, read, { body: 'Only followers.', visibility: 'followers' })).json();

    await patchReview(author, created.id, { visibility: 'public' });
    const viaPatch = await reviewActivity(created.id);
    expect(viaPatch.map((a) => a.visibility)).toEqual(['followers']);

    await postReview(author, read, { body: 'Only followers, edited.', visibility: 'public' });
    const viaUpsert = await reviewActivity(created.id);
    expect(viaUpsert.map((a) => a.visibility)).toEqual(['followers']);
    expect(await popularFeedIds()).not.toContain(created.id);
  });

  it('a public review on a private read stays out of feeds (the stricter visibility wins)', async () => {
    const author = await makeUser(db, uniq('pd'));
    const work = await makeWork(db, 'Private Read');
    const read = await makeRead(db, author.id, work, { visibility: 'private' });
    const created = (await postReview(author, read, { body: 'On a private read.', visibility: 'public' })).json();
    // GET /reviews/:id already answers 404 to a guest (Audit 05); the feed must agree.
    expect((await app.inject({ method: 'GET', url: `/v1/reviews/${created.id}` })).statusCode).toBe(404);
    expect(await popularFeedIds()).not.toContain(created.id);
    expect(await reviewActivity(created.id)).toHaveLength(0);
  });

  it('making the read private afterwards takes its review out of feeds; public again brings it back', async () => {
    const author = await makeUser(db, uniq('pr'));
    const work = await makeWork(db, 'Read Hidden Later');
    const read = await makeRead(db, author.id, work);
    const created = (await postReview(author, read, { body: 'Posted in public.' })).json();
    expect(await popularFeedIds()).toContain(created.id);

    const setReadVisibility = (visibility: string) =>
      catalogApp.inject({ method: 'POST', url: '/v1/reads', headers: author.auth, payload: { work_id: work, status: 'finished', visibility } });
    expect((await setReadVisibility('private')).statusCode).toBeLessThan(300);
    expect(await reviewActivity(created.id)).toHaveLength(0);
    expect(await popularFeedIds()).not.toContain(created.id);

    await setReadVisibility('public');
    expect((await reviewActivity(created.id)).map((a) => a.visibility)).toEqual(['public']);
  });

  it('a status change that does not mention visibility keeps a private read private', async () => {
    const author = await makeUser(db, uniq('pt'));
    const work = await makeWork(db, 'Private Reading');
    const read = await makeRead(db, author.id, work, { status: 'reading', visibility: 'private' });
    const created = (await postReview(author, read, { body: 'Mid-book notes.', visibility: 'public' })).json();
    const res = await catalogApp.inject({ method: 'POST', url: '/v1/reads', headers: author.auth, payload: { work_id: work, status: 'finished' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().visibility).toBe('private');
    expect(await reviewActivity(created.id)).toHaveLength(0);
  });

  it.each(['finish', 'dnf'])('POST /reads/:id/%s without a visibility keeps a private read private', async (action) => {
    const author = await makeUser(db, uniq('pu'));
    const work = await makeWork(db, `Private ${action}`);
    const read = await makeRead(db, author.id, work, { status: 'reading', visibility: 'private' });
    const res = await catalogApp.inject({ method: 'POST', url: `/v1/reads/${read}/${action}`, headers: author.auth, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().visibility).toBe('private');
  });

  it('turning the account private takes its reviews out of the public feed', async () => {
    const author = await makeUser(db, uniq('ps'));
    const work = await makeWork(db, 'Account Hidden Later');
    const read = await makeRead(db, author.id, work);
    const created = (await postReview(author, read, { body: 'Before going private.' })).json();
    const res = await catalogApp.inject({ method: 'PATCH', url: '/v1/me/profile', headers: author.auth, payload: { isPrivate: true } });
    expect(res.statusCode).toBe(200);
    expect((await reviewActivity(created.id)).map((a) => a.visibility)).toEqual(['followers']);
    expect(await popularFeedIds()).not.toContain(created.id);
  });

  it('a followers review on a followers read is a followers activity', async () => {
    const author = await makeUser(db, uniq('pe'));
    const work = await makeWork(db, 'Followers Read');
    const read = await makeRead(db, author.id, work, { visibility: 'followers' });
    const created = (await postReview(author, read, { body: 'For followers.' })).json();
    expect((await reviewActivity(created.id)).map((a) => a.visibility)).toEqual(['followers']);
  });

  it('marking spoilers or editing the text after posting updates the feed card', async () => {
    const author = await makeUser(db, uniq('pf'));
    const work = await makeWork(db, 'Spoiled Later');
    const read = await makeRead(db, author.id, work);
    const created = (await postReview(author, read, { body: 'The butler did it.' })).json();

    await patchReview(author, created.id, { has_spoilers: true, body: 'Big reveal at the end.' });
    const [row] = await reviewActivity(created.id);
    expect(row!.metadata).toMatchObject({ hasSpoilers: true, snippet: 'Big reveal at the end.' });
  });

  it('deleting removes the activity; writing again publishes it again as a new review', async () => {
    const author = await makeUser(db, uniq('pg'));
    const work = await makeWork(db, 'Second Thoughts');
    const read = await makeRead(db, author.id, work);
    const first = (await postReview(author, read, { body: 'First take.', visibility: 'followers' })).json();
    await app.inject({ method: 'DELETE', url: `/v1/reviews/${first.id}`, headers: author.auth });
    expect(await reviewActivity(first.id)).toHaveLength(0);

    const again = await postReview(author, read, { body: 'Second take.' });
    expect(again.statusCode).toBe(200);
    const body = again.json();
    expect(body.id).toBe(first.id);
    // A revived review is a new publication: public by default, not "edited",
    // and back in feeds.
    expect(body.visibility).toBe('public');
    expect(body.edited_at).toBeNull();
    expect(new Date(body.published_at).getTime()).toBeGreaterThan(new Date(first.published_at).getTime());
    expect((await reviewActivity(first.id)).map((a) => a.visibility)).toEqual(['public']);
  });

  it('an imported read publishes no activity, on create or on any edit', async () => {
    const author = await makeUser(db, uniq('ph'));
    const work = await makeWork(db, 'Imported');
    const read = await makeRead(db, author.id, work);
    await db.update(reads).set({ source: 'import' }).where(eq(reads.id, read));
    const created = (await postReview(author, read, { body: 'From Goodreads.' })).json();
    await patchReview(author, created.id, { visibility: 'followers', body: 'From Goodreads, edited.' });
    await postReview(author, read, { body: 'From Goodreads, again.' });
    expect(await reviewActivity(created.id)).toHaveLength(0);
  });
});

describe('the review write', () => {
  it('is one transaction: a failure after the rating write leaves nothing behind', async () => {
    const author = await makeUser(db, uniq('ta'));
    const work = await makeWork(db, 'Atomic');
    const read = await makeRead(db, author.id, work, { rating: '5.0' });
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION audit09_boom() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'snippet' = 'BOOM' THEN RAISE EXCEPTION 'boom'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER audit09_boom BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION audit09_boom()`);
    try {
      const res = await postReview(author, read, { body: 'BOOM', rating: 1.5 });
      expect(res.statusCode).toBe(500);
    } finally {
      await db.execute(sql`DROP TRIGGER audit09_boom ON activity`);
    }
    const [r] = await db.select({ rating: reads.rating }).from(reads).where(eq(reads.id, read));
    expect(r!.rating).toBe('5.0');
    expect(await db.select().from(reviews).where(eq(reviews.readId, read))).toHaveLength(0);
  });

  it('a book on the want list cannot be reviewed; reading, paused, finished and DNF can (A-09-026)', async () => {
    const author = await makeUser(db, uniq('tw'));
    for (const status of ['want', 'reading', 'paused', 'finished', 'dnf'] as const) {
      const work = await makeWork(db, `Status ${status}`);
      const read = await makeRead(db, author.id, work, { status });
      const res = await postReview(author, read, { body: `On a ${status} read.` });
      if (status === 'want') {
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toMatchObject({ code: 'review_needs_reading', field: 'status' });
        expect(await db.select().from(reviews).where(eq(reviews.readId, read))).toHaveLength(0);
      } else {
        expect(res.statusCode).toBe(200);
      }
    }
  });

  it('a double submit (two requests at once) is one review and one activity, both 200', async () => {
    const author = await makeUser(db, uniq('tb'));
    const work = await makeWork(db, 'Double Tap');
    const read = await makeRead(db, author.id, work);
    const [a, b] = await Promise.all([
      postReview(author, read, { body: 'Tapped twice.' }),
      postReview(author, read, { body: 'Tapped twice.' }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().id).toBe(b.json().id);
    expect(await reviewActivity(a.json().id)).toHaveLength(1);
  });

  it('an edit that omits visibility and spoilers keeps them (an offline replay sends only the body)', async () => {
    const author = await makeUser(db, uniq('tc'));
    const work = await makeWork(db, 'Keep Settings');
    const read = await makeRead(db, author.id, work);
    await postReview(author, read, { body: 'Careful.', visibility: 'followers', has_spoilers: true, spoiler_after_page: 12 });
    const res = await postReview(author, read, { body: 'Careful, edited.' });
    expect(res.json()).toMatchObject({ visibility: 'followers', has_spoilers: true, spoiler_after_page: 12, body: 'Careful, edited.' });
  });

  it('rating: null clears the rating (PRD §9.3), through POST and PATCH', async () => {
    const author = await makeUser(db, uniq('td'));
    const work = await makeWork(db, 'Unrate');
    const read = await makeRead(db, author.id, work, { rating: '4.0' });
    const created = (await postReview(author, read, { body: 'Rated.', rating: null })).json();
    expect(created.rating).toBeNull();
    await patchReview(author, created.id, { rating: 3.5 });
    expect((await patchReview(author, created.id, { rating: null })).json().rating).toBeNull();
  });

  it('POST /reads clears a rating with clear_rating; a status change alone keeps it', async () => {
    const author = await makeUser(db, uniq('tk'));
    const work = await makeWork(db, 'Clear Me');
    await makeRead(db, author.id, work, { status: 'reading', rating: '3.5' });
    const post = (payload: Record<string, unknown>) =>
      catalogApp.inject({ method: 'POST', url: '/v1/reads', headers: author.auth, payload: { work_id: work, ...payload } });

    expect((await post({ status: 'finished', rating: null })).json().rating).toBe(3.5);
    const both = await post({ status: 'finished', rating: 4, clear_rating: true });
    expect(both.statusCode).toBe(422);
    expect(both.json().error.field).toBe('clear_rating');
    const cleared = await post({ status: 'finished', clear_rating: true });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().rating).toBeNull();
    const [ws] = await db.execute<{ rating_count: number }>(sql`SELECT rating_count::int FROM work_stats WHERE work_id = ${work}`);
    expect(ws!.rating_count).toBe(0);
  });

  it('the heart is independent of the rating (§9.4): heart with no rating, and un-heart', async () => {
    const author = await makeUser(db, uniq('te'));
    const work = await makeWork(db, 'Loved Unrated');
    const read = await makeRead(db, author.id, work);
    const created = (await postReview(author, read, { body: 'No stars, all heart.', hearted: true })).json();
    expect(created).toMatchObject({ rating: null, hearted: true });
    expect((await patchReview(author, created.id, { hearted: false })).json()).toMatchObject({ rating: null, hearted: false });
  });

  it.each([3.7, 4.04, 0.25])('refuses the rating %s with a field error, never stores it rounded (§9.2)', async (rating) => {
    const author = await makeUser(db, uniq('tf'));
    const work = await makeWork(db, 'Half Steps');
    const read = await makeRead(db, author.id, work, { rating: '2.0' });
    const res = await postReview(author, read, { body: 'Precise.', rating });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('rating');
    const [r] = await db.select({ rating: reads.rating }).from(reads).where(eq(reads.id, read));
    expect(r!.rating).toBe('2.0');
  });

  it('counts the 10,000 limit in characters, as the database does, not UTF-16 units', async () => {
    const author = await makeUser(db, uniq('tg'));
    const work = await makeWork(db, 'Emoji');
    const read = await makeRead(db, author.id, work);
    const sixThousandEmoji = '📚'.repeat(6000); // 6,000 characters, 12,000 UTF-16 units
    expect((await postReview(author, read, { body: sixThousandEmoji })).statusCode).toBe(200);
    const tooLong = '📚'.repeat(10_001);
    expect((await postReview(author, read, { body: tooLong })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('spoiler_after_page: beyond the edition is refused; without the spoiler flag it is not stored', async () => {
    const author = await makeUser(db, uniq('th'));
    const work = await makeWork(db, 'Paged');
    const [ed] = await db.insert(editions).values({ workId: work, pageCount: 300 }).returning({ id: editions.id });
    const read = await makeRead(db, author.id, work);
    await db.update(reads).set({ editionId: ed!.id }).where(eq(reads.id, read));

    const beyond = await postReview(author, read, { body: 'Late twist.', has_spoilers: true, spoiler_after_page: 301 });
    expect(beyond.statusCode).toBe(422);
    expect(beyond.json().error.field).toBe('spoiler_after_page');

    const ok = await postReview(author, read, { body: 'Late twist.', has_spoilers: true, spoiler_after_page: 300 });
    expect(ok.json().spoiler_after_page).toBe(300);

    const noFlag = await postReview(author, read, { body: 'No spoilers after all.', has_spoilers: false, spoiler_after_page: 120 });
    expect(noFlag.json()).toMatchObject({ has_spoilers: false, spoiler_after_page: null });
  });

  it('leaves work_stats exact with the trigger alone: the nightly reconcile finds nothing to fix', async () => {
    const author = await makeUser(db, uniq('ti'));
    const other = await makeUser(db, uniq('tj'));
    const work = await makeWork(db, 'Counted');
    const r1 = await makeRead(db, author.id, work);
    const r2 = await makeRead(db, other.id, work, { rating: '2.0' });
    const created = (await postReview(author, r1, { body: 'Four and a half.', rating: 4.5, hearted: true })).json();
    await patchReview(author, created.id, { rating: 3.0 });
    await postReview(other, r2, { body: 'Meh.', hearted: true });

    // What the nightly reconcile would write for this work, against what is stored.
    const [row] = await db.execute<{ stored: string; truth: string }>(sql`
      SELECT
        (SELECT row(rating_count, rating_sum, avg_rating, heart_count, read_count, dnf_count)::text
           FROM work_stats WHERE work_id = ${work}) AS stored,
        (SELECT row(COUNT(rating), COALESCE(SUM(rating), 0)::numeric(12, 1),
                    ROUND(SUM(rating) / NULLIF(COUNT(rating), 0), 2)::numeric(3, 2),
                    COUNT(DISTINCT user_id) FILTER (WHERE hearted),
                    COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished'),
                    COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf'))::text
           FROM reads WHERE work_id = ${work}) AS truth`);
    expect(row!.stored).toBe(row!.truth);
    expect(row!.stored).toBe('(2,5.0,2.50,2,2,0)');
  });
});

describe('the Bayesian rating has one implementation (SQL)', () => {
  it.each([
    [1, 5.0, 3.9, 3.94],
    [500, 4.3 * 500, 3.9, 4.28],
    [25, 25 * 2.0, 4.0, 3.0],
    [0, 0, 3.9, null],
  ])('flyleaf_weighted_rating(v=%s, sum=%s, C=%s) = %s', async (v, sum, c, expected) => {
    const [row] = await db.execute<{ w: string | null }>(sql`SELECT flyleaf_weighted_rating(${v}::bigint, ${sum}::numeric, ${c}::numeric)::text AS w`);
    expect(row!.w === null ? null : Number(row!.w)).toBe(expected);
  });

  it('a single 5-star book cannot outrank a beloved classic (§9.5)', async () => {
    const [row] = await db.execute<{ one: string; classic: string }>(sql`
      SELECT flyleaf_weighted_rating(1, 5.0, 3.9)::text AS one, flyleaf_weighted_rating(40000, 40000 * 4.3, 3.9)::text AS classic`);
    expect(Number(row!.classic)).toBeGreaterThan(Number(row!.one));
  });
});

describe('the book reviews list', () => {
  let work: string;
  let viewer: TestUser;
  const ids: string[] = [];

  beforeAll(async () => {
    work = await makeWork(db, 'Many Reviews');
    viewer = await makeUser(db, uniq('lv'));
    const ratings = ['3.5', '4.0', '4.5', '4.0', null];
    for (let i = 0; i < 25; i++) {
      const u = await makeUser(db, uniq('la'));
      if (i % 5 === 0) await follow(db, viewer.id, u.id);
      const read = await makeRead(db, u.id, work, { rating: ratings[i % 5] });
      const res = await postReview(u, read, { body: `Review number ${i} with a reasonable length for ranking purposes.` });
      ids.push(res.json().id);
    }
    // Every tie at once: same instant, same likes. Only the id can order them.
    await db.update(reviews).set({ publishedAt: new Date('2026-09-01T00:00:00Z') }).where(eq(reviews.workId, work));
    // One deleted review must never appear or count.
    await db.update(reviews).set({ deletedAt: new Date() }).where(eq(reviews.id, ids[24]!));
  }, 120_000);

  const page = async (sort: string, offset: number, extra = '', who?: TestUser, limit = 7) =>
    (await app.inject({ method: 'GET', url: `/v1/works/${work}/reviews?sort=${sort}&limit=${limit}&offset=${offset}${extra}`, headers: who?.auth ?? {} })).json();

  it.each(['friends', 'likes', 'newest', 'highest', 'lowest'])('sort=%s pages through every review exactly once', async (sort) => {
    for (const who of [viewer, undefined]) {
      const seen: string[] = [];
      let total = 0;
      for (let off = 0; off < 35; off += 7) {
        const p = await page(sort, off, '', who);
        total = p.total;
        seen.push(...p.data.map((r: { id: string }) => r.id));
      }
      expect(total).toBe(24);
      expect(new Set(seen).size).toBe(24);
      expect(seen).toHaveLength(24);
      expect(seen).not.toContain(ids[24]);
    }
  });

  it('friends sort puts followed accounts first for a signed-in viewer', async () => {
    const p = await page('friends', 0, '', viewer);
    const followedFirst = p.data.slice(0, 5).map((r: { id: string }) => ids.indexOf(r.id) % 5);
    expect(followedFirst).toEqual([0, 0, 0, 0, 0]);
  });

  it('highest and lowest order by rating, unrated last in both', async () => {
    const hi = (await page('highest', 0, '', undefined, 30)).data as { rating: number | null }[];
    const lo = (await page('lowest', 0, '', undefined, 30)).data as { rating: number | null }[];
    expect(hi.map((r) => r.rating).slice(0, 5)).toEqual([4.5, 4.5, 4.5, 4.5, 4.5]);
    expect(lo.map((r) => r.rating).slice(0, 5)).toEqual([3.5, 3.5, 3.5, 3.5, 3.5]);
    expect(hi.at(-1)!.rating).toBeNull();
    expect(lo.at(-1)!.rating).toBeNull();
  });

  it('the rating filter is the histogram bucket: 4 means 3.5 and 4.0', async () => {
    const p = await page('newest', 0, '&rating=4', undefined, 30);
    const got = new Set((p.data as { rating: number }[]).map((r) => r.rating));
    expect(got).toEqual(new Set([3.5, 4.0]));
    expect(p.total).toBe(p.data.length);
  });
});

describe('work page aggregates', () => {
  it('GET /works/:id carries heart_count next to rating_count (§9.4)', async () => {
    const a = await makeUser(db, uniq('ha'));
    const b = await makeUser(db, uniq('hb'));
    const work = await makeWork(db, 'Hearted');
    const ra = await makeRead(db, a.id, work, { rating: '3.5' });
    await makeRead(db, b.id, work);
    await db.update(reads).set({ hearted: true }).where(eq(reads.id, ra));
    const res = await catalogApp.inject({ method: 'GET', url: `/v1/works/${work}` });
    expect(res.json()).toMatchObject({ rating_count: 1, heart_count: 1 });
  });

  it('your_read carries the id of your live review, so the composer can edit it', async () => {
    const a = await makeUser(db, uniq('hc'));
    const work = await makeWork(db, 'Edit Me');
    const read = await makeRead(db, a.id, work);
    const created = (await postReview(a, read, { body: 'Draft one.' })).json();
    const res = await catalogApp.inject({ method: 'GET', url: `/v1/works/${work}`, headers: a.auth });
    expect(res.json().your_read).toMatchObject({ id: read, review_id: created.id });
  });
});

// Audit 09b (A-09-009): the friends sort ranks a capped candidate set for a
// signed-in viewer, and caches the ranked ids for guests. Both must give
// exactly SO-23's order.
describe('friends sort: capped candidates and the guest cache (09b)', () => {
  // Real time, frozen: the access tokens are signed on the real clock and expire.
  const NOW = new Date();
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  let work: string;
  let viewer: TestUser;
  let hidden: string[];

  beforeAll(async () => {
    work = await makeWork(db, 'Capped');
    const elsewhere = await makeWork(db, 'Elsewhere');
    viewer = await makeUser(db, uniq('cv'));
    const friends = [];
    for (let i = 0; i < 8; i++) friends.push(await makeUser(db, uniq('cf')));
    for (const f of friends) await follow(db, viewer.id, f.id);

    // 415 strangers. Likes 0-3 by g % 4 cluster the lower bounds; g 381-400
    // are recent (the exploration pool). g 401-410 are followed by a friend
    // (second degree, +0.14) and g 411-415 have 99-like reviews elsewhere
    // (credibility, +0.10): all ten with no likes here, so their lower bound
    // is among the lowest, but their exact score beats every 3-like review.
    const rows = await db.execute<{ id: string; g: number }>(sql`
      WITH u AS (
        INSERT INTO users (email, password_hash, date_of_birth, email_verified_at)
        SELECT 'cap' || g || '@example.com', 'x', '1990-01-01', now() FROM generate_series(1, 415) g
        RETURNING id, email)
      SELECT id, split_part(substr(email, 4), '@', 1)::int AS g FROM u`);
    await db.execute(sql`INSERT INTO profiles (user_id, username, is_private)
      SELECT u.id, 'cap_' || replace(u.id::text, '-', ''), false FROM users u WHERE u.email LIKE 'cap%@example.com'`);
    const author = (g: number) => rows.find((r) => Number(r.g) === g)!.id;
    const likes = (g: number) => (g <= 400 ? g % 4 : 0);
    const age = (g: number) => (g > 380 && g <= 400 ? 2 : 30);
    const values = rows.map((r) => sql`(${r.id}::uuid, ${likes(Number(r.g))}::int, ${daysAgo(age(Number(r.g)))}::timestamptz)`);
    for (const f of friends) values.push(sql`(${f.id}::uuid, 0, ${daysAgo(30)}::timestamptz)`);
    await db.execute(sql`
      WITH spec (user_id, likes, at) AS (VALUES ${sql.join(values, sql`, `)}),
      rd AS (
        INSERT INTO reads (user_id, work_id, status, visibility, like_count)
        SELECT user_id, ${work}::uuid, 'finished', 'public', likes FROM spec
        RETURNING id, user_id)
      INSERT INTO reviews (read_id, user_id, work_id, body, published_at)
      SELECT rd.id, rd.user_id, ${work}::uuid, repeat('w', 200), spec.at FROM rd JOIN spec USING (user_id)`);
    for (let g = 401; g <= 410; g++) await follow(db, friends[0]!.id, author(g));
    for (let g = 411; g <= 415; g++) {
      for (const attempt of [1, 2]) {
        const read = await makeRead(db, author(g), elsewhere, { attemptNo: attempt });
        await db.execute(sql`UPDATE reads SET like_count = 99 WHERE id = ${read}`);
        await db.execute(sql`INSERT INTO reviews (read_id, user_id, work_id, body) VALUES (${read}, ${author(g)}, ${elsewhere}, 'Loved.')`);
      }
    }
    const ids = await db.execute<{ id: string }>(sql`
      SELECT rv.id FROM reviews rv JOIN users u ON u.id = rv.user_id
      WHERE rv.work_id = ${work} AND split_part(substr(u.email, 4), '@', 1) ~ '^(40[1-9]|41[0-5]|410)$'
      ORDER BY split_part(substr(u.email, 4), '@', 1)::int`);
    hidden = ids.map((r) => r.id);
    expect(hidden).toHaveLength(15);
  }, 120_000);

  afterEach(() => vi.useRealTimers());

  const listPage = async (who: TestUser | undefined, offset: number, limit = 20, on = app) =>
    (await on.inject({ method: 'GET', url: `/v1/works/${work}/reviews?sort=friends&limit=${limit}&offset=${offset}`, headers: who?.auth ?? {} })).json();

  it('a signed-in viewer gets exactly the uncapped order, page by page, with authors beyond the first N lower bounds', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const uncapped = await new ReviewService(db).rankAll(work, viewer.id);
    expect(uncapped).toHaveLength(423);
    // All fifteen rank in the first two pages on their exact score, although
    // their lower bounds are outside the first N = 200: a cap that never
    // extends misses them (mutation-checked).
    for (const h of hidden) expect(uncapped.indexOf(h)).toBeLessThan(40);
    expect((await listPage(viewer, 0)).total).toBe(423);
    for (const offset of [0, 20, 40, 220]) {
      const p = await listPage(viewer, offset);
      expect(p.data.map((r: { id: string }) => r.id), `offset ${offset}`).toEqual(uncapped.slice(offset, offset + 20));
    }
  });

  /**
   * One review per new author on a new work, `likes` likes, `age` days old,
   * 200 characters. `elsewhere` >= 0 adds two reviews with that many likes on
   * other works: credibility is the median of the author's likes, this
   * review included, so 0 keeps a liked author at 0 and 99 makes one fully
   * credible. The reader follows `friend`, and `friend` or the reader
   * follows the authors their spec says.
   */
  async function slackFixture(prefix: string, specs: { likes: number; age: number; elsewhere: number; followedBy?: 'reader' | 'friend' }[]) {
    const work = await makeWork(db, `${prefix} work`);
    const [e1, e2] = [await makeWork(db, `${prefix} e1`), await makeWork(db, `${prefix} e2`)];
    const reader = await makeUser(db, uniq(`${prefix}v`));
    const friend = await makeUser(db, uniq(`${prefix}f`));
    await follow(db, reader.id, friend.id);
    const made = await db.execute<{ id: string; i: number }>(sql`
      WITH u AS (
        INSERT INTO users (email, password_hash, date_of_birth, email_verified_at)
        SELECT ${prefix} || '.' || i || '@example.com', 'x', '1990-01-01', now() FROM generate_series(1, ${specs.length}) i
        RETURNING id, email)
      SELECT id, split_part(split_part(email, '@', 1), '.', 2)::int AS i FROM u`);
    await db.execute(sql`INSERT INTO profiles (user_id, username, is_private)
      SELECT u.id, 's_' || replace(u.id::text, '-', ''), false FROM users u WHERE u.email LIKE ${`${prefix}.%@example.com`}`);
    const specOf = (m: { i: number }) => specs[Number(m.i) - 1]!;
    const row = (m: { id: string }, workId: string, likes: number, age: number) =>
      sql`(${m.id}::uuid, ${workId}::uuid, ${likes}::int, ${daysAgo(age)}::timestamptz)`;
    const values = made.flatMap((m) => {
      const x = specOf(m);
      return [row(m, work, x.likes, x.age), ...(x.elsewhere >= 0 ? [row(m, e1, x.elsewhere, 60), row(m, e2, x.elsewhere, 60)] : [])];
    });
    await db.execute(sql`
      WITH spec (user_id, work_id, likes, at) AS (VALUES ${sql.join(values, sql`, `)}),
      rd AS (
        INSERT INTO reads (user_id, work_id, status, visibility, like_count)
        SELECT user_id, work_id, 'finished', 'public', likes FROM spec
        RETURNING id, user_id, work_id)
      INSERT INTO reviews (read_id, user_id, work_id, body, published_at)
      SELECT rd.id, rd.user_id, rd.work_id, repeat('w', 200), spec.at FROM rd JOIN spec USING (user_id, work_id)`);
    const follows = made.filter((m) => specOf(m).followedBy);
    if (follows.length) {
      await db.execute(sql`INSERT INTO follows (follower_id, followee_id, state) VALUES ${sql.join(
        follows.map((m) => sql`(${specOf(m).followedBy === 'reader' ? reader.id : friend.id}::uuid, ${m.id}::uuid, 'accepted')`),
        sql`, `)}`);
    }
    const authorsWhere = (pred: (x: (typeof specs)[number]) => boolean) => made.filter((m) => pred(specOf(m))).map((m) => m.id);
    return { work, reader, authorsWhere };
  }

  async function firstPageAgainstUncapped(work: string, reader: TestUser) {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const uncapped = await new ReviewService(db).rankAll(work, reader.id);
    const page = (await app.inject({ method: 'GET', url: `/v1/works/${work}/reviews?sort=friends&limit=20&offset=0`, headers: reader.auth })).json();
    expect(page.data.map((r: { id: string }) => r.id)).toEqual(uncapped.slice(0, 20));
    return page.data.map((r: { user_id: string }) => r.user_id) as string[];
  }

  it('extends by exactly the slack credibility and second-degree proximity can add (0.24)', async () => {
    // Lower bounds: 20 reviews with 53 likes (0.420, also their exact score),
    // 200 with none (0.247), and 3 by authors who are second degree AND
    // credible, a day older (0.245: outside N = 200, exact 0.485). With
    // N = 200 the 20th candidate scores 0.420, above the boundary + 0.10 or
    // + 0.14 but not + 0.24: only the full slack extends and finds the three.
    const { work, reader, authorsWhere } = await slackFixture('slack', [
      ...Array.from({ length: 20 }, () => ({ likes: 53, age: 30, elsewhere: 0 })),
      ...Array.from({ length: 200 }, () => ({ likes: 0, age: 30, elsewhere: -1 })),
      ...Array.from({ length: 3 }, () => ({ likes: 0, age: 31, elsewhere: 99, followedBy: 'friend' as const })),
    ]);
    const onPage = await firstPageAgainstUncapped(work, reader);
    expect(onPage.slice(0, 3).sort()).toEqual(authorsWhere((x) => x.elsewhere === 99).sort());
  }, 120_000);

  it('caps the friend tier too, extending by the credibility a friend can add (0.10)', async () => {
    // All friends. Lower bounds: 20 with 4 likes (0.597), 197 with none
    // (0.527), 3 credible and a day older (0.525: outside N = 200, exact
    // 0.625). The 20th candidate, 0.597, is above the boundary but not
    // above it + 0.10.
    const { work, reader, authorsWhere } = await slackFixture('fslack', [
      ...Array.from({ length: 20 }, () => ({ likes: 4, age: 30, elsewhere: 0, followedBy: 'reader' as const })),
      ...Array.from({ length: 197 }, () => ({ likes: 0, age: 30, elsewhere: -1, followedBy: 'reader' as const })),
      ...Array.from({ length: 3 }, () => ({ likes: 0, age: 31, elsewhere: 99, followedBy: 'reader' as const })),
    ]);
    const onPage = await firstPageAgainstUncapped(work, reader);
    expect(onPage.slice(0, 3).sort()).toEqual(authorsWhere((x) => x.elsewhere === 99).sort());
  }, 120_000);

  /** Every page of 100, in order. */
  const allIds = async (who: TestUser | undefined, on: FastifyInstance) => {
    const out: string[] = [];
    for (let offset = 0; ; offset += 100) {
      const p = await listPage(who, offset, 100, on);
      out.push(...p.data.map((r: { id: string }) => r.id));
      if (offset + 100 >= p.total) return out;
    }
  };

  it('caches the guest ranking for 60 s, re-checks visibility, and never serves it to a signed-in viewer', async () => {
    const cached = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), cache: new MemoryCache() });
    await cached.ready();
    try {
      const before = await allIds(undefined, cached);
      expect(before).toHaveLength(423);

      // A new public review: the cached guest list does not know it yet; a signed-in viewer sees it.
      const late = await makeUser(db, uniq('cl'));
      const lateRead = await makeRead(db, late.id, work);
      const lateReview = (await postReview(late, lateRead, { body: 'Late to the party.' })).json();
      const guestIds = await allIds(undefined, cached);
      expect(guestIds).not.toContain(lateReview.id);
      const signedIn = await allIds(viewer, cached);
      expect(signedIn).toContain(lateReview.id);

      // A review made private inside the 60 s is gone from the cached page at once.
      const target = before[0]!;
      await db.update(reviews).set({ visibility: 'private' }).where(eq(reviews.id, target));
      const after = await allIds(undefined, cached);
      expect(after).not.toContain(target);
      expect(after).toEqual(before.slice(1));
      await db.update(reviews).set({ visibility: 'public' }).where(eq(reviews.id, target));
    } finally {
      await cached.close();
    }
  });
});
