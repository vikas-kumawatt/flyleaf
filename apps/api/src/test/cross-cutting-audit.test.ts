// Audit 15a (§3, §4): batch jobs work in bounded key ranges, every soft delete
// and log has an end, the has_works repair, the zero-result summary (D-10-3),
// and the telemetry route mounted where the app calls it (A-15-001). Each test
// names its finding in docs/audit/findings/15-cross-cutting.md.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import type { Db } from '../platform/index.js';
import {
  QUEUES,
  reconcileFollowsJobHandler,
  reconcileReadsJobHandler,
  reconcileShelvesJobHandler,
  reconcileWorksJobHandler,
  repairAuthorsJobHandler,
} from '../jobs/index.js';
import { walkRanges } from '../jobs/ranges.js';
import { retentionSweep, searcherKey, summariseZeroResults, weekOf, SUMMARY_MIN_SEARCHERS } from '../jobs/retention.js';
import { CatalogService } from '../catalog/index.js';
import { MemoryCache } from '../platform/index.js';
import { MemoryObjectStorage } from '../providers/index.js';
import { freshDrizzle } from './pg.js';
import { follow, makeRead, makeUser, makeWork, type TestUser } from './interaction-fixtures.js';

let db: Db;
let seq = 0;
const name = (p: string) => `${p}${++seq}`.slice(0, 20);
const user = (p: string) => makeUser(db, name(p));
const one = async <T,>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0]!;

beforeAll(async () => {
  ({ db } = await freshDrizzle());
}, 60_000);

