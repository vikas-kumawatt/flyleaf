// ST-07 / ST-08 over HTTP: who may fetch each card, what it may show, covers
// from our own storage, never-fabricate on stat cards, the content-hash cache.
// The 8-viewer × 3-account matrix for every card route is in
// authorization-matrix.test.ts; this file covers what the matrix cannot see
// (what is ON a card).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';

import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import type { Db } from '../platform/index.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import { profiles, reads, reviews, works } from '../db/schema.js';
import { CardService } from '../cards/index.js';
import { coverKey, openLibraryCoverUrl, type FetchBytes } from '../cards/images.js';
import { CardRenderer } from '../cards/render.js';
import { freshDrizzle } from './pg.js';
import { follow, makeRead, makeUser, makeWork, unlimited, type TestUser } from './interaction-fixtures.js';
import { COVER_PNG } from './card-fixtures.js';
import { decodePng } from './png.js';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let storage: MemoryObjectStorage;
let renderer: CardRenderer;
const fetched: string[] = [];
let fetchMode: 'ok' | 'missing' | 'down' = 'ok';

const fetchBytes: FetchBytes = async (url) => {
  fetched.push(url);
  if (fetchMode === 'down') return { ok: false, reason: 'timeout' };
  if (fetchMode === 'missing') return { ok: false, reason: 'http' };
  return { ok: true, data: { bytes: COVER_PNG, contentType: 'image/png' } };
};

let owner: TestUser;
let followerU: TestUser;
let stranger: TestUser;
let service: CardService;

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  storage = new MemoryObjectStorage();
  renderer = new CardRenderer();
  app = await buildApp({
    db,
    identity: new IdentityService(db, unlimited),
    reading: new ReadingService(db),
    limiter: unlimited,
    storage,
    cards: { fetchBytes, renderer, coverBudgetMs: 2_000 },
  });
  await app.ready();
  service = new CardService(db, { storage, fetchBytes, renderer });
  owner = await makeUser(db, 'card_owner');
  followerU = await makeUser(db, 'card_follower');
  stranger = await makeUser(db, 'card_stranger');
  await follow(db, followerU.id, owner.id);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await close?.();
});

beforeEach(() => {
  fetched.length = 0;
  fetchMode = 'ok';
});

async function work(title: string, opts: { coverId?: number; author?: string; maturity?: string } = {}): Promise<string> {
  const id = await makeWork(db, title);
  await db.update(works).set({ olCoverId: opts.coverId ?? null, maturity: opts.maturity ?? 'general' }).where(eq(works.id, id));
  if (opts.author) {
    await db.execute(sql`WITH a AS (INSERT INTO authors (name) VALUES (${opts.author}) RETURNING id)
      INSERT INTO work_authors (work_id, author_id, position) SELECT ${id}::uuid, a.id, 0 FROM a`);
  }
  return id;
}

async function finished(user: TestUser, workId: string, opts: { visibility?: 'public' | 'followers' | 'private'; rating?: string; finishedAt?: string; attemptNo?: number } = {}) {
  const id = await makeRead(db, user.id, workId, { visibility: opts.visibility ?? 'public', rating: opts.rating ?? null, attemptNo: opts.attemptNo });
  if (opts.finishedAt) await db.update(reads).set({ finishedAt: opts.finishedAt, startedAt: opts.finishedAt }).where(eq(reads.id, id));
  return id;
}

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

