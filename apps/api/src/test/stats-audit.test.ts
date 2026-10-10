// Audit 10: reading stats (SL-74). PRD §17.5 [LOCKED]: the owner's stats
// include private reads, anyone else's must not, in any field. §17.4: never
// fabricate, disclose exclusions. §8.7 streaks on the user's local day.
// D-08-3: one page-count rule. A-09-043: ten half-star buckets.
//
// The privacy oracle is a TWIN: a second account holding exactly the reads a
// given viewer may see of the owner. The viewer's response about the owner
// must deep-equal the twin's own response, field by field, so a stat that
// forgets the viewer (audio, streak, extremes, author...) cannot hide.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { authors, editions, follows, progressEvents, reads, workAuthors, works } from '../db/schema.js';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { ReadingService } from '../reading/index.js';
import { freshDrizzle } from './pg.js';
import { block, follow, makeUser, type TestUser } from './interaction-fixtures.js';

/** The reading and catalog routes as well: interactionHarness mounts neither. */
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

type Vis = 'public' | 'followers' | 'private';
interface Spec {
  key: string;
  status: 'finished' | 'dnf' | 'reading';
  vis: Vis;
  finishedAt?: string | null;
  abandonedAt?: string | null;
  rating?: string | null;
  format?: 'hardcover' | 'paperback' | 'ebook' | 'audiobook' | 'unknown';
  pages?: number | null;
  audioDuration?: number | null;
  author: string;
  /** Progress events: [days ago, audio position seconds | null]. */
  events?: Array<[number, number | null]>;
}

const DAY = 86_400_000;

// One library covering every stat: public, followers-only and private reads,
// each with a distinguishing value so a leak changes the answer.
const LIBRARY: Spec[] = [
  { key: 'pub1', status: 'finished', vis: 'public', finishedAt: '2025-03-10', rating: '4.5', format: 'paperback', pages: 300, author: 'Author Public', events: [[20, null]] },
  { key: 'pub2', status: 'finished', vis: 'public', finishedAt: '2025-07-02', rating: '3.0', format: 'hardcover', pages: 120, author: 'Author Public' },
  { key: 'fol1', status: 'finished', vis: 'followers', finishedAt: '2025-04-10', rating: '2.0', format: 'ebook', pages: 500, author: 'Author Followers', events: [[10, null]] },
  { key: 'prv1', status: 'finished', vis: 'private', finishedAt: '2025-05-10', rating: '1.0', format: 'audiobook', pages: 900, audioDuration: 36_000, author: 'Author Private',
    events: [[0, 7_200], [1, 3_600], [2, 1_800]] },
  { key: 'prv2', status: 'finished', vis: 'private', finishedAt: '2025-05-11', rating: '0.5', format: 'paperback', pages: 40, author: 'Author Private' },
  { key: 'prv3', status: 'finished', vis: 'private', finishedAt: '2025-05-12', rating: '5.0', format: 'paperback', pages: 50, author: 'Author Private' },
  { key: 'prvDnf', status: 'dnf', vis: 'private', abandonedAt: '2025-06-01', format: 'paperback', pages: 200, author: 'Author Private' },
];

