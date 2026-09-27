// The book, author and series pages serve real data (audit 08, SL-41, SL-43).
//
// Before: the app showed one fixed description, series and rating histogram
// for every book; the author page searched for the author's NAME as a title
// and invented a bio and books; the series page was hard-coded.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';

import { MemoryCache, PgRateLimiter, type Db } from '../platform/index.js';
import { ReadingService } from '../reading/index.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { buildApp } from '../app.js';
import { freshDrizzle } from './pg.js';
import { authors } from '../db/schema.js';
import { makeUser, makeWork, makeRead, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let client: { close: () => Promise<void> };
let alice: TestUser;

beforeEach(async () => {
  await app?.close();
  await client?.close();
  ({ db, client } = await freshDrizzle());
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();
  alice = await makeUser(db, 'alice');
});
afterAll(async () => { await app?.close(); await client?.close(); });

const get = (url: string, who?: TestUser) =>
  app.inject({ method: 'GET', url: `/v1${url}`, headers: who ? who.auth : {} });

async function author(name: string, alternate: string[] = []) {
  const [a] = await db.insert(authors).values({ name, alternateNames: alternate }).returning({ id: authors.id });
  return a!.id;
}
async function credit(workId: string, authorId: string, position = 0) {
  await db.execute(sql`INSERT INTO work_authors (work_id, author_id, role, position) VALUES (${workId}, ${authorId}, 'author', ${position})`);
}

describe('GET /works/:id carries the page’s real content', () => {
  it('description, credited authors with ids, series and a real rating histogram', async () => {
    const work = await makeWork(db, 'A Wizard of Earthsea');
    await db.execute(sql`UPDATE works SET description = 'Ged, a boy with power.' WHERE id = ${work}`);
    const le = await author('Ursula K. Le Guin');
    await credit(work, le);
    const [s] = await db.execute<{ id: string }>(sql`INSERT INTO series (name) VALUES ('Earthsea Cycle') RETURNING id`);
    await db.execute(sql`INSERT INTO series_entries (series_id, work_id, position) VALUES (${s!.id}, ${work}, 1)`);
    const users = await Promise.all(['a', 'b', 'c', 'd'].map((n) => makeUser(db, `r${n}`)));
    await makeRead(db, users[0]!.id, work, { rating: '5.0' });
    await makeRead(db, users[1]!.id, work, { rating: '4.5' });
    await makeRead(db, users[2]!.id, work, { rating: '0.5' });
    await makeRead(db, users[3]!.id, work, { rating: null });

    const res = await get(`/works/${work}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.description).toBe('Ged, a boy with power.');
    expect(body.authors).toEqual([{ id: le, name: 'Ursula K. Le Guin' }]);
    expect(body.series).toEqual([{ id: s!.id, name: 'Earthsea Cycle', position: 1 }]);
    expect(body.rating_distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 0, 5: 2 });
  });

  it('a book with none of that says so rather than borrowing another book’s', async () => {
    const work = await makeWork(db, 'Untitled Draft');
    const body = (await get(`/works/${work}`)).json();
    expect(body.description).toBeNull();
    expect(body.authors).toEqual([]);
    expect(body.series).toEqual([]);
    expect(body.rating_distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });
});

describe('GET /authors/:id (SL-43)', () => {
  it('lists works credited to the author, most logged first, whatever their titles', async () => {
    const ishiguro = await author('Kazuo Ishiguro', ['カズオ・イシグロ']);
    const remains = await makeWork(db, 'The Remains of the Day');
    const klara = await makeWork(db, 'Klara and the Sun');
    const other = await makeWork(db, 'Ishiguro: a critical study');  // a title search found this
    await db.execute(sql`UPDATE works SET ol_log_count = 900 WHERE id = ${remains}`);
    await db.execute(sql`UPDATE works SET ol_log_count = 1200 WHERE id = ${klara}`);
    await credit(remains, ishiguro);
    await credit(klara, ishiguro);
    void other;

    const res = await get(`/authors/${ishiguro}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('Kazuo Ishiguro');
    expect(body.alternate_names).toEqual(['カズオ・イシグロ']);
    expect(body.works.map((w: { title: string }) => w.title)).toEqual(['Klara and the Sun', 'The Remains of the Day']);
    expect(body.works_count).toBe(2);
    expect(body.bio).toBeNull();
  });

  it('leaves out merged, provisional and (for a filtered viewer) explicit works', async () => {
    const a = await author('A. Writer');
    const live = await makeWork(db, 'Live');
    const merged = await makeWork(db, 'Merged away');
    const provisional = await makeWork(db, 'Provisional');
    const explicit = await makeWork(db, 'Explicit');
    await db.execute(sql`UPDATE works SET merged_into_id = ${live} WHERE id = ${merged}`);
    await db.execute(sql`UPDATE works SET is_provisional = true WHERE id = ${provisional}`);
    await db.execute(sql`UPDATE works SET maturity = 'explicit' WHERE id = ${explicit}`);
    for (const w of [live, merged, provisional, explicit]) await credit(w, a);

    const body = (await get(`/authors/${a}`)).json();
    expect(body.works.map((w: { title: string }) => w.title)).toEqual(['Live']);
    expect(body.works_count).toBe(1);
  });

  it('carries the viewer’s status and finished count; a guest gets neither', async () => {
    const a = await author('A. Writer');
    const one = await makeWork(db, 'One');
    const two = await makeWork(db, 'Two');
    await credit(one, a);
    await credit(two, a);
    await makeRead(db, alice.id, one, { status: 'finished' });

    const mine = (await get(`/authors/${a}`, alice)).json();
    expect(mine.read_count).toBe(1);
    expect(mine.works.find((w: { id: string }) => w.id === one).your_read.status).toBe('finished');
    const guest = (await get(`/authors/${a}`)).json();
    expect(guest.read_count).toBe(0);
    expect(guest.works.every((w: { your_read?: unknown }) => w.your_read === undefined)).toBe(true);
  });

  it('pages with limit and offset; an unknown id is a 404', async () => {
    const a = await author('Prolific');
    for (let i = 0; i < 5; i++) await credit(await makeWork(db, `Book ${i}`), a);
    const page = (await get(`/authors/${a}?limit=2&offset=2`)).json();
    expect(page.works).toHaveLength(2);
    expect(page.works_count).toBe(5);
    expect((await get('/authors/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('GET /series/:id (SL-43)', () => {
  it('lists the series in reading order with the viewer’s progress', async () => {
    const [s] = await db.execute<{ id: string }>(sql`INSERT INTO series (name) VALUES ('The Locked Tomb') RETURNING id`);
    const books = [['Harrow the Ninth', 2], ['Gideon the Ninth', 1], ['Nona the Ninth', 3]] as const;
    const ids: Record<string, string> = {};
    for (const [title, position] of books) {
      ids[title] = await makeWork(db, title);
      await db.execute(sql`INSERT INTO series_entries (series_id, work_id, position) VALUES (${s!.id}, ${ids[title]!}, ${position})`);
    }
    await makeRead(db, alice.id, ids['Gideon the Ninth']!, { status: 'finished' });
    await makeRead(db, alice.id, ids['Harrow the Ninth']!, { status: 'reading' });

    const body = (await get(`/series/${s!.id}`, alice)).json();
    expect(body.name).toBe('The Locked Tomb');
    expect(body.entries.map((e: { title: string; your_status: string | null }) => [e.title, e.your_status])).toEqual([
      ['Gideon the Ninth', 'finished'], ['Harrow the Ninth', 'reading'], ['Nona the Ninth', null],
    ]);
    expect(body.read_books).toBe(1);
    expect((await get('/series/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});
