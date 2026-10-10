// Audit 12 (import and export). Every test here pins one finding in
// docs/audit/findings/12-import-export.md; the finding names it.
//
// Runs on the disk storage adapter with its signed URLs (the brief: not only
// memory), through the real routes where a client would go through them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import type { PgBoss } from 'pg-boss';

import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { DiskObjectStorage, readAll } from '../providers/storage/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import {
  editions,
  exports as exportsTable,
  importRows,
  imports,
  progressEvents,
  reads,
  reviews,
  shelfItems,
  shelves,
  users,
  works,
  authors,
  workAuthors,
} from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeRead, makeUser, makeWork, follow, type TestUser } from './interaction-fixtures.js';
import { importCsv, seedImport, uploadFile } from './upload-fixtures.js';
import { processImport } from '../imports/processor.js';
import { parseCsv } from '../imports/parser.js';
import { ExportService, escapeCsvField, formatAsCsv, generateExportData } from '../exports/index.js';

let app: FastifyInstance;
let db: Db;
let client: PGlite;
let storage: DiskObjectStorage;
let mailer: MemoryEmailSender;
let baseDir: string;

async function countStatements<T>(fn: () => Promise<T>): Promise<{ n: number; result: T }> {
  const c = client as unknown as Record<string, any>;
  const orig = { query: c.query, exec: c.exec, transaction: c.transaction };
  let n = 0;
  const wrapQ = (target: any, name: 'query' | 'exec') => {
    const f = target[name];
    return (...args: unknown[]) => { n++; return f.apply(target, args); };
  };
  c.query = wrapQ(client, 'query');
  c.exec = wrapQ(client, 'exec');
  c.transaction = (cb: (tx: any) => unknown) =>
    orig.transaction.call(client, (tx: any) => {
      const tq = tx.query; const te = tx.exec;
      tx.query = (...a: unknown[]) => { n++; return tq.apply(tx, a); };
      tx.exec = (...a: unknown[]) => { n++; return te.apply(tx, a); };
      return cb(tx);
    });
  try {
    const result = await fn();
    return { n, result };
  } finally {
    c.query = orig.query; c.exec = orig.exec; c.transaction = orig.transaction;
  }
}

/** A valid ISBN-13 (the matcher checks the check digit). */
function withCheck13(d12: string): string {
  const t = [...d12].reduce((acc, c, i) => acc + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
  return d12 + String((10 - (t % 10)) % 10);
}

let seq = 0;
const uniq = (p: string) => `${p}${++seq}`;

async function work(title: string, opts: { author?: string; isbn13?: string; isbn10?: string; olKey?: string } = {}) {
  const [w] = await db.insert(works).values({ title, olWorkKey: opts.olKey ?? null }).returning({ id: works.id });
  if (opts.author) {
    const [a] = await db.insert(authors).values({ name: opts.author }).returning({ id: authors.id });
    await db.insert(workAuthors).values({ workId: w!.id, authorId: a!.id, position: 0 });
  }
  let editionId: string | null = null;
  if (opts.isbn13 || opts.isbn10) {
    const [e] = await db
      .insert(editions)
      .values({ workId: w!.id, isbn13: opts.isbn13 ?? null, isbn10: opts.isbn10 ?? null })
      .returning({ id: editions.id });
    editionId = e!.id;
  }
  return { id: w!.id, editionId };
}

const GR_HEADER =
  'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies';

/** One Goodreads row, Goodreads quoting (ISBNs as ="…"). */
function grRow(r: {
  id?: string; title: string; author?: string; isbn?: string; isbn13?: string; rating?: string;
  dateRead?: string; dateAdded?: string; shelves?: string; shelf?: string; review?: string; spoiler?: string;
}): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [
    r.id ?? String(1000 + ++seq), q(r.title), q(r.author ?? ''), '', '',
    `="${r.isbn ?? ''}"`, `="${r.isbn13 ?? ''}"`, r.rating ?? '0', '4.00', '', 'Paperback', '300', '2000', '2000',
    r.dateRead ?? '', r.dateAdded ?? '2020/01/01', q(r.shelves ?? ''), '', r.shelf ?? 'read', q(r.review ?? ''), r.spoiler ?? '', '', '1', '0',
  ].join(',');
}
const gr = (...rows: string[]) => [GR_HEADER, ...rows].join('\n') + '\n';

/** Upload, create, process; returns the import row. */
async function runImport(u: TestUser, csv: string | Buffer, opts: { source?: string; force?: boolean } = {}) {
  const res = await importCsv(app, u.auth, csv, opts);
  if (res.statusCode !== 201) throw new Error(`POST /v1/imports ${res.statusCode} ${res.body}`);
  const id = res.json().id as string;
  await processImport(db, storage, id).catch(() => undefined);
  const [row] = await db.select().from(imports).where(eq(imports.id, id));
  return row!;
}