describe('reading stats (Audit 10, SL-74)', () => {
  let db: Db;
  let client: { close: () => Promise<void> };
  let app: FastifyInstance;
  let owner: TestUser;
  let follower: TestUser;
  let pending: TestUser;
  let stranger: TestUser;
  let blocker: TestUser;
  let blocked: TestUser;
  let twinPublic: TestUser;
  let twinFollower: TestUser;
  const authorIds = new Map<string, string>();

  async function authorId(name: string): Promise<string> {
    const known = authorIds.get(name);
    if (known) return known;
    const [a] = await db.insert(authors).values({ name }).returning({ id: authors.id });
    authorIds.set(name, a!.id);
    return a!.id;
  }

  /** Works are per spec key and shared by the owner and the twins. */
  const workIds = new Map<string, { workId: string; editionId: string }>();
  async function workFor(s: Spec) {
    const known = workIds.get(s.key);
    if (known) return known;
    const [w] = await db.insert(works).values({ title: `Book ${s.key}` }).returning({ id: works.id });
    await db.insert(workAuthors).values({ workId: w!.id, authorId: await authorId(s.author), position: 0 });
    const [e] = await db
      .insert(editions)
      .values({ workId: w!.id, pageCount: s.pages ?? null, format: s.format ?? 'unknown', audioSeconds: s.audioDuration ?? null })
      .returning({ id: editions.id });
    const ids = { workId: w!.id, editionId: e!.id };
    workIds.set(s.key, ids);
    return ids;
  }

  async function seed(userId: string, specs: Spec[]) {
    for (const s of specs) {
      const { workId, editionId } = await workFor(s);
      const [r] = await db
        .insert(reads)
        .values({
          userId,
          workId,
          editionId,
          status: s.status,
          visibility: s.vis,
          finishedAt: s.finishedAt ?? null,
          abandonedAt: s.abandonedAt ?? null,
          rating: s.rating ?? null,
        })
        .returning({ id: reads.id });
      for (const [daysAgo, audio] of s.events ?? []) {
        await db.insert(progressEvents).values({
          readId: r!.id,
          at: new Date(Date.now() - daysAgo * DAY),
          page: audio === null ? 10 : null,
          audioSeconds: audio,
          clientEventId: randomUUID(),
        });
      }
    }
  }

  beforeAll(async () => {
    ({ db, client, app } = await statsHarness());
    owner = await makeUser(db, 'stats_owner');
    follower = await makeUser(db, 'stats_follower');
    pending = await makeUser(db, 'stats_pending');
    stranger = await makeUser(db, 'stats_stranger');
    blocker = await makeUser(db, 'stats_blocker');
    blocked = await makeUser(db, 'stats_blocked');
    twinPublic = await makeUser(db, 'twin_public');
    twinFollower = await makeUser(db, 'twin_follower');

    await seed(owner.id, LIBRARY);
    await seed(twinPublic.id, LIBRARY.filter((s) => s.vis === 'public'));
    await seed(twinFollower.id, LIBRARY.filter((s) => s.vis !== 'private'));

    await follow(db, follower.id, owner.id);
    await db.insert(follows).values({ followerId: pending.id, followeeId: owner.id, state: 'pending' });
    await block(db, blocker.id, owner.id);
    await block(db, owner.id, blocked.id);
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  const statsOf = async (userId: string, viewer: TestUser | null, query = 'year=all') => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/users/${userId}/stats?${query}`,
      headers: viewer ? viewer.auth : {},
    });
    return res;
  };
  const myStats = async (viewer: TestUser, query = 'year=all') =>
    app.inject({ method: 'GET', url: `/v1/me/stats?${query}`, headers: viewer.auth });

  describe('§17.5 [LOCKED]: every field, per viewer', () => {
    for (const query of ['year=all', 'year=2025']) {
      it(`a stranger, a guest and a pending follower see exactly the public reads (${query})`, async () => {
        const expected = (await myStats(twinPublic, query)).json();
        for (const viewer of [stranger, null, pending]) {
          const res = await statsOf(owner.id, viewer, query);
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual(expected);
        }
      });

      it(`an accepted follower sees exactly the public and followers-only reads (${query})`, async () => {
        const expected = (await myStats(twinFollower, query)).json();
        const res = await statsOf(owner.id, follower, query);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(expected);
      });
    }

    it('the owner sees everything, private reads included, and the owner view is the same on both routes', async () => {
      const mine = (await myStats(owner)).json();
      expect(mine.books_count).toBe(6);
      expect(mine.most_read_author).toEqual({ name: 'Author Private', count: 3 });
      expect(mine.longest_book.page_count).toBe(900);
      expect(mine.dnf_count).toBe(1);
      expect(mine.current_streak).toBeGreaterThanOrEqual(3);
      expect(mine.audio_hours).toBe(10); // the finished audiobook's 36,000 s duration
      const viaUsers = (await statsOf(owner.id, owner)).json();
      expect(viaUsers).toEqual(mine);
    });

    it('the public view leaks no private value (spot checks behind the twin oracle)', async () => {
      const pub = (await statsOf(owner.id, stranger)).json();
      expect(pub.books_count).toBe(2);
      expect(pub.pages_count).toBe(420);
      expect(pub.audio_hours).toBe(0);
      expect(pub.current_streak).toBe(0);
      expect(pub.longest_book.page_count).toBe(300);
      expect(pub.shortest_book.page_count).toBe(120);
      expect(pub.most_read_author).toEqual({ name: 'Author Public', count: 2 });
      expect(pub.dnf_count).toBe(0);
    });

    it('blocked either way and a random id are the same 404', async () => {
      const random = await statsOf('00000000-0000-4000-8000-000000000000', stranger);
      for (const viewer of [blocker, blocked]) {
        const res = await statsOf(owner.id, viewer);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(random.body);
      }
    });
  });

  describe('private account', () => {
    it('stats are followers-only: a stranger and a guest get the random-id 404, a follower gets 200', async () => {
      const priv = await makeUser(db, 'stats_private', { isPrivate: true });
      const fan = await makeUser(db, 'stats_private_fan');
      await follow(db, fan.id, priv.id);
      await seed(priv.id, [{ key: 'privacct', status: 'finished', vis: 'public', finishedAt: '2025-01-05', author: 'X', pages: 100 }]);
      const random = await statsOf('00000000-0000-4000-8000-000000000000', stranger);
      for (const viewer of [stranger, null]) {
        const res = await statsOf(priv.id, viewer);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(random.body);
      }
      const res = await statsOf(priv.id, fan);
      expect(res.statusCode).toBe(200);
      expect(res.json().books_count).toBe(1);
    });
  });
});

describe('reading stats: rules (Audit 10)', () => {
  let db: Db;
  let client: { close: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ db, client, app } = await statsHarness());
  });
  afterAll(async () => {
    await app.close();
    await client.close();
  });

  async function work(title: string, eds: Array<{ pages: number | null; format?: string; audio?: number | null }>, defaultIdx?: number) {
    const [w] = await db.insert(works).values({ title }).returning({ id: works.id });
    const ids: string[] = [];
    for (const e of eds) {
      const [row] = await db
        .insert(editions)
        .values({ workId: w!.id, pageCount: e.pages, format: e.format ?? 'unknown', audioSeconds: e.audio ?? null })
        .returning({ id: editions.id });
      ids.push(row!.id);
    }
    if (defaultIdx !== undefined) await db.update(works).set({ defaultEditionId: ids[defaultIdx]! }).where(eq(works.id, w!.id));
    return { workId: w!.id, editionIds: ids };
  }
  const get = async (u: TestUser, query: string) =>
    (await app.inject({ method: 'GET', url: `/v1/me/stats?${query}`, headers: u.auth })).json();

  it('D-08-3: no chosen edition → default edition, else the median ignoring < 20 pages', async () => {
    const u = await makeUser(db, 'pages_rule');
    const median = await work('Median', [{ pages: 96 }, { pages: 310 }, { pages: 320 }, { pages: 1200 }, { pages: 5 }]);
    const withDefault = await work('Default', [{ pages: 100 }, { pages: 700 }, { pages: 800 }], 0);
    await db.insert(reads).values([
      { userId: u.id, workId: median.workId, status: 'finished', finishedAt: '2025-02-01' },
      { userId: u.id, workId: withDefault.workId, status: 'finished', finishedAt: '2025-02-02' },
    ]);
    const s = await get(u, 'year=2025');
    expect(s.pages_count).toBe(315 + 100);
    expect(s.longest_book.page_count).toBe(315);
    // The same rule in the reads list (progress %) and on the book page.
    const list = await app.inject({ method: 'GET', url: '/v1/reads', headers: u.auth });
    const byWork = new Map(list.json().data.map((r: any) => [r.work_id, r.page_count]));
    expect(byWork.get(median.workId)).toBe(315);
    expect(byWork.get(withDefault.workId)).toBe(100);
    const page = await app.inject({ method: 'GET', url: `/v1/works/${median.workId}`, headers: u.auth });
    expect(page.json().page_count).toBe(315);
  });

  it('§17.4: a book without a page count adds nothing and is disclosed; undated finishes are counted all-time and disclosed', async () => {
    const u = await makeUser(db, 'honest');
    const noPages = await work('No pages', [{ pages: null }, { pages: 12 }]);
    const undated = await work('Undated', [{ pages: 250 }]);
    await db.insert(reads).values([
      { userId: u.id, workId: noPages.workId, status: 'finished', finishedAt: '2025-03-01' },
      { userId: u.id, workId: undated.workId, status: 'finished', finishedAt: null, source: 'import' },
    ]);
    const year = await get(u, 'year=2025');
    expect(year.books_count).toBe(1);
    expect(year.pages_count).toBe(0);
    expect(year.longest_book).toBeNull();
    expect(year.excluded).toEqual({ missing_page_count: 1, undated: 1 });
    const all = await get(u, 'year=all');
    expect(all.books_count).toBe(2);
    expect(all.pages_count).toBe(250);
    expect(all.monthly_pace.reduce((n: number, m: any) => n + m.books, 0)).toBe(1);
    expect(all.excluded).toEqual({ missing_page_count: 1, undated: 1 });
  });

  it('format split: override first, then the edition format; an unknown format is not counted as print', async () => {
    const u = await makeUser(db, 'formats');
    const eb = await work('Ebook ed', [{ pages: 200, format: 'ebook' }]);
    const au = await work('Audio ed', [{ pages: 200, format: 'audiobook' }]);
    const hc = await work('Hardcover ed', [{ pages: 200, format: 'hardcover' }]);
    const un = await work('Unknown ed', [{ pages: 200, format: 'unknown' }]);
    const ov = await work('Override', [{ pages: 200, format: 'hardcover' }]);
    await db.insert(reads).values([
      { userId: u.id, workId: eb.workId, editionId: eb.editionIds[0]!, status: 'finished', finishedAt: '2025-01-01' },
      { userId: u.id, workId: au.workId, editionId: au.editionIds[0]!, status: 'finished', finishedAt: '2025-01-02' },
      { userId: u.id, workId: hc.workId, editionId: hc.editionIds[0]!, status: 'finished', finishedAt: '2025-01-03' },
      { userId: u.id, workId: un.workId, editionId: un.editionIds[0]!, status: 'finished', finishedAt: '2025-01-04' },
      { userId: u.id, workId: ov.workId, editionId: ov.editionIds[0]!, status: 'finished', finishedAt: '2025-01-05', formatOverride: 'audiobook' },
    ]);
    const s = await get(u, 'year=2025');
    expect(s.format_breakdown).toEqual({ print: 1, ebook: 1, audiobook: 2, unknown: 1 });
  });

  it('A-09-043: the histogram has the ten half-star buckets', async () => {
    const u = await makeUser(db, 'buckets');
    const w1 = await work('R1', [{ pages: 100 }]);
    const w2 = await work('R2', [{ pages: 100 }]);
    const w3 = await work('R3', [{ pages: 100 }]);
    await db.insert(reads).values([
      { userId: u.id, workId: w1.workId, status: 'finished', finishedAt: '2025-01-01', rating: '4.5' },
      { userId: u.id, workId: w2.workId, status: 'finished', finishedAt: '2025-01-02', rating: '0.5' },
      { userId: u.id, workId: w3.workId, status: 'finished', finishedAt: '2025-01-03', rating: '4.5' },
    ]);
    const s = await get(u, 'year=2025');
    expect(s.rating_distribution).toEqual({
      '0.5': 1, '1.0': 0, '1.5': 0, '2.0': 0, '2.5': 0, '3.0': 0, '3.5': 0, '4.0': 0, '4.5': 2, '5.0': 0,
    });
  });

  it('re-reads: books per attempt, distinct works reported beside it (§17.2)', async () => {
    const u = await makeUser(db, 'rereader');
    const w = await work('Loved', [{ pages: 300 }]);
    await db.insert(reads).values([
      { userId: u.id, workId: w.workId, status: 'finished', finishedAt: '2025-01-01', attemptNo: 1 },
      { userId: u.id, workId: w.workId, status: 'finished', finishedAt: '2025-06-01', attemptNo: 2 },
    ]);
    const s = await get(u, 'year=2025');
    expect(s.books_count).toBe(2);
    expect(s.distinct_works_count).toBe(1);
    expect(s.pages_count).toBe(600);
  });

  it('the year is the finish date, never shifted by the server clock', async () => {
    const u = await makeUser(db, 'newyear');
    const w = await work('NY', [{ pages: 100 }]);
    await db.insert(reads).values({ userId: u.id, workId: w.workId, status: 'finished', finishedAt: '2025-01-01' });
    const y2025 = await get(u, 'year=2025');
    expect(y2025.books_count).toBe(1);
    expect(y2025.monthly_pace[0].books).toBe(1);
    expect((await get(u, 'year=2024')).books_count).toBe(0);
  });

  it('listening hours: audio_seconds is a position, so a read counts its furthest point, not the sum of its events', async () => {
    const u = await makeUser(db, 'listener');
    const w = await work('Long listen', [{ pages: 300, format: 'audiobook' }]);
    const [r] = await db
      .insert(reads)
      .values({ userId: u.id, workId: w.workId, editionId: w.editionIds[0]!, status: 'reading' })
      .returning({ id: reads.id });
    for (const [at, pos] of [['2025-03-01T10:00:00Z', 3_600], ['2025-03-02T10:00:00Z', 7_200], ['2025-03-03T10:00:00Z', 10_800]] as const) {
      await db.insert(progressEvents).values({ readId: r!.id, at: new Date(at), audioSeconds: pos, clientEventId: randomUUID() });
    }
    expect((await get(u, 'year=all')).audio_hours).toBe(3);
    expect((await get(u, 'year=2025')).audio_hours).toBe(3);
    // Across a year boundary, each year gets what was listened in it.
    await db.insert(progressEvents).values({ readId: r!.id, at: new Date('2026-01-02T10:00:00Z'), audioSeconds: 14_400, clientEventId: randomUUID() });
    expect((await get(u, 'year=2025')).audio_hours).toBe(3);
    expect((await get(u, 'year=2026')).audio_hours).toBe(1);
  });

  it('§8.7: streak days are the user\'s local days (tz), not UTC', async () => {
    const u = await makeUser(db, 'ist_reader');
    const w = await work('Night', [{ pages: 300 }]);
    const [r] = await db
      .insert(reads)
      .values({ userId: u.id, workId: w.workId, status: 'reading' })
      .returning({ id: reads.id });
    // 23:50 IST on 10 March and 00:10 IST on 11 March are 18:20 and 18:40
    // UTC on 10 March: two local days in India, one day in UTC.
    for (const at of ['2025-03-10T18:20:00Z', '2025-03-10T18:40:00Z']) {
      await db.insert(progressEvents).values({ readId: r!.id, at: new Date(at), page: 10, clientEventId: randomUUID() });
    }
    expect((await get(u, 'year=all&tz=Asia/Kolkata')).longest_streak).toBe(2);
    expect((await get(u, 'year=all&tz=UTC')).longest_streak).toBe(1);
    expect((await get(u, 'year=all')).longest_streak).toBe(1); // no tz: UTC
    const bad = await app.inject({ method: 'GET', url: '/v1/me/stats?tz=Not/AZone', headers: u.auth });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('invalid_timezone');
  });

  it('a year before 1900 or not a year is refused, not silently replaced by this year', async () => {
    const u = await makeUser(db, 'bad_year');
    for (const year of ['20x5', '0', '99999']) {
      const res = await app.inject({ method: 'GET', url: `/v1/me/stats?year=${year}`, headers: u.auth });
      expect(res.statusCode).toBe(422);
    }
  });
});
