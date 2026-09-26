// IM-10: CSV/JSON Export, Emailed Link, and Round-Trip Tests (PRD §1290, §3424, §3608, §5320, Phases §217).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import {
  users,
  profiles,
  works,
  editions,
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
import { targetPath } from './upload-fixtures.js';
import { ExportService } from '../exports/index.js';
import { processImport } from '../imports/processor.js';

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
const ALICE_TOKEN = 'token-alice';
const BOB_TOKEN = 'token-bob';

const WORK_DUNE = '33333333-3333-3333-3333-333333333333';
const WORK_NEUROMANCER = '44444444-4444-4444-4444-444444444444';

const EDITION_DUNE = '77777777-7777-7777-7777-777777777777';

beforeAll(async () => {
  const context = await freshDrizzle();
  drizzleDb = context.db;

  // Insert users & profiles
  await drizzleDb.insert(users).values([
    {
      id: USER_ALICE,
      email: 'alice@flyleaf.test',
      passwordHash: 'hash1',
      dateOfBirth: '2000-01-01',
    },
    {
      id: USER_BOB,
      email: 'bob@flyleaf.test',
      passwordHash: 'hash2',
      dateOfBirth: '2000-01-01',
    },
  ]);

  await drizzleDb.insert(profiles).values([
    {
      userId: USER_ALICE,
      username: 'alice',
      displayName: 'Alice Reader',
      bio: 'Lover of speculative fiction.',
    },
    {
      userId: USER_BOB,
      username: 'bob',
      displayName: 'Bob Reader',
    },
  ]);

  // Insert catalog works & editions
  await drizzleDb.insert(works).values([
    {
      id: WORK_DUNE,
      title: 'Dune',
    },
    {
      id: WORK_NEUROMANCER,
      title: 'Neuromancer',
    },
  ]);

  await drizzleDb.insert(editions).values({
    id: EDITION_DUNE,
    workId: WORK_DUNE,
    isbn10: '0441172717',
    isbn13: '9780441172719',
    title: 'Dune',
    format: 'paperback',
  });

  // Populate Alice's library:
  // 1. Dune: finished, 5.0 rating, review, custom shelf "Favorites"
  const [duneRead] = await drizzleDb
    .insert(reads)
    .values({
      userId: USER_ALICE,
      workId: WORK_DUNE,
      editionId: EDITION_DUNE,
      status: 'finished',
      rating: '5.0',
      finishedAt: '2024-03-15',
      source: 'app',
    })
    .returning();

  await drizzleDb.insert(reviews).values({
    readId: duneRead!.id,
    userId: USER_ALICE,
    workId: WORK_DUNE,
    body: 'An absolute masterpiece of worldbuilding.',
    hasSpoilers: false,
    visibility: 'public',
  });

  const [favShelf] = await drizzleDb
    .insert(shelves)
    .values({
      userId: USER_ALICE,
      name: 'Favorites',
      slug: 'favorites',
      privacy: 'public',
    })
    .returning();

  await drizzleDb.insert(shelfItems).values({
    shelfId: favShelf!.id,
    workId: WORK_DUNE,
    position: 1,
  });

  // 2. Neuromancer: want to read, unrated (NULL per IM-06)
  await drizzleDb.insert(reads).values({
    userId: USER_ALICE,
    workId: WORK_NEUROMANCER,
    status: 'want',
    rating: null,
    source: 'app',
  });

  storage = new MemoryObjectStorage();
  mailer = new MemoryEmailSender();

  exportService = new ExportService(drizzleDb, storage, mailer);

  const mockIdentity = {
    lookup: async (token: string) => {
      if (token === ALICE_TOKEN) return USER_ALICE;
      if (token === BOB_TOKEN) return USER_BOB;
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

describe('IM-10: CSV/JSON Export & Emailed Link API', () => {
  let createdExportId: string;
  let downloadToken: string;

  it('rejects unauthenticated export request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/exports',
      payload: { format: 'csv' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/exports requests CSV export and creates queued record', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/exports',
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      payload: { format: 'csv' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.user_id).toBe(USER_ALICE);
    expect(body.format).toBe('csv');
    expect(body.state).toBe('queued');

    createdExportId = body.id;

    // Verify row in DB
    const [row] = await drizzleDb
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, createdExportId));

    expect(row).toBeDefined();
    expect(row!.downloadToken).toBeDefined();
    downloadToken = row!.downloadToken!;
  });

  it('processExport generates CSV file in storage and emails download link', async () => {
    mailer.clear();

    const result = await exportService.processExport(createdExportId);

    expect(result.state).toBe('completed');
    expect(result.file_size_bytes).toBeGreaterThan(0);
    expect(result.download_url).toContain(`/v1/exports/${createdExportId}/download?token=${downloadToken}`);

    // Verify file exists in storage
    const [row] = await drizzleDb
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, createdExportId));

    const fileContent = await stored(row!.fileKey!);
    expect(fileContent).toBeDefined();
    const csvString = fileContent!.toString('utf-8');

    // Assert CSV content contains headers and Alice's books
    expect(csvString).toContain('Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf');
    expect(csvString).toContain('Dune');
    expect(csvString).toContain('9780441172719');
    expect(csvString).toContain('5.0');
    expect(csvString).toContain('read');
    expect(csvString).toContain('Favorites');
    expect(csvString).toContain('An absolute masterpiece of worldbuilding.');
    expect(csvString).toContain('Neuromancer');
    expect(csvString).toContain('to-read');

    // Verify email was sent with link
    expect(mailer.sentMessages).toHaveLength(1);
    const sent = mailer.sentMessages[0]!;
    expect(sent.to).toBe('alice@flyleaf.test');
    expect(sent.subject).toContain('Your Flyleaf data export is ready');
    expect(sent.text).toContain(`token=${downloadToken}`);
  });

  it('GET /v1/exports/:id/download with the emailed token redirects to a short-lived storage URL (PV-02)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/exports/${createdExportId}/download?token=${downloadToken}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const location = String(res.headers.location);
    // The storage URL carries its own signature, never the emailed token.
    expect(location).not.toContain(downloadToken);
    const exp = Number(new URL(location).searchParams.get('exp'));
    expect(exp * 1000 - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const file = await app.inject({ method: 'GET', url: targetPath(location) });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['content-disposition']).toContain('attachment; filename=');
    expect(file.body).toContain('Dune');
    expect(file.body).toContain('Neuromancer');
  });

  it('GET /v1/exports/:id/download redirects the owner with a Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/exports/${createdExportId}/download`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(302);
    const file = await app.inject({ method: 'GET', url: targetPath(String(res.headers.location)) });
    expect(file.body).toContain('Dune');
  });

  it('GET /v1/exports/:id/download is 404 when the file is gone from storage', async () => {
    const [row] = await drizzleDb.select().from(exportsTable).where(eq(exportsTable.id, createdExportId));
    const saved = await stored(row!.fileKey!);
    await storage.delete(row!.fileKey!);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/exports/${createdExportId}/download?token=${downloadToken}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await storage.put(row!.fileKey!, saved!, 'text/csv');
    }
  });

  it('GET /v1/exports/:id/download returns 404 for invalid token or unauthorized user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/exports/${createdExportId}/download?token=wrong-token`,
    });

    expect(res.statusCode).toBe(404);

    const resBob = await app.inject({
      method: 'GET',
      url: `/v1/exports/${createdExportId}/download`,
      headers: { authorization: `Bearer ${BOB_TOKEN}` },
    });

    expect(resBob.statusCode).toBe(404);
  });

  it('POST /v1/exports supports JSON format and produces structured archive', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/exports',
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      payload: { format: 'json' },
    });

    expect(res.statusCode).toBe(201);
    const jsonExportId = res.json().id;

    const result = await exportService.processExport(jsonExportId);
    expect(result.state).toBe('completed');
    expect(result.format).toBe('json');

    const [row] = await drizzleDb
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, jsonExportId));

    const content = await stored(row!.fileKey!);
    const parsed = JSON.parse(content!.toString('utf-8'));

    expect(parsed.version).toBe('1.0');
    expect(parsed.user.username).toBe('alice');
    expect(parsed.reads).toHaveLength(2);
    expect(parsed.shelves).toHaveLength(1);
    expect(parsed.shelves[0].name).toBe('Favorites');
  });

  it('Round-Trip: Alice export imports into clean Bob account with data intact (Phases §217)', async () => {
    // 1. Get Alice's CSV export
    const [aliceExport] = await drizzleDb
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, createdExportId));

    const csvBuffer = await stored(aliceExport!.fileKey!);
    expect(csvBuffer).toBeDefined();

    // 2. Upload and process this CSV into Bob's account using the standard importer
    const bobFileKey = `imports/${USER_BOB}/alice_roundtrip.csv`;
    await storage.put(bobFileKey, csvBuffer!, 'text/csv');

    const [bobImport] = await drizzleDb
      .insert(exportsTable) // placeholder to get UUID
      .values({
        userId: USER_BOB,
        format: 'csv',
        state: 'queued',
      })
      .returning();

    // Insert into imports table
    const [importJob] = await drizzleDb
      .insert((await import('../db/schema.js')).imports)
      .values({
        userId: USER_BOB,
        source: 'goodreads', // standard CSV headers match goodreads/flyleaf format
        state: 'queued',
        fileKey: bobFileKey,
        filename: 'export.csv',
      })
      .returning();

    // Process import
    const importResult = await processImport(drizzleDb, storage, importJob!.id);

    expect(importResult.state).toBe('completed');
    expect(importResult.matched).toBe(2);
    expect(importResult.unmatched).toBe(0);

    // 3. Verify Bob's reads match Alice's data:
    const bobReads = await drizzleDb
      .select()
      .from(reads)
      .where(eq(reads.userId, USER_BOB));

    expect(bobReads).toHaveLength(2);

    // Dune check
    const bobDune = bobReads.find((r) => r.workId === WORK_DUNE);
    expect(bobDune).toBeDefined();
    expect(bobDune!.status).toBe('finished');
    expect(bobDune!.rating).toBe('5.0');
    expect(bobDune!.source).toBe('import');

    // Neuromancer check: rating must be NULL (IM-06), status 'want'
    const bobNeuro = bobReads.find((r) => r.workId === WORK_NEUROMANCER);
    expect(bobNeuro).toBeDefined();
    expect(bobNeuro!.status).toBe('want');
    expect(bobNeuro!.rating).toBeNull();
    expect(bobNeuro!.source).toBe('import');

    // Review check
    const bobReviews = await drizzleDb
      .select()
      .from(reviews)
      .where(eq(reviews.userId, USER_BOB));

    expect(bobReviews).toHaveLength(1);
    expect(bobReviews[0]!.body).toBe('An absolute masterpiece of worldbuilding.');

    // Shelf check
    const bobShelves = await drizzleDb
      .select()
      .from(shelves)
      .where(eq(shelves.userId, USER_BOB));

    expect(bobShelves.some((s) => s.slug === 'favorites')).toBe(true);
  });
});