async function readsOf(userId: string, workId?: string) {
  return db
    .select()
    .from(reads)
    .where(workId ? and(eq(reads.userId, userId), eq(reads.workId, workId)) : eq(reads.userId, userId));
}

async function rowsOf(importId: string) {
  return db.select().from(importRows).where(eq(importRows.importId, importId)).orderBy(importRows.rowNo);
}

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  client = fresh.client;
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-audit12-'));
  storage = new DiskObjectStorage({ publicUrl: 'http://localhost', baseDir });
  mailer = new MemoryEmailSender();
  const identity = new IdentityService(db, new PgRateLimiter(db));
  app = await buildApp({ db, identity, storage, mailer });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await client?.close();
  if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
describe('IM-03 parsing: encodings and malformed files (A-12-004, A-12-005, A-12-006, A-12-008)', () => {
  it('decodes a Windows-1252 export instead of mangling é, ü and ’', () => {
    const text = 'Title,Author\nLes Misérables,Victor Hugo\nDer Zauberberg – Überarbeitet,Thomas Mann\nThe Handmaid’s Tale,Margaret Atwood\n';
    // Encode as Windows-1252 by hand: é=E9, Ü=DC, ’=92, –=96.
    const map: Record<string, number> = { 'é': 0xe9, 'Ü': 0xdc, '’': 0x92, '–': 0x96 };
    const bytes = Buffer.from([...text].map((ch) => map[ch] ?? ch.charCodeAt(0)));
    const parsed = parseCsv(bytes);
    expect(parsed.rows.map((r) => r.data.Title)).toEqual([
      'Les Misérables',
      'Der Zauberberg – Überarbeitet',
      'The Handmaid’s Tale',
    ]);
  });

  it('decodes UTF-16 with a BOM (Excel "Unicode text")', () => {
    const text = 'Title,Author\r\nLes Misérables,Victor Hugo\r\n';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(parseCsv(le).rows[0]!.data).toEqual({ Title: 'Les Misérables', Author: 'Victor Hugo' });
    const be = Buffer.from(le);
    be.swap16();
    expect(parseCsv(be).rows[0]!.data).toEqual({ Title: 'Les Misérables', Author: 'Victor Hugo' });
  });

  it('a UTF-16 file passes /complete (its NUL bytes are not binary)', async () => {
    const u = await makeUser(db, uniq('u16_'));
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(gr(grRow({ title: 'Utf Sixteen' })), 'utf16le')]);
    const id = await uploadFile(app, u.auth, body);
    expect(id).toMatch(/[0-9a-f-]{36}/);
  });

  it('a UTF-8 BOM before a quoted header still finds the columns', () => {
    const parsed = parseCsv(Buffer.from('﻿"Title","Author"\r\n"Dune","Frank Herbert"', 'utf8'));
    expect(parsed.headers).toEqual(['Title', 'Author']);
    expect(parsed.rows[0]!.data.Title).toBe('Dune');
  });

  it('an unclosed quote spoils one row, not the rest of the file', () => {
    const parsed = parseCsv('Title,Author\nOne,A\n"Two,B\nThree,C\nFour,D\n');
    expect(parsed.rows.map((r) => r.data.Title)).toEqual(['One', '"Two', 'Three', 'Four']);
    expect(parsed.rows[1]!.malformed).toBe(true);
    expect(parsed.rows[2]!.malformed).toBeFalsy();
  });

  it('a broken row in the middle spoils itself and its neighbour, not the rest of the file (PRD §6.8)', async () => {
    const u = await makeUser(db, uniq('mal_'));
    const first = await work('Malformed First Book', { isbn13: '9780000000307' });
    const last = await work('Malformed Last Book', { isbn13: '9780000000314' });
    const csv = gr(
      grRow({ title: 'Malformed First Book', isbn13: '9780000000307' }),
      '1,"Broken row,never closed',
      grRow({ title: 'Swallowed Neighbour' }),
      grRow({ title: 'Malformed Last Book', isbn13: '9780000000314' }),
      grRow({ title: 'After The Damage' }),
    );
    const imp = await runImport(u, csv);
    expect(imp.state).toBe('completed');
    expect(await readsOf(u.id, first.id)).toHaveLength(1);
    expect(await readsOf(u.id, last.id)).toHaveLength(1);
    expect((await rowsOf(imp.id)).map((r) => (r.raw as Record<string, string>).Title)).toContain('After The Damage');
  });

  it('an unclosed quote on the last row is reported as malformed_row', async () => {
    const u = await makeUser(db, uniq('mal_eof_'));
    const w = await work('Before The Broken End', { isbn13: '9780000000321' });
    const imp = await runImport(u, gr(grRow({ title: 'Before The Broken End', isbn13: '9780000000321' })) + '1,"Broken at the end,x\n');
    expect(imp.state).toBe('completed');
    expect(await readsOf(u.id, w.id)).toHaveLength(1);
    expect((await rowsOf(imp.id)).some((r) => r.failureReason === 'malformed_row')).toBe(true);
  });

  it('a file with only a header row fails with a clear error instead of "completed, 0 books"', async () => {
    const u = await makeUser(db, uniq('hdr_'));
    const imp = await runImport(u, GR_HEADER + '\n');
    expect(imp.state).toBe('failed');
    expect(imp.error).toMatch(/no books/i);
  });

  it('an unrecognised file fails and names the columns it found (PRD §34.4)', async () => {
    const u = await makeUser(db, uniq('unk_'));
    const imp = await runImport(u, 'foo,bar\n1,2\n');
    expect(imp.state).toBe('failed');
    expect(imp.error).toContain('foo, bar');
  });

  it('a StoryGraph file declared as Goodreads is read as StoryGraph', async () => {
    const u = await makeUser(db, uniq('sg_'));
    const w = await work('Declared Wrong Book', { author: 'Some Author', isbn13: '9780000000026' });
    const csv =
      'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Star Rating,Review,Tags,Owned?\n' +
      'Declared Wrong Book,Some Author,,9780000000026,print,to-read,2024/01/01,,,0,,,,No\n';
    const imp = await runImport(u, csv, { source: 'goodreads' });
    expect(imp.state).toBe('completed');
    expect(imp.source).toBe('storygraph');
    const [r] = await readsOf(u.id, w.id);
    expect(r?.status).toBe('want');
  });
});

