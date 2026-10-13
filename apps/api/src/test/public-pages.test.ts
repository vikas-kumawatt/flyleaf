// SO-50 / SO-51: public book, profile and shelf pages (PRD §16.5, §29.1,
// AC-18, §4.2, §7.8). Rendered for a guest, always: everything a guest may
// not see is the one 404 page, byte for byte, with nothing in any tag.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';

import { type Db } from '../platform/index.js';
import { profiles, reviews, shelves, shelfItems, users, works } from '../db/schema.js';
import { NOT_FOUND_PAGE, PUBLIC_PAGE_CSP } from '../web/public-pages.js';
import { block, follow, interactionHarness, makeRead, makeUser, makeWork, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let seq = 0;
let attempt = 0;
const uname = (p: string) => `${p}_${++seq}`;
const EVIL = '"><script>alert(1)</script><img src=x onerror=alert(2)>';

beforeAll(async () => {
  ({ db, app } = await interactionHarness());
}, 60_000);

async function page(url: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.body, headers: res.headers, location: res.headers.location };
}

async function review(u: TestUser, workId: string, body: string, opts: { visibility?: 'public' | 'followers' | 'private'; readVisibility?: 'public' | 'followers' | 'private'; spoilers?: boolean; rating?: string } = {}) {
  const readId = await makeRead(db, u.id, workId, {
    status: 'finished', visibility: opts.readVisibility ?? 'public', rating: opts.rating ?? '4.0', attemptNo: ++attempt,
  });
  const [rv] = await db.insert(reviews).values({
    readId, userId: u.id, workId, body, visibility: opts.visibility ?? 'public', hasSpoilers: opts.spoilers ?? false,
  }).returning({ id: reviews.id });
  return rv!.id;
}

async function shelf(u: TestUser, name: string, privacy: 'public' | 'followers' | 'private', items: string[] = [], description: string | null = null) {
  const res = await app.inject({ method: 'POST', url: '/v1/shelves', headers: u.auth, payload: { name, privacy, description } });
  expect(res.statusCode).toBe(201);
  const s = res.json().shelf as { id: string; slug: string };
  for (const w of items) {
    expect((await app.inject({ method: 'POST', url: `/v1/shelves/${s.id}/items`, headers: u.auth, payload: { work_id: w } })).statusCode).toBe(201);
  }
  return s;
}

/** A denial is the random id's page: same status, same bytes, same headers that matter. */
function expectNotFound(res: Awaited<ReturnType<typeof page>>) {
  expect(res.status).toBe(404);
  expect(res.body).toBe(NOT_FOUND_PAGE);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['content-security-policy']).toBe(PUBLIC_PAGE_CSP);
  expect(res.headers['x-robots-tag']).toBe('noindex');
  expect(res.headers.location).toBeUndefined();
}

function expectPage(res: Awaited<ReturnType<typeof page>>) {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.headers['cache-control']).toBe('public, max-age=300');
  expect(res.headers['content-security-policy']).toBe(PUBLIC_PAGE_CSP);
  expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  // No script may run on a public page, and none is there.
  expect(PUBLIC_PAGE_CSP).not.toMatch(/script-src/);
  expect(res.body).not.toMatch(/<script/i);
  // No inline handler on any tag (quoted attribute values blanked first:
  // escaped text inside one is not an attribute).
  expect(res.body.replace(/"[^"]*"/g, '""')).not.toMatch(/<[^>]*\son[a-z]+=/i);
}

// ---------------------------------------------------------------------------
// Book pages
// ---------------------------------------------------------------------------

