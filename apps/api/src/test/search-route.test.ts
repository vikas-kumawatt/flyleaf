// GET /v1/search through the real app (audit 02; Part 01 lead L-06: no test
// sent an HTTP request to this route). search.test.ts covers SEARCH_SQL; this
// file covers what sits around it: the viewer-dependent maturity rule, the
// query-string contract, hostile input reaching the driver, and gap-fill's
// behaviour when Open Library is slow.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { GapFillService } from '../catalog/gapfill.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { CircuitBreaker, OutboundClient, TokenBucket } from '../platform/outbound.js';
import { MemoryCache, PgRateLimiter, TRIGRAM_THRESHOLD, makeDb, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { makeRead, makeUser, type TestUser } from './interaction-fixtures.js';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let adultOptedIn: TestUser;
let adultDefault: TestUser;
let minorOptedIn: TestUser;

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();

  await db.execute(sql`
    INSERT INTO works (title, log_count, maturity) VALUES
      ('Velvet Nights', 900, 'explicit'),
      ('Velvet Revolution', 10, 'mature'),
      ('Velvet Hour', 5, 'unclassified'),
      ('Velvet Morning', 3, 'general')`);

  adultOptedIn = await makeUser(db, 'adult_optin');
  adultDefault = await makeUser(db, 'adult_default');
  minorOptedIn = await makeUser(db, 'minor_optin');
  await db.execute(sql`UPDATE profiles SET show_explicit = true
                       WHERE user_id IN (${adultOptedIn.id}, ${minorOptedIn.id})`);
  // Fifteen years old today. The setting is only reachable by 18+ accounts
  // (§7.8), but a row that says otherwise must not be trusted on its own.
  await db.execute(sql`UPDATE users SET date_of_birth = (current_date - interval '15 years')::date
                       WHERE id = ${minorOptedIn.id}`);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await close?.();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });
const titlesOf = (body: string) => (JSON.parse(body).data as { title: string }[]).map((w) => w.title);

describe('maturity (PRD §7.8 [LOCKED], §4.2)', () => {
  it('hides explicit works from a guest', async () => {
    const res = await get('/v1/search?q=velvet');
    expect(res.statusCode).toBe(200);
    expect(titlesOf(res.body)).not.toContain('Velvet Nights');
    expect(titlesOf(res.body)).toEqual(expect.arrayContaining(['Velvet Revolution', 'Velvet Hour', 'Velvet Morning']));
  });

  it('hides them from an adult who has not opted in', async () => {
    const res = await get('/v1/search?q=velvet', adultDefault.auth);
    expect(titlesOf(res.body)).not.toContain('Velvet Nights');
  });

  it('shows them to an adult who opted in', async () => {
    const res = await get('/v1/search?q=velvet', adultOptedIn.auth);
    expect(titlesOf(res.body)).toContain('Velvet Nights');
  });

  it('hides them from an under-18 account even when the flag is set', async () => {
    const res = await get('/v1/search?q=velvet', minorOptedIn.auth);
    expect(titlesOf(res.body)).not.toContain('Velvet Nights');
  });
});

