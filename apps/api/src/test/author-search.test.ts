// GET /search/authors: the Authors tab of search. Before it existed the app's
// Authors tab showed the book results again.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';

import { MemoryCache, PgRateLimiter, type Db } from '../platform/index.js';
import { ReadingService } from '../reading/index.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { buildApp } from '../app.js';
import { freshDrizzle } from './pg.js';
import { authors } from '../db/schema.js';
import { makeWork } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let client: { close: () => Promise<void> };

const ids: Record<string, string> = {};

async function author(name: string, alternate: string[] = []) {
  const [a] = await db.insert(authors).values({ name, alternateNames: alternate }).returning({ id: authors.id });
  return (ids[name] = a!.id);
}
async function book(title: string, authorId: string, opts: { logs?: number; maturity?: string } = {}) {
  const w = await makeWork(db, title);
  await db.execute(sql`UPDATE works SET ol_log_count = ${opts.logs ?? 0}, maturity = ${opts.maturity ?? 'general'} WHERE id = ${w}`);
  await db.execute(sql`INSERT INTO work_authors (work_id, author_id, role, position) VALUES (${w}, ${authorId}, 'author', 0)`);
  return w;
}

beforeAll(async () => {
  ({ db, client } = await freshDrizzle());
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();

  const rowling = await author('J. K. Rowling');
  await book("Harry Potter and the Philosopher's Stone", rowling, { logs: 900 });
  await book('Harry Potter and the Chamber of Secrets', rowling, { logs: 700 });
  // Matches "harr" in the middle of the name, and is logged less.
  await book('A Dog Called Harr', await author('Ellen Harrington'), { logs: 5 });
  // Starts with the query: ranks above a mid-name match however popular that is.
  await book('Stories', await author('Harriet Beecher Stowe'), { logs: 1 });
  // Exact name: first of all.
  await book('Small', await author('Harri'), { logs: 0 });
  // An alias (0003): found by it, shown by its name.
  await book('Norwegian Wood', await author('村上春樹', ['Haruki Murakami']), { logs: 1351 });
  // Credited on nothing: not offered.
  await author('Harrison Uncredited');
  // Explicit works only: hidden from a guest, like the books they wrote.
  await book('Adults Only', await author('Harrowing Explicit'), { maturity: 'explicit' });
}, 60_000);

afterAll(async () => { await app?.close(); await client?.close(); });

const search = async (q: string, limit?: number) => {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/search/authors?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
  });
  return { status: res.statusCode, data: res.json().data as { id: string; name: string; works_count: number }[] };
};

describe('GET /search/authors', () => {
  it('is guest readable and ranks exact, then starts-with, then most logged', async () => {
    const { status, data } = await search('harri');
    expect(status).toBe(200);
    expect(data.map((a) => a.name)).toEqual(['Harri', 'Harriet Beecher Stowe', 'Ellen Harrington']);
  });

  it('counts the works a viewer may see, and leaves out uncredited and explicit-only authors', async () => {
    const { data } = await search('harr');
    expect(data.find((a) => a.name === 'J. K. Rowling')).toBeUndefined();
    expect(data.map((a) => a.name)).not.toContain('Harrison Uncredited');
    expect(data.map((a) => a.name)).not.toContain('Harrowing Explicit');
    const rowling = (await search('rowling')).data;
    expect(rowling).toEqual([{ id: ids['J. K. Rowling'], name: 'J. K. Rowling', works_count: 2 }]);
  });

  it('matches case-insensitively and through an alias', async () => {
    expect((await search('ROWLING')).data.map((a) => a.name)).toEqual(['J. K. Rowling']);
    expect((await search('murakami')).data.map((a) => a.name)).toEqual(['村上春樹']);
  });

  it('two characters match the start of a name or of a word in it', async () => {
    const names = (await search('st')).data.map((a) => a.name);
    expect(names).toContain('Harriet Beecher Stowe');
  });

  it('under two characters returns nothing; limit caps the page; % is literal', async () => {
    expect((await search('h')).data).toEqual([]);
    expect((await search('harr', 1)).data).toHaveLength(1);
    expect((await search('%%')).data).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/search/authors?q=ha&limit=51' })).statusCode).toBe(422);
  });
});
