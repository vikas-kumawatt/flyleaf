// ST-09: Year in Review (PRD §6.41, §17.5, §17.6, §19.2 item 8).
//
//   - opens on 1 December in the reader's own zone, with a fixed clock, on
//     either side of midnight in zones from UTC−11 to UTC+14;
//   - built from the same per-viewer stats as the stats screen: every figure
//     equals GET /me/stats?year= for the owner, private reads included;
//   - under 5 books, a gentle variant with no counts and nothing that shames;
//     a goal appears only when met;
//   - its share cards are the reader's own, public reads only, like every card;
//   - the Year in Review notification: once a year, after 1 December locally,
//     through preferences, quiet hours and the daily cap.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';

import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import type { Db } from '../platform/index.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import { goals, notificationPreferences, progressEvents, reads } from '../db/schema.js';
import { CardService } from '../cards/index.js';
import { CardRenderer } from '../cards/render.js';
import { isUnlocked, latestYear, YearInReviewService } from '../reading/year-in-review.js';
import { MemoryNotifyQueue, Notifier, viewNotification, compose } from '../notify/index.js';
import { decemberSomewhere, sendYearInReviewNotices } from '../notify/year-in-review.js';
import { freshDrizzle } from './pg.js';
import { follow, makeRead, makeUser, makeWork, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let clock = new Date('2026-12-15T12:00:00Z');
const now = () => clock;

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  app = await buildApp({
    db,
    identity: new IdentityService(db, unlimited),
    reading: new ReadingService(db),
    limiter: unlimited,
    storage: new MemoryObjectStorage(),
    cards: { renderer: new CardRenderer(), fetchBytes: async () => ({ ok: false, reason: 'http' }) },
    yearInReview: { now },
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await close?.();
});

beforeEach(() => {
  clock = new Date('2026-12-15T12:00:00Z');
});

async function work(title: string, opts: { pages?: number; author?: string } = {}): Promise<string> {
  const id = await makeWork(db, title);
  if (opts.pages) await db.execute(sql`INSERT INTO editions (work_id, page_count, format) VALUES (${id}::uuid, ${opts.pages}, 'paperback')`);
  if (opts.author) {
    await db.execute(sql`WITH a AS (INSERT INTO authors (name) VALUES (${opts.author}) RETURNING id)
      INSERT INTO work_authors (work_id, author_id, position) SELECT ${id}::uuid, a.id, 0 FROM a`);
  }
  return id;
}

async function finish(user: TestUser, workId: string, on: string, opts: { visibility?: 'public' | 'followers' | 'private'; rating?: string } = {}) {
  const id = await makeRead(db, user.id, workId, { visibility: opts.visibility ?? 'public', rating: opts.rating ?? null });
  await db.update(reads).set({ finishedAt: on, startedAt: on }).where(eq(reads.id, id));
  return id;
}

const yir = (user: TestUser, q = '') => app.inject({ method: 'GET', url: `/v1/me/year-in-review${q}`, headers: user.auth });

describe('ST-09: opens on 1 December in the reader\'s own time zone (fixed clock)', () => {
  it('either side of local midnight, in zones from UTC−11 to UTC+14', () => {
    const cases: Array<[instant: string, tz: string, open: boolean]> = [
      // UTC itself.
      ['2026-11-30T23:59:59Z', 'UTC', false],
      ['2026-12-01T00:00:00Z', 'UTC', true],
      // East of UTC: open while it is still 30 November in London.
      ['2026-11-30T15:00:00Z', 'Asia/Tokyo', true], // 00:00 JST
      ['2026-11-30T14:59:59Z', 'Asia/Tokyo', false], // 23:59:59 JST
      ['2026-11-30T18:30:00Z', 'Asia/Kolkata', true], // 00:00 IST (+05:30)
      ['2026-11-30T18:29:59Z', 'Asia/Kolkata', false],
      ['2026-11-30T10:00:00Z', 'Pacific/Kiritimati', true], // UTC+14, the first place on Earth
      ['2026-11-30T09:59:59Z', 'Pacific/Kiritimati', false],
      // West of UTC: still locked after midnight in London.
      ['2026-12-01T07:59:59Z', 'America/Los_Angeles', false], // 23:59:59 PST
      ['2026-12-01T08:00:00Z', 'America/Los_Angeles', true],
      ['2026-12-01T10:59:59Z', 'Pacific/Pago_Pago', false], // UTC−11
      ['2026-12-01T11:00:00Z', 'Pacific/Pago_Pago', true],
    ];
    for (const [instant, tz, open] of cases) expect(isUnlocked(2026, tz, new Date(instant)), `${instant} ${tz}`).toBe(open);
    // Re-viewable any time afterwards (§6.41), and a later year is not open early.
    expect(isUnlocked(2025, 'UTC', new Date('2026-03-01T00:00:00Z'))).toBe(true);
    expect(isUnlocked(2027, 'UTC', new Date('2026-12-31T23:59:59Z'))).toBe(false);
  });

  it('the default year is this year from 1 December locally, else last year', () => {
    expect(latestYear('UTC', new Date('2026-11-30T23:59:59Z'))).toBe(2025);
    expect(latestYear('UTC', new Date('2026-12-01T00:00:00Z'))).toBe(2026);
    expect(latestYear('Asia/Tokyo', new Date('2026-11-30T15:00:00Z'))).toBe(2026);
    expect(latestYear('America/Los_Angeles', new Date('2027-01-01T07:00:00Z'))).toBe(2026); // still 31 Dec there
  });

  it('through the API: locked says when and carries nothing; open carries the cards', async () => {
    const r = await makeUser(db, 'yir_clock');
    await finish(r, await work('Clock book'), '2026-06-01');
    clock = new Date('2026-11-30T23:30:00Z');
    const london = await yir(r, '?year=2026&tz=Europe/London');
    expect(london.statusCode).toBe(200);
    expect(london.json()).toEqual({ year: 2026, unlocked: false, unlocks_on: '2026-12-01', variant: null, cards: [] });
    const kolkata = (await yir(r, '?year=2026&tz=Asia/Kolkata')).json();
    expect(kolkata.unlocked).toBe(true);
    expect(kolkata.cards.length).toBeGreaterThan(0);
    clock = new Date('2026-12-01T04:00:00Z');
    expect((await yir(r, '?year=2026&tz=America/Los_Angeles')).json().unlocked).toBe(false);
    expect((await yir(r, '?year=2026&tz=UTC')).json().unlocked).toBe(true);
    // Default year follows the same rule.
    clock = new Date('2026-11-15T12:00:00Z');
    expect((await yir(r)).json().year).toBe(2025);
  });

  it('bad input is 422, signed out is 401', async () => {
    const r = await makeUser(db, 'yir_input');
    for (const q of ['?year=26', '?year=abcd', '?year=1899', '?tz=Mars/Base']) expect((await yir(r, q)).statusCode, q).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/v1/me/year-in-review' })).statusCode).toBe(401);
  });
});

describe('ST-09: the same numbers as the stats screen (§17.5: the owner\'s full data)', () => {
  let reader: TestUser;
  beforeAll(async () => {
    reader = await makeUser(db, 'yir_full');
    const leGuin = 'Ursula K. Le Guin';
    await finish(reader, await work('Earthsea', { pages: 200, author: leGuin }), '2026-01-10', { rating: '5.0' });
    await finish(reader, await work('Lathe', { pages: 180, author: leGuin }), '2026-02-10', { rating: '4.0' });
    await finish(reader, await work('Dune', { pages: 600, author: 'Frank Herbert' }), '2026-03-10', { rating: '4.5' });
    await finish(reader, await work('Beloved', { author: 'Toni Morrison' }), '2026-04-10', { rating: '3.5' });
    await finish(reader, await work('Secret diary', { pages: 900 }), '2026-05-10', { visibility: 'private', rating: '2.0' });
    await finish(reader, await work('Club book', { pages: 120 }), '2026-06-10', { visibility: 'followers' });
    await finish(reader, await work('Last year'), '2025-12-31');
    // Two reading days with progress, one of them a finish day too.
    const r = await makeRead(db, reader.id, await work('In progress'), { status: 'reading' });
    await db.insert(progressEvents).values([
      { readId: r, at: new Date('2026-07-04T10:00:00Z'), page: 10, clientEventId: randomUUID() },
      { readId: r, at: new Date('2026-01-10T20:00:00Z'), page: 20, clientEventId: randomUUID() },
    ]);
    await db.insert(goals).values({ userId: reader.id, year: 2026, targetBooks: 6 });
  });

  it('every figure equals GET /me/stats?year=2026 for the owner, private reads included', async () => {
    const body = (await yir(reader, '?year=2026&tz=UTC')).json();
    const stats = (await app.inject({ method: 'GET', url: '/v1/me/stats?year=2026&tz=UTC', headers: reader.auth })).json();
    expect(body.variant).toBe('full');
    const card = (k: string) => body.cards.find((c: { kind: string }) => c.kind === k);
    expect(stats.books_count).toBe(6);
    expect(card('books').value).toBe(String(stats.books_count));
    expect(card('pages').value).toBe(stats.pages_count.toLocaleString('en-GB'));
    expect(card('pages').value).toBe('2,000'); // 200 + 180 + 600 + 900 + 120: the private one counts for the owner
    expect(card('pages').note).toBe('Based on 5 of 6 books — 1 has no page count.');
    expect(card('longest').value).toBe(stats.longest_book.page_count.toLocaleString('en-GB'));
    expect(card('longest').detail).toBe('Secret diary');
    expect(card('author')).toMatchObject({ value: String(stats.most_read_author.count), caption: stats.most_read_author.name });
    expect(card('top').books.map((b: { title: string }) => b.title)).toEqual(['Earthsea', 'Dune', 'Lathe', 'Beloved']);
    // Days with reading: the six 2026 finish days and two progress days, one of them (10 Jan) shared.
    expect(card('calendar').value).toBe('7');
    expect(card('calendar').calendar[0][9]).toBe(1); // 10 Jan
    expect(card('calendar').calendar[6][3]).toBe(1); // 4 Jul
    expect(card('calendar').calendar[1][27]).toBe(0);
    expect(card('calendar').calendar[1]).toHaveLength(28);
    // The goal is met (6 of 6): a celebration, with the figure.
    expect(card('goal')).toMatchObject({ heading: 'Goal reached', value: '6', caption: 'books, for a goal of 6' });
    expect(card('summary')).toMatchObject({ value: '6', detail: '2,000 pages' });
    expect(body.cards.map((c: { kind: string }) => c.kind)).toEqual(['books', 'pages', 'top', 'longest', 'author', 'calendar', 'goal', 'summary']);
  });

  it('a goal not met is left out entirely (§8.6: never a shortfall)', async () => {
    await db.update(goals).set({ targetBooks: 12 }).where(eq(goals.userId, reader.id));
    const body = (await yir(reader, '?year=2026')).json();
    expect(body.cards.some((c: { kind: string }) => c.kind === 'goal')).toBe(false);
    const words = body.cards.flatMap((c: Record<string, unknown>) => [c.heading, c.value, c.caption, c.detail, c.note]).filter(Boolean).join(' ');
    expect(words).not.toMatch(/\b12\b|behind|left to|short of|remaining/i);
    await db.update(goals).set({ targetBooks: 6 }).where(eq(goals.userId, reader.id));
  });

  it('share cards are the reader\'s own and public reads only (§17.5), saying so', async () => {
    const service = new CardService(db, { now, fetchBytes: async () => ({ ok: false, reason: 'http' }) });
    // Public: 4 books, so the public view is the gentle one, and "books" is its shelf.
    const books = await service.yearInReview(reader.id, reader.id, '2026', 'books', 'UTC');
    expect(books.value).toBeNull();
    expect(books.posters.map((p) => p.title).sort()).toEqual(['Beloved', 'Dune', 'Earthsea', 'Lathe']);
    const summary = await service.yearInReview(reader.id, reader.id, '2026', 'summary', 'UTC');
    expect(JSON.stringify(summary)).not.toMatch(/Secret diary|Club book|2,000|\b6\b/);
    // Not "goal reached" from public reads (4 < 6), and no pages card on the gentle side.
    await expect(service.yearInReview(reader.id, reader.id, '2026', 'goal', 'UTC')).rejects.toMatchObject({ status: 422, code: 'nothing_to_share' });
    await expect(service.yearInReview(reader.id, reader.id, '2026', 'pages', 'UTC')).rejects.toMatchObject({ code: 'nothing_to_share' });

    const res = await app.inject({ method: 'GET', url: `/v1/cards/users/${reader.id}/year/2026/books?tz=UTC`, headers: reader.auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  }, 60_000);

  it('anyone else gets the random-id 404, a follower included; before 1 December it is 422', async () => {
    const fan = await makeUser(db, 'yir_fan');
    await follow(db, fan.id, reader.id);
    const random = await app.inject({ method: 'GET', url: `/v1/cards/users/${randomUUID()}/year/2026/books`, headers: fan.auth });
    expect(random.statusCode).toBe(404);
    for (const headers of [fan.auth, {}]) {
      const r = await app.inject({ method: 'GET', url: `/v1/cards/users/${reader.id}/year/2026/books`, headers });
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual(random.json());
    }
    clock = new Date('2026-11-30T12:00:00Z');
    const locked = await app.inject({ method: 'GET', url: `/v1/cards/users/${reader.id}/year/2026/books?tz=UTC`, headers: reader.auth });
    expect(locked.statusCode).toBe(422);
    expect(locked.json().error.code).toBe('year_in_review_locked');
  });
});

describe('ST-09: the low-volume variant celebrates and never measures (§17.6)', () => {
  // Words that rank, ration or measure a light year.
  const SHAME = /\b(only|just|few|fewer|less|least|more|behind|short|remaining|left|missed|failed|try|next year|goal of|out of|percent)\b/i;

  it('under 5 books: no figure on any card, no number but the year, nothing that shames', async () => {
    const light = await makeUser(db, 'yir_light');
    await finish(light, await work('Piranesi', { pages: 272, author: 'Susanna Clarke' }), '2026-03-01', { rating: '4.5' });
    await finish(light, await work('Small Things', { pages: 120 }), '2026-08-01');
    await finish(light, await work('Hidden', { pages: 300 }), '2026-09-01', { visibility: 'private' });
    await db.insert(goals).values({ userId: light.id, year: 2026, targetBooks: 3 });
    const body = (await yir(light, '?year=2026')).json();
    expect(body.variant).toBe('gentle');
    expect(body.cards.map((c: { kind: string }) => c.kind)).toEqual(['shelf', 'favourite', 'goal', 'summary_gentle']);
    for (const c of body.cards) {
      expect(c.value, c.kind).toBeNull();
      expect(c.bars, c.kind).toEqual([]);
      expect(c.calendar, c.kind).toBeNull();
      const words = [c.heading, c.caption, c.detail, c.note].filter(Boolean).join(' ');
      expect(words.replace(/2026/g, ''), c.kind).not.toMatch(/\d/);
      expect(words, c.kind).not.toMatch(SHAME);
    }
    expect(body.cards[0].books.map((b: { title: string }) => b.title)).toEqual(['Hidden', 'Small Things', 'Piranesi']);
    expect(body.cards[1]).toMatchObject({ heading: 'A favourite', caption: 'Piranesi', detail: 'Susanna Clarke' });
    expect(body.cards[2]).toMatchObject({ heading: 'Goal reached', caption: 'You set a reading goal for 2026 and reached it.' });
  });

  it('one book is a Year in Review too; a goal not met is not mentioned; none at all is empty', async () => {
    const one = await makeUser(db, 'yir_one');
    await finish(one, await work('The only one'), '2026-05-05');
    await db.insert(goals).values({ userId: one.id, year: 2026, targetBooks: 20 });
    const body = (await yir(one, '?year=2026')).json();
    expect(body.variant).toBe('gentle');
    expect(body.cards.map((c: { kind: string }) => c.kind)).toEqual(['shelf', 'summary_gentle']);
    const none = await makeUser(db, 'yir_none');
    expect((await yir(none, '?year=2026')).json()).toMatchObject({ unlocked: true, variant: 'empty', cards: [] });
  });

  it('5 books is the full variant (the boundary)', async () => {
    const five = await makeUser(db, 'yir_five');
    for (let i = 0; i < 5; i++) await finish(five, await work(`Five ${i}`), `2026-0${i + 1}-01`);
    expect((await yir(five, '?year=2026')).json().variant).toBe('full');
  });
});

describe('ST-09: the Year in Review notification (PRD §19.2 item 8)', () => {
  it('only while some zone is in December', () => {
    expect(decemberSomewhere(new Date('2026-11-30T09:59:59Z'))).toBe(false);
    expect(decemberSomewhere(new Date('2026-11-30T10:00:00Z'))).toBe(true);
    expect(decemberSomewhere(new Date('2026-12-25T00:00:00Z'))).toBe(true);
    expect(decemberSomewhere(new Date('2027-01-01T11:59:59Z'))).toBe(true);
    expect(decemberSomewhere(new Date('2027-01-01T12:00:00Z'))).toBe(false);
    expect(decemberSomewhere(new Date('2026-07-01T00:00:00Z'))).toBe(false);
  });

  it('once a year, after 1 December in the reader\'s zone, for readers with a book that year; push queued, words and link', async () => {
    // A fresh database: the job looks at every reader.
    const fresh = await freshDrizzle();
    const d = fresh.db;
    try {
      const queue = new MemoryNotifyQueue();
      const notifier = new Notifier(queue);
      const tokyo = await makeUser(d, 'yir_tokyo');
      const la = await makeUser(d, 'yir_la');
      const idle = await makeUser(d, 'yir_idle');
      const off = await makeUser(d, 'yir_off');
      const w = await makeWork(d, 'A book');
      for (const u of [tokyo, la, off]) {
        const id = await makeRead(d, u.id, w);
        await d.update(reads).set({ finishedAt: '2026-04-01', startedAt: '2026-04-01' }).where(eq(reads.id, id));
      }
      const idleRead = await makeRead(d, idle.id, w);
      await d.update(reads).set({ finishedAt: '2025-04-01', startedAt: '2025-04-01' }).where(eq(reads.id, idleRead)); // nothing in 2026
      await d.insert(notificationPreferences).values([
        { userId: tokyo.id, timezone: 'Asia/Tokyo' },
        { userId: la.id, timezone: 'America/Los_Angeles' },
        { userId: off.id, timezone: 'UTC', categories: { year_in_review: { push: false, in_app: false } } },
      ] as never);

      // 1 Dec 00:30 in Tokyo, still 30 Nov 07:30 in LA, 15:30 UTC.
      expect(await sendYearInReviewNotices(d, notifier, new Date('2026-11-30T15:30:00Z'))).toEqual({ claimed: 1 });
      const rows = await d.execute<{ user_id: string; id: string }>(sql`SELECT user_id, id FROM notifications WHERE type = 'year_in_review'`);
      expect(rows.map((r) => r.user_id)).toEqual([tokyo.id]);
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]!.job.notificationId).toBe(rows[0]!.id);
      const v = (await viewNotification(d, rows[0]!.id))!;
      expect(compose(v)).toEqual({ text: 'Your 2026 Year in Review is ready.', deepLink: 'flyleaf://year-in-review/2026' });

      // A second run the same day: nobody twice.
      expect(await sendYearInReviewNotices(d, notifier, new Date('2026-11-30T16:00:00Z'))).toEqual({ claimed: 0 });
      // 1 Dec 08:30 UTC: LA reached midnight; "off" is claimed but gets no row (both channels off); idle has no 2026 book.
      expect(await sendYearInReviewNotices(d, notifier, new Date('2026-12-01T08:30:00Z'))).toEqual({ claimed: 2 });
      const all = await d.execute<{ user_id: string }>(sql`SELECT user_id FROM notifications WHERE type = 'year_in_review' ORDER BY created_at`);
      expect(all.map((r) => r.user_id)).toEqual([tokyo.id, la.id]);
      expect(queue.jobs).toHaveLength(2);
      // Switched on again later in December: still nothing (once a year, claimed).
      await d.update(notificationPreferences).set({ categories: {} } as never).where(eq(notificationPreferences.userId, off.id));
      expect(await sendYearInReviewNotices(d, notifier, new Date('2026-12-20T08:30:00Z'))).toEqual({ claimed: 0 });
      // Outside December, the job does nothing at all.
      await d.execute(sql`DELETE FROM year_in_review_notices`);
      expect(await sendYearInReviewNotices(d, notifier, new Date('2027-02-01T00:00:00Z'))).toEqual({ claimed: 0 });
      // A unique row per year even if the claim table were lost: the notification itself is once a year.
      await notifier.yearInReview(d, tokyo.id, 2026);
      expect((await d.execute(sql`SELECT 1 FROM notifications WHERE type = 'year_in_review' AND user_id = ${tokyo.id}::uuid`)).length).toBe(1);
    } finally {
      await fresh.client.close();
    }
  });
});

