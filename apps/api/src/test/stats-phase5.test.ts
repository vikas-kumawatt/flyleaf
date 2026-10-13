// Phase 5 part A: stats (ST-01, ST-02, ST-03, ST-05, ST-06).
//
//   ST-02  every figure checked against numbers computed by hand, in the
//          comments beside each assertion (Phase 5 exit criterion).
//   ST-03  never fabricate: one test per figure that can lack data, each
//          with a book (or session) missing exactly that datum.
//   ST-06  streaks with PRD §8.7's two-day grace, framed as "longest".
//   ST-05  goals: per viewer (§17.5), the profile ring's data only (§8.6).
//
// ST-01 (every new field per viewer) is the twin oracle in stats-audit.test.ts,
// whose library now carries a value for each new figure; the private re-read
// and the goal routes are checked here.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { authors, editions, follows, goals, progressEvents, reads, subjects, workAuthors, workSubjects, works } from '../db/schema.js';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { ReadingService, computeStreaks, STREAK_GRACE_DAYS, weeklyPace, median } from '../reading/index.js';
import { freshDrizzle } from './pg.js';
import { block, follow, makeUser, type TestUser } from './interaction-fixtures.js';

async function statsHarness() {
  const { db, client } = await freshDrizzle();
  const app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();
  return { db, client, app };
}

let db: Db;
let client: { close: () => Promise<void> };
let app: FastifyInstance;

beforeAll(async () => {
  ({ db, client, app } = await statsHarness());
}, 60_000);
afterAll(async () => {
  await app.close();
  await client.close();
});

interface BookSpec {
  title: string;
  pages?: number | null;
  format?: 'hardcover' | 'paperback' | 'ebook' | 'audiobook' | 'unknown';
  audio?: number | null;
  author?: string | null;
  /** [name, weight] */
  genres?: Array<[string, number]>;
  year?: number | null;
  /** The edition's language; 'und' when not given. */
  language?: string;
}

const authorIds = new Map<string, string>();
async function book(spec: BookSpec): Promise<{ workId: string; editionId: string }> {
  const [w] = await db.insert(works).values({ title: spec.title, firstPublishYear: spec.year ?? null }).returning({ id: works.id });
  if (spec.author) {
    let a = authorIds.get(spec.author);
    if (!a) {
      const [row] = await db.insert(authors).values({ name: spec.author }).returning({ id: authors.id });
      a = row!.id;
      authorIds.set(spec.author, a);
    }
    await db.insert(workAuthors).values({ workId: w!.id, authorId: a, position: 0 });
  }
  for (const [name, weight] of spec.genres ?? []) {
    const slug = `g-${name.toLowerCase()}`;
    await db.insert(subjects).values({ slug, name, kind: 'genre' }).onConflictDoNothing();
    const [g] = await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.slug, slug));
    await db.insert(workSubjects).values({ workId: w!.id, subjectId: g!.id, weight });
  }
  const [e] = await db
    .insert(editions)
    .values({
      workId: w!.id,
      pageCount: spec.pages ?? null,
      format: spec.format ?? 'unknown',
      audioSeconds: spec.audio ?? null,
      language: spec.language ?? 'und',
    })
    .returning({ id: editions.id });
  return { workId: w!.id, editionId: e!.id };
}

interface ReadSpec {
  status?: 'finished' | 'dnf' | 'reading';
  started?: string | null;
  finished?: string | null;
  abandoned?: string | null;
  rating?: string | null;
  attempt?: number;
  visibility?: 'public' | 'followers' | 'private';
  source?: 'app' | 'import';
}
async function read(userId: string, b: { workId: string; editionId: string }, spec: ReadSpec = {}): Promise<string> {
  const [r] = await db
    .insert(reads)
    .values({
      userId,
      workId: b.workId,
      editionId: b.editionId,
      status: spec.status ?? 'finished',
      startedAt: spec.started ?? null,
      finishedAt: spec.status === undefined || spec.status === 'finished' ? (spec.finished === undefined ? '2025-05-05' : spec.finished) : null,
      abandonedAt: spec.abandoned ?? null,
      rating: spec.rating ?? null,
      attemptNo: spec.attempt ?? 1,
      visibility: spec.visibility ?? 'public',
      source: spec.source ?? 'app',
    })
    .returning({ id: reads.id });
  return r!.id;
}