describe('ST-07: finish card', () => {
  it('a PNG, story size, cached by content hash with the hash as ETag; 304 on a match', async () => {
    const w = await work('Piranesi', { coverId: 1001, author: 'Susanna Clarke' });
    const readId = await finished(owner, w, { rating: '4.5' });
    const before = renderer.renders;
    const res = await get(`/v1/cards/finish/${readId}`, owner.auth);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    const png = decodePng(res.rawPayload);
    expect([png.width, png.height]).toEqual([1080, 1920]);
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(renderer.renders).toBe(before + 1);

    const again = await get(`/v1/cards/finish/${readId}`, stranger.auth);
    expect(again.statusCode).toBe(200);
    expect(again.headers.etag).toBe(etag);
    expect(again.headers['server-timing']).toContain('cache');
    expect(renderer.renders).toBe(before + 1);

    const notModified = await get(`/v1/cards/finish/${readId}`, { ...owner.auth, 'if-none-match': etag });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.rawPayload.length).toBe(0);

    // A changed rating is new content: a new hash, a new render.
    await db.update(reads).set({ rating: '3.0' }).where(eq(reads.id, readId));
    const changed = await get(`/v1/cards/finish/${readId}`, owner.auth);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('covers come from our storage: copied from Open Library once, by cover id, then never fetched again', async () => {
    const w = await work('Cover once', { coverId: 2002 });
    const r1 = await finished(owner, w);
    const m1 = await service.finish(owner.id, r1);
    expect(fetched).toEqual([openLibraryCoverUrl(2002)]);
    expect(openLibraryCoverUrl(2002)).toBe('https://covers.openlibrary.org/b/id/2002-L.jpg?default=false');
    expect(await storage.head(coverKey(2002))).not.toBeNull();
    expect(m1.cover?.uri).toBe(`data:image/png;base64,${COVER_PNG.toString('base64')}`);
    // Another reader, another card of the same book: our copy, no fetch.
    const r2 = await finished(followerU, w);
    const m2 = await service.finish(followerU.id, r2);
    expect(fetched).toHaveLength(1);
    expect(m2.cover?.uri).toBe(m1.cover?.uri);
  });

  it('no cover to be had (missing, Open Library down, or not an image): a typographic poster, never a broken card', async () => {
    fetchMode = 'missing';
    const r1 = await finished(owner, await work('No such cover', { coverId: 3003 }));
    expect((await service.finish(owner.id, r1)).cover).toBeNull();
    // Missing is remembered for an hour: not asked again.
    await service.finish(owner.id, r1);
    expect(fetched).toHaveLength(1);
    fetchMode = 'down';
    const r2 = await finished(owner, await work('Down', { coverId: 3004 }));
    expect((await get(`/v1/cards/finish/${r2}`, owner.auth)).statusCode).toBe(200);
    expect(await storage.head(coverKey(3004))).toBeNull();
    // A cover that is not JPEG or PNG is not drawn and not stored.
    const badFetch: FetchBytes = async () => ({ ok: true, data: { bytes: Buffer.from('<html>nope</html>'), contentType: 'text/html' } });
    const bad = new CardService(db, { storage, fetchBytes: badFetch, renderer });
    const r3 = await finished(owner, await work('HTML cover', { coverId: 3005 }));
    expect((await bad.finish(owner.id, r3)).cover).toBeNull();
    expect(await storage.head(coverKey(3005))).toBeNull();
  });

  it('an explicit book has no cover on a card (§7.8), and nothing is fetched for it', async () => {
    const r = await finished(owner, await work('Explicit', { coverId: 4004, maturity: 'explicit' }));
    expect((await service.finish(owner.id, r)).cover).toBeNull();
    expect(fetched).toEqual([]);
  });

  it('a read that is not finished is 422 card_unavailable; someone else\'s private read is the random-id 404', async () => {
    const w = await work('Reading now');
    const reading = await makeRead(db, owner.id, w, { status: 'reading', attemptNo: 1 });
    const res = await get(`/v1/cards/finish/${reading}`, owner.auth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('card_unavailable');

    const priv = await finished(owner, await work('Private'), { visibility: 'private' });
    const random = await get(`/v1/cards/finish/${randomUUID()}`, followerU.auth);
    for (const h of [followerU.auth, stranger.auth, {}]) {
      const r = await get(`/v1/cards/finish/${priv}`, h);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(random.json());
    }
    // Its owner may make one.
    expect((await get(`/v1/cards/finish/${priv}`, owner.auth)).statusCode).toBe(200);
  });

  it('every text field arrives clean and bounded: a 2,000-character title, an override in the author, an empty title', async () => {
    const w = await work('x'.repeat(2000), { author: `Evil${String.fromCodePoint(0x202e)}rohtua` });
    const m = await service.finish(owner.id, await finished(owner, w));
    expect([...new Intl.Segmenter().segment(m.title)]).toHaveLength(90);
    expect(m.author).toBe('Evilrohtua');
    const empty = await work('   ');
    const m2 = await service.finish(owner.id, await finished(owner, empty));
    expect(m2.title).toBe('Untitled');
    expect(m2.author).toBeNull();
  });
});

describe('ST-08: review quote card — its author only (§41.4)', () => {
  async function review(user: TestUser, body: string, opts: { spoilers?: boolean; visibility?: 'public' | 'followers' | 'private' } = {}) {
    const readId = await finished(user, await work(`Reviewed ${randomUUID().slice(0, 6)}`, { author: 'A. Writer' }), { rating: '4.0' });
    const [rv] = await db.insert(reviews).values({
      readId, userId: user.id, workId: (await db.select({ w: reads.workId }).from(reads).where(eq(reads.id, readId)))[0]!.w,
      body, hasSpoilers: opts.spoilers ?? false, visibility: opts.visibility ?? 'public', publishedAt: new Date(),
    } as any).returning({ id: reviews.id });
    return rv!.id;
  }

  it('the author gets a card; a reader who can see the review gets the random-id 404, like a guest', async () => {
    const id = await review(owner, 'A quiet, strange, lovely book.');
    expect((await get(`/v1/cards/review/${id}`, owner.auth)).statusCode).toBe(200);
    // Visible to them as a review...
    expect((await get(`/v1/reviews/${id}`, stranger.auth)).statusCode).toBe(200);
    // ...but not theirs to card.
    const random = await get(`/v1/cards/review/${randomUUID()}`, stranger.auth);
    for (const h of [stranger.auth, followerU.auth, {}]) {
      const r = await get(`/v1/cards/review/${id}`, h);
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(random.json());
    }
    const m = await service.review(owner.id, id);
    expect(m.quote).toBe('A quiet, strange, lovely book.');
    expect(m.rating).toBe(4);
    expect(m.handle).toBe('card_owner');
  });

  it('a review with spoilers, or hidden by a moderator, puts no text on the card', async () => {
    const spoiler = await review(owner, 'Bruce Willis was dead all along.', { spoilers: true });
    expect((await service.review(owner.id, spoiler)).quote).toBeNull();
    const hidden = await review(owner, 'Hidden by a moderator.');
    await db.update(reviews).set({ hiddenAt: new Date() } as any).where(eq(reviews.id, hidden));
    // Its author can still fetch the review, but the card carries no text.
    const m = await service.review(owner.id, hidden);
    expect(m.quote).toBeNull();
    expect(m.title).toMatch(/^Reviewed /);
  });

  it('a 5,000-character review is cut to the quote budget at a grapheme, with an ellipsis', async () => {
    const id = await review(owner, `${'word '.repeat(1000)}`);
    const m = await service.review(owner.id, id);
    expect([...new Intl.Segmenter().segment(m.quote!)].length).toBeLessThanOrEqual(420);
    expect(m.quote!.endsWith('…')).toBe(true);
  });
});

describe('ST-08: stat cards count public reads only and never fabricate (ST-03)', () => {
  let reader: TestUser;
  beforeAll(async () => {
    reader = await makeUser(db, 'stat_reader');
    await follow(db, followerU.id, reader.id);
    // Public: 2 books, one rated 4, one with 300 pages. Followers-only and private: rated 1, so any leak moves the average.
    const a = await work('Public one', { author: 'Ursula K. Le Guin' });
    const b = await work('Public two', { author: 'Ursula K. Le Guin' });
    await db.execute(sql`INSERT INTO editions (work_id, page_count, format) VALUES (${b}::uuid, 300, 'paperback')`);
    await finished(reader, a, { rating: '4.0', finishedAt: '2025-03-01' });
    await finished(reader, b, { finishedAt: '2025-04-01' });
    await finished(reader, await work('Followers one', { author: 'Secret Author' }), { visibility: 'followers', rating: '1.0', finishedAt: '2025-05-01' });
    await finished(reader, await work('Private one', { author: 'Secret Author' }), { visibility: 'private', rating: '1.0', finishedAt: '2025-06-01' });
    await finished(reader, await work('Private two', { author: 'Secret Author' }), { visibility: 'private', rating: '1.0', finishedAt: '2025-06-02' });
  });

  it('the owner, a follower and a guest all get the same public figures', async () => {
    for (const viewer of [reader.id, followerU.id, null]) {
      const books = await service.stat(viewer, reader.id, 'books', '2025');
      expect(books.value).toBe('2');
      const rating = await service.stat(viewer, reader.id, 'rating', '2025');
      expect(rating.value).toBe('4.0');
      expect(rating.coverage).toBe('Based on 1 of 2 books — 1 is unrated.');
      const author = await service.stat(viewer, reader.id, 'author', '2025');
      expect(author.caption).toBe('Ursula K. Le Guin');
    }
    // The screen itself (not a card) still shows the owner everything.
    const own = await app.inject({ method: 'GET', url: '/v1/me/stats?year=2025', headers: reader.auth });
    expect(own.json().books_count).toBe(5);
  });

  it('pages are based only on books with a page count, and say so', async () => {
    const pages = await service.stat(reader.id, reader.id, 'pages', '2025');
    expect(pages.value).toBe('300');
    expect(pages.coverage).toBe('Based on 1 of 2 books — 1 has no page count.');
  });

  it('nothing to stand on is 422 nothing_to_share, never a zero', async () => {
    const empty = await makeUser(db, 'stat_empty');
    for (const stat of ['books', 'pages', 'rating', 'author', 'genres', 'formats', 'streak']) {
      const r = await get(`/v1/cards/users/${empty.id}/stat/${stat}?year=all`, empty.auth);
      expect(r.statusCode, stat).toBe(422);
      expect(r.json().error.code).toBe('nothing_to_share');
    }
    // Only private reads: still nothing to share publicly.
    const shy = await makeUser(db, 'stat_shy');
    await finished(shy, await work('Shy book'), { visibility: 'private', rating: '5.0', finishedAt: '2025-01-01' });
    expect((await get(`/v1/cards/users/${shy.id}/stat/books?year=all`, shy.auth)).statusCode).toBe(422);
    expect((await get(`/v1/cards/users/${shy.id}/stat/rating?year=all`, shy.auth)).statusCode).toBe(422);
  });

  it('an unknown stat, a bad year or zone is 422, never a 500', async () => {
    expect((await get(`/v1/cards/users/${reader.id}/stat/vibes`, reader.auth)).statusCode).toBe(422);
    expect((await get(`/v1/cards/users/${reader.id}/stat/books?year=20x5`, reader.auth)).statusCode).toBe(422);
    expect((await get(`/v1/cards/users/${reader.id}/stat/books?tz=Mars/Base`, reader.auth)).statusCode).toBe(422);
    expect((await get(`/v1/cards/users/not-a-uuid/stat/books`, reader.auth)).statusCode).toBe(422);
  });

  it('renders every stat card that has data', async () => {
    for (const stat of ['books', 'pages', 'rating', 'author']) {
      const r = await get(`/v1/cards/users/${reader.id}/stat/${stat}?year=2025`);
      expect(r.statusCode, stat).toBe(200);
      expect(r.headers['content-type']).toBe('image/png');
    }
  }, 60_000);
});

describe('ST-08: profile and Wall cards carry public reads only', () => {
  let reader: TestUser;
  beforeAll(async () => {
    reader = await makeUser(db, 'wall_reader');
    await follow(db, followerU.id, reader.id);
    for (let i = 0; i < 18; i++) await finished(reader, await work(`Public ${i}`, { coverId: 5000 + i }), { finishedAt: `2025-01-${String(i + 1).padStart(2, '0')}` });
    await finished(reader, await work('FOLLOWERS-ONLY BOOK'), { visibility: 'followers', finishedAt: '2025-12-30' });
    await finished(reader, await work('PRIVATE BOOK'), { visibility: 'private', finishedAt: '2025-12-31' });
    await finished(reader, await work('EXPLICIT BOOK', { maturity: 'explicit' }), { finishedAt: '2025-12-29' });
    // A re-read counts the book once on the Wall.
    const again = await work('Read twice');
    await finished(reader, again, { finishedAt: '2024-01-01', attemptNo: 1 });
    await finished(reader, again, { finishedAt: '2025-02-01', attemptNo: 2 });
    const fav1 = await work('Favourite public');
    const fav2 = await work('Favourite explicit', { maturity: 'explicit' });
    await db.update(profiles).set({ favouriteWorkIds: [fav1, fav2], bio: 'Reads everything.' }).where(eq(profiles.userId, reader.id));
  });

  it('the Wall: newest first, each book once, 16 or 15 posters, no followers-only, private or explicit book, whoever asks', async () => {
    for (const viewer of [reader.id, followerU.id, null]) {
      const wall = await service.wall(viewer, reader.id, '4x4');
      const titles = wall.posters.map((p) => p.title);
      expect(titles).toHaveLength(16);
      expect(wall.count).toBe(19);
      // Newest finish first: the re-read (Feb 2025), then January's books.
      expect(titles.slice(0, 3)).toEqual(['Read twice', 'Public 17', 'Public 16']);
      expect(titles).not.toContain('FOLLOWERS-ONLY BOOK');
      expect(titles).not.toContain('PRIVATE BOOK');
      expect(titles).not.toContain('EXPLICIT BOOK');
      expect(titles.filter((t) => t === 'Read twice')).toHaveLength(1);
      expect((await service.wall(viewer, reader.id, '3x5')).posters).toHaveLength(15);
    }
    const in2024 = await service.wall(reader.id, reader.id, '4x4', '2024');
    expect(in2024.posters.map((p) => p.title)).toEqual(['Read twice']); // its first attempt finished in 2024
  }, 60_000);

  it('covers on the Wall are copied within the budget; any not yet copied are posters', async () => {
    const res = await get(`/v1/cards/users/${reader.id}/wall?layout=3x5`, followerU.auth);
    expect(res.statusCode).toBe(200);
    // The 14 newest books with covers (the re-read has none) are in our storage now.
    for (let i = 4; i < 18; i++) expect(await storage.head(coverKey(5000 + i)), `cover ${5000 + i}`).not.toBeNull();
    for (const url of fetched) expect(url).toMatch(/^https:\/\/covers\.openlibrary\.org\/b\/id\/\d+-L\.jpg\?default=false$/);
    expect((await get(`/v1/cards/users/${reader.id}/wall?layout=5x5`, followerU.auth)).statusCode).toBe(422);
  }, 60_000);

  it('the profile card: public counts, explicit favourites left off', async () => {
    const tz = 'UTC';
    const p = await service.profile(reader.id, reader.id, tz);
    expect(p.booksAllTime).toBe(21); // 18 + explicit + 2 attempts of "Read twice"; not followers-only or private
    expect(p.favourites.map((f) => f.title)).toEqual(['Favourite public']);
    expect(p.bio).toBe('Reads everything.');
    expect(p.initials).toBe('W'); // display name is the username here
    expect((await get(`/v1/cards/users/${reader.id}/profile`, stranger.auth)).statusCode).toBe(200);
  }, 60_000);

  it('a reader with no public finished book has no Wall card to share: 422', async () => {
    const shy = await makeUser(db, 'wall_shy');
    await finished(shy, await work('Only private'), { visibility: 'private' });
    const r = await get(`/v1/cards/users/${shy.id}/wall`, shy.auth);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('nothing_to_share');
  });
});