// Audit 02c: decision 4 (02b) made the scan answer 403 for a filtered viewer.
// That broke PRD §7.8 [LOCKED] ("a user is never blocked from recording a book
// they actually read"), so it was reverted deliberately: the scan ALWAYS
// resolves and says whether the client must show the interstitial. Search
// results, an exact ISBN typed into search included, keep the filter.
describe('exact ISBN and maturity (PRD §7.8; audit 02c)', () => {
  const EXPLICIT_ISBN = '9780140328721';
  const SHARED_ISBN = '9780441013593';
  const UNKNOWN_ISBN = '9780804429573';

  beforeAll(async () => {
    // A shared ISBN: the explicit work is the more-logged one, so ISBN_ORDER
    // alone would pick it. A filtered viewer must get the allowed one.
    await db.execute(sql`
      INSERT INTO works (title, log_count, maturity) VALUES
        ('Scarlet Ledger', 5000, 'explicit'),
        ('Scarlet Ledger (Student Edition)', 1, 'general')`);
    await db.execute(sql`
      INSERT INTO editions (work_id, isbn_13, format)
      SELECT id, ${EXPLICIT_ISBN}, 'paperback' FROM works WHERE title = 'Velvet Nights'
      UNION ALL
      SELECT id, ${SHARED_ISBN}, 'paperback' FROM works WHERE title LIKE 'Scarlet Ledger%'`);
  });

  const scan = (isbn: string, headers?: Record<string, string>) => get(`/v1/editions/isbn/${isbn}`, headers);

  it.each([
    ['a guest', () => undefined],
    ['an adult who has not opted in', () => adultDefault.auth],
    ['an under-18 account with the flag set', () => minorOptedIn.auth],
  ])('the scan resolves an explicit work for %s, with its maturity and the interstitial flag', async (_who, auth) => {
    const res = await scan(EXPLICIT_ISBN, auth());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.work.title).toBe('Velvet Nights');
    expect(body.maturity).toBe('explicit');
    expect(body.content_warning).toBe(true);
  });

  it('no interstitial for an adult who opted in', async () => {
    const res = await scan(EXPLICIT_ISBN, adultOptedIn.auth);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.work.title).toBe('Velvet Nights');
    expect(body.maturity).toBe('explicit');
    expect(body.content_warning).toBe(false);
  });

  it('a filtered adult can log the book the scan opened', async () => {
    const opened = JSON.parse((await scan(EXPLICIT_ISBN, adultDefault.auth)).body);
    const res = await app.inject({
      method: 'POST', url: '/v1/reads', headers: adultDefault.auth,
      payload: { work_id: opened.work.id, status: 'finished' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).work_id).toBe(opened.work.id);
  });

  it('an unknown ISBN is a 404', async () => {
    const res = await scan(UNKNOWN_ISBN);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('not_found');
  });

  it('search does not surface it for a filtered viewer, and puts it first for an opted-in adult', async () => {
    for (const auth of [undefined, adultDefault.auth, minorOptedIn.auth]) {
      const res = await get(`/v1/search?q=${EXPLICIT_ISBN}`, auth);
      expect(res.statusCode).toBe(200);
      expect(titlesOf(res.body)).not.toContain('Velvet Nights');
    }
    const res = await get(`/v1/search?q=${EXPLICIT_ISBN}`, adultOptedIn.auth);
    expect(titlesOf(res.body)[0]).toBe('Velvet Nights');
  });

  it('a shared ISBN resolves to the allowed work for a filtered viewer, on both paths', async () => {
    const guestScan = JSON.parse((await scan(SHARED_ISBN)).body);
    expect(guestScan.work.title).toBe('Scarlet Ledger (Student Edition)');
    expect(guestScan.maturity).toBe('general');
    expect(guestScan.content_warning).toBe(false);
    expect(titlesOf((await get(`/v1/search?q=${SHARED_ISBN}`)).body)[0]).toBe('Scarlet Ledger (Student Edition)');

    const adultScan = JSON.parse((await scan(SHARED_ISBN, adultOptedIn.auth)).body);
    expect(adultScan.work.title).toBe('Scarlet Ledger');
    expect(adultScan.content_warning).toBe(false);
    expect(titlesOf((await get(`/v1/search?q=${SHARED_ISBN}`, adultOptedIn.auth)).body)[0]).toBe('Scarlet Ledger');
  });
});

// AC-7: "each result shows ... my status if any".
describe('your_read on search results (AC-7)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('carries the viewer\'s latest attempt on the rows they have read, and nothing on the rest', async () => {
    const reader = await makeUser(db, 'status_reader');
    const [morning] = await db.execute<{ id: string }>(sql`SELECT id FROM works WHERE title = 'Velvet Morning'`);
    const [hour] = await db.execute<{ id: string }>(sql`SELECT id FROM works WHERE title = 'Velvet Hour'`);
    const first = await makeRead(db, reader.id, morning!.id, { status: 'finished', attemptNo: 1, rating: '4.5' });
    const reread = await makeRead(db, reader.id, morning!.id, { status: 'reading', attemptNo: 2 });
    await db.execute(sql`INSERT INTO progress_events (read_id, page, at, client_event_id) VALUES
      (${reread}, 12, now() - interval '1 day', gen_random_uuid()), (${reread}, 42, now(), gen_random_uuid())`);
    await makeRead(db, reader.id, hour!.id, { status: 'want' });

    const rows = JSON.parse((await get('/v1/search?q=velvet', reader.auth)).body).data as
      { title: string; your_read?: { id: string; status: string; page: number | null } }[];
    const by = new Map(rows.map((r) => [r.title, r.your_read]));
    expect(by.get('Velvet Morning')).toMatchObject({ id: reread, status: 'reading', page: 42 });
    expect(by.get('Velvet Morning')!.id).not.toBe(first);
    expect(by.get('Velvet Hour')).toMatchObject({ status: 'want', page: null });
    expect(by.get('Velvet Revolution')).toBeUndefined();

    // Someone else's reads never show, and a guest has none.
    const other = JSON.parse((await get('/v1/search?q=velvet', adultDefault.auth)).body).data;
    expect(other.every((r: { your_read?: unknown }) => r.your_read === undefined)).toBe(true);
    const guest = JSON.parse((await get('/v1/search?q=velvet')).body).data;
    expect(guest.every((r: { your_read?: unknown }) => r.your_read === undefined)).toBe(true);
  });

  it('costs one query for the whole page, not one per row', async () => {
    const reader = await makeUser(db, 'status_counter');
    const ids = await db.execute<{ id: string }>(sql`SELECT id FROM works WHERE title LIKE 'Velvet %' AND maturity <> 'explicit'`);
    for (const { id } of ids) await makeRead(db, reader.id, id, { status: 'want' });

    const catalog = new CatalogService(db, new MemoryCache());
    const spy = vi.spyOn(db, 'execute');
    const rows = await catalog.search(reader.id, 'velvet');
    expect(rows.filter((r) => r.your_read)).toHaveLength(ids.length);
    // #allowsExplicit + #yourReads. SEARCH_SQL itself goes through $client.
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockClear();
    await catalog.search(null, 'velvet');
    expect(spy).toHaveBeenCalledTimes(0);
  });
});