async function event(readId: string, at: string, e: { page?: number; percent?: string; minutes?: number; audio?: number }) {
  await db.insert(progressEvents).values({
    readId,
    at: new Date(at),
    page: e.page ?? null,
    percent: e.percent ?? null,
    minutes: e.minutes ?? null,
    audioSeconds: e.audio ?? null,
    clientEventId: randomUUID(),
  });
}

const statsOf = async (u: TestUser, query = 'year=2025&tz=UTC') => {
  const res = await app.inject({ method: 'GET', url: `/v1/me/stats?${query}`, headers: u.auth });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json();
};

// ---------------------------------------------------------------------------
// ST-02: one library, every figure computed by hand.
// ---------------------------------------------------------------------------

describe('ST-02: every stat against hand-computed figures', () => {
  let s: any;

  beforeAll(async () => {
    const me = await makeUser(db, 'hand_me');
    const x = await makeUser(db, 'hand_x');
    const y = await makeUser(db, 'hand_y');

    // A  Alpha    Ann Author  Mystery(1) Thriller(0.5)  1925  en  hardcover 200
    // B  Beta     Ann Author  Mystery                    1999  en  paperback 300
    // C  Gamma    Bob Writer  Fantasy                    2010  fr  ebook     500
    // D  Delta    Bob Writer  —                          —     —   audiobook —   10 h
    // E  Epsilon  —           Fantasy                    1890  en  unknown   150
    const A = await book({ title: 'Alpha', author: 'Ann Author', genres: [['Mystery', 1], ['Thriller', 0.5]], year: 1925, language: 'en', format: 'hardcover', pages: 200 });
    const B = await book({ title: 'Beta', author: 'Ann Author', genres: [['Mystery', 1]], year: 1999, language: 'en', format: 'paperback', pages: 300 });
    const C = await book({ title: 'Gamma', author: 'Bob Writer', genres: [['Fantasy', 1]], year: 2010, language: 'fr', format: 'ebook', pages: 500 });
    const D = await book({ title: 'Delta', author: 'Bob Writer', format: 'audiobook', pages: null, audio: 36_000 });
    const E = await book({ title: 'Epsilon', author: null, genres: [['Fantasy', 1]], year: 1890, language: 'en', format: 'unknown', pages: 150 });
    const G = await book({ title: 'Zeta', pages: 100 });
    const H = await book({ title: 'Eta', pages: 400 });
    const I = await book({ title: 'Theta', pages: 100 });

    //            started     finished    rating  days (both included)
    await read(me.id, A, { started: '2025-01-01', finished: '2025-01-10', rating: '4.0' }); // 10
    const rB = await read(me.id, B, { started: '2025-02-01', finished: '2025-02-03', rating: '2.5' }); // 3
    const rC = await read(me.id, C, { started: '2025-02-10', finished: '2025-03-01', rating: '5.0' }); // 20 (Feb 2025 has 28 days)
    await read(me.id, D, { started: null, finished: '2025-03-15' }); //  —  (no start date)
    await read(me.id, E, { started: '2025-06-01', finished: '2025-06-01', rating: '3.0' }); // 1
    await read(me.id, A, { started: '2025-11-05', finished: '2025-11-20', rating: '4.5', attempt: 2 }); // 16 (re-read of A)
    await read(me.id, G, { status: 'dnf', abandoned: '2025-07-01' });
    await read(me.id, H, { finished: null, source: 'import' }); // undated: not in 2025
    await read(me.id, I, { status: 'reading', started: '2025-12-01' });

    // Other readers, for "you vs the crowd". A: 3.0 and 5.0 → others' mean 4.0.
    // B: 3.5. E: 2.0. C: nobody else.
    await read(x.id, A, { rating: '3.0' });
    await read(y.id, A, { rating: '5.0' });
    await read(x.id, B, { rating: '3.5' });
    await read(y.id, E, { rating: '2.0' });

    // Sessions (UTC). Weekdays: 1 Feb 2025 is a Saturday.
    await event(rB, '2025-02-01T08:00:00Z', { page: 50 }); //                 Sat 08  first page event: no rise known
    await event(rB, '2025-02-02T21:00:00Z', { page: 200, minutes: 90 }); //   Sun 21  +150 in 90 min
    await event(rB, '2025-02-03T21:30:00Z', { page: 300, minutes: 60 }); //   Mon 21  +100 in 60 min
    await event(rC, '2025-02-10T07:00:00Z', { percent: '10.00' }); //         Mon 07  percent only: no page
    await event(rC, '2025-02-12T07:00:00Z', { page: 100, minutes: 30 }); //   Wed 07  first page event of C: no rise known
    await event(rC, '2025-02-14T22:00:00Z', { page: 80, minutes: 20 }); //    Fri 22  went back 20: a rise of 0

    s = await statsOf(me);
  });

  it('volume', () => {
    // Finished in 2025: A, B, C, D, E, A again = 6 attempts, 5 works. H is undated.
    expect(s.books_count).toBe(6);
    expect(s.distinct_works_count).toBe(5);
    expect(s.books_in_progress).toBe(1); // I
    // 200 + 300 + 500 + 150 + 200 (A's re-read); D has no page count.
    expect(s.pages_count).toBe(1350);
    // D: a finished audiobook of 36,000 s = 10 h.
    expect(s.audio_hours).toBe(10);
    // G: 1 DNF of 7 → 0.142857 → 0.14.
    expect(s.dnf_count).toBe(1);
    expect(s.dnf_rate).toBe(0.14);
    expect(s.excluded).toEqual({ undated: 1, missing_page_count: 1 });
  });

  it('temporal: months, velocity, pace, speed, time of day, streak', () => {
    const months = Object.fromEntries(s.monthly_pace.filter((m: any) => m.books > 0).map((m: any) => [m.month, [m.books, m.pages]]));
    // Jan A 200 · Feb B 300 · Mar C 500 + D 0 · Jun E 150 · Nov A 200.
    expect(months).toEqual({ 1: [1, 200], 2: [1, 300], 3: [2, 500], 6: [1, 150], 11: [1, 200] });

    // Days: 1, 3, 10, 16, 20 → median 10.
    expect(s.velocity.median_days).toBe(10);
    const vel = Object.fromEntries(s.velocity.by_month.filter((m: any) => m.median_days !== null).map((m: any) => [m.month, m.median_days]));
    expect(vel).toEqual({ 1: 10, 2: 3, 3: 20, 6: 1, 11: 16 });

    // Rises: Sun 2 Feb +150 (week of Mon 27 Jan), Mon 3 Feb +100 (week of
    // 3 Feb), Fri 14 Feb +0 (week of 10 Feb). Per day: 150/7 = 21.4, 100/7 = 14.3.
    expect(s.pace).toEqual([
      { week_start: '2025-01-27', pages: 150, pages_per_day: 21.4 },
      { week_start: '2025-02-03', pages: 100, pages_per_day: 14.3 },
      { week_start: '2025-02-10', pages: 0, pages_per_day: 0 },
    ]);

    // Timed sessions with a rise: +150 in 90 and +100 in 60 → 250 pages in
    // 150 minutes = 100 pages an hour. C's 30 min (no known rise) and 20 min
    // (no rise) are not in it.
    expect(s.speed).toEqual({ pages_per_hour: 100, pages: 250, minutes: 150 });

    // Monday = 0. Sat 08, Sun 21, Mon 21, Mon 07, Wed 07, Fri 22.
    const cells: string[] = [];
    s.time_of_day.forEach((hours: number[], day: number) => hours.forEach((n, h) => { if (n) cells.push(`${day}:${h}=${n}`); }));
    expect(cells.sort()).toEqual(['0:21=1', '0:7=1', '2:7=1', '4:22=1', '5:8=1', '6:21=1']);
    expect(s.time_of_day).toHaveLength(7);
    expect(s.time_of_day.every((h: number[]) => h.length === 24)).toBe(true);

    // Active days: finishes 10 Jan, 3 Feb, 1 Mar, 15 Mar, 1 Jun, 20 Nov; sessions
    // 1, 2, 3, 10, 12, 14 Feb. With two days' grace: 1–3 Feb (3 days), 10–14 Feb
    // (12 and 14 are 1 missed day apart: 5 days). Without grace it would be 3.
    expect(s.longest_streak).toBe(5);
    expect(s.longest_streak_range).toEqual({ start: '2025-02-10', end: '2025-02-14' });
    expect(s.current_streak).toBe(0);
    expect(s.current_streak_range).toBeNull();
  });

  it('taste', () => {
    // (4.0 + 2.5 + 5.0 + 3.0 + 4.5) / 5 = 3.8
    expect(s.avg_rating).toBe(3.8);
    expect(s.rating_distribution).toEqual({
      '0.5': 0, '1.0': 0, '1.5': 0, '2.0': 0, '2.5': 1, '3.0': 1, '3.5': 0, '4.0': 1, '4.5': 1, '5.0': 1,
    });
    // Others' means without me: A 4.0 (both attempts), B 3.5, E 2.0, C none.
    // (4.0−4.0) + (2.5−3.5) + (3.0−2.0) + (4.5−4.0) = 0.5 over 4 → 0.125 → 0.13.
    expect(s.vs_crowd).toBe(0.13);
    // A, B, A hardcover/paperback = print 3; C ebook; D audiobook; E unknown.
    expect(s.format_breakdown).toEqual({ print: 3, ebook: 1, audiobook: 1, unknown: 1 });
    // Ann: A, B, A = 3; Bob: C, D = 2; E has no author.
    expect(s.most_read_author).toEqual({ name: 'Ann Author', count: 3 });
    // Primary genre (highest weight): A Mystery (not Thriller), B Mystery, A
    // Mystery, C Fantasy, E Fantasy; D none.
    expect(s.genres).toEqual({ top: [{ name: 'Mystery', count: 3 }, { name: 'Fantasy', count: 2 }], other: 0 });
    // 1925 ×2, 1999, 2010, 1890; D none.
    expect(s.decades).toEqual([
      { decade: 1890, count: 1 }, { decade: 1920, count: 2 }, { decade: 1990, count: 1 }, { decade: 2010, count: 1 },
    ]);
    // en: A, B, E, A; fr: C; D none.
    expect(s.languages).toEqual([{ language: 'en', count: 4 }, { language: 'fr', count: 1 }]);
  });

  it('extremes', () => {
    expect(s.longest_book).toMatchObject({ title: 'Gamma', page_count: 500 });
    expect(s.shortest_book).toMatchObject({ title: 'Epsilon', page_count: 150, author_name: null });
    expect(s.fastest_read).toMatchObject({ title: 'Epsilon', days: 1 });
    expect(s.slowest_read).toMatchObject({ title: 'Gamma', days: 20 });
    expect(s.highest_rated).toMatchObject({ title: 'Gamma', rating: 5 });
    expect(s.lowest_rated).toMatchObject({ title: 'Beta', rating: 2.5 });
    expect(s.oldest_publication).toMatchObject({ title: 'Epsilon', year: 1890 });
    expect(s.most_reread).toMatchObject({ title: 'Alpha', count: 2 });
  });

  it('coverage: what each figure is based on', () => {
    expect(s.coverage).toEqual({
      pages: { based_on: 5, of: 6 }, //      D has no page count
      months: { based_on: 6, of: 6 }, //     every 2025 finish is dated
      ratings: { based_on: 5, of: 6 }, //    D unrated
      vs_crowd: { based_on: 4, of: 5 }, //   C: nobody else rated it
      formats: { based_on: 5, of: 6 }, //    E unknown
      authors: { based_on: 5, of: 6 }, //    E
      genres: { based_on: 5, of: 6 }, //     D
      decades: { based_on: 5, of: 6 }, //    D
      languages: { based_on: 5, of: 6 }, //  D
      velocity: { based_on: 5, of: 6 }, //   D has no start date
      audio: { based_on: 1, of: 1 }, //      D has a duration
      pace: { based_on: 3, of: 6 }, //       sessions with a known page rise
      speed: { based_on: 2, of: 6 }, //      ... that also carry minutes and a rise
    });
  });
});

