// IM-09: Import rows and unmatched review list tests (PRD §34.4, §5141, AC-9, Architecture §3.7).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { imports, importRows, users, works, reads } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';

let app: FastifyInstance;
let drizzleDb: Db;
let storage: MemoryObjectStorage;

const USER_ALICE = '11111111-1111-1111-1111-111111111111';
const USER_BOB = '22222222-2222-2222-2222-222222222222';
const ALICE_TOKEN = 'token-alice';
const BOB_TOKEN = 'token-bob';

const WORK_DUNE = '33333333-3333-3333-3333-333333333333';
const WORK_NEUROMANCER = '44444444-4444-4444-4444-444444444444';

const IMPORT_ID = '55555555-5555-5555-5555-555555555555';
const BOB_IMPORT_ID = '66666666-6666-6666-6666-666666666666';

beforeAll(async () => {
  const context = await freshDrizzle();
  drizzleDb = context.db;

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

  // Insert Alice's test import
  await drizzleDb.insert(imports).values({
    id: IMPORT_ID,
    userId: USER_ALICE,
    source: 'goodreads',
    state: 'completed',
    totalRows: 3,
    matched: 1,
    unmatched: 2,
    filename: 'goodreads_export.csv',
  });

  // Insert Bob's import for authorization test
  await drizzleDb.insert(imports).values({
    id: BOB_IMPORT_ID,
    userId: USER_BOB,
    source: 'storygraph',
    state: 'completed',
    totalRows: 1,
    matched: 1,
    unmatched: 0,
    filename: 'storygraph_export.csv',
  });

  // Insert import rows for Alice:
  // Row 1: matched (Dune)
  // Row 2: unmatched (ambiguous match)
  // Row 3: unmatched (not in catalog)
  await drizzleDb.insert(importRows).values([
    {
      importId: IMPORT_ID,
      rowNo: 1,
      raw: {
        Title: 'Dune',
        Author: 'Frank Herbert',
        'My Rating': '5',
        'Exclusive Shelf': 'read',
      },
      state: 'matched',
      workId: WORK_DUNE,
      confidence: 1.0,
      failureReason: null,
    },
    {
      importId: IMPORT_ID,
      rowNo: 2,
      raw: {
        Title: 'Neuromancer (Sprawl #1)',
        Author: 'Gibson, William',
        'My Rating': '4',
        'Exclusive Shelf': 'read',
        'Date Read': '2024/02/10',
      },
      state: 'unmatched',
      workId: null,
      confidence: 0.65,
      failureReason: 'ambiguous_match',
    },
    {
      importId: IMPORT_ID,
      rowNo: 3,
      raw: {
        Title: 'Obscure Indie Novel',
        Author: 'Unknown Writer',
        'My Rating': '0',
        'Exclusive Shelf': 'to-read',
      },
      state: 'unmatched',
      workId: null,
      confidence: null,
      failureReason: 'not_found',
    },
  ]);

  storage = new MemoryObjectStorage();

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
    identity: mockIdentity as any,
  });
});

afterAll(async () => {
  await app.close();
});

describe('IM-09: Unmatched Review Queue & Import Rows API', () => {
  it('GET /imports/:id/rows returns paginated rows for the import', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${IMPORT_ID}/rows`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(3);
    expect(body.rows[0].row_no).toBe(1);
    expect(body.rows[0].state).toBe('matched');
    expect(body.rows[1].row_no).toBe(2);
    expect(body.rows[1].state).toBe('unmatched');
  });

  it('GET /imports/:id/rows?state=unmatched filters to only unmatched items', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${IMPORT_ID}/rows?state=unmatched`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].row_no).toBe(2);
    expect(body.rows[0].failure_reason).toBe('ambiguous_match');
    expect(body.rows[1].row_no).toBe(3);
    expect(body.rows[1].failure_reason).toBe('not_found');
  });

  it('GET /imports/:id/rows respects pagination limit and offset', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${IMPORT_ID}/rows?limit=1&offset=1`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].row_no).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
  });

  it('GET /imports/:id/rows returns 404 when viewer does not own the import', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${BOB_IMPORT_ID}/rows`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /imports/:id/rows/:rowNo/resolve resolves unmatched row and commits read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/imports/${IMPORT_ID}/rows/2/resolve`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      payload: {
        work_id: WORK_NEUROMANCER,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.row_no).toBe(2);
    expect(body.state).toBe('resolved');
    expect(body.work_id).toBe(WORK_NEUROMANCER);

    // Verify row updated in DB
    const [row] = await drizzleDb
      .select()
      .from(importRows)
      .where(eq(importRows.importId, IMPORT_ID));

    // Verify read was created in DB with source = 'import' (IM-07) and rating 4.0 (IM-06)
    const userReads = await drizzleDb
      .select()
      .from(reads)
      .where(eq(reads.userId, USER_ALICE));

    const neuromancerRead = userReads.find((r) => r.workId === WORK_NEUROMANCER);
    expect(neuromancerRead).toBeDefined();
    expect(neuromancerRead!.source).toBe('import');
    expect(neuromancerRead!.rating).toBe('4.0');
    expect(neuromancerRead!.status).toBe('finished');

    // Verify import counters updated: matched=2, unmatched=1
    const [imp] = await drizzleDb
      .select()
      .from(imports)
      .where(eq(imports.id, IMPORT_ID));

    expect(imp!.matched).toBe(2);
    expect(imp!.unmatched).toBe(1);
  });

  it('POST /imports/:id/rows/:rowNo/resolve is idempotent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/imports/${IMPORT_ID}/rows/2/resolve`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      payload: {
        work_id: WORK_NEUROMANCER,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('resolved');
  });

  it('POST /imports/:id/rows/:rowNo/skip marks row as skipped without creating a read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/imports/${IMPORT_ID}/rows/3/skip`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.row_no).toBe(3);
    expect(body.state).toBe('skipped');

    // Verify import counters updated: matched=2, unmatched=0
    const [imp] = await drizzleDb
      .select()
      .from(imports)
      .where(eq(imports.id, IMPORT_ID));

    expect(imp!.matched).toBe(2);
    expect(imp!.unmatched).toBe(0);
  });

  it('POST /imports/:id/rows/:rowNo/resolve returns 404 for another user import', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/imports/${BOB_IMPORT_ID}/rows/1/resolve`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
      payload: {
        work_id: WORK_DUNE,
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /imports/:id/rows/:rowNo/skip returns 404 for another user import', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/imports/${BOB_IMPORT_ID}/rows/1/skip`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
