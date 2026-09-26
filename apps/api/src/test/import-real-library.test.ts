// IM-12: Real Library Import, Unmatched Review/Resolution, and Phase 3 Exit Criteria Verification
// PRD §6.8, §34.4, §40.3, §5141, AC-9, Architecture §3.7, §8, §9, Phases §217.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { freshDrizzle } from './pg.js';
import {
  users,
  profiles,
  authors,
  works,
  editions,
  workAuthors,
  imports,
  importRows,
  reads,
  reviews,
  shelves,
  shelfItems,
  exports as exportsTable,
} from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { buildApp } from '../app.js';
import { MemoryObjectStorage, readAll } from '../providers/storage/index.js';
import { importCsv } from './upload-fixtures.js';
import { ExportService } from '../exports/index.js';
import { processImport } from '../imports/processor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let app: FastifyInstance;
let drizzleDb: Db;
let storage: MemoryObjectStorage;

async function stored(key: string): Promise<Buffer | null> {
  const stream = await storage.getStream(key);
  return stream ? readAll(stream) : null;
}
let mailer: MemoryEmailSender;
let exportService: ExportService;

const USER_ALICE = '11111111-1111-1111-1111-111111111111';
const USER_BOB = '22222222-2222-2222-2222-222222222222';
const USER_CHARLIE = '33333333-3333-3333-3333-333333333333';
const ALICE_TOKEN = 'token-alice';
const BOB_TOKEN = 'token-bob';
const CHARLIE_TOKEN = 'token-charlie';

// Seeded Work & Edition IDs to track
let workYeats1Id: string;
let workYeats2Id: string;
let editionYeats1Id: string;
let workDuneId: string;
let workHobbitId: string;
let workNeuromancerId: string;
let workHailMaryId: string;
let workTomorrowId: string;