// ---------------------------------------------------------------------------
describe('IM-03 dates (A-12-006, A-12-019)', () => {
  it('an impossible calendar date in one row does not fail the import', async () => {
    const u = await makeUser(db, uniq('feb_'));
    const a = await work('February Thirtieth', { isbn13: '9780000000033' });
    const b = await work('A Normal Date', { isbn13: '9780000000040' });
    const imp = await runImport(u, gr(
      grRow({ title: 'February Thirtieth', isbn13: '9780000000033', dateRead: '2023/02/30' }),
      grRow({ title: 'A Normal Date', isbn13: '9780000000040', dateRead: '2023/03/01' }),
    ));
    expect(imp.state).toBe('completed');
    expect((await readsOf(u.id, a.id))[0]?.finishedAt).toBeNull();
    expect((await readsOf(u.id, b.id))[0]?.finishedAt).toBe('2023-03-01');
  });

  it('a date in the future is dropped, not stored', async () => {
    const u = await makeUser(db, uniq('fut_'));
    const w = await work('Future Finish', { isbn13: '9780000000057' });
    await runImport(u, gr(grRow({ title: 'Future Finish', isbn13: '9780000000057', dateRead: `${new Date().getUTCFullYear() + 1}/01/01` })));
    expect((await readsOf(u.id, w.id))[0]?.finishedAt).toBeNull();
  });

  it("Goodreads' Date Added is when the book was shelved, not when it was started", async () => {
    const u = await makeUser(db, uniq('added_'));
    const want = await work('Shelved Not Started', { isbn13: '9780000000064' });
    const fin = await work('Added Long Before', { isbn13: '9780000000071' });
    await runImport(u, gr(
      grRow({ title: 'Shelved Not Started', isbn13: '9780000000064', shelf: 'to-read', dateAdded: '2019/05/05' }),
      grRow({ title: 'Added Long Before', isbn13: '9780000000071', dateAdded: '2015/01/01', dateRead: '2024/06/01' }),
    ));
    const [w] = await readsOf(u.id, want.id);
    expect(w?.status).toBe('want');
    expect(w?.startedAt).toBeNull();
    const [f] = await readsOf(u.id, fin.id);
    expect(f?.startedAt).not.toBe('2015-01-01');
  });
});

