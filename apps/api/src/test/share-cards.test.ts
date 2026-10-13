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
import { CardService, STAT_KINDS, statModel } from '../cards/index.js';
import type { ReadingStats } from '../reading/index.js';
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
    for (const stat of STAT_KINDS) {
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

describe('owner decision on Phase 5 B: cover copies unused for 180 days are deleted', () => {
  it('drawing a cover records it; the sweep deletes copies unused 180 days, keeps the rest, and a later card copies it again', async () => {
    const { retentionSweep } = await import('../jobs/retention.js');
    const old = await work('Old cover', { coverId: 7001 });
    const recent = await work('Recent cover', { coverId: 7002 });
    const oldRead = await finished(owner, old);
    const recentRead = await finished(owner, recent);
    expect((await get(`/v1/cards/finish/${oldRead}`, owner.auth)).statusCode).toBe(200);
    expect((await get(`/v1/cards/finish/${recentRead}`, owner.auth)).statusCode).toBe(200);
    expect(await storage.head(coverKey(7001))).not.toBeNull();
    const used = await db.execute<{ cover_id: number }>(sql`SELECT cover_id FROM card_covers WHERE cover_id IN (7001, 7002) ORDER BY 1`);
    expect(used.map((r) => Number(r.cover_id))).toEqual([7001, 7002]);

    await db.execute(sql`UPDATE card_covers SET last_used_at = now() - interval '181 days' WHERE cover_id = 7001`);
    await db.execute(sql`UPDATE card_covers SET last_used_at = now() - interval '179 days' WHERE cover_id = 7002`);
    const result = await retentionSweep(db, storage);
    expect(result.cardCovers).toBe(1);
    expect(await storage.head(coverKey(7001))).toBeNull();
    expect(await storage.head(coverKey(7002))).not.toBeNull();
    const left = await db.execute<{ cover_id: number }>(sql`SELECT cover_id FROM card_covers WHERE cover_id IN (7001, 7002)`);
    expect(left.map((r) => Number(r.cover_id))).toEqual([7002]);

    // Drawing the kept one again moves its date; the deleted one is copied afresh.
    const fresh = new CardService(db, { storage, fetchBytes, renderer });
    fetched.length = 0;
    await fresh.finish(owner.id, recentRead);
    await fresh.finish(owner.id, oldRead);
    expect(fetched).toEqual([openLibraryCoverUrl(7001)]);
    const dates = await db.execute<{ cover_id: number; recent: boolean }>(sql`
      SELECT cover_id, last_used_at > now() - interval '1 hour' AS recent FROM card_covers WHERE cover_id IN (7001, 7002) ORDER BY 1`);
    expect(dates.map((r) => [Number(r.cover_id), r.recent])).toEqual([[7001, true], [7002, true]]);
  });

  it('without storage the sweep deletes nothing', async () => {
    const { retentionSweep } = await import('../jobs/retention.js');
    await db.execute(sql`INSERT INTO card_covers (cover_id, last_used_at) VALUES (7999, now() - interval '400 days') ON CONFLICT DO NOTHING`);
    expect((await retentionSweep(db, null)).cardCovers).toBe(0);
    expect((await db.execute(sql`SELECT 1 FROM card_covers WHERE cover_id = 7999`)).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ST-04: a card for every figure on the stats screen, each from the figure
// and its ST-03 coverage, never a made-up value.
// ---------------------------------------------------------------------------

const cov = (based_on: number, of: number) => ({ based_on, of });
const book = (title: string, extra: Record<string, unknown> = {}) => ({ work_id: randomUUID(), title, author_name: 'An Author', page_count: 320, cover_id: null, ...extra });

function emptyStats(year = '2025'): ReadingStats {
  const zero = cov(0, 0);
  return {
    year, books_count: 0, distinct_works_count: 0, books_in_progress: 0, pages_count: 0, audio_hours: 0, avg_rating: null, vs_crowd: null,
    rating_distribution: {}, format_breakdown: { print: 0, ebook: 0, audiobook: 0, unknown: 0 },
    monthly_pace: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, books: 0, pages: 0 })),
    genres: { top: [], other: 0 }, decades: [], languages: [],
    velocity: { median_days: null, by_month: [] }, speed: { pages_per_hour: null, pages: 0, minutes: 0 }, pace: [],
    time_of_day: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
    longest_book: null, shortest_book: null, fastest_read: null, slowest_read: null, highest_rated: null, lowest_rated: null,
    oldest_publication: null, most_reread: null, most_read_author: null, dnf_count: 0, dnf_rate: 0,
    current_streak: 0, longest_streak: 0, current_streak_range: null, longest_streak_range: null,
    excluded: { undated: 0, missing_page_count: 0 },
    coverage: {
      pages: zero, months: zero, ratings: zero, vs_crowd: zero, formats: zero, authors: zero, genres: zero,
      decades: zero, languages: zero, velocity: zero, audio: zero, pace: zero, speed: zero,
    },
  };
}

function fullStats(): ReadingStats {
  const s = emptyStats();
  const tod = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  tod[2]![21] = 5; // Wednesday 9 pm
  tod[5]![21] = 2;
  tod[6]![8] = 6; // Sunday 8 am: the busiest single slot, but 9 pm is the busiest hour overall (7)
  return {
    ...s, books_count: 6, audio_hours: 12.5, vs_crowd: -0.43, dnf_count: 2,
    monthly_pace: s.monthly_pace.map((m) => (m.month === 3 ? { ...m, books: 3 } : m.month === 7 ? { ...m, books: 2 } : m.month === 9 ? { ...m, books: 1 } : m)),
    decades: [{ decade: 1990, count: 1 }, { decade: 2010, count: 4 }],
    languages: [{ language: 'en', count: 4 }, { language: 'fr', count: 1 }],
    velocity: { median_days: 9, by_month: [] },
    speed: { pages_per_hour: 42.5, pages: 850, minutes: 1200 },
    pace: [{ week_start: '2025-03-03', pages: 120, pages_per_day: 17.1 }, { week_start: '2025-03-10', pages: 410, pages_per_day: 58.6 }],
    time_of_day: tod,
    longest_book: book('The Long One', { page_count: 1200 }), shortest_book: book('The Short One', { page_count: 96 }),
    fastest_read: { ...book('Quick'), days: 1 }, slowest_read: { ...book('Slow'), days: 64 },
    highest_rated: { ...book('Best'), rating: 5 }, lowest_rated: { ...book('Worst'), rating: 1.5 },
    oldest_publication: { ...book('Old'), year: 1818 }, most_reread: { ...book('Again'), count: 3 },
    coverage: {
      ...s.coverage, audio: cov(1, 2), vs_crowd: cov(3, 4), decades: cov(5, 6), languages: cov(5, 6), velocity: cov(4, 6),
      speed: cov(10, 30), pace: cov(28, 30), months: cov(6, 6),
    },
  };
}

describe('ST-04: a stat card for every figure on the stats screen', () => {
  const card = (kind: (typeof STAT_KINDS)[number], s = fullStats()) => statModel(kind, s, 'aisha');

  it('each new figure, worked out by hand from the stats it is given', () => {
    expect(card('audio')).toMatchObject({ value: '12.5', caption: 'hours listened', coverage: 'Based on 1 of 2 audiobooks — 1 has no length or listening progress.' });
    expect(card('crowd')).toMatchObject({ value: '−0.4', caption: 'stars below the average, per book', coverage: 'Based on 3 of 4 rated books — 1 has no other ratings yet.' });
    expect(card('decades')).toMatchObject({ value: '2010s', caption: '4 books first published then', coverage: 'Based on 5 of 6 books — 1 has no publication year.' });
    expect(card('decades').bars.map((b) => b.label)).toEqual(['2010s', '1990s']);
    expect(card('languages')).toMatchObject({ value: '2', caption: 'languages read' });
    expect(card('languages').bars.map((b) => b.label)).toEqual(['English', 'French']);
    expect(card('velocity')).toMatchObject({ value: '9', caption: 'days for a typical book', coverage: 'Based on 4 of 6 books — 2 have no start date.' });
    expect(card('speed')).toMatchObject({ value: '42.5', caption: 'pages an hour', detail: '850 pages in 1,200 timed minutes', coverage: 'Based on 10 of 30 sessions — 20 have no minutes or pages logged.' });
    expect(card('pace')).toMatchObject({ value: '410', caption: 'pages', detail: 'Week of 10 Mar 2025' });
    expect(card('months')).toMatchObject({ value: '3', caption: 'books in March', coverage: null });
    expect(card('months').bars.map((b) => b.label)).toEqual(['March', 'July', 'September']);
    expect(card('dnf')).toMatchObject({ heading: 'Stopped reading', value: '2', detail: 'Not every book is for every reader.' });
    expect(card('time')).toMatchObject({ value: '9 pm', detail: 'Most of all on Sundays at 8 am' });
  });

  it('extremes name their book, with the figure that makes it extreme', () => {
    expect(card('longest')).toMatchObject({ heading: 'Longest book', value: '1,200', caption: 'pages', poster: { title: 'The Long One', author: 'An Author', cover: null } });
    expect(card('shortest')).toMatchObject({ value: '96' });
    expect(card('fastest')).toMatchObject({ value: '1', caption: 'day' });
    expect(card('slowest')).toMatchObject({ value: '64', caption: 'days' });
    expect(card('highest')).toMatchObject({ value: '5.0', poster: { title: 'Best' } });
    expect(card('lowest')).toMatchObject({ value: '1.5', poster: { title: 'Worst' } });
    expect(card('oldest')).toMatchObject({ value: '1818', caption: 'first published' });
    expect(card('reread')).toMatchObject({ value: '3', caption: 'times read' });
  });

  it('a figure with nothing under it is nothing_to_share, never a zero (§17.4)', () => {
    for (const kind of STAT_KINDS) {
      expect(() => card(kind, emptyStats()), kind).toThrowError(expect.objectContaining({ status: 422, code: 'nothing_to_share' }));
    }
    // One language is not a language card (§17.2 "shown only when >1 language").
    expect(() => card('languages', { ...fullStats(), languages: [{ language: 'en', count: 6 }] })).toThrow();
    // Months need a year.
    expect(() => card('months', { ...fullStats(), year: 'all' })).toThrow();
    // A crowd delta of exactly 0 is a real figure, not missing.
    expect(card('crowd', { ...fullStats(), vs_crowd: 0 })).toMatchObject({ value: '0' });
  });

  it('an extreme card draws its book\'s cover from our storage; an explicit book has none', async () => {
    const reader = await makeUser(db, 'extreme_reader');
    const big = await work('A Very Long Book', { coverId: 8101, author: 'Long Author' });
    await db.execute(sql`INSERT INTO editions (work_id, page_count, format) VALUES (${big}::uuid, 900, 'paperback')`);
    await finished(reader, big, { finishedAt: '2025-02-01' });
    const m = await service.stat(reader.id, reader.id, 'longest', '2025');
    expect(m).toMatchObject({ value: '900', poster: { title: 'A Very Long Book', author: 'Long Author' } });
    expect(m.poster?.cover?.uri).toMatch(/^data:image\/png;base64,/);
    await db.update(works).set({ maturity: 'explicit' }).where(eq(works.id, big));
    expect((await service.stat(reader.id, reader.id, 'longest', '2025')).poster?.cover).toBeNull();
    const res = await get(`/v1/cards/users/${reader.id}/stat/longest?year=2025`, reader.auth);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });
});