// ---------------------------------------------------------------------------
// ST-03: never fabricate. For each figure, two finished books, one missing
// exactly the datum that figure needs: the figure comes from the other book
// alone, and coverage says "based on 1 of 2".
// ---------------------------------------------------------------------------

describe('ST-03: each figure says what it is missing', () => {
  let n = 0;
  const fresh = () => makeUser(db, `honest_${++n}`);

  it('pages: a book with no page count adds none and is not an extreme', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'P1', pages: 320 }));
    await read(u.id, await book({ title: 'P2', pages: null }));
    const s = await statsOf(u);
    expect(s.pages_count).toBe(320);
    expect(s.longest_book.page_count).toBe(320);
    expect(s.shortest_book.page_count).toBe(320);
    expect(s.coverage.pages).toEqual({ based_on: 1, of: 2 });
  });

  it('months: an undated finish is counted all-time but in no month', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'M1', pages: 100 }), { finished: '2025-04-04' });
    await read(u.id, await book({ title: 'M2', pages: 100 }), { finished: null, source: 'import' });
    const s = await statsOf(u, 'year=all&tz=UTC');
    expect(s.books_count).toBe(2);
    expect(s.monthly_pace.reduce((t: number, m: any) => t + m.books, 0)).toBe(1);
    expect(s.coverage.months).toEqual({ based_on: 1, of: 2 });
  });

  it('ratings: an unrated book is not a zero', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'R1' }), { rating: '4.0' });
    await read(u.id, await book({ title: 'R2' }), { rating: null });
    const s = await statsOf(u);
    expect(s.avg_rating).toBe(4);
    expect(s.highest_rated.rating).toBe(4);
    expect(s.lowest_rated.rating).toBe(4);
    expect(s.coverage.ratings).toEqual({ based_on: 1, of: 2 });
  });

  it('vs the crowd: a book nobody else rated is not compared with anything', async () => {
    const u = await fresh();
    const other = await fresh();
    const shared = await book({ title: 'V1' });
    await read(u.id, shared, { rating: '4.0' });
    await read(other.id, shared, { rating: '2.0' });
    await read(u.id, await book({ title: 'V2' }), { rating: '1.0' });
    const s = await statsOf(u);
    expect(s.vs_crowd).toBe(2); // 4.0 − 2.0, V2 left out
    expect(s.coverage.vs_crowd).toEqual({ based_on: 1, of: 2 });
    // Nobody to compare with at all: null, never 0.
    const alone = await fresh();
    await read(alone.id, await book({ title: 'V3' }), { rating: '3.0' });
    expect((await statsOf(alone)).vs_crowd).toBeNull();
  });

  it('formats: an unknown format is "unknown", never print', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'F1', format: 'ebook' }));
    await read(u.id, await book({ title: 'F2', format: 'unknown' }));
    const s = await statsOf(u);
    expect(s.format_breakdown).toEqual({ print: 0, ebook: 1, audiobook: 0, unknown: 1 });
    expect(s.coverage.formats).toEqual({ based_on: 1, of: 2 });
  });

  it('authors: a book with no author is nobody\'s, not "Unknown Author"\'s', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'A1', author: 'Real Author' }));
    await read(u.id, await book({ title: 'A2', author: null }));
    await read(u.id, await book({ title: 'A3', author: null }));
    const s = await statsOf(u);
    expect(s.most_read_author).toEqual({ name: 'Real Author', count: 1 });
    expect(s.coverage.authors).toEqual({ based_on: 1, of: 3 });
  });

  it('genres: a book with no genre is left out of the donut', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'G1', genres: [['Sci-Fi', 1]] }));
    await read(u.id, await book({ title: 'G2' }));
    const s = await statsOf(u);
    expect(s.genres).toEqual({ top: [{ name: 'Sci-Fi', count: 1 }], other: 0 });
    expect(s.coverage.genres).toEqual({ based_on: 1, of: 2 });
  });

  it('decades: a book with no publication year has no decade and is not the oldest', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'D1', year: 1967 }));
    await read(u.id, await book({ title: 'D2', year: null }));
    const s = await statsOf(u);
    expect(s.decades).toEqual([{ decade: 1960, count: 1 }]);
    expect(s.oldest_publication).toMatchObject({ title: 'D1', year: 1967 });
    expect(s.coverage.decades).toEqual({ based_on: 1, of: 2 });
  });

  it('languages: an unknown language ("und") is left out, never English', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'L1', language: 'es' }));
    await read(u.id, await book({ title: 'L2', language: 'und' }));
    const s = await statsOf(u);
    expect(s.languages).toEqual([{ language: 'es', count: 1 }]);
    expect(s.coverage.languages).toEqual({ based_on: 1, of: 2 });
  });

  it('velocity: a finish with no start date has no days to finish', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'S1' }), { started: '2025-05-01', finished: '2025-05-07' });
    await read(u.id, await book({ title: 'S2' }), { started: null, finished: '2025-05-07' });
    const s = await statsOf(u);
    expect(s.velocity.median_days).toBe(7);
    expect(s.fastest_read).toMatchObject({ title: 'S1', days: 7 });
    expect(s.slowest_read).toMatchObject({ title: 'S1', days: 7 });
    expect(s.coverage.velocity).toEqual({ based_on: 1, of: 2 });
  });

  it('listening: a finished audiobook with no duration and no positions adds no hours', async () => {
    const u = await fresh();
    await read(u.id, await book({ title: 'AU1', format: 'audiobook', audio: 7_200 }));
    await read(u.id, await book({ title: 'AU2', format: 'audiobook', audio: null }));
    const s = await statsOf(u);
    expect(s.audio_hours).toBe(2);
    expect(s.coverage.audio).toEqual({ based_on: 1, of: 2 });
  });

  it('pace: a session with no earlier page adds no pages (no inference, §8.4)', async () => {
    const u = await fresh();
    const r = await read(u.id, await book({ title: 'PC1', pages: 300 }), { status: 'reading' });
    await event(r, '2025-03-03T10:00:00Z', { page: 120 }); //       first: the rise is unknown
    await event(r, '2025-03-03T18:00:00Z', { percent: '45.00' }); // percent only: no page, and not in the way
    await event(r, '2025-03-04T10:00:00Z', { page: 150 }); //       +30 from the previous PAGE event
    const s = await statsOf(u);
    expect(s.pace).toEqual([{ week_start: '2025-03-03', pages: 30, pages_per_day: 4.3 }]);
    expect(s.coverage.pace).toEqual({ based_on: 1, of: 3 });
  });

  it('speed: a session without minutes is not timed (no inference from gaps, §8.4)', async () => {
    const u = await fresh();
    const r = await read(u.id, await book({ title: 'SP1', pages: 300 }), { status: 'reading' });
    await event(r, '2025-03-03T10:00:00Z', { page: 10 });
    await event(r, '2025-03-03T11:00:00Z', { page: 40, minutes: 45 }); // +30 in 45 min
    await event(r, '2025-03-05T10:00:00Z', { page: 100 }); //             +60, no minutes
    const s = await statsOf(u);
    expect(s.speed).toEqual({ pages_per_hour: 40, pages: 30, minutes: 45 });
    expect(s.coverage.speed).toEqual({ based_on: 1, of: 3 });
    // No timed session at all: null, never 0 pages an hour.
    const v = await fresh();
    const r2 = await read(v.id, await book({ title: 'SP2', pages: 300 }), { status: 'reading' });
    await event(r2, '2025-03-03T10:00:00Z', { page: 10, minutes: 30 });
    expect((await statsOf(v)).speed.pages_per_hour).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ST-01: the figures new in Phase 5, per viewer, where the twin oracle in
// stats-audit.test.ts cannot reach (a private re-read; books in progress).
// ---------------------------------------------------------------------------

describe('ST-01: per viewer', () => {
  it('a private re-read is the owner\'s most re-read book and nobody else\'s', async () => {
    const owner = await makeUser(db, 'reread_owner');
    const stranger = await makeUser(db, 'reread_stranger');
    const fan = await makeUser(db, 'reread_fan');
    await follow(db, fan.id, owner.id);
    const b = await book({ title: 'Loved Twice', pages: 200 });
    await read(owner.id, b, { visibility: 'public', finished: '2025-01-01' });
    await read(owner.id, b, { visibility: 'private', finished: '2025-02-01', attempt: 2 });
    await read(owner.id, await book({ title: 'Now' }), { status: 'reading', visibility: 'followers' });
    const mine = await statsOf(owner);
    expect(mine.most_reread).toMatchObject({ title: 'Loved Twice', count: 2 });
    expect(mine.books_in_progress).toBe(1);
    for (const [viewer, inProgress] of [[stranger, 0], [fan, 1], [null, 0]] as const) {
      const res = await app.inject({ method: 'GET', url: `/v1/users/${owner.id}/stats?year=2025`, headers: viewer ? viewer.auth : {} });
      expect(res.json().most_reread).toBeNull();
      expect(res.json().books_count).toBe(1);
      expect(res.json().books_in_progress).toBe(inProgress);
    }
  });
});

// ---------------------------------------------------------------------------
// ST-06: streaks (PRD §8.7).
// ---------------------------------------------------------------------------

describe('ST-06: streak with a two-day grace, framed as the longest', () => {
  it('the grace is two days', () => {
    expect(STREAK_GRACE_DAYS).toBe(2);
  });

  it('up to two days without reading do not break a run; three do', () => {
    // 1, 4 (2 missed), 7 (2 missed) → one run of 7 days; 11 (3 missed) starts another.
    const r = computeStreaks(['2025-03-01', '2025-03-04', '2025-03-07', '2025-03-11'], '2025-06-01');
    expect(r.longestStreak).toBe(7);
    expect(r.longestRange).toEqual({ start: '2025-03-01', end: '2025-03-07' });
    expect(r.currentStreak).toBe(0);
    expect(r.currentRange).toBeNull();
  });

  it('the current streak is alive while today is within the grace of its last day', () => {
    const days = ['2025-03-01', '2025-03-02', '2025-03-03'];
    for (const [today, alive] of [['2025-03-03', true], ['2025-03-04', true], ['2025-03-06', true], ['2025-03-07', false]] as const) {
      const r = computeStreaks(days, today);
      expect(r.currentStreak, today).toBe(alive ? 3 : 0);
      expect(r.longestStreak, today).toBe(3); // a broken streak is still the longest
    }
  });

  it('length is the calendar span, so it matches the range shown beside it', () => {
    const r = computeStreaks(['2025-01-30', '2025-02-01', '2025-02-02'], '2025-02-02');
    expect(r.currentStreak).toBe(4); // 30 Jan – 2 Feb
    expect(r.currentRange).toEqual({ start: '2025-01-30', end: '2025-02-02' });
  });

  it('the earliest of two equal runs is the longest, every time', () => {
    const r = computeStreaks(['2025-01-01', '2025-01-02', '2025-05-01', '2025-05-02'], '2025-09-01');
    expect(r.longestRange).toEqual({ start: '2025-01-01', end: '2025-01-02' });
  });

  it('nothing logged is no streak, and no range', () => {
    expect(computeStreaks([], '2025-01-01')).toEqual({ currentStreak: 0, longestStreak: 0, currentRange: null, longestRange: null });
  });

  it('through the API, in the reader\'s zone', async () => {
    const u = await makeUser(db, 'streak_api');
    const r = await read(u.id, await book({ title: 'Daily', pages: 300 }), { status: 'reading' });
    const today = new Date();
    const ago = (d: number) => new Date(today.getTime() - d * 86_400_000).toISOString();
    // 6, 5 and 2 days ago (3 and 4 missed): one run of 5 days, still current.
    for (const d of [6, 5, 2]) await event(r, ago(d), { page: 10 + d });
    const s = await statsOf(u, 'year=all&tz=UTC');
    expect(s.current_streak).toBe(5);
    expect(s.longest_streak).toBe(5);
    expect(s.current_streak_range).toEqual(s.longest_streak_range);
  });

  it('helpers: median and weekly pace', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(weeklyPace(new Map())).toEqual([]);
    // Wed 1 Jan 2025 → week of Mon 30 Dec 2024; a gap week is 0, not skipped.
    expect(weeklyPace(new Map([['2025-01-01', 70], ['2025-01-15', 7]]))).toEqual([
      { week_start: '2024-12-30', pages: 70, pages_per_day: 10 },
      { week_start: '2025-01-06', pages: 0, pages_per_day: 0 },
      { week_start: '2025-01-13', pages: 7, pages_per_day: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ST-05: goals (PRD §8.6 [LOCKED]).
// ---------------------------------------------------------------------------

describe('ST-05: goals', () => {
  let owner: TestUser;
  let stranger: TestUser;
  let fan: TestUser;
  let pendingFan: TestUser;
  let blocker: TestUser;
  let blocked: TestUser;

  beforeAll(async () => {
    owner = await makeUser(db, 'goal_owner');
    stranger = await makeUser(db, 'goal_stranger');
    fan = await makeUser(db, 'goal_fan');
    pendingFan = await makeUser(db, 'goal_pending');
    blocker = await makeUser(db, 'goal_blocker');
    blocked = await makeUser(db, 'goal_blocked');
    await follow(db, fan.id, owner.id);
    await db.insert(follows).values({ followerId: pendingFan.id, followeeId: owner.id, state: 'pending' });
    await block(db, blocker.id, owner.id);
    await block(db, owner.id, blocked.id);
    // 2025: public 300 pages, followers-only 200, private 100, private with no page count, undated public.
    await read(owner.id, await book({ title: 'GP', pages: 300 }), { finished: '2025-02-01', visibility: 'public' });
    await read(owner.id, await book({ title: 'GF', pages: 200 }), { finished: '2025-03-01', visibility: 'followers' });
    await read(owner.id, await book({ title: 'GX', pages: 100 }), { finished: '2025-04-01', visibility: 'private' });
    await read(owner.id, await book({ title: 'GN', pages: null }), { finished: '2025-05-01', visibility: 'private' });
    await read(owner.id, await book({ title: 'GU', pages: 999 }), { finished: null, visibility: 'public', source: 'import' });
    await read(owner.id, await book({ title: 'G24', pages: 50 }), { finished: '2024-12-31', visibility: 'public' });
  });

  const put = (u: TestUser, payload: unknown) => app.inject({ method: 'PUT', url: '/v1/me/goal', headers: u.auth, payload: payload as any });
  const goalOf = (userId: string, viewer: TestUser | null, year = '2025') =>
    app.inject({ method: 'GET', url: `/v1/users/${userId}/goal?year=${year}`, headers: viewer ? viewer.auth : {} });

  it('none set is goal: null, not a zero target', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/goal?year=2025', headers: owner.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ year: 2025, goal: null });
  });

  it('set, then change downward with no friction; the owner\'s progress counts private reads', async () => {
    const first = await put(owner, { year: 2025, target_books: 24, target_pages: 8000 });
    expect(first.statusCode, first.payload).toBe(200);
    const lower = await put(owner, { year: 2025, target_books: 4, target_pages: 600 });
    expect(lower.statusCode).toBe(200);
    // Dated 2025 finishes: GP, GF, GX, GN = 4 books; 300 + 200 + 100 = 600 pages (GN has none).
    expect(lower.json()).toEqual({
      year: 2025,
      goal: {
        target_books: 4, target_pages: 600, books_count: 4, pages_count: 600, books_reached: true, pages_reached: true,
        pages_coverage: { based_on: 3, of: 4 },
      },
    });
    const rows = await db.select().from(goals).where(eq(goals.userId, owner.id));
    expect(rows).toHaveLength(1);
  });

  it('another viewer counts only the reads they may see (§17.5)', async () => {
    const expectGoal = async (viewer: TestUser | null, books: number, pages: number) => {
      const res = await goalOf(owner.id, viewer);
      expect(res.statusCode).toBe(200);
      expect(res.json().goal).toMatchObject({ target_books: 4, books_count: books, pages_count: pages, books_reached: books >= 4 });
    };
    await expectGoal(stranger, 1, 300);
    await expectGoal(null, 1, 300);
    await expectGoal(pendingFan, 1, 300);
    await expectGoal(fan, 2, 500);
    await expectGoal(owner, 4, 600);
  });

  it('blocked either way, a random id and a private account to a stranger are the random-id 404', async () => {
    const random = await goalOf(randomUUID(), stranger);
    expect(random.statusCode).toBe(404);
    for (const viewer of [blocker, blocked]) {
      const res = await goalOf(owner.id, viewer);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(random.body);
    }
    const priv = await makeUser(db, 'goal_private', { isPrivate: true });
    await put(priv, { year: 2025, target_books: 10 });
    for (const viewer of [stranger, null]) {
      const res = await goalOf(priv.id, viewer);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe((await goalOf(randomUUID(), viewer)).body);
    }
    const privFan = await makeUser(db, 'goal_private_fan');
    await follow(db, privFan.id, priv.id);
    expect((await goalOf(priv.id, privFan)).json().goal.target_books).toBe(10);
  });

  it('years are separate, and delete is idempotent', async () => {
    await put(owner, { year: 2024, target_books: 1 });
    expect((await goalOf(owner.id, owner, '2024')).json().goal).toMatchObject({ target_books: 1, books_count: 1, books_reached: true });
    for (let i = 0; i < 2; i++) {
      const del = await app.inject({ method: 'DELETE', url: '/v1/me/goal?year=2024', headers: owner.auth });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ year: 2024, goal: null });
    }
    expect((await goalOf(owner.id, owner)).json().goal.target_books).toBe(4); // 2025 untouched
  });

  it('refuses what is not a goal, and writes nothing', async () => {
    const u = await makeUser(db, 'goal_bad');
    for (const body of [
      { year: 2025, target_books: 0 },
      { year: 2025, target_books: -3 },
      { year: 2025, target_books: 2.5 },
      { year: 2025, target_books: 10_001 },
      { year: 2025, target_books: 5, target_pages: 0 },
      { year: 2025, target_books: 5, target_pages: 10_000_001 },
      { year: 1899, target_books: 5 },
      { year: 'next', target_books: 5 },
      { year: 2025, target_books: 'five' },
      { target_books: 5 },
      {},
    ]) {
      const res = await put(u, body);
      expect([400, 422], JSON.stringify(body)).toContain(res.statusCode);
    }
    expect(await db.select().from(goals).where(eq(goals.userId, u.id))).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: '/v1/me/goal', headers: u.auth })).statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/v1/me/goal?year=12', headers: u.auth })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PUT', url: '/v1/me/goal', payload: { year: 2025, target_books: 5 } })).statusCode).toBe(401);
  });

  it('the goal lives on its own route only: not in the stats response (§8.6, ring on the profile and nowhere else)', async () => {
    const s = await statsOf(owner);
    expect(JSON.stringify(Object.keys(s))).not.toMatch(/goal|target/i);
    const res = await goalOf(owner.id, owner);
    expect(JSON.stringify(res.json())).not.toMatch(/behind|ahead|schedule|remaining/i);
  });
});