describe('A-03-026: the nightly reconciles walk key ranges and repair the same drift', () => {
  it('walkRanges covers every key once, in order, even when one key holds more rows than a batch', async () => {
    const u = await user('wr');
    const hot = await makeWork(db, 'Hot');
    for (let i = 0; i < 5; i++) await makeRead(db, (await user(`wr${i}`)).id, hot);
    for (let i = 0; i < 4; i++) await makeRead(db, u.id, await makeWork(db, `W${i}`));
    const seen: string[] = [];
    const ranges = await walkRanges(db, { table: 'reads', column: 'work_id' }, 2, async (lo, hi) => {
      const rows = await db.execute<{ work_id: string }>(sql`
        SELECT work_id::text FROM reads WHERE work_id >= ${lo}::uuid AND (${hi}::uuid IS NULL OR work_id < ${hi}::uuid)`);
      seen.push(...rows.map((r) => r.work_id));
    });
    const all = (await db.execute<{ work_id: string }>(sql`SELECT work_id::text FROM reads`)).map((r) => r.work_id);
    expect(seen.sort()).toEqual(all.sort());
    expect(ranges).toBeGreaterThan(2);
  });

  it('read, follow, shelf and work counters: drift repaired range by range; the whole-table function then finds nothing', async () => {
    const a = await user('rc');
    const b = await user('rd');
    const c = await user('re');
    await follow(db, a.id, b.id);
    await follow(db, c.id, b.id);
    const w = await makeWork(db, 'Counted');
    const r1 = await makeRead(db, a.id, w, { rating: '4.0' });
    await makeRead(db, b.id, w, { rating: '2.0' });
    await db.execute(sql`INSERT INTO read_likes (read_id, user_id) VALUES (${r1}::uuid, ${b.id}::uuid)`);
    const shelf = await one<{ id: string }>(sql`INSERT INTO shelves (user_id, name, slug) VALUES (${a.id}::uuid, 'S', ${name('s')}) RETURNING id`);
    await db.execute(sql`INSERT INTO shelf_items (shelf_id, work_id, position) VALUES (${shelf.id}::uuid, ${w}::uuid, 1)`);

    // Drift everything the triggers maintain.
    await db.execute(sql`UPDATE reads SET like_count = 7 WHERE id = ${r1}::uuid`);
    await db.execute(sql`UPDATE profiles SET follower_count = 99, following_count = 5 WHERE user_id = ${b.id}::uuid`);
    await db.execute(sql`UPDATE shelves SET item_count = 40 WHERE id = ${shelf.id}::uuid`);
    await db.execute(sql`UPDATE work_stats SET rating_count = 9, rating_sum = 1 WHERE work_id = ${w}::uuid`);
    await db.execute(sql`UPDATE works SET reader_count = 11 WHERE id = ${w}::uuid`);

    const reads = await reconcileReadsJobHandler([], db, { batch: 1 });
    const follows = await reconcileFollowsJobHandler([], db, { batch: 1 });
    const shelves = await reconcileShelvesJobHandler([], db, { batch: 1 });
    const works = await reconcileWorksJobHandler([], db, { batch: 1 });
    expect(reads.corrected).toBeGreaterThanOrEqual(1);
    expect(follows.corrected).toBeGreaterThanOrEqual(1);
    expect(shelves.corrected).toBeGreaterThanOrEqual(1);
    expect(works.workStats).toBeGreaterThanOrEqual(1);
    expect(works.readerCount).toBeGreaterThanOrEqual(1);
    for (const r of [reads, follows, works]) expect(r.ranges).toBeGreaterThan(1);

    expect(await one<{ like_count: number }>(sql`SELECT like_count FROM reads WHERE id = ${r1}::uuid`)).toMatchObject({ like_count: 1 });
    expect(await one<{ f: number; g: number }>(sql`SELECT follower_count AS f, following_count AS g FROM profiles WHERE user_id = ${b.id}::uuid`)).toMatchObject({ f: 2, g: 0 });
    expect(await one<{ n: number }>(sql`SELECT item_count AS n FROM shelves WHERE id = ${shelf.id}::uuid`)).toMatchObject({ n: 1 });
    expect(await one<{ n: number; rc: number }>(sql`
      SELECT ws.rating_count AS n, w.reader_count AS rc FROM work_stats ws JOIN works w ON w.id = ws.work_id WHERE ws.work_id = ${w}::uuid`)).toMatchObject({ n: 2, rc: 2 });

    // The batched walk leaves nothing for the whole-table versions to fix.
    expect(await one<{ n: number }>(sql`SELECT reconcile_read_counters() AS n`)).toMatchObject({ n: 0 });
    expect(await one<{ n: number }>(sql`SELECT reconcile_follow_counters() AS n`)).toMatchObject({ n: 0 });
    expect(await one<{ n: number }>(sql`SELECT reconcile_shelf_counters() AS n`)).toMatchObject({ n: 0 });
    const whole = await one<{ r: { work_stats: number; reader_count: number } }>(sql`SELECT reconcile_work_counters() AS r`);
    expect(whole.r).toMatchObject({ work_stats: 0, reader_count: 0 });
    // And the catalog mean they share is the same.
    expect(works.catalogMean).toBeCloseTo(3.0, 5);
  });

  it('every batch process connects with its own work_mem and statement_timeout', () => {
    const worker = fs.readFileSync(new URL('../worker.ts', import.meta.url), 'utf8');
    expect(worker).toMatch(/makeDb\(config\.databaseUrl, \{ max: 4, settings: JOB_DB_SETTINGS\.worker \}\)/);
    expect(worker).toMatch(/settings: JOB_DB_SETTINGS\.dedupe/);
    for (const [file, profile] of [['../dedupe.ts', 'dedupe'], ['../ingest.ts', 'ingest'], ['../devdb.ts', 'ingest']] as const) {
      expect(fs.readFileSync(new URL(file, import.meta.url), 'utf8')).toContain(`JOB_DB_SETTINGS.${profile}`);
    }
  });

  it('a finished ingest pass ANALYZEs every table the writer loads (A-06-013 hand-over)', async () => {
    const { TABLES_LOADED } = await import('../catalog/ingest/writer.js');
    const writer = fs.readFileSync(new URL('../catalog/ingest/writer.ts', import.meta.url), 'utf8');
    const written = new Set([...writer.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]!));
    const analyzed = new Set<string>(Object.values(TABLES_LOADED).flat());
    expect([...written].filter((t) => !analyzed.has(t))).toEqual([]);
    const ingest = fs.readFileSync(new URL('../ingest.ts', import.meta.url), 'utf8');
    expect(ingest).toMatch(/if \(status === 'done'\) \{\s*for \(const t of TABLES_LOADED\[args\.type\]\)/);
  });
});