describe('SO-50 · /book/:id', () => {
  it('renders the book with canonical, Open Graph, Twitter and App Links tags, and its public reviews', async () => {
    const author = await makeUser(db, uname('rev'));
    const workId = await makeWork(db, 'Piranesi');
    await db.update(works).set({ olCoverId: 12345, description: 'A house of endless halls.' }).where(eq(works.id, workId));
    await review(author, workId, 'The most beautiful book I read this year.');
    const res = await page(`/book/${workId}`);
    expectPage(res);
    const b = res.body;
    expect(b).toContain(`<link rel="canonical" href="http://localhost:8081/book/${workId}">`);
    expect(b).toContain('<meta property="og:type" content="books.book">');
    expect(b).toContain('<meta property="og:title" content="Piranesi by Unknown author">');
    expect(b).toContain('<meta property="og:description" content="A house of endless halls.">');
    expect(b).toContain('<meta property="og:image" content="https://covers.openlibrary.org/b/id/12345-L.jpg">');
    expect(b).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(b).toContain(`<meta property="al:ios:url" content="flyleaf://work/${workId}">`);
    expect(b).toContain(`<meta property="al:android:url" content="flyleaf://work/${workId}">`);
    expect(b).toContain('The most beautiful book I read this year.');
    expect(b).toContain(`href="/@${author.username}"`);
  });

  it('shows only what a guest may read: no private, followers-only, private-account, unverified, deleted, hidden or banned review', async () => {
    const workId = await makeWork(db, 'Many Reviews');
    const ok = await makeUser(db, uname('ok'));
    const priv = await makeUser(db, uname('priv'), { isPrivate: true });
    const unv = await makeUser(db, uname('unv'), { verified: false });
    const banned = await makeUser(db, uname('ban'));
    const deleted = await makeUser(db, uname('del'));
    await review(ok, workId, 'VISIBLE public review');
    await review(ok, workId, 'HIDDEN private review', { visibility: 'private' });
    await review(ok, workId, 'HIDDEN followers review', { visibility: 'followers' });
    await review(ok, workId, 'HIDDEN public review on a private read', { readVisibility: 'private' });
    await review(priv, workId, 'HIDDEN private account review');
    await review(unv, workId, 'HIDDEN unverified author review');
    const gone = await review(ok, workId, 'HIDDEN deleted review');
    await db.update(reviews).set({ deletedAt: new Date() }).where(eq(reviews.id, gone));
    const hidden = await review(ok, workId, 'HIDDEN moderator-removed review');
    await db.update(reviews).set({ deletedAt: new Date(), hiddenAt: new Date() }).where(eq(reviews.id, hidden));
    await review(banned, workId, 'HIDDEN banned author review');
    await db.update(users).set({ bannedAt: new Date(), deletedAt: new Date() }).where(eq(users.id, banned.id));
    await review(deleted, workId, 'HIDDEN deleted account review');
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted.id));
    // A signed-in reader who could see more still gets the guest's page.
    const fan = await makeUser(db, uname('fan'));
    await follow(db, fan.id, priv.id);
    await follow(db, fan.id, ok.id);
    for (const headers of [{}, fan.auth, ok.auth]) {
      const res = await page(`/book/${workId}`, headers);
      expectPage(res);
      expect(res.body).toContain('VISIBLE public review');
      expect(res.body).not.toContain('HIDDEN');
    }
  });

  it('a spoiler review shows its author but never its text', async () => {
    const u = await makeUser(db, uname('spoil'));
    const workId = await makeWork(db, 'Twisty');
    await review(u, workId, 'The butler did it.', { spoilers: true });
    const res = await page(`/book/${workId}`);
    expectPage(res);
    expect(res.body).toContain(`@${u.username}`);
    expect(res.body).not.toContain('The butler did it.');
    expect(res.body).toContain('Contains spoilers');
  });

  it('PRD §7.8: an explicit book resolves, but with no cover, description or reviews, and is not indexed', async () => {
    const u = await makeUser(db, uname('exp'));
    const workId = await makeWork(db, 'Adult Title');
    await db.update(works).set({ maturity: 'explicit', olCoverId: 999, description: 'EXPLICIT DESCRIPTION' }).where(eq(works.id, workId));
    await review(u, workId, 'EXPLICIT REVIEW BODY');
    const res = await page(`/book/${workId}`);
    expectPage(res);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('<meta name="robots" content="noindex">');
    expect(res.body).toContain('Adult Title');
    expect(res.body).not.toContain('999-L.jpg');
    expect(res.body).not.toContain('og:image');
    expect(res.body).not.toContain('EXPLICIT DESCRIPTION');
    expect(res.body).not.toContain('EXPLICIT REVIEW BODY');
  });

  it('a merged book 301s to its survivor; a provisional, missing or malformed id is the one 404', async () => {
    const survivor = await makeWork(db, 'Survivor');
    const loser = await makeWork(db, 'Loser');
    await db.update(works).set({ mergedIntoId: survivor }).where(eq(works.id, loser));
    const moved = await page(`/book/${loser}`);
    expect(moved.status).toBe(301);
    expect(moved.location).toBe(`/book/${survivor}`);
    expect(moved.headers['cache-control']).toBe('no-store');

    const provisional = await makeWork(db, 'PROVISIONAL TITLE');
    await db.update(works).set({ isProvisional: true }).where(eq(works.id, provisional));
    expectNotFound(await page(`/book/${provisional}`));
    expectNotFound(await page(`/book/${randomUUID()}`));
    expectNotFound(await page('/book/not-a-uuid'));
    expectNotFound(await page(`/book/${encodeURIComponent(EVIL)}`));
  });

  it('escapes every value it shows', async () => {
    const u = await makeUser(db, uname('xss'));
    const workId = await makeWork(db, `Title ${EVIL}`);
    await db.update(works).set({ description: `Desc ${EVIL}`, subtitle: `Sub ${EVIL}` }).where(eq(works.id, workId));
    await db.update(profiles).set({ displayName: `Name ${EVIL}` }).where(eq(profiles.userId, u.id));
    await review(u, workId, `Body ${EVIL}`);
    const res = await page(`/book/${workId}`);
    expectPage(res);
    expect(res.body).not.toContain(EVIL);
    expect(res.body).toContain('&quot;&gt;&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// Profile pages: flyleaf.app/@username (SO-51)
// ---------------------------------------------------------------------------

describe('SO-51 · /@username', () => {
  it('renders a public profile: name, bio, favourites, recent public reviews, public shelves, and the tags', async () => {
    const u = await makeUser(db, uname('reader'));
    const fav = await makeWork(db, 'Favourite Book');
    const explicitFav = await makeWork(db, 'EXPLICIT FAVOURITE');
    await db.update(works).set({ olCoverId: 777 }).where(eq(works.id, fav));
    await db.update(works).set({ maturity: 'explicit' }).where(eq(works.id, explicitFav));
    await db.update(profiles).set({ displayName: 'Ada Reader', bio: 'Reads at night.', favouriteWorkIds: [fav, explicitFav] }).where(eq(profiles.userId, u.id));
    const reviewed = await makeWork(db, 'Reviewed Book');
    await review(u, reviewed, 'PUBLIC REVIEW TEXT');
    await review(u, await makeWork(db, 'Other'), 'FOLLOWERS REVIEW TEXT', { visibility: 'followers' });
    await review(u, explicitFav, 'REVIEW OF AN EXPLICIT BOOK');
    await shelf(u, 'Public Picks', 'public', [fav]);
    await shelf(u, 'FOLLOWERS SHELF', 'followers');
    await shelf(u, 'PRIVATE SHELF', 'private');

    const res = await page(`/@${u.username}`);
    expectPage(res);
    const b = res.body;
    expect(b).toContain(`<link rel="canonical" href="http://localhost:8081/@${u.username}">`);
    expect(b).toContain('<meta property="og:type" content="profile">');
    expect(b).toContain(`<meta property="og:title" content="Ada Reader (@${u.username})">`);
    expect(b).toContain('<meta property="og:description" content="Reads at night.">');
    expect(b).toContain(`<meta property="profile:username" content="${u.username}">`);
    expect(b).toContain(`<meta property="al:android:url" content="flyleaf://user/${u.id}">`);
    expect(b).toContain('777-M.jpg');
    expect(b).toContain(`href="/book/${fav}"`);
    expect(b).toContain('PUBLIC REVIEW TEXT');
    expect(b).toContain('Public Picks');
    for (const hidden of ['EXPLICIT FAVOURITE', 'FOLLOWERS REVIEW TEXT', 'REVIEW OF AN EXPLICIT BOOK', 'FOLLOWERS SHELF', 'PRIVATE SHELF']) {
      expect(b, hidden).not.toContain(hidden);
    }
  });

  it('a private, deleted or banned account, an unknown name and a malformed one are the same 404, with nothing in any tag', async () => {
    const priv = await makeUser(db, uname('secret'), { isPrivate: true });
    await db.update(profiles).set({ displayName: 'SECRET NAME', bio: 'SECRET BIO' }).where(eq(profiles.userId, priv.id));
    const del = await makeUser(db, uname('gone'));
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, del.id));
    const banned = await makeUser(db, uname('banned'));
    await db.update(users).set({ deletedAt: new Date(), bannedAt: new Date() }).where(eq(users.id, banned.id));
    // A follower's token changes nothing: the page is the guest's.
    const fan = await makeUser(db, uname('fan'));
    await follow(db, fan.id, priv.id);
    for (const url of [`/@${priv.username}`, `/@${del.username}`, `/@${banned.username}`, '/@nobody_here_at_all', `/@${encodeURIComponent(EVIL)}`]) {
      expectNotFound(await page(url));
      expectNotFound(await page(url, fan.auth));
    }
    expectNotFound(await page(`/@${priv.username}`, priv.auth));
  });

  it('a block changes nothing for a guest page: the blocked reader with a token still sees only the public page', async () => {
    const owner = await makeUser(db, uname('blocker'));
    const other = await makeUser(db, uname('blocked'));
    await block(db, owner.id, other.id);
    // The HTML page ignores tokens, so it is identical for a stranger, the blocked
    // reader and a guest: it can never confirm a block.
    const guest = await page(`/@${owner.username}`);
    expectPage(guest);
    expect((await page(`/@${owner.username}`, other.auth)).body).toBe(guest.body);
  });

  it('an old username and a different case 301 to the current /@username; /u/:username 301s there too', async () => {
    const u = await makeUser(db, uname('before'));
    const newName = uname('after');
    expect((await app.inject({ method: 'PATCH', url: '/v1/me/username', headers: u.auth, payload: { username: newName } })).statusCode).toBe(200);
    const old = await page(`/@${u.username}`);
    expect(old.status).toBe(301);
    expect(old.location).toBe(`/@${newName}`);
    expect(old.headers['cache-control']).toBe('no-store');
    expect((await page(`/@${newName.toUpperCase()}`)).location).toBe(`/@${newName}`);
    expect((await page(`/u/${newName}`)).location).toBe(`/@${newName}`);
    expect((await page(`/u/${u.username}`)).location).toBe(`/@${newName}`);
    expectPage(await page(`/@${newName}`));
  });

  it('an old username of an account that went private, or was deleted, is the 404: a redirect never reveals it', async () => {
    const u = await makeUser(db, uname('hide'));
    const newName = uname('hidden');
    await app.inject({ method: 'PATCH', url: '/v1/me/username', headers: u.auth, payload: { username: newName } });
    await db.update(profiles).set({ isPrivate: true }).where(eq(profiles.userId, u.id));
    expectNotFound(await page(`/@${u.username}`));
    expectNotFound(await page(`/u/${u.username}`));
    expectNotFound(await page(`/u/${newName}`));
  });

  it('escapes every value it shows', async () => {
    const u = await makeUser(db, uname('esc'));
    const w = await makeWork(db, `Book ${EVIL}`);
    await db.update(profiles).set({ displayName: `N ${EVIL}`, bio: `B ${EVIL}`, favouriteWorkIds: [w] }).where(eq(profiles.userId, u.id));
    await review(u, w, `R ${EVIL}`);
    await shelf(u, 'Shelf xss', 'public', [], `D ${EVIL}`);
    await db.update(shelves).set({ name: `S ${EVIL}` }).where(eq(shelves.userId, u.id));
    const res = await page(`/@${u.username}`);
    expectPage(res);
    expect(res.body).not.toContain(EVIL);
  });
});

// ---------------------------------------------------------------------------
// Shelf pages, rendered as a guest (SO-50 over SH-10)
// ---------------------------------------------------------------------------

describe('SO-50 · shelf pages', () => {
  it('list the shelf’s books (explicit ones left out), with og:image from the first cover', async () => {
    const u = await makeUser(db, uname('lister'));
    const a = await makeWork(db, 'First Listed');
    const x = await makeWork(db, 'EXPLICIT LISTED');
    await db.update(works).set({ olCoverId: 4242 }).where(eq(works.id, a));
    await db.update(works).set({ maturity: 'explicit' }).where(eq(works.id, x));
    const s = await shelf(u, 'My List', 'public', [a, x]);
    for (const url of [`/u/${u.username}/shelves/${s.slug}`, `/shelf/${s.id}`]) {
      const res = await page(url);
      expectPage(res);
      expect(res.body).toContain('First Listed');
      expect(res.body).toContain(`href="/book/${a}"`);
      expect(res.body).not.toContain('EXPLICIT LISTED');
      expect(res.body).toContain('<meta property="og:image" content="https://covers.openlibrary.org/b/id/4242-L.jpg">');
      expect(res.body).toContain(`<link rel="canonical" href="http://localhost:8081/u/${u.username}/shelves/${s.slug}">`);
      expect(res.body).toContain(`href="/@${u.username}"`);
    }
  });

  it('a private or followers-only shelf, a private account’s shelf and a deleted shelf are the 404, even with the owner’s token', async () => {
    const u = await makeUser(db, uname('shelfowner'));
    const priv = await shelf(u, 'PRIVATE LIST', 'private');
    const fol = await shelf(u, 'FOLLOWERS LIST', 'followers');
    const del = await shelf(u, 'DELETED LIST', 'public');
    await app.inject({ method: 'DELETE', url: `/v1/shelves/${del.id}`, headers: u.auth });
    const p = await makeUser(db, uname('privacct'), { isPrivate: true });
    const ps = await shelf(p, 'PRIVATE ACCOUNT LIST', 'public');
    for (const [owner, s] of [[u, priv], [u, fol], [u, del], [p, ps]] as const) {
      expectNotFound(await page(`/u/${owner.username}/shelves/${s.slug}`, owner.auth));
      expectNotFound(await page(`/shelf/${s.id}`, owner.auth));
    }
    expectNotFound(await page(`/shelf/${randomUUID()}`));
    expectNotFound(await page('/shelf/not-a-uuid'));
    expectNotFound(await page(`/u/${u.username}/shelves/${'x'.repeat(90)}`));
  });

  it('a renamed shelf still 301s to its current address, after the visibility check', async () => {
    const u = await makeUser(db, uname('renamer'));
    const s = await shelf(u, 'Old Name', 'public');
    const r = await app.inject({ method: 'PATCH', url: `/v1/shelves/${s.id}`, headers: u.auth, payload: { name: 'New Name' } });
    const moved = await page(`/u/${u.username}/shelves/old-name`);
    expect(moved.status).toBe(301);
    expect(moved.location).toBe(`/u/${u.username}/shelves/${r.json().shelf.slug}`);
    await app.inject({ method: 'PATCH', url: `/v1/shelves/${s.id}`, headers: u.auth, payload: { privacy: 'private' } });
    expectNotFound(await page(`/u/${u.username}/shelves/old-name`));
  });
});