// ---------------------------------------------------------------------------
describe('IM-04 source maps against the real exporters (A-12-007, A-12-008, A-12-009, A-12-011)', () => {
  it('OpenReads: planned is want-to-read, my_review is the review, readings give the dates, deleted rows are skipped', async () => {
    const u = await makeUser(db, uniq('or_'));
    const planned = await work('Planned Book', { isbn13: '9780000000088' });
    const done = await work('Finished Book', { isbn13: '9780000000095' });
    const binned = await work('Binned Book', { isbn13: '9780000000101' });
    const csv = [
      'title,subtitle,author,description,status,favourite,deleted,rating,pages,publication_year,isbn,olid,tags,my_review,notes,book_format,readings,date_added,date_modified',
      'Planned Book,,A,,planned,false,false,,100,2000,9780000000088,,,,,paperback,,2024-01-01T00:00:00.000,2024-01-01T00:00:00.000',
      'Finished Book,,B,,finished,false,false,4.5,100,2000,9780000000095,,,Loved it,,ebook,2024-02-01T00:00:00.000|2024-02-20T00:00:00.000|,2024-01-01T00:00:00.000,2024-01-01T00:00:00.000',
      'Binned Book,,C,,finished,false,true,3.0,100,2000,9780000000101,,,,,,,2024-01-01T00:00:00.000,2024-01-01T00:00:00.000',
    ].join('\n');
    const imp = await runImport(u, csv, { source: 'openreads' });
    expect(imp.state).toBe('completed');
    expect((await readsOf(u.id, planned.id))[0]?.status).toBe('want');
    const [d] = await readsOf(u.id, done.id);
    expect(d).toMatchObject({ status: 'finished', rating: '4.5', startedAt: '2024-02-01', finishedAt: '2024-02-20', formatOverride: 'ebook' });
    const [rv] = await db.select().from(reviews).where(eq(reviews.readId, d!.id));
    expect(rv?.body).toBe('Loved it');
    expect(await readsOf(u.id, binned.id)).toHaveLength(0);
  });

  it('Open Library reading log: Bookshelf, My Ratings and Work ID are read', async () => {
    const u = await makeUser(db, uniq('ol_'));
    const read = await work('Some Unindexed Title', { olKey: 'OL777W' });
    const want = await work('Another Unindexed Title', { olKey: 'OL778W' });
    const csv = [
      'Work ID,Title,Authors,First Publish Year,Edition ID,Edition Count,Bookshelf,My Ratings,Ratings Average,Ratings Count,Has Ebook,Subjects,Subject People,Subject Places,Subject Times',
      'OL777W,Some Unindexed Title,Ann Author | Bob Author,1999,,3,Already Read,4,4.1,10,False,,,,',
      'OL778W,Another Unindexed Title,Cy Author,1999,,1,Want to Read,,,,False,,,,',
    ].join('\n');
    const imp = await runImport(u, csv, { source: 'openlibrary' });
    expect(imp.state).toBe('completed');
    expect((await readsOf(u.id, read.id))[0]).toMatchObject({ status: 'finished', rating: '4.0' });
    expect((await readsOf(u.id, want.id))[0]?.status).toBe('want');
  });

  it("Calibre's comments are the book's blurb: never published as the reader's review; pubdate is not a finish date", async () => {
    const u = await makeUser(db, uniq('cal_'));
    const w = await work('Calibre Book', { isbn13: '9780000000118' });
    const csv =
      '﻿author_sort,authors,comments,id,isbn,pubdate,rating,tags,timestamp,title\n' +
      '"Doe, Jane","Jane Doe","A sweeping saga from the bestselling author.","1","9780000000118","1965-08-01T00:00:00+00:00","4","fiction","2021-03-04T10:00:00+00:00","Calibre Book"\n';
    await runImport(u, csv, { source: 'calibre' });
    const [r] = await readsOf(u.id, w.id);
    expect(r).toBeDefined();
    expect(r!.finishedAt).not.toBe('1965-08-01');
    expect(await db.select().from(reviews).where(eq(reviews.readId, r!.id))).toHaveLength(0);
  });

  it('Goodreads: a review marked Spoiler is imported with the spoiler flag', async () => {
    const u = await makeUser(db, uniq('spoil_'));
    const w = await work('Spoiled Ending', { isbn13: '9780000000125' });
    await runImport(u, gr(grRow({ title: 'Spoiled Ending', isbn13: '9780000000125', rating: '4', review: 'The butler did it.', spoiler: 'true', dateRead: '2024/01/02' })));
    const [r] = await readsOf(u.id, w.id);
    const [rv] = await db.select().from(reviews).where(eq(reviews.readId, r!.id));
    expect(rv?.hasSpoilers).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('IM-05 matching: never guess (A-12-002, A-12-003, A-12-014)', () => {
  it('an ISBN carried by editions of two different works is ambiguous, not the more popular one', async () => {
    const u = await makeUser(db, uniq('isbn2_'));
    const a = await work('Twin Isbn A', { isbn13: '9780000000132' });
    const b = await work('Twin Isbn B');
    await db.insert(editions).values({ workId: b.id, isbn13: '9780000000132' });
    await db.update(works).set({ olLogCount: 50 }).where(eq(works.id, a.id));
    const imp = await runImport(u, gr(grRow({ title: 'Twin Isbn', isbn13: '9780000000132' })));
    const [row] = await rowsOf(imp.id);
    expect(row).toMatchObject({ state: 'unmatched', failureReason: 'ambiguous_match', workId: null });
    expect(await readsOf(u.id)).toHaveLength(0);
  });

  it('ISBN-10 and ISBN-13 of one row pointing at different works is ambiguous', async () => {
    const u = await makeUser(db, uniq('isbn1013_'));
    await work('Ten Side', { isbn10: '000000099X' });
    await work('Thirteen Side', { isbn13: '9780000000149' });
    const imp = await runImport(u, gr(grRow({ title: 'Mixed Isbn', isbn: '000000099X', isbn13: '9780000000149' })));
    const [row] = await rowsOf(imp.id);
    expect(row).toMatchObject({ state: 'unmatched', failureReason: 'ambiguous_match' });
  });

  it('an Open Library work key of a merged work resolves to the survivor', async () => {
    const u = await makeUser(db, uniq('merged_'));
    const survivor = await work('Survivor Of Merge');
    const loser = await work('Loser Of Merge', { olKey: 'OL555W' });
    await db.update(works).set({ mergedIntoId: survivor.id }).where(eq(works.id, loser.id));
    const csv = 'Work ID,Title,Authors,Edition ID,Bookshelf,My Ratings\nOL555W,Zzqx Unfindable Title,Nobody,,Already Read,\n';
    const imp = await runImport(u, csv, { source: 'openlibrary' });
    const [row] = await rowsOf(imp.id);
    expect(row?.workId).toBe(survivor.id);
    expect((await readsOf(u.id, survivor.id)).length).toBe(1);
  });

  it('LIKE metacharacters in an author are literal', async () => {
    const u = await makeUser(db, uniq('like_'));
    await work('Wildcard Collected Poems', { author: 'Joanna Baillie' });
    const imp = await runImport(u, gr(grRow({ title: 'Wildcard Collected Poems', author: '_' })));
    const [row] = await rowsOf(imp.id);
    expect(row?.state).toBe('unmatched');
  });

  it('matching a chunk of rows with ISBNs does not cost an ISBN query per row', async () => {
    const u = await makeUser(db, uniq('batch_'));
    const rows: string[] = [];
    for (let i = 0; i < 40; i++) {
      const isbn = withCheck13(`97810000${String(i).padStart(4, '0')}`);
      await work(`Batch Book ${i}`, { isbn13: isbn });
      rows.push(grRow({ title: `Batch Book ${i}`, isbn13: isbn }));
    }
    const res = await importCsv(app, u.auth, gr(...rows));
    const id = res.json().id as string;
    const { n } = await countStatements(() => processImport(db, storage, id));
    const [imp] = await db.select().from(imports).where(eq(imports.id, id));
    expect(imp?.matched).toBe(40);
    // Before: 208 (an ISBN lookup and ~4 more statements per row). After: 50,
    // one ISBN query per chunk and ~1 statement per committed row.
    expect(n).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------
describe('IM-07 commit: re-imports merge, never duplicate (A-12-001, A-12-006, A-12-010)', () => {
  it('importing the same file again with force creates no second attempt', async () => {
    const u = await makeUser(db, uniq('force_'));
    const w = await work('Forced Twice', { isbn13: '9780000000156' });
    const csv = gr(grRow({ title: 'Forced Twice', isbn13: '9780000000156', rating: '4', dateRead: '2024/01/05' }));
    await runImport(u, csv);
    await runImport(u, csv, { force: true });
    expect(await readsOf(u.id, w.id)).toHaveLength(1);
  });

  it("a book already logged in the app is left as the reader logged it", async () => {
    const u = await makeUser(db, uniq('own_'));
    const w = await work('Already Mine', { isbn13: '9780000000163' });
    await makeRead(db, u.id, w.id, { status: 'reading' });
    const imp = await runImport(u, gr(grRow({ title: 'Already Mine', isbn13: '9780000000163', rating: '2', dateRead: '2020/01/01' })));
    const mine = await readsOf(u.id, w.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'reading', source: 'app' });
    const [row] = await rowsOf(imp.id);
    expect(row).toMatchObject({ workId: w.id, failureReason: 'already_in_library' });
  });

  it('one row the database refuses is recorded and the import goes on', async () => {
    const u = await makeUser(db, uniq('refuse_'));
    const bad = await work('Refused By Database', { isbn13: '9780000000170' });
    const good = await work('Accepted By Database', { isbn13: '9780000000187' });
    await client.exec(`
      CREATE OR REPLACE FUNCTION audit12_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.work_id = '${bad.id}' THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER audit12_refuse BEFORE INSERT ON reads FOR EACH ROW EXECUTE FUNCTION audit12_refuse();`);
    try {
      const imp = await runImport(u, gr(
        grRow({ title: 'Refused By Database', isbn13: '9780000000170' }),
        grRow({ title: 'Accepted By Database', isbn13: '9780000000187' }),
      ));
      expect(imp.state).toBe('completed');
      expect(await readsOf(u.id, good.id)).toHaveLength(1);
      const rows = await rowsOf(imp.id);
      expect(rows[0]).toMatchObject({ state: 'unmatched', failureReason: 'commit_failed' });
    } finally {
      await client.exec('DROP TRIGGER audit12_refuse ON reads; DROP FUNCTION audit12_refuse();');
    }
  });

  it("an import tag reuses the reader's shelf of that name, and never fills a deleted shelf", async () => {
    const u = await makeUser(db, uniq('tags_'));
    const w = await work('Tagged Book', { isbn13: '9780000000194' });
    const [cafe] = await db.insert(shelves).values({ userId: u.id, name: 'Café', slug: 'cafe' }).returning();
    const [gone] = await db.insert(shelves).values({ userId: u.id, name: 'Old Favs', slug: 'old-favs', deletedAt: new Date() }).returning();
    await runImport(u, gr(grRow({ title: 'Tagged Book', isbn13: '9780000000194', shelves: 'café, old-favs' })));
    const items = await db.select().from(shelfItems).where(eq(shelfItems.workId, w.id));
    const ids = items.map((i) => i.shelfId);
    expect(ids).toContain(cafe!.id);
    expect(ids).not.toContain(gone!.id);
    const live = await db.select().from(shelves).where(and(eq(shelves.userId, u.id), sql`deleted_at IS NULL`));
    expect(live.filter((s) => s.name.toLowerCase() === 'café')).toHaveLength(1);
    expect(live.some((s) => s.name === 'old-favs')).toBe(true);
  });

  it('imports never take a reader past 200 shelves (PRD §15.6)', async () => {
    const u = await makeUser(db, uniq('cap_'));
    const w = await work('Capped Book', { isbn13: '9780000000200' });
    await db.insert(shelves).values(Array.from({ length: 200 }, (_, i) => ({ userId: u.id, name: `S${i}`, slug: `s${i}` })));
    const imp = await runImport(u, gr(grRow({ title: 'Capped Book', isbn13: '9780000000200', shelves: 'brand-new-tag' })));
    expect(imp.state).toBe('completed');
    expect(await readsOf(u.id, w.id)).toHaveLength(1);
    const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM shelves WHERE user_id = ${u.id}`)) as any;
    expect(Number(n)).toBe(200);
  });

  it('imports write no activity (IM-07)', async () => {
    const u = await makeUser(db, uniq('act_'));
    await work('Quiet Book', { isbn13: '9780000000217' });
    await runImport(u, gr(grRow({ title: 'Quiet Book', isbn13: '9780000000217', rating: '5', review: 'Great.', shelves: 'quiet' })));
    const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM activity WHERE actor_id = ${u.id}`)) as any;
    expect(Number(n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('IM-09 review queue (A-12-012)', () => {
  async function unmatchedImport(u: TestUser) {
    const imp = await runImport(u, gr(grRow({ title: `Zzqx Nowhere ${seq}`, author: 'Nobody' })));
    const [row] = await rowsOf(imp.id);
    expect(row?.state).toBe('unmatched');
    return { imp, row: row! };
  }
  const resolve = (u: TestUser, id: string, rowNo: number, body: object) =>
    app.inject({ method: 'POST', url: `/v1/imports/${id}/rows/${rowNo}/resolve`, headers: u.auth, payload: body });

  it('resolving to a work that does not exist is 404, not 500', async () => {
    const u = await makeUser(db, uniq('rv404_'));
    const { imp, row } = await unmatchedImport(u);
    const res = await resolve(u, imp.id, row.rowNo, { work_id: crypto.randomUUID() });
    expect(res.statusCode).toBe(404);
  });

  it('resolving to a merged work logs the survivor', async () => {
    const u = await makeUser(db, uniq('rvm_'));
    const survivor = await work('Resolve Survivor');
    const loser = await work('Resolve Loser');
    await db.update(works).set({ mergedIntoId: survivor.id }).where(eq(works.id, loser.id));
    const { imp, row } = await unmatchedImport(u);
    const res = await resolve(u, imp.id, row.rowNo, { work_id: loser.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().work_id).toBe(survivor.id);
    expect(await readsOf(u.id, survivor.id)).toHaveLength(1);
    expect(await readsOf(u.id, loser.id)).toHaveLength(0);
  });

  it('a resolved row cannot be resolved again to another work (no second read)', async () => {
    const u = await makeUser(db, uniq('rv2_'));
    const a = await work('Resolve First');
    const b = await work('Resolve Second');
    const { imp, row } = await unmatchedImport(u);
    expect((await resolve(u, imp.id, row.rowNo, { work_id: a.id })).statusCode).toBe(200);
    expect((await resolve(u, imp.id, row.rowNo, { work_id: a.id })).statusCode).toBe(200);
    const again = await resolve(u, imp.id, row.rowNo, { work_id: b.id });
    expect(again.statusCode).toBe(409);
    expect(await readsOf(u.id)).toHaveLength(1);
  });

  it('a matched row cannot be skipped (its read would stay while the counters say skipped)', async () => {
    const u = await makeUser(db, uniq('skipm_'));
    await work('Matched Then Skipped', { isbn13: '9780000000224' });
    const imp = await runImport(u, gr(grRow({ title: 'Matched Then Skipped', isbn13: '9780000000224' })));
    const res = await app.inject({ method: 'POST', url: `/v1/imports/${imp.id}/rows/1/skip`, headers: u.auth });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('IM-10 export (A-12-015 … A-12-018, A-12-020)', () => {
  it('neutralises spreadsheet formulas in every cell (lead 1)', () => {
    for (const bad of ['=HYPERLINK("http://evil","click")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(escapeCsvField(bad).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(escapeCsvField('Dune')).toBe('Dune');
    expect(escapeCsvField('4.5')).toBe('4.5');
  });

  it('the guarded review comes back unchanged through re-import (round trip)', async () => {
    const alice = await makeUser(db, uniq('rt_a_'));
    const bob = await makeUser(db, uniq('rt_b_'));
    const w = await work('Formula Book', { isbn13: '9780000000231' });
    const readId = await makeRead(db, alice.id, w.id, { status: 'finished', rating: '4.0' });
    await db.update(reads).set({ editionId: w.editionId }).where(eq(reads.id, readId));
    const body = '=HYPERLINK("http://evil","click") was the best line';
    await db.insert(reviews).values({ readId, userId: alice.id, workId: w.id, body });
    const [sh] = await db.insert(shelves).values({ userId: alice.id, name: '+plus shelf', slug: 'plus-shelf' }).returning();
    await db.insert(shelfItems).values({ shelfId: sh!.id, workId: w.id, position: 1 });
    const csv = formatAsCsv(await generateExportData(db, alice.id));
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"") was the best line"`);
    await runImport(bob, csv);
    const [r] = await readsOf(bob.id, w.id);
    const [rv] = await db.select().from(reviews).where(eq(reviews.readId, r!.id));
    expect(rv?.body).toBe(body);
    const bobShelves = await db.select().from(shelves).where(eq(shelves.userId, bob.id));
    expect(bobShelves.map((s) => s.name)).toContain('+plus shelf');
  });

  it("exports everything §26.4 lists and nothing deleted: progress, follows, DNF note, heart, visibility", async () => {
    const u = await makeUser(db, uniq('full_'));
    const other = await makeUser(db, uniq('full_o_'));
    await follow(db, u.id, other.id);
    const w = await work('Exported Fully');
    const readId = await makeRead(db, u.id, w.id, { status: 'dnf', visibility: 'followers' });
    await db.update(reads).set({ dnfNote: 'Too slow', hearted: true }).where(eq(reads.id, readId));
    await db.insert(progressEvents).values({ readId, page: 42, clientEventId: crypto.randomUUID() });
    await db.insert(reviews).values({ readId, userId: u.id, workId: w.id, body: 'Deleted words', deletedAt: new Date() });
    await db.insert(shelves).values({ userId: u.id, name: 'Gone Shelf', slug: 'gone', deletedAt: new Date() });
    const data = (await generateExportData(db, u.id)) as any;
    const r = data.reads.find((x: any) => x.readId === readId);
    expect(r).toMatchObject({ dnfNote: 'Too slow', hearted: true, visibility: 'followers', review: null });
    expect(r.progress).toEqual([expect.objectContaining({ page: 42 })]);
    expect(data.following.map((f: any) => f.username)).toEqual([other.username]);
    expect(data.shelves.map((s: any) => s.name)).not.toContain('Gone Shelf');
  });

  it("an export costs the same statements for 2 shelves as for 12", async () => {
    const u = await makeUser(db, uniq('n1_'));
    const w = await work('Shelved For Export');
    const mk = async (k: number) => {
      for (let i = 0; i < k; i++) {
        const [s] = await db.insert(shelves).values({ userId: u.id, name: uniq('X'), slug: uniq('x') }).returning();
        await db.insert(shelfItems).values({ shelfId: s!.id, workId: w.id, position: 1 });
      }
    };
    await mk(2);
    const few = await countStatements(() => generateExportData(db, u.id));
    await mk(10);
    const many = await countStatements(() => generateExportData(db, u.id));
    expect(many.n).toBe(few.n);
  });

  it('the download token is not stored in the clear; a wrong token is the random-id 404; an expired link is 410', async () => {
    const u = await makeUser(db, uniq('tok_'));
    const create = await app.inject({ method: 'POST', url: '/v1/exports', headers: u.auth, payload: { format: 'csv' } });
    expect(create.statusCode).toBe(201);
    const id = create.json().id as string;
    await new ExportService(db, storage, mailer).processExport(id);
    const mail = mailer.sentMessages.at(-1)!;
    const link = new URL(mail.text.match(/https?:\/\/\S+/)![0]);
    const token = link.searchParams.get('token')!;
    const [row] = await db.select().from(exportsTable).where(eq(exportsTable.id, id));
    expect(JSON.stringify(row)).not.toContain(token);

    const ok = await app.inject({ method: 'GET', url: `/v1/exports/${id}/download?token=${token}` });
    expect(ok.statusCode).toBe(302);
    const wrong = await app.inject({ method: 'GET', url: `/v1/exports/${id}/download?token=${token.slice(0, -1)}x` });
    const random = await app.inject({ method: 'GET', url: `/v1/exports/${crypto.randomUUID()}/download?token=x` });
    expect(wrong.statusCode).toBe(404);
    expect(wrong.body).toBe(random.body);

    await db.update(exportsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(exportsTable.id, id));
    const expired = await app.inject({ method: 'GET', url: `/v1/exports/${id}/download?token=${token}` });
    expect(expired.statusCode).toBe(410);
  });

  it('the owner gets a short-lived link from the app without the emailed token', async () => {
    const u = await makeUser(db, uniq('own_link_'));
    const create = await app.inject({ method: 'POST', url: '/v1/exports', headers: u.auth, payload: { format: 'json' } });
    const id = create.json().id as string;
    await new ExportService(db, storage, mailer).processExport(id);
    const res = await app.inject({ method: 'GET', url: `/v1/exports/${id}/link`, headers: u.auth });
    expect(res.statusCode).toBe(200);
    const file = await app.inject({ method: 'GET', url: new URL(res.json().url).pathname + new URL(res.json().url).search });
    expect(file.statusCode).toBe(200);
    expect(JSON.parse(file.body).user.id).toBe(u.id);
    const other = await makeUser(db, uniq('own_link_o_'));
    expect((await app.inject({ method: 'GET', url: `/v1/exports/${id}/link`, headers: other.auth })).statusCode).toBe(404);
  });

  it('a failed enqueue leaves no export queued forever', async () => {
    const u = await makeUser(db, uniq('enq_'));
    const failing = { send: async () => { throw new Error('queue down'); } } as unknown as PgBoss;
    const svc = new ExportService(db, storage, mailer, failing);
    await expect(svc.create(u.id, { format: 'csv' })).rejects.toThrow();
    const rows = await db.select().from(exportsTable).where(eq(exportsTable.userId, u.id));
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('D-05-3: an unverified author\'s imported review is visible only to its author (A-12-013)', () => {
  it('hidden from the work list and the review page until the email is verified', async () => {
    const author = await makeUser(db, uniq('unv_'), { verified: false });
    const stranger = await makeUser(db, uniq('unv_s_'));
    const w = await work('Unverified Review Book', { isbn13: '9780000000248' });
    await runImport(author, gr(grRow({ title: 'Unverified Review Book', isbn13: '9780000000248', rating: '5', review: 'Bought praise.', dateRead: '2024/01/01' })));
    const [rv] = await db.select().from(reviews).where(eq(reviews.userId, author.id));
    expect(rv).toBeDefined();

    const list = (v?: TestUser) => app.inject({ method: 'GET', url: `/v1/works/${w.id}/reviews`, headers: v?.auth ?? {} });
    const one = (v?: TestUser) => app.inject({ method: 'GET', url: `/v1/reviews/${rv!.id}`, headers: v?.auth ?? {} });
    const ids = (res: any) => (res.json().data ?? []).map((r: any) => r.id);

    expect(ids(await list(stranger))).not.toContain(rv!.id);
    expect(ids(await list())).not.toContain(rv!.id);
    expect((await one(stranger)).statusCode).toBe(404);
    expect((await one()).statusCode).toBe(404);
    expect((await one(author)).statusCode).toBe(200);

    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, author.id));
    expect(ids(await list(stranger))).toContain(rv!.id);
    expect((await one(stranger)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('IM-02 upload edge cases (brief)', () => {
  it("a ../../ filename is only a display name; the object's key comes from ids", async () => {
    const u = await makeUser(db, uniq('trav_'));
    const res = await app.inject({
      method: 'POST', url: '/v1/uploads', headers: u.auth,
      payload: { purpose: 'import', content_type: 'text/csv', size: 10, filename: '../../etc/passwd' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().filename).toBe('passwd');
    const key = new URL(res.json().target.url).searchParams.get('key')!;
    expect(key).toBe(`uploads/${u.id}/${res.json().id}`);
  });

  it('an empty file is refused before any byte is sent (422), and an .xlsx named .csv at /complete', async () => {
    const u = await makeUser(db, uniq('empty_'));
    const empty = await app.inject({
      method: 'POST', url: '/v1/uploads', headers: u.auth,
      payload: { purpose: 'import', content_type: 'text/csv', size: 0, filename: 'empty.csv' },
    });
    expect(empty.statusCode).toBe(422);
    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]);
    await expect(uploadFile(app, u.auth, xlsx, { filename: 'library.csv' })).rejects.toThrow(/422.*upload_invalid_content/);
  });

  it('seedImport helper still works with the disk adapter (processor reads through getStream)', async () => {
    const u = await makeUser(db, uniq('seed_'));
    await work('Seeded Disk Book', { isbn13: '9780000000255' });
    const id = await seedImport(db, storage, u.id, gr(grRow({ title: 'Seeded Disk Book', isbn13: '9780000000255' })));
    const res = await processImport(db, storage, id);
    expect(res.matched).toBe(1);
    const stream = await storage.getStream((await db.select().from(imports).where(eq(imports.id, id)))[0]!.fileKey!);
    expect((await readAll(stream!)).length).toBeGreaterThan(0);
  });
});