describe('§4: authors.has_works is repaired nightly', () => {
  it('flags an author an ingest left unflagged, clears one whose works were all merged away, and reports both', async () => {
    const missed = await one<{ id: string }>(sql`INSERT INTO authors (name) VALUES ('Missed Author') RETURNING id`);
    const w1 = await makeWork(db, 'Credited');
    // As the ingest writes it: the has_works trigger bypassed (0020).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('flyleaf.bulk_load', 'on', true)`);
      await tx.execute(sql`INSERT INTO work_authors (work_id, author_id) VALUES (${w1}::uuid, ${missed.id}::uuid)`);
    });
    expect(await one<{ h: boolean }>(sql`SELECT has_works AS h FROM authors WHERE id = ${missed.id}::uuid`)).toMatchObject({ h: false });

    const gone = await one<{ id: string }>(sql`INSERT INTO authors (name) VALUES ('Merged Away') RETURNING id`);
    const survivor = await makeWork(db, 'Survivor');
    const loser = await makeWork(db, 'Loser');
    await db.execute(sql`INSERT INTO work_authors (work_id, author_id) VALUES (${loser}::uuid, ${gone.id}::uuid)`);
    expect(await one<{ h: boolean }>(sql`SELECT has_works AS h FROM authors WHERE id = ${gone.id}::uuid`)).toMatchObject({ h: true });
    await db.execute(sql`UPDATE works SET merged_into_id = ${survivor}::uuid WHERE id = ${loser}::uuid`);

    const result = await repairAuthorsJobHandler([], db, { batch: 1 });
    expect(result).toMatchObject({ set: 1, cleared: 1 });
    expect(result.ranges).toBeGreaterThan(1);
    expect(await one<{ h: boolean }>(sql`SELECT has_works AS h FROM authors WHERE id = ${missed.id}::uuid`)).toMatchObject({ h: true });
    expect(await one<{ h: boolean }>(sql`SELECT has_works AS h FROM authors WHERE id = ${gone.id}::uuid`)).toMatchObject({ h: false });
    // A second night finds nothing.
    expect(await repairAuthorsJobHandler([], db)).toMatchObject({ set: 0, cleared: 0 });
  });
});

