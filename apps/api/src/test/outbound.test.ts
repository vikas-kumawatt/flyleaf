// Outbound limiter, circuit breaker and gap-fill (FN-30, FN-31, FN-32).
//
// No network. `fetch` is stubbed, because the interesting cases are the ones
// you cannot summon on demand: Open Library returning 503, a request timing
// out, the rate limit being exhausted mid-search.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  CircuitBreaker, OutboundClient, TokenBucket,
} from '../platform/outbound.js';
import { GapFillService, parseOlSearch } from '../catalog/gapfill.js';
import { freshDrizzle } from './pg.js';

describe('TokenBucket', () => {
  it('allows the burst, then refuses', () => {
    const b = new TokenBucket(3, 5);
    expect([1, 2, 3, 4, 5].map(() => b.tryAcquire())).toEqual([true, true, true, true, true]);
    expect(b.tryAcquire()).toBe(false);
  });

  it('refills at the configured rate', async () => {
    const b = new TokenBucket(100, 1);      // 100/s: one token every 10ms
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(b.tryAcquire()).toBe(true);
  });

  it('wait() eventually resolves rather than refusing', async () => {
    const b = new TokenBucket(50, 1);
    await b.wait();
    const started = Date.now();
    await b.wait();                          // must queue, not throw
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});

describe('CircuitBreaker', () => {
  it('opens on the fifth consecutive failure, not the fourth', () => {
    const cb = new CircuitBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) cb.fail();
    expect(cb.allow()).toBe(true);
    cb.fail();
    expect(cb.allow()).toBe(false);
  });

  it('a success resets the count', () => {
    const cb = new CircuitBreaker(5, 60_000);
    for (let i = 0; i < 4; i++) cb.fail();
    cb.succeed();
    for (let i = 0; i < 4; i++) cb.fail();
    expect(cb.allow()).toBe(true);
  });

  it('half-opens after the cooldown and closes on a successful trial', async () => {
    const cb = new CircuitBreaker(2, 20);
    cb.fail(); cb.fail();
    expect(cb.allow()).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(cb.state).toBe('half-open');
    cb.succeed();
    expect(cb.state).toBe('closed');
  });

  it('re-opens immediately when the trial fails, without needing 5 more', async () => {
    const cb = new CircuitBreaker(2, 20);
    cb.fail(); cb.fail();
    await new Promise((r) => setTimeout(r, 30));
    expect(cb.state).toBe('half-open');
    cb.fail();
    expect(cb.allow()).toBe(false);
  });
});

describe('OutboundClient', () => {
  const stub = (impl: typeof fetch) => vi.stubGlobal('fetch', impl);
  afterEach(() => vi.unstubAllGlobals());

  const client = (limiter = new TokenBucket(100, 100), breaker = new CircuitBreaker()) =>
    new OutboundClient(limiter, breaker, 'Flyleaf/test');

  it('sends an identifying User-Agent — it is what buys the higher rate limit', async () => {
    let seen: Record<string, string> = {};
    stub((async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    await client().getJson('https://example.test/x');
    expect(seen['User-Agent']).toBe('Flyleaf/test');
  });

  it('refuses without a token instead of queueing on a request path', async () => {
    const spent = new TokenBucket(1, 1);
    expect(spent.tryAcquire()).toBe(true);
    stub((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch);
    const res = await client(spent).getJson('https://example.test/x');
    expect(res).toEqual({ ok: false, reason: 'limited' });
  });

  it('does not call fetch at all when the circuit is open', async () => {
    const breaker = new CircuitBreaker(1, 60_000);
    breaker.fail();
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    stub(spy as unknown as typeof fetch);

    const res = await client(undefined, breaker).getJson('https://example.test/x');
    expect(res).toEqual({ ok: false, reason: 'open-circuit' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('trips the breaker on 5xx and on 429', async () => {
    for (const status of [500, 503, 429]) {
      const breaker = new CircuitBreaker(1, 60_000);
      stub((async () => new Response('', { status })) as unknown as typeof fetch);
      await client(undefined, breaker).getJson('https://example.test/x');
      expect(breaker.allow(), `status ${status}`).toBe(false);
    }
  });

  it('does NOT trip the breaker on 404 — that is our bug, not their outage', async () => {
    const breaker = new CircuitBreaker(1, 60_000);
    stub((async () => new Response('', { status: 404 })) as unknown as typeof fetch);
    const res = await client(undefined, breaker).getJson('https://example.test/x');
    expect(res).toEqual({ ok: false, reason: 'http' });
    expect(breaker.allow()).toBe(true);
  });

  it('returns a reason instead of throwing when the network fails', async () => {
    stub((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    await expect(client().getJson('https://example.test/x')).resolves.toMatchObject({ ok: false });
  });
});

// The shape Open Library's search.json actually returns.
describe('parseOlSearch', () => {
  it('normalises bare author ids to full paths, so both sources land on one row', () => {
    const [w] = parseOlSearch({
      docs: [{
        key: '/works/OL45804W', title: 'Fantastic Mr Fox', first_publish_year: 1970,
        cover_i: 8739161, author_key: ['OL34184A'], author_name: ['Roald Dahl'], edition_count: 84,
      }],
    });
    expect(w).toMatchObject({
      olWorkKey: '/works/OL45804W',
      authorKeys: ['/authors/OL34184A'],       // was "OL34184A"
      coverId: 8739161,
    });
  });

  it('applies the same filter rule as the dump ingest', () => {
    expect(parseOlSearch({ docs: [{ key: '/works/OL1W', title: 'No Author' }] })).toHaveLength(0);
    expect(parseOlSearch({ docs: [{ key: '/works/OL1W', author_key: ['OL1A'], author_name: ['X'] }] })).toHaveLength(0);
    expect(parseOlSearch({ docs: [{ key: '/authors/OL1A', title: 'Wrong type', author_key: ['OL1A'], author_name: ['X'] }] })).toHaveLength(0);
  });

  it('survives a response with no docs at all', () => {
    expect(parseOlSearch({})).toEqual([]);
    expect(parseOlSearch({ docs: [] })).toEqual([]);
  });

  it('rejects OL\'s -1 cover sentinel', () => {
    const [w] = parseOlSearch({
      docs: [{ key: '/works/OL1W', title: 'T', cover_i: -1, author_key: ['OL1A'], author_name: ['A'] }],
    });
    expect(w!.coverId).toBeNull();
  });
});

describe('GapFillService', () => {
  let db: unknown;
  let service: GapFillService;

  const DOCS = {
    docs: [
      { key: '/works/OL45804W', title: 'Fantastic Mr Fox', first_publish_year: 1970,
        cover_i: 8739161, author_key: ['OL34184A'], author_name: ['Roald Dahl'], edition_count: 84 },
      { key: '/works/OL27448W', title: 'The Lord of the Rings', first_publish_year: 1954,
        cover_i: 9255566, author_key: ['OL26320A'], author_name: ['J. R. R. Tolkien'], edition_count: 120 },
    ],
  };

  let client: PGlite;

  const stubOl = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', (async () =>
      new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);

  const makeService = (db: unknown) => new GapFillService(
    db as never,
    new OutboundClient(new TokenBucket(100, 100), new CircuitBreaker(), 'Flyleaf/test'),
  );

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    client = fresh.client;
    db = fresh.db as never;
  }, 60_000);

  afterAll(async () => { await client?.close(); });
  afterEach(() => vi.unstubAllGlobals());

  const count = async (table: string) =>
    (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  it('returns [] rather than throwing when Open Library is unreachable', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    service = makeService(db);
    await expect(service.search('anything')).resolves.toEqual([]);
  });

  it('does not call out for a one or two character query', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(DOCS), { status: 200 }));
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    service = makeService(db);

    await service.search('ab');
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks only for the fields it stores', async () => {
    let url = '';
    vi.stubGlobal('fetch', (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(DOCS), { status: 200 });
    }) as unknown as typeof fetch);
    service = makeService(db);

    const works = await service.search('fantastic mr fox');
    expect(url).toContain('fields=key,title,first_publish_year,cover_i,author_key,author_name,edition_count');
    expect(works.map((w) => w.title)).toEqual(['Fantastic Mr Fox', 'The Lord of the Rings']);
  });

  // The whole point: a miss becomes a permanent catalog entry.
  it('fills a gap into real rows, with provenance', async () => {
    stubOl(DOCS);
    service = makeService(db);

    expect(await service.fill('fantastic mr fox')).toBe(2);
    expect(await count('works')).toBe(2);
    expect(await count('authors')).toBe(2);
    expect(await count('work_authors')).toBe(2);
    expect(await count('external_ids')).toBe(2);
    expect(await count('field_provenance')).toBe(6);   // 3 fields x 2 works

    const { rows } = await client.query<{ title: string; ol_cover_id: number; maturity: string }>(
      `SELECT title, ol_cover_id, maturity FROM works WHERE ol_work_key = '/works/OL45804W'`);
    expect(rows[0]).toMatchObject({ title: 'Fantastic Mr Fox', ol_cover_id: 8739161 });

    // search.json carries no subjects, so there is nothing to classify on.
    // Guessing 'general' to make the catalog look tidier is precisely the
    // App Store §1.2 mistake.
    expect(rows[0]!.maturity).toBe('unclassified');
  });

  it('is idempotent — filling the same gap twice adds nothing', async () => {
    stubOl(DOCS);
    service = makeService(db);
    const before = [await count('works'), await count('authors'), await count('work_authors')];
    await service.fill('fantastic mr fox');
    expect([await count('works'), await count('authors'), await count('work_authors')]).toEqual(before);
  });

  it('records provenance only as open_library', async () => {
    const { rows } = await client.query<{ provider: string }>(
      `SELECT DISTINCT provider FROM field_provenance`);
    expect(rows.map((r) => r.provider)).toEqual(['open_library']);
  });

  it('stores nothing when Open Library returns an error', async () => {
    stubOl({}, 503);
    service = makeService(db);
    expect(await service.fill('something else entirely')).toBe(0);
  });

  // Open Library's search is fuzzier than ours, so a query returns things we
  // would not have ranked. Those are still worth STORING -- the catalog grows
  // faster than any one result list -- but they are not shown for this query.
  // Storing more than we show is the intended behaviour, not a leak.
  it('stores everything Open Library returned, shows only what matches', async () => {
    const { CatalogService } = await import('../catalog/index.js');
    const { MemoryCache } = await import('../platform/index.js');

    await client.exec('TRUNCATE works CASCADE; TRUNCATE authors CASCADE;');
    stubOl(DOCS);

    const catalog = new CatalogService(
      db as never,
      new MemoryCache(),
      makeService(db),
    );

    const results = await catalog.search('fantastic mr fox');
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe('Fantastic Mr Fox');
    // A real uuid, because the rows were persisted before the list was built.
    expect(results[0]!.id).toHaveLength(36);

    expect(await count('works')).toBe(2);

    // And the one that was stored but not shown is now findable.
    const later = await catalog.search('lord of the rings');
    expect(later[0]!.title).toBe('The Lord of the Rings');
  });

  it('a malformed doc is skipped without losing the good ones', async () => {
    stubOl({ docs: [
      { key: '/works/OLGOODW', title: 'Good', author_key: ['OLAA'], author_name: ['A'] },
      { key: null, title: 'Broken' },
      { title: 'No key at all', author_key: ['OLBB'], author_name: ['B'] },
    ] });
    service = makeService(db);
    expect(await service.fill('mixed')).toBe(1);
  });
});

// The licensing rule, checked at the source level rather than at runtime,
// because the failure it guards against is somebody ADDING a provider later.
describe('licensing', () => {
  it('gap-fill never names a provider the field_provenance CHECK forbids', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = fs.readFileSync(
      fileURLToPath(new URL('../catalog/gapfill.ts', import.meta.url)), 'utf8');

    // Strip comments: the file DISCUSSES google_books at length on purpose.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

    expect(code).not.toContain('google_books');
    expect(code).toContain("'open_library'");
  });
});
