// PV-07: the CatalogSource contract. Open Library is the only adapter today;
// a second one runs the same cases by adding a harness.
//
// The Open Library adapter runs against a fake of openlibrary.org serving
// real records (fixtures/ol-records.json, the same ones the ingest tests
// use), through a real OutboundClient. No network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, OutboundClient, TokenBucket } from '../platform/outbound.js';
import { OpenLibrarySource, type CatalogSource } from '../providers/catalog/index.js';

type OlRecord = { key: string; json: Record<string, unknown> };
const RECORDS: OlRecord[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/ol-records.json', import.meta.url)), 'utf8'),
);
const byKey = new Map(RECORDS.map((r) => [r.key, r.json]));

const SEARCH = {
  docs: [
    { key: '/works/OL45804W', title: 'Fantastic Mr Fox', first_publish_year: 1970, cover_i: 8739161,
      author_key: ['OL34184A'], author_name: ['Roald Dahl'], edition_count: 84 },
    { key: '/works/OL1W', title: 'No author, dropped' },
  ],
};

/** openlibrary.org, as far as the adapter uses it. */
function fakeOpenLibrary(opts: { down?: boolean } = {}) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (async (input: string) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (opts.down) return new Response('unavailable', { status: 503 });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (url.pathname === '/search.json') return json(SEARCH);
    const isbn = /^\/isbn\/([0-9X]+)\.json$/.exec(url.pathname)?.[1];
    if (isbn) {
      const edition = RECORDS.find((r) =>
        [...((r.json.isbn_13 as string[]) ?? []), ...((r.json.isbn_10 as string[]) ?? [])].includes(isbn));
      // openlibrary.org redirects /isbn/… to /books/…; fetch follows it.
      return edition ? json(edition.json) : new Response('not found', { status: 404 });
    }
    const record = byKey.get(url.pathname.replace(/\.json$/, ''));
    return record ? json(record) : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch);
  return urls;
}

const client = () => new OutboundClient(new TokenBucket(100, 100), new CircuitBreaker(), 'Flyleaf/test');

const ADAPTERS: { name: string; make: (opts?: { down?: boolean }) => { source: CatalogSource; calls: string[] } }[] = [
  {
    name: 'openlibrary (fake openlibrary.org)',
    make: (opts) => ({ calls: fakeOpenLibrary(opts), source: new OpenLibrarySource(client()) }),
  },
];

afterEach(() => vi.unstubAllGlobals());

for (const adapter of ADAPTERS) {
  describe(`CatalogSource contract: ${adapter.name}`, () => {
    it('search returns storable works only (title and author), with full author keys', async () => {
      const { source } = adapter.make();
      const works = await source.search('fantastic mr fox', 10);
      expect(works).toEqual([
        {
          olWorkKey: '/works/OL45804W',
          title: 'Fantastic Mr Fox',
          firstPublishYear: 1970,
          coverId: 8739161,
          authorKeys: ['/authors/OL34184A'],
          authorNames: ['Roald Dahl'],
          editionCount: 84,
        },
      ]);
    });

    it('search with under 3 characters asks nothing', async () => {
      const { source, calls } = adapter.make();
      expect(await source.search('ab', 10)).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('looks an edition up by ISBN-13, ISBN-10 or a hyphenated ISBN, as the ingest would store it', async () => {
      const { source } = adapter.make();
      for (const isbn of ['9780140328721', '0140328726', '978-0-14-032872-1']) {
        const edition = await source.lookupIsbn(isbn);
        expect(edition, isbn).toMatchObject({
          olEditionKey: '/books/OL7353617M',
          workKey: '/works/OL45804W',
          isbn13: '9780140328721',
          isbn10: '0140328726',
        });
      }
    });

    it('an invalid ISBN is null without a request; an unknown one is null', async () => {
      const { source, calls } = adapter.make();
      expect(await source.lookupIsbn('12345')).toBeNull();
      expect(await source.lookupIsbn('9780140328722')).toBeNull(); // bad check digit
      expect(calls).toHaveLength(0);
      expect(await source.lookupIsbn('9780306406157')).toBeNull(); // valid, not in the catalog
    });

    it('looks a work and an author up by full or bare key', async () => {
      const { source } = adapter.make();
      for (const key of ['/works/OL45804W', 'OL45804W']) {
        expect(await source.lookupWork(key), key).toMatchObject({
          olWorkKey: '/works/OL45804W',
          title: 'Fantastic Mr Fox',
          authorKeys: expect.arrayContaining(['/authors/OL34184A']),
        });
      }
      expect(await source.lookupAuthor('OL34184A')).toMatchObject({ olAuthorKey: '/authors/OL34184A', name: 'Roald Dahl' });
    });

    it('a malformed key is null without a request (no path injection)', async () => {
      const { source, calls } = adapter.make();
      expect(await source.lookupWork('../authors/OL34184A')).toBeNull();
      expect(await source.lookupWork('OL45804W?x=1')).toBeNull();
      expect(await source.lookupAuthor('/works/OL45804W')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it('never throws when the source is down: empty results', async () => {
      const { source } = adapter.make({ down: true });
      expect(await source.search('fantastic mr fox', 10)).toEqual([]);
      expect(await source.lookupIsbn('9780140328721')).toBeNull();
      expect(await source.lookupWork('OL45804W')).toBeNull();
      expect(await source.lookupAuthor('OL34184A')).toBeNull();
    });

    it('builds cover URLs in the three sizes', () => {
      const { source } = adapter.make();
      expect(source.coverUrl(8739161, 'M')).toBe('https://covers.openlibrary.org/b/id/8739161-M.jpg');
      expect(source.coverUrl(8739161, 'S')).toMatch(/-S\.jpg$/);
      expect(source.coverUrl(8739161, 'L')).toMatch(/-L\.jpg$/);
    });
  });
}

describe('openlibrary specifics', () => {
  it('every request goes through the shared limiter: a drained bucket means no request', async () => {
    const calls = fakeOpenLibrary();
    const drained = new TokenBucket(0.001, 1);
    drained.tryAcquire();
    const source = new OpenLibrarySource(new OutboundClient(drained, new CircuitBreaker(), 'Flyleaf/test'));
    expect(await source.search('fantastic mr fox', 10)).toEqual([]);
    expect(await source.lookupWork('OL45804W')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