describe('§4: retention, every soft delete and log has an end', () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

  it('deletes ended rate-limit buckets, events past 13 months, zero-result queries past 30 days; keeps the rest', async () => {
    await db.execute(sql`INSERT INTO rate_limits (bucket, count, window_start, expires_at) VALUES
      ('t:ended', 3, now() - interval '2 hours', now() - interval '1 hour'),
      ('t:live', 3, now(), now() + interval '1 hour'),
      ('t:legacy-old', 1, now() - interval '40 days', NULL),
      ('t:legacy-new', 1, now() - interval '2 days', NULL)`);
    await db.execute(sql`INSERT INTO events (name, properties, at) VALUES
      ('app_opened', '{}', ${daysAgo(400)}::timestamptz),
      ('app_opened', '{}', ${daysAgo(300)}::timestamptz),
      ('search_zero_results', '{"query":"old"}', ${daysAgo(31)}::timestamptz),
      ('search_zero_results', '{"query":"new"}', ${daysAgo(29)}::timestamptz)`);
    const r = await retentionSweep(db, null, { batch: 1 });
    const buckets = (await db.execute<{ bucket: string }>(sql`SELECT bucket FROM rate_limits WHERE bucket LIKE 't:%' ORDER BY bucket`)).map((x) => x.bucket);
    expect(buckets).toEqual(['t:legacy-new', 't:live']);
    expect(r.rateLimits).toBeGreaterThanOrEqual(2);
    const left = await db.execute<{ name: string; q: string | null }>(sql`SELECT name, properties->>'query' AS q FROM events ORDER BY at`);
    expect(left.map((e) => `${e.name}:${e.q ?? ''}`)).toEqual(['app_opened:', 'search_zero_results:new']);
  });

  it('purges shelves, reviews and comments 30 days after deletion, not before', async () => {
    const u = await user('pg');
    const w = await makeWork(db, 'Purged');
    const readId = await makeRead(db, u.id, w);
    const oldShelf = await one<{ id: string }>(sql`INSERT INTO shelves (user_id, name, slug, deleted_at) VALUES (${u.id}::uuid, 'Old', ${name('o')}, ${daysAgo(31)}::timestamptz) RETURNING id`);
    const newShelf = await one<{ id: string }>(sql`INSERT INTO shelves (user_id, name, slug, deleted_at) VALUES (${u.id}::uuid, 'New', ${name('n')}, ${daysAgo(29)}::timestamptz) RETURNING id`);
    await db.execute(sql`INSERT INTO shelf_items (shelf_id, work_id, position) VALUES (${oldShelf.id}::uuid, ${w}::uuid, 1)`);
    const rev = await one<{ id: string }>(sql`INSERT INTO reviews (read_id, user_id, work_id, body, deleted_at) VALUES (${readId}::uuid, ${u.id}::uuid, ${w}::uuid, 'gone', ${daysAgo(31)}::timestamptz) RETURNING id`);
    const c1 = await one<{ id: string }>(sql`INSERT INTO read_comments (read_id, user_id, body, deleted_at) VALUES (${readId}::uuid, ${u.id}::uuid, 'old', ${daysAgo(31)}::timestamptz) RETURNING id`);
    const c2 = await one<{ id: string }>(sql`INSERT INTO read_comments (read_id, user_id, body, deleted_at) VALUES (${readId}::uuid, ${u.id}::uuid, 'recent', ${daysAgo(2)}::timestamptz) RETURNING id`);
    const c3 = await one<{ id: string }>(sql`INSERT INTO read_comments (read_id, user_id, body) VALUES (${readId}::uuid, ${u.id}::uuid, 'live') RETURNING id`);
    await retentionSweep(db, null);
    const ids = async (table: 'shelves' | 'reviews' | 'read_comments', list: string[]) =>
      (await db.execute<{ id: string }>(sql`SELECT id::text FROM ${sql.raw(table)} WHERE id = ANY (${`{${list.join(',')}}`}::uuid[])`)).map((r) => r.id).sort();
    expect(await ids('shelves', [oldShelf.id, newShelf.id])).toEqual([newShelf.id]);
    expect(await ids('reviews', [rev.id])).toEqual([]);
    expect(await ids('read_comments', [c1.id, c2.id, c3.id])).toEqual([c2.id, c3.id].sort());
    // The purged shelf's items and slug claim went with it.
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM shelf_items WHERE shelf_id = ${oldShelf.id}::uuid`)).toMatchObject({ n: 0 });
  });

  it('hard-deletes an account 30 days after deletion, its stored objects first; orphan mutes go too', async () => {
    const storage = new MemoryObjectStorage();
    const gone = await user('hd');
    const recent = await user('hr');
    const muter = await user('hm');
    const key = `uploads/${gone.id}/${randomUUID()}`;
    await storage.put(key, 'file', 'text/csv');
    await db.execute(sql`INSERT INTO uploads (user_id, purpose, key, content_type, size, max_bytes, status, expires_at)
      VALUES (${gone.id}::uuid, 'import', ${key}, 'text/csv', 4, 100, 'consumed', now())`);
    await db.execute(sql`INSERT INTO mutes (user_id, target_type, target_id) VALUES (${muter.id}::uuid, 'user', ${gone.id}::uuid)`);
    await db.execute(sql`UPDATE users SET deleted_at = ${daysAgo(31)}::timestamptz WHERE id = ${gone.id}::uuid`);
    await db.execute(sql`UPDATE users SET deleted_at = ${daysAgo(5)}::timestamptz WHERE id = ${recent.id}::uuid`);

    // Without storage (the object cannot be deleted), the account waits.
    expect((await retentionSweep(db, null)).accounts).toBe(0);
    const r = await retentionSweep(db, storage);
    expect(r).toMatchObject({ accounts: 1, accountObjects: 1, orphanMutes: 1 });
    expect(await storage.head(key)).toBeNull();
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM users WHERE id = ${gone.id}::uuid`)).toMatchObject({ n: 0 });
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM users WHERE id = ${recent.id}::uuid`)).toMatchObject({ n: 1 });
  });

  it('a committed import row keeps only what identifies the book once the import is 30 days old; rows to review keep everything', async () => {
    const u = await user('ir');
    const imp = await one<{ id: string }>(sql`
      INSERT INTO imports (user_id, source, state, finished_at) VALUES (${u.id}::uuid, 'goodreads', 'completed', ${daysAgo(31)}::timestamptz) RETURNING id`);
    const fresh = await one<{ id: string }>(sql`
      INSERT INTO imports (user_id, source, state, finished_at) VALUES (${u.id}::uuid, 'goodreads', 'completed', ${daysAgo(3)}::timestamptz) RETURNING id`);
    const line = { Title: 'Piranesi', Author: 'Susanna Clarke', ISBN13: '9781526622426', 'My Review': 'Private thoughts', 'Date Read': '2024/01/02' };
    await db.execute(sql`INSERT INTO import_rows (import_id, row_no, raw, state) VALUES
      (${imp.id}::uuid, 1, ${JSON.stringify(line)}::jsonb, 'matched'),
      (${imp.id}::uuid, 2, ${JSON.stringify(line)}::jsonb, 'unmatched'),
      (${fresh.id}::uuid, 1, ${JSON.stringify(line)}::jsonb, 'matched')`);
    const r = await retentionSweep(db, null);
    expect(r.importRowsTrimmed).toBe(1);
    const rows = await db.execute<{ import_id: string; row_no: number; raw: Record<string, string> }>(sql`
      SELECT import_id::text, row_no, raw FROM import_rows WHERE import_id IN (${imp.id}::uuid, ${fresh.id}::uuid) ORDER BY import_id, row_no`);
    const byKey = new Map(rows.map((x) => [`${x.import_id}:${x.row_no}`, x.raw]));
    expect(byKey.get(`${imp.id}:1`)).toEqual({ Title: 'Piranesi', Author: 'Susanna Clarke', ISBN13: '9781526622426' });
    expect(byKey.get(`${imp.id}:2`)).toEqual(line);
    expect(byKey.get(`${fresh.id}:1`)).toEqual(line);
  });

  it('deletes a replaced avatar\'s object that the replace failed to delete, a day later', async () => {
    const storage = new MemoryObjectStorage();
    const u = await user('av');
    const oldKey = `uploads/${u.id}/${randomUUID()}`;
    const curKey = `uploads/${u.id}/${randomUUID()}`;
    for (const k of [oldKey, curKey]) {
      await storage.put(k, 'img', 'image/png');
      await db.execute(sql`INSERT INTO uploads (user_id, purpose, key, content_type, size, max_bytes, status, expires_at, consumed_at)
        VALUES (${u.id}::uuid, 'avatar', ${k}, 'image/png', 3, 100, 'consumed', now(), now() - interval '2 days')`);
    }
    await db.execute(sql`UPDATE profiles SET avatar_key = ${curKey} WHERE user_id = ${u.id}::uuid`);
    const r = await retentionSweep(db, storage);
    expect(r.avatarObjects).toBe(1);
    expect(await storage.head(oldKey)).toBeNull();
    expect(await storage.head(curKey)).not.toBeNull();
  });

  it('the worker schedules the repair, the sweep and the summary', () => {
    const worker = fs.readFileSync(new URL('../worker.ts', import.meta.url), 'utf8');
    for (const q of ['repairAuthors', 'retentionSweep', 'summariseZeroResults']) {
      expect(worker).toMatch(new RegExp(`boss\\.schedule\\(QUEUES\\.${q},`));
    }
    expect([QUEUES.repairAuthors, QUEUES.retentionSweep, QUEUES.summariseZeroResults]).toEqual(['authors.repair', 'retention.sweep', 'search.zero.summary']);
  });
});

describe('D-10-3: the zero-result summary', () => {
  it('a zero-result search stores a weekly searcher key, never the account, session or IP', async () => {
    const catalog = new CatalogService(db, new MemoryCache());
    const viewer = await user('zs');
    const session = randomUUID();
    await catalog.searchPage(viewer.id, 'zzqqxx nothing', 20, `account:${viewer.id}`);
    await catalog.searchPage(null, 'zzqqxx nothing', 20, `session:${session}`);
    const evs = await db.execute<{ user_id: string | null; properties: Record<string, string> }>(sql`
      SELECT user_id, properties FROM events WHERE name = 'search_zero_results' AND properties->>'query' = 'zzqqxx nothing'`);
    expect(evs).toHaveLength(2);
    for (const e of evs) {
      expect(e.user_id).toBeNull();
      expect(e.properties.searcher).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(e.properties)).not.toContain(viewer.id);
      expect(JSON.stringify(e.properties)).not.toContain(session);
    }
    expect(evs[0]!.properties.searcher).not.toBe(evs[1]!.properties.searcher);
    // The same searcher in the same week gets the same key.
    const again = await searcherKey(db, `account:${viewer.id}`);
    expect(evs.map((e) => e.properties.searcher)).toContain(again.key);
  });

  it('keeps a query\'s text only past 5 distinct searchers, counts the rest, and deletes the week\'s salt with it', async () => {
    await db.execute(sql`DELETE FROM events WHERE name = 'search_zero_results'`);
    const lastWeek = new Date(Date.now() - 7 * 86_400_000);
    const week = weekOf(lastWeek);
    const insert = async (query: string, who: string) => {
      const { key } = await searcherKey(db, who, lastWeek);
      await db.execute(sql`INSERT INTO events (name, properties, at)
        VALUES ('search_zero_results', ${JSON.stringify({ query, searcher: key })}::jsonb, ${week}::date + interval '1 day')`);
    };
    for (let i = 0; i < SUMMARY_MIN_SEARCHERS; i++) await insert('Wolf Hall Sequel', `session:${i}`);
    await insert('wolf hall sequel', 'session:0'); // same searcher, other case: one more search, not one more searcher
    for (let i = 0; i < SUMMARY_MIN_SEARCHERS - 1; i++) await insert('my secret diary title', `account:${i}`);
    await insert('another rare one', 'ip:1');

    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM search_week_salts WHERE week = ${week}::date`)).toMatchObject({ n: 1 });
    const res = await summariseZeroResults(db);
    expect(res.weeks).toContain(week);
    const rows = await db.execute<{ query: string | null; searches: number; distinct_searchers: number }>(sql`
      SELECT query, searches, distinct_searchers FROM search_zero_summaries WHERE week = ${week}::date ORDER BY query NULLS LAST`);
    expect(rows).toEqual([
      { query: 'wolf hall sequel', searches: 6, distinct_searchers: 5 },
      { query: null, searches: 5, distinct_searchers: 5 },
    ]);
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM search_week_salts WHERE week = ${week}::date`)).toMatchObject({ n: 0 });
    // Nothing of the rare queries survives in the summary.
    expect(JSON.stringify(rows)).not.toContain('secret');
    // A second run has no salt for that week and writes nothing.
    expect((await summariseZeroResults(db)).rows).toBe(0);
  });
});

describe('§4: every server-rendered HTML page escapes what it shows and sends a CSP', () => {
  it('admin login, both shelf share pages and both emailed-link pages', async () => {
    const { IdentityService } = await import('../identity/index.js');
    const { PgRateLimiter } = await import('../platform/index.js');
    const app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), storage: new MemoryObjectStorage() });
    const owner = await user('html');
    const evil = '<script>alert(1)</script>';
    const shelf = await one<{ id: string; slug: string }>(sql`
      INSERT INTO shelves (user_id, name, slug, description, privacy) VALUES (${owner.id}::uuid, ${`Mine ${evil}`}, ${name('h')}, ${evil}, 'public') RETURNING id, slug`);
    const pages = [
      '/admin/login',
      `/shelf/${shelf.id}`,
      `/u/${owner.username}/shelves/${shelf.slug}`,
      `/verify-email?token=${encodeURIComponent(`abc"${evil}`)}`,
      `/reset-password?token=${encodeURIComponent(`abc"${evil}`)}`,
    ];
    for (const url of pages) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-type'], url).toMatch(/^text\/html/);
      const csp = String(res.headers['content-security-policy'] ?? '');
      expect(csp, url).toContain("default-src 'none'");
      expect(csp, url).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(res.body, url).not.toContain(evil);
      expect(res.body, url).not.toMatch(/\son[a-z]+=/i); // no inline handlers
    }
    await app.close();
  });
});

describe('A-15-001: telemetry is served where the app sends it', () => {
  it('POST /v1/events and GET /v1/admin/telemetry/budgets exist on the real app; the old root paths do not', async () => {
    const app = await buildApp({ db, storage: new MemoryObjectStorage() });
    const ev = await app.inject({ method: 'POST', url: '/v1/events', payload: { events: [{ name: 'app_opened', session_id: randomUUID(), at: new Date().toISOString(), properties: {} }] } });
    expect(ev.statusCode).toBe(202);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/telemetry/budgets' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/events', payload: { events: [] } })).statusCode).toBe(404);
    await app.close();
  });
});

// Fixture type use, so a refactor of the helpers is caught by the compiler here too.
export type _U = TestUser;

describe('§4: every write the offline queue sends is safe to replay (Part 07\'s table, re-run)', () => {
  it('each queued action sent twice leaves one state and one activity row, and the second answer is one the queue treats as done', async () => {
    const { ReadingService } = await import('../reading/index.js');
    const { IdentityService } = await import('../identity/index.js');
    const { PgRateLimiter } = await import('../platform/index.js');
    const app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), reading: new ReadingService(db) });
    await app.ready();
    try {
      const reader = await user('replay');
      const other = await user('replayo');
      const twice = async (method: 'POST' | 'DELETE', url: string, payload?: object, as = reader) => {
        const a = await app.inject({ method, url, headers: as.auth, payload });
        const b = await app.inject({ method, url, headers: as.auth, payload });
        return [a.statusCode, b.statusCode];
      };
      const verbs = async (id: string) => (await db.execute<{ verb: string }>(
        sql`SELECT verb FROM activity WHERE actor_id = ${id} ORDER BY created_at, verb`)).map((r) => r.verb);

      // upsert_read
      const w1 = await makeWork(db, name('Replay one'));
      expect((await twice('POST', '/v1/reads', { work_id: w1, status: 'reading' })).every((s) => s < 300)).toBe(true);
      const reads1 = await db.execute<{ id: string }>(sql`SELECT id FROM reads WHERE user_id = ${reader.id} AND work_id = ${w1}`);
      expect(reads1.length).toBe(1);
      const r1 = reads1[0]!.id;
      // add_progress
      const event = { client_event_id: randomUUID(), page: 40 };
      expect(await twice('POST', `/v1/reads/${r1}/progress`, event)).toEqual([expect.any(Number), 200]);
      expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM progress_events WHERE read_id = ${r1}`)).n).toBe(1);
      // finish_read
      const today = new Date().toISOString().slice(0, 10);
      expect(await twice('POST', `/v1/reads/${r1}/finish`, { finished_at: today })).toEqual([200, 200]);
      // save_review
      expect((await twice('POST', `/v1/reads/${r1}/review`, { body: 'A replayed review.' })).every((s) => s < 300)).toBe(true);
      expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM reviews WHERE read_id = ${r1} AND deleted_at IS NULL`)).n).toBe(1);
      // dnf_read on a second book
      const w2 = await makeWork(db, name('Replay two'));
      const r2 = (await app.inject({ method: 'POST', url: '/v1/reads', headers: reader.auth, payload: { work_id: w2, status: 'reading' } })).json().id;
      expect(await twice('POST', `/v1/reads/${r2}/dnf`, { abandoned_page: 10 })).toEqual([200, 200]);
      expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM reads WHERE user_id = ${reader.id} AND work_id = ${w2}`)).n).toBe(1);
      // set_like and set_follow, by another reader
      expect((await twice('POST', `/v1/reads/${r1}/like`, undefined, other)).every((s) => s < 300)).toBe(true);
      expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM read_likes WHERE read_id = ${r1}`)).n).toBe(1);
      expect((await twice('POST', `/v1/users/${reader.id}/follow`, undefined, other)).every((s) => s < 300)).toBe(true);
      expect((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM follows WHERE follower_id = ${other.id}`)).n).toBe(1);
      expect(await verbs(other.id)).toEqual(['followed']);
      // Activity: one per state change, however many times each was sent.
      expect((await verbs(reader.id)).sort()).toEqual(['dnf', 'finished', 'reviewed', 'started', 'started'].sort());
      // delete_read: the replay is 404, which the queue treats as done.
      expect(await twice('DELETE', `/v1/reads/${r2}`)).toEqual([expect.any(Number), 404]);
    } finally {
      await app.close();
    }
  });
});