describe('query string', () => {
  it('honours limit', async () => {
    const res = await get('/v1/search?q=velvet&limit=2');
    expect(res.statusCode).toBe(200);
    expect(titlesOf(res.body)).toHaveLength(2);
  });

  it.each(['0', '-1', '101', 'abc', '2.5'])('rejects limit=%s with 422', async (limit) => {
    const res = await get(`/v1/search?q=velvet&limit=${limit}`);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe('invalid_field');
  });

  it.each(['', '%20%20%20', 'a', '!!!', '%00', 'a%00b', '%F0%9F%93%9A'])(
    'answers q=%s with 200 and an empty list, never an error', async (q) => {
      const res = await get(`/v1/search?q=${q}`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ data: [] });
    });

  it('answers a missing q with 200 and an empty list', async () => {
    const res = await get('/v1/search');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ data: [] });
  });

  it('survives a 5,000-character query', async () => {
    const res = await get(`/v1/search?q=${'velvet%20'.repeat(700)}`);
    expect(res.statusCode).toBe(200);
  });

  it('does not 500 on a repeated q', async () => {
    const res = await get('/v1/search?q=velvet&q=hour');
    expect(res.statusCode).toBeLessThan(500);
  });
});

// FN-32 on the request path: a miss must be bounded by the outbound timeout
// and must stop costing anything once the breaker has opened.
describe('gap-fill when Open Library is down', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('bounds a miss by the 2.5 s timeout, then short-circuits on the open breaker', async () => {
    // Hangs until aborted, like a server that accepted the connection and
    // never answered.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }));

    const client = new OutboundClient(new TokenBucket(3, 5), new CircuitBreaker(1, 60_000), 'flyleaf-test');
    const catalog = new CatalogService(db, new MemoryCache(), new GapFillService(db, client));

    let t = performance.now();
    expect(await catalog.search(null, 'zzqx nothing matches this')).toEqual([]);
    const first = performance.now() - t;
    expect(first).toBeGreaterThanOrEqual(2_400);
    expect(first).toBeLessThan(4_000);

    t = performance.now();
    expect(await catalog.search(null, 'zzqx nothing matches this either')).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('never waits for a limiter token on the request path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const empty = new TokenBucket(0.001, 1);
    empty.tryAcquire(); // drained
    const client = new OutboundClient(empty, new CircuitBreaker(5, 60_000), 'flyleaf-test');
    const catalog = new CatalogService(db, new MemoryCache(), new GapFillService(db, client));

    const t = performance.now();
    expect(await catalog.search(null, 'zzqx still nothing')).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The DATABASE-level setting from migrate.ts is lost by a restore or a
// recreate. Checked against real Postgres (audit 02, A-02-009): a plain
// connection to a database without it reports the parameter as unrecognised;
// a makeDb() connection reports 0.45.
describe('trigram threshold', () => {
  it('is sent on every pooled connection, not left to ALTER DATABASE', async () => {
    const pool = makeDb('postgres://nobody@127.0.0.1:1/none', { max: 1 });
    const options = (pool.$client as unknown as { options: { connection: Record<string, string> } }).options;
    expect(options.connection['pg_trgm.similarity_threshold']).toBe(String(TRIGRAM_THRESHOLD));
    await pool.$client.end();
  });
});