beforeAll(async () => {
  const context = await freshDrizzle();
  drizzleDb = context.db;

  // 1. Insert users & profiles
  await drizzleDb.insert(users).values([
    {
      id: USER_ALICE,
      email: 'alice@flyleaf.test',
      passwordHash: 'hash1',
      dateOfBirth: '1995-01-01',
    },
    {
      id: USER_BOB,
      email: 'bob@flyleaf.test',
      passwordHash: 'hash2',
      dateOfBirth: '1995-01-01',
    },
    {
      id: USER_CHARLIE,
      email: 'charlie@flyleaf.test',
      passwordHash: 'hash3',
      dateOfBirth: '1995-01-01',
    },
  ]);

  await drizzleDb.insert(profiles).values([
    {
      userId: USER_ALICE,
      username: 'alice',
      displayName: 'Alice Reader',
    },
    {
      userId: USER_BOB,
      username: 'bob',
      displayName: 'Bob Reader',
    },
    {
      userId: USER_CHARLIE,
      username: 'charlie',
      displayName: 'Charlie Reader',
    },
  ]);

  // 2. Helper to seed an author, work, and edition
  const seedBook = async (params: {
    title: string;
    authorName: string;
    isbn10?: string;
    isbn13?: string;
    year?: number;
    format?: 'hardcover' | 'paperback' | 'ebook' | 'audiobook' | 'unknown';
  }) => {
    // Author
    const [author] = await drizzleDb
      .insert(authors)
      .values({ name: params.authorName })
      .returning();

    // Work
    const [work] = await drizzleDb
      .insert(works)
      .values({
        title: params.title,
        firstPublishYear: params.year,
        isProvisional: false,
        logCount: 1000,
      })
      .returning();

    await drizzleDb.insert(workAuthors).values({
      workId: work!.id,
      authorId: author!.id,
      position: 0,
      role: 'author',
    });

    // Edition
    let editionId: string | undefined;
    if (params.isbn10 || params.isbn13) {
      const [ed] = await drizzleDb
        .insert(editions)
        .values({
          workId: work!.id,
          isbn10: params.isbn10,
          isbn13: params.isbn13,
          title: params.title,
          format: params.format ?? 'paperback',
          publishYear: params.year,
        })
        .returning();
      editionId = ed!.id;

      await drizzleDb
        .update(works)
        .set({ defaultEditionId: editionId })
        .where(eq(works.id, work!.id));
    }

    return { workId: work!.id, authorId: author!.id, editionId };
  };

  // 3. Seed 23 catalog books for Goodreads & StoryGraph fixtures
  const dune = await seedBook({
    title: 'Dune',
    authorName: 'Frank Herbert',
    isbn10: '0441172717',
    isbn13: '9780441172719',
    year: 1965,
  });
  workDuneId = dune.workId;

  await seedBook({
    title: 'Nineteen Eighty-Four',
    authorName: 'George Orwell',
    isbn10: '0451524934',
    isbn13: '9780451524935',
    year: 1949,
  });

  const hobbit = await seedBook({
    title: 'The Hobbit',
    authorName: 'J.R.R. Tolkien',
    isbn10: '0547928227',
    isbn13: '9780547928227',
    year: 1937,
  });
  workHobbitId = hobbit.workId;

  await seedBook({
    title: 'Fantastic Mr. Fox',
    authorName: 'Roald Dahl',
    isbn10: '0140328726',
    isbn13: '9780140328721',
    year: 1970,
  });

  await seedBook({
    title: 'Wuthering Heights',
    authorName: 'Emily Brontë',
    isbn10: '0141439556',
    isbn13: '9780141439556',
    year: 1847,
  });

  await seedBook({
    title: 'Oliver Twist',
    authorName: 'Charles Dickens',
    isbn10: '0141439742',
    isbn13: '9780141439747',
    year: 1838,
  });

  await seedBook({
    title: 'How to Cool the Planet',
    authorName: 'Jeff Goodell',
    isbn10: '0618990615',
    isbn13: '9780618990610',
    year: 2010,
    format: 'hardcover',
  });

  const neuro = await seedBook({
    title: 'Neuromancer',
    authorName: 'William Gibson',
    isbn10: '0441569595',
    isbn13: '9780441569595',
    year: 1984,
  });
  workNeuromancerId = neuro.workId;

  await seedBook({
    title: 'Foundation',
    authorName: 'Isaac Asimov',
    isbn10: '0553293354',
    isbn13: '9780553293357',
    year: 1951,
  });

  await seedBook({
    title: 'Dune Messiah',
    authorName: 'Frank Herbert',
    isbn10: '0441172695',
    isbn13: '9780441172696',
    year: 1969,
  });

  await seedBook({
    title: 'Children of Dune',
    authorName: 'Frank Herbert',
    isbn10: '0441104029',
    isbn13: '9780441104024',
    year: 1976,
  });

  await seedBook({
    title: 'The Fellowship of the Ring',
    authorName: 'J.R.R. Tolkien',
    isbn10: '0618346252',
    isbn13: '9780618346257',
    year: 1954,
  });

  await seedBook({
    title: 'The Two Towers',
    authorName: 'J.R.R. Tolkien',
    isbn10: '0618346260',
    isbn13: '9780618346264',
    year: 1954,
  });

  await seedBook({
    title: 'The Return of the King',
    authorName: 'J.R.R. Tolkien',
    isbn10: '0618346279',
    isbn13: '9780618346271',
    year: 1955,
  });

  await seedBook({
    title: 'Animal Farm',
    authorName: 'George Orwell',
    isbn10: '0451526341',
    isbn13: '9780451526342',
    year: 1945,
  });

  await seedBook({
    title: 'Hyperion',
    authorName: 'Dan Simmons',
    isbn10: '0553283685',
    isbn13: '9780553283686',
    year: 1989,
  });

  const tomorrow = await seedBook({
    title: 'Tomorrow, and Tomorrow, and Tomorrow',
    authorName: 'Gabrielle Zevin',
    isbn10: '0593321200',
    isbn13: '9780593321201',
    year: 2022,
    format: 'hardcover',
  });
  workTomorrowId = tomorrow.workId;

  await seedBook({
    title: 'Frankenstein',
    authorName: 'Mary Wollstonecraft Shelley',
    isbn10: '0141439475',
    isbn13: '9780141439471',
    year: 1818,
  });

  await seedBook({
    title: 'Brave New World',
    authorName: 'Aldous Huxley',
    isbn10: '0060850523',
    isbn13: '9780060850524',
    year: 1932,
  });

  await seedBook({
    title: 'The Left Hand of Darkness',
    authorName: 'Ursula K. Le Guin',
    isbn10: '0441478123',
    isbn13: '9780441478125',
    year: 1969,
  });

  const hailMary = await seedBook({
    title: 'Project Hail Mary',
    authorName: 'Andy Weir',
    isbn10: '0593135202',
    isbn13: '9780593135204',
    year: 2021,
    format: 'hardcover',
  });
  workHailMaryId = hailMary.workId;

  await seedBook({
    title: 'Piranesi',
    authorName: 'Susanna Clarke',
    isbn10: '163557563X',
    isbn13: '9781635575637',
    year: 2020,
    format: 'hardcover',
  });

  await seedBook({
    title: 'Solaris',
    authorName: 'Stanisław Lem',
    isbn10: '0156027607',
    isbn13: '9780156027601',
    year: 1961,
  });

  // 4. Seed homonymous works for W.B. Yeats (Book 1024) to trigger PRD AC-9 ambiguity rule
  const [authorYeats] = await drizzleDb
    .insert(authors)
    .values({ name: 'W.B. Yeats' })
    .returning();

  const [w1] = await drizzleDb
    .insert(works)
    .values({
      title: 'Collected Poems',
      firstPublishYear: 1933,
      isProvisional: false,
      logCount: 200,
    })
    .returning();
  workYeats1Id = w1!.id;

  await drizzleDb.insert(workAuthors).values({
    workId: workYeats1Id,
    authorId: authorYeats!.id,
    position: 0,
    role: 'author',
  });

  // Seed edition for Yeats work 1 with an Oxford ISBN (different from Goodreads Scribner ISBN 9780026327015)
  // so Goodreads import remains ambiguous, but resolving attaches this edition for round-trip export
  const [yeatsEd] = await drizzleDb
    .insert(editions)
    .values({
      workId: workYeats1Id,
      isbn10: '0199538768',
      isbn13: '9780199538768',
      title: 'Collected Poems',
      format: 'paperback',
      publishYear: 1933,
    })
    .returning();
  editionYeats1Id = yeatsEd!.id;

  await drizzleDb
    .update(works)
    .set({ defaultEditionId: editionYeats1Id })
    .where(eq(works.id, workYeats1Id));

  const [w2] = await drizzleDb
    .insert(works)
    .values({
      title: 'Collected Poems',
      firstPublishYear: 1989,
      isProvisional: false,
      logCount: 150,
    })
    .returning();
  workYeats2Id = w2!.id;

  await drizzleDb.insert(workAuthors).values({
    workId: workYeats2Id,
    authorId: authorYeats!.id,
    position: 0,
    role: 'author',
  });
  // Notice: no editions with Scribner ISBN 0026327015 or 9780026327015 are seeded!

  // 5. Setup infrastructure
  storage = new MemoryObjectStorage();
  mailer = new MemoryEmailSender();
  exportService = new ExportService(drizzleDb, storage, mailer);

  const mockIdentity = {
    lookup: async (token: string) => {
      if (token === ALICE_TOKEN) return USER_ALICE;
      if (token === BOB_TOKEN) return USER_BOB;
      if (token === CHARLIE_TOKEN) return USER_CHARLIE;
      return null;
    },
  };

  app = await buildApp({
    db: drizzleDb,
    storage,
    mailer,
    identity: mockIdentity as any,
  });
});

