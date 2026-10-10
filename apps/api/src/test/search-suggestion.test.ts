// Audit 10 (A-02-024, routed from Part 02): PRD §14.7 step 1 and AC-7. A
// search with no results offers a spelling suggestion, and the miss is
// logged as search_zero_results{query}. "tolkein" is the required case: the
// search itself still misses it (word similarity 0.50 < the typo arms' 0.6).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { authors, events, workAuthors, works } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser } from './interaction-fixtures.js';
import { QUEUES, refreshSearchSuggestionsJobHandler } from '../jobs/index.js';

let db: Db;
let client: { close: () => Promise<void> };
let app: FastifyInstance;

async function work(title: string, author: string, logCount: number, maturity: 'general' | 'explicit' = 'general') {
  const [w] = await db.insert(works).values({ title, maturity }).returning({ id: works.id });
  // log_count is ol_log_count + readers, kept by trigger (A-02-013).
  await db.execute(sql`UPDATE works SET ol_log_count = ${logCount} WHERE id = ${w!.id}`);
  const [a] = await db.insert(authors).values({ name: author }).returning({ id: authors.id });
  await db.insert(workAuthors).values({ workId: w!.id, authorId: a!.id, position: 0 });
}

beforeAll(async () => {
  ({ db, client } = await freshDrizzle());
  await work('The Hobbit', 'J.R.R. Tolkien', 5000);
  await work('The Silmarillion', 'Christopher Tolkien', 300);
  // Closer to "tolkein" by word similarity (0.625), but obscure.
  await work('What Einstein Told His Cook', 'Robert L. Wolke', 35);
  await work('Never Let Me Go', 'Kazuo Ishiguro', 4000);
  // Explicit and below the popularity floor: never suggested.
  await work('Tolkein Nights', 'Anon', 900, 'explicit');
  await work('Rare Pamphlet', 'Nobody', 3);
  await db.execute(sql`SELECT refresh_search_suggestions()`);
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await client.close();
});

const search = (q: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/v1/search?q=${encodeURIComponent(q)}`, headers });

describe('zero-result search (PRD §14.7, AC-7)', () => {
  it('"tolkein" finds nothing, and suggests J.R.R. Tolkien (the popular near miss, not the closest obscure one)', async () => {
    const res = await search('tolkein');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], suggestion: 'J.R.R. Tolkien' });
  });

  it('a search with results carries no suggestion', async () => {
    const res = await search('hobbit');
    expect(res.json().data.length).toBeGreaterThan(0);
    expect(res.json().suggestion).toBeNull();
  });

  it('nothing close: no suggestion', async () => {
    expect((await search('zzqqxxv')).json()).toEqual({ data: [], suggestion: null });
  });

  it('logs search_zero_results{query} never linked to the viewer (PRD §23.5), and nothing for a hit', async () => {
    await db.delete(events);
    const u = await makeUser(db, 'zero_searcher');
    await search('tolkein', u.auth);
    await search('zzqqxxv');
    await search('hobbit');
    const rows = await db.select().from(events);
    // D-10-3 (Audit 15): each row also carries `searcher`, a keyed hash under
    // this week's salt, which is deleted once the week's summary is written.
    // It is never the account id or anything derived from it without the salt.
    const searchers = rows.map((r) => (r.properties as { searcher?: string }).searcher);
    for (const k of searchers) {
      expect(k).toMatch(/^[0-9a-f]{32}$/);
      expect(k).not.toContain(u.id.replace(/-/g, '').slice(0, 12));
    }
    expect(rows.map((r) => [r.name, { query: (r.properties as { query: string }).query }, r.userId]).sort()).toEqual(
      [
        ['search_zero_results', { query: 'tolkein' }, null],
        ['search_zero_results', { query: 'zzqqxxv' }, null],
      ].sort(),
    );
    expect(rows.map((r) => Object.keys(r.properties as object).sort())).toEqual([['query', 'searcher'], ['query', 'searcher']]);
  });

  it('the vocabulary keeps only popular, non-explicit works and their authors', async () => {
    const terms = (await db.execute<{ term: string }>(sql`SELECT term FROM search_suggestions ORDER BY term`)).map((r) => r.term);
    expect(terms).toContain('J.R.R. Tolkien');
    expect(terms).not.toContain('Tolkein Nights');
    expect(terms).not.toContain('Rare Pamphlet');
    expect(terms).not.toContain('Anon');
  });
});

describe('search.suggestions.refresh (weekly)', () => {
  it('picks up a work that became popular, and the worker schedules it', async () => {
    await work('Piranesi', 'Susanna Clarke', 400);
    const has = async () => (await db.execute(sql`SELECT 1 FROM search_suggestions WHERE term = 'Susanna Clarke'`)).length === 1;
    expect(await has()).toBe(false);
    const result = await refreshSearchSuggestionsJobHandler([{ id: '1', name: QUEUES.refreshSearchSuggestions, data: undefined }] as never, db);
    expect(result.terms).toBeGreaterThan(0);
    expect(await has()).toBe(true);
    const fs = await import('node:fs');
    const worker = fs.readFileSync(new URL('../worker.ts', import.meta.url), 'utf8');
    expect(worker).toMatch(/boss\.schedule\(QUEUES\.refreshSearchSuggestions,/);
  });
});