afterAll(async () => {
  await app?.close();
});

describe('IM-12: Real Library Import & Phase 3 Exit Criteria', () => {
  let goodreadsImportId: string;

  it('Phase 3 Exit Criterion 1: Real Goodreads export imports with >=85% matched rows', async () => {
    const csvPath = path.join(__dirname, 'fixtures', 'real-library-goodreads.csv');
    const csvBuffer = fs.readFileSync(csvPath);

    // 1. Upload through the presigned flow, then start the import (PV-02)
    const uploadRes = await importCsv(app, { authorization: `Bearer ${ALICE_TOKEN}` }, csvBuffer, {
      source: 'goodreads',
      filename: 'real-library-goodreads.csv',
    });

    expect(uploadRes.statusCode).toBe(201);
    const uploadBody = uploadRes.json();
    expect(uploadBody.id).toBeDefined();
    expect(uploadBody.state).toBe('queued');
    goodreadsImportId = uploadBody.id;

    // 2. Process the import
    const result = await processImport(drizzleDb, storage, goodreadsImportId);

    expect(result.state).toBe('completed');
    expect(result.totalRows).toBe(25);
    expect(result.matched).toBe(23);
    expect(result.unmatched).toBe(2);

    // Match rate calculation: 23 / 25 = 92.0% >= 85%
    const matchRate = result.matched / result.totalRows;
    expect(matchRate).toBeGreaterThanOrEqual(0.85);
    expect(matchRate).toBeCloseTo(0.92, 2);

    // 3. Verify Alice's library reads
    const aliceReads = await drizzleDb
      .select()
      .from(reads)
      .where(eq(reads.userId, USER_ALICE));

    expect(aliceReads).toHaveLength(23);

    // Every imported read must have source = 'import'
    for (const r of aliceReads) {
      expect(r.source).toBe('import');
    }

    // Verify unrated books (My Rating = 0 in CSV: Project Hail Mary, Piranesi, Solaris)
    const hailMaryRead = aliceReads.find((r) => r.workId === workHailMaryId);
    expect(hailMaryRead).toBeDefined();
    expect(hailMaryRead!.rating).toBeNull();
    expect(hailMaryRead!.status).toBe('want');

    // Verify Tomorrow, and Tomorrow, and Tomorrow read
    const tomorrowRead = aliceReads.find((r) => r.workId === workTomorrowId);
    expect(tomorrowRead).toBeDefined();
    expect(tomorrowRead!.rating).toBe('4.0');
    expect(tomorrowRead!.status).toBe('finished');

    // Verify Dune read details: finished, rating 5.0, finishedAt 2024-01-15
    const duneRead = aliceReads.find((r) => r.workId === workDuneId);
    expect(duneRead).toBeDefined();
    expect(duneRead!.rating).toBe('5.0');
    expect(duneRead!.status).toBe('finished');
    expect(duneRead!.finishedAt).toBe('2024-01-15');

    // Verify reviews were created for read books with reviews
    const aliceReviews = await drizzleDb
      .select()
      .from(reviews)
      .where(eq(reviews.userId, USER_ALICE));

    expect(aliceReviews.length).toBeGreaterThanOrEqual(15);
    const duneReview = aliceReviews.find((rv) => rv.workId === workDuneId);
    expect(duneReview).toBeDefined();
    expect(duneReview!.body).toContain('An absolute masterpiece of worldbuilding');

    // Verify custom shelves were created and populated
    const aliceShelves = await drizzleDb
      .select()
      .from(shelves)
      .where(eq(shelves.userId, USER_ALICE));

    const shelfSlugs = aliceShelves.map((s) => s.slug);
    expect(shelfSlugs).toContain('favorites');
    expect(shelfSlugs).toContain('sci-fi');
    expect(shelfSlugs).toContain('classics');
  });

  it('Phase 3 Exit Criterion 2: Unmatched rows are reviewable via GET and resolvable via POST', async () => {
    // 1. GET /v1/imports/:id/rows?state=unmatched
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/imports/${goodreadsImportId}/rows?state=unmatched`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);

    // Row 24: Collected Poems by W.B. Yeats (Book 1024) -> ambiguous_match
    const row24 = body.rows.find((r: any) => r.row_no === 24);
    expect(row24).toBeDefined();
    expect(row24.state).toBe('unmatched');
    expect(row24.failure_reason).toBe('ambiguous_match');
    expect(row24.raw.Title).toBe('Collected Poems');
    expect(row24.raw.Author).toBe('W.B. Yeats');

    // Row 25: Unknown Obscure Zine 99 (Book 1025) -> no_confident_match
    const row25 = body.rows.find((r: any) => r.row_no === 25);
    expect(row25).toBeDefined();
    expect(row25.state).toBe('unmatched');
    expect(row25.failure_reason).toBe('no_confident_match');

    // 2. Resolve Row 24 by attaching workYeats1Id and editionYeats1Id
    const resolveRes = await app.inject({
      method: 'POST',
      url: `/v1/imports/${goodreadsImportId}/rows/24/resolve`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      payload: { work_id: workYeats1Id, edition_id: editionYeats1Id },
    });

    expect(resolveRes.statusCode).toBe(200);
    const resolvedRow = resolveRes.json();
    expect(resolvedRow.row_no).toBe(24);
    expect(resolvedRow.state).toBe('resolved');
    expect(resolvedRow.work_id).toBe(workYeats1Id);

    // 3. Verify read committed for Alice with source = 'import' and rating = '3.0'
    const [yeatsRead] = await drizzleDb
      .select()
      .from(reads)
      .where(and(eq(reads.userId, USER_ALICE), eq(reads.workId, workYeats1Id)));

    expect(yeatsRead).toBeDefined();
    expect(yeatsRead!.rating).toBe('3.0');
    expect(yeatsRead!.status).toBe('finished');
    expect(yeatsRead!.source).toBe('import');

    // 4. Verify import counters were updated
    const [importJob] = await drizzleDb
      .select()
      .from(imports)
      .where(eq(imports.id, goodreadsImportId));

    expect(importJob!.matched).toBe(24);
    expect(importJob!.unmatched).toBe(1);

    // 5. Skip Row 25
    const skipRes = await app.inject({
      method: 'POST',
      url: `/v1/imports/${goodreadsImportId}/rows/25/skip`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(skipRes.statusCode).toBe(200);
    const skippedRow = skipRes.json();
    expect(skippedRow.row_no).toBe(25);
    expect(skippedRow.state).toBe('skipped');
  });

  it('Phase 3 Exit Criterion 3: Export round-trips to CSV, wipe/fresh account, re-import with all data intact', async () => {
    // 1. Export Alice's imported library to CSV
    const exportReqRes = await app.inject({
      method: 'POST',
      url: '/v1/exports',
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      payload: { format: 'csv' },
    });

    expect(exportReqRes.statusCode).toBe(201);
    const exportId = exportReqRes.json().id;

    // Process export
    const exportResult = await exportService.processExport(exportId);
    expect(exportResult.state).toBe('completed');
    expect(exportResult.file_size_bytes).toBeGreaterThan(0);

    // Download / retrieve exported CSV
    const [exportRow] = await drizzleDb
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, exportId));

    const csvBuffer = await stored(exportRow!.fileKey!);
    expect(csvBuffer).toBeDefined();
    const csvContent = csvBuffer!.toString('utf-8');

    // Verify CSV content contains Alice's books and shelves
    expect(csvContent).toContain('Dune');
    expect(csvContent).toContain('Collected Poems');
    expect(csvContent).toContain('Project Hail Mary');
    expect(csvContent.toLowerCase()).toContain('favorites');

    // 2. Re-import into fresh account (Bob)
    const bobUploadRes = await importCsv(app, { authorization: `Bearer ${BOB_TOKEN}` }, csvContent, {
      source: 'goodreads',
      filename: 'alice_export.csv',
    });

    expect(bobUploadRes.statusCode).toBe(201);
    const bobImportId = bobUploadRes.json().id;

    const bobProcessResult = await processImport(drizzleDb, storage, bobImportId);
    expect(bobProcessResult.state).toBe('completed');
    // All 24 exported books should match Bob's catalog
    expect(bobProcessResult.matched).toBe(24);
    expect(bobProcessResult.unmatched).toBe(0);

    // 3. Verify Bob's library has all data intact:
    const bobReads = await drizzleDb
      .select()
      .from(reads)
      .where(eq(reads.userId, USER_BOB));

    expect(bobReads).toHaveLength(24);

    // Check Dune: rating 5.0, status finished, source 'import'
    const bobDune = bobReads.find((r) => r.workId === workDuneId);
    expect(bobDune).toBeDefined();
    expect(bobDune!.rating).toBe('5.0');
    expect(bobDune!.status).toBe('finished');
    expect(bobDune!.source).toBe('import');

    // Check Project Hail Mary: unrated (NULL rating), status want
    const bobHailMary = bobReads.find((r) => r.workId === workHailMaryId);
    expect(bobHailMary).toBeDefined();
    expect(bobHailMary!.rating).toBeNull();
    expect(bobHailMary!.status).toBe('want');

    // Check reviews intact
    const bobReviews = await drizzleDb
      .select()
      .from(reviews)
      .where(eq(reviews.userId, USER_BOB));

    expect(bobReviews.length).toBeGreaterThanOrEqual(15);
    const bobDuneReview = bobReviews.find((rv) => rv.workId === workDuneId);
    expect(bobDuneReview).toBeDefined();
    expect(bobDuneReview!.body).toContain('An absolute masterpiece of worldbuilding');

    // Check custom shelves intact
    const bobShelves = await drizzleDb
      .select()
      .from(shelves)
      .where(eq(shelves.userId, USER_BOB));

    const bobShelfSlugs = bobShelves.map((s) => s.slug);
    expect(bobShelfSlugs).toContain('favorites');
  });

  it('StoryGraph real export imports correctly with quarter-star ratings and date ranges', async () => {
    const csvPath = path.join(__dirname, 'fixtures', 'real-library-storygraph.csv');
    const csvBuffer = fs.readFileSync(csvPath);

    // Upload as Charlie
    const uploadRes = await importCsv(app, { authorization: `Bearer ${CHARLIE_TOKEN}` }, csvBuffer, {
      source: 'storygraph',
      filename: 'real-library-storygraph.csv',
    });

    expect(uploadRes.statusCode).toBe(201);
    const storygraphImportId = uploadRes.json().id;

    const result = await processImport(drizzleDb, storage, storygraphImportId);
    expect(result.state).toBe('completed');
    expect(result.totalRows).toBe(5);
    expect(result.matched).toBe(5);
    expect(result.unmatched).toBe(0);

    // Verify Charlie's Dune read:
    // Star Rating 4.75 rounds to 5.0 per reads_rating_ck constraint
    const [duneRead] = await drizzleDb
      .select()
      .from(reads)
      .where(and(eq(reads.userId, USER_CHARLIE), eq(reads.workId, workDuneId)));

    expect(duneRead).toBeDefined();
    expect(duneRead!.rating).toBe('5.0');
    expect(duneRead!.status).toBe('finished');
    expect(duneRead!.startedAt).toBe('2023-12-15');
    expect(duneRead!.finishedAt).toBe('2024-01-15');

    // Verify The Hobbit read:
    // Star Rating 4.25 rounds to 4.5 per reads_rating_ck constraint
    const [hobbitRead] = await drizzleDb
      .select()
      .from(reads)
      .where(and(eq(reads.userId, USER_CHARLIE), eq(reads.workId, workHobbitId)));

    expect(hobbitRead).toBeDefined();
    expect(hobbitRead!.rating).toBe('4.5');
    expect(hobbitRead!.status).toBe('finished');
    expect(hobbitRead!.startedAt).toBe('2023-08-01');
    expect(hobbitRead!.finishedAt).toBe('2023-08-20');

    // Verify Neuromancer read:
    // Star Rating 3.75 rounds to 4.0 per reads_rating_ck constraint
    const [neuroRead] = await drizzleDb
      .select()
      .from(reads)
      .where(and(eq(reads.userId, USER_CHARLIE), eq(reads.workId, workNeuromancerId)));

    expect(neuroRead).toBeDefined();
    expect(neuroRead!.rating).toBe('4.0');
    expect(neuroRead!.status).toBe('finished');
    expect(neuroRead!.startedAt).toBe('2022-10-01');
    expect(neuroRead!.finishedAt).toBe('2022-10-14');

    // Verify unrated book (Project Hail Mary: Star Rating 0.00 -> NULL)
    const [hailMaryRead] = await drizzleDb
      .select()
      .from(reads)
      .where(and(eq(reads.userId, USER_CHARLIE), eq(reads.workId, workHailMaryId)));

    expect(hailMaryRead).toBeDefined();
    expect(hailMaryRead!.rating).toBeNull();
    expect(hailMaryRead!.status).toBe('want');
  });
});
