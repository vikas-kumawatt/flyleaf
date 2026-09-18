// IM-01: Imports & Import Rows Schema, Constraints, and Migration Tests
// PRD §7.83, AC-9, Architecture §3.7

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { freshDb, freshDrizzle, rejected } from './pg.js';
import { imports, importRows, users, works, editions } from '../db/schema.js';
import type { Db } from '../platform/index.js';

let pgliteDb: PGlite;
let drizzleDb: Db;

const USER_1 = '11111111-1111-1111-1111-111111111111';
const USER_2 = '22222222-2222-2222-2222-222222222222';
const WORK_1 = '33333333-3333-3333-3333-333333333333';
const EDITION_1 = '44444444-4444-4444-4444-444444444444';

beforeAll(async () => {
  pgliteDb = await freshDb();
  const context = await freshDrizzle();
  drizzleDb = context.db;

  await pgliteDb.exec(`
    INSERT INTO users (id, email, password_hash, date_of_birth) VALUES
      ('${USER_1}', 'user1@flyleaf.test', 'hash1', '2000-01-01'),
      ('${USER_2}', 'user2@flyleaf.test', 'hash2', '2000-01-01');

    INSERT INTO works (id, title) VALUES
      ('${WORK_1}', 'The Left Hand of Darkness');

    INSERT INTO editions (id, work_id, isbn_13, isbn_10, title) VALUES
      ('${EDITION_1}', '${WORK_1}', '9780441478125', '0441478123', 'The Left Hand of Darkness (Ace)');
  `);
}, 60_000);

afterAll(async () => {
  await pgliteDb?.close();
});

describe('IM-01: imports Table Constraints', () => {
  it('creates an import with default values', async () => {
    const { rows } = await pgliteDb.query<{
      id: string;
      user_id: string;
      source: string;
      state: string;
      total_rows: number;
      matched: number;
      unmatched: number;
      created_at: string;
      finished_at: string | null;
    }>(`
      INSERT INTO imports (user_id, source)
      VALUES ('${USER_1}', 'goodreads')
      RETURNING id, user_id, source, state, total_rows, matched, unmatched, created_at, finished_at;
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(USER_1);
    expect(rows[0]?.source).toBe('goodreads');
    expect(rows[0]?.state).toBe('queued');
    expect(rows[0]?.total_rows).toBe(0);
    expect(rows[0]?.matched).toBe(0);
    expect(rows[0]?.unmatched).toBe(0);
    expect(rows[0]?.created_at).toBeDefined();
    expect(rows[0]?.finished_at).toBeNull();
  });

  it('accepts all 6 supported import sources (PRD §7.83, Architecture §3.7)', async () => {
    const validSources = [
      'goodreads',
      'storygraph',
      'librarything',
      'calibre',
      'openlibrary',
      'openreads',
    ];

    for (const src of validSources) {
      const { rows } = await pgliteDb.query<{ source: string }>(`
        INSERT INTO imports (user_id, source)
        VALUES ('${USER_1}', '${src}')
        RETURNING source;
      `);
      expect(rows[0]?.source).toBe(src);
    }
  });

  it('rejects unsupported import sources via imports_source_ck', async () => {
    const fail = await rejected(pgliteDb, `
      INSERT INTO imports (user_id, source)
      VALUES ('${USER_1}', 'amazon_kindle')
    `);
    expect(fail).toBe(true);
  });

  it('accepts valid state values and rejects invalid ones via imports_state_ck', async () => {
    const validStates = ['queued', 'processing', 'completed', 'failed'];
    for (const st of validStates) {
      const { rows } = await pgliteDb.query<{ state: string }>(`
        INSERT INTO imports (user_id, source, state)
        VALUES ('${USER_1}', 'goodreads', '${st}')
        RETURNING state;
      `);
      expect(rows[0]?.state).toBe(st);
    }

    // Invalid state
    const fail = await rejected(pgliteDb, `
      INSERT INTO imports (user_id, source, state)
      VALUES ('${USER_1}', 'goodreads', 'running')
    `);
    expect(fail).toBe(true);
  });

  it('enforces non-negative counter checks via imports_counts_ck', async () => {
    const failTotal = await rejected(pgliteDb, `
      INSERT INTO imports (user_id, source, total_rows)
      VALUES ('${USER_1}', 'goodreads', -1)
    `);
    expect(failTotal).toBe(true);

    const failMatched = await rejected(pgliteDb, `
      INSERT INTO imports (user_id, source, matched)
      VALUES ('${USER_1}', 'goodreads', -5)
    `);
    expect(failMatched).toBe(true);

    const failUnmatched = await rejected(pgliteDb, `
      INSERT INTO imports (user_id, source, unmatched)
      VALUES ('${USER_1}', 'goodreads', -2)
    `);
    expect(failUnmatched).toBe(true);
  });

  it('supports duplicate import tracking fields (filename, content_hash, file_size_bytes)', async () => {
    const hash = 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';
    const { rows } = await pgliteDb.query<{
      filename: string;
      content_hash: string;
      file_size_bytes: string;
    }>(`
      INSERT INTO imports (user_id, source, filename, content_hash, file_size_bytes)
      VALUES ('${USER_1}', 'storygraph', 'my_storygraph_library.csv', '${hash}', 1048576)
      RETURNING filename, content_hash, file_size_bytes;
    `);

    expect(rows[0]?.filename).toBe('my_storygraph_library.csv');
    expect(rows[0]?.content_hash).toBe(hash);
    expect(Number(rows[0]?.file_size_bytes)).toBe(1048576);
  });
});

describe('IM-01: import_rows Table Constraints', () => {
  it('creates an import row with raw json payload and match state', async () => {
    const { rows: imp } = await pgliteDb.query<{ id: string }>(`
      INSERT INTO imports (user_id, source) VALUES ('${USER_1}', 'goodreads') RETURNING id;
    `);
    const importId = imp[0]!.id;

    const rawPayload = JSON.stringify({
      'Book Id': '18423',
      Title: 'The Left Hand of Darkness',
      Author: 'Ursula K. Le Guin',
      ISBN13: '="9780441478125"',
      'My Rating': '5',
      'Exclusive Shelf': 'read',
    });

    const { rows } = await pgliteDb.query<{
      import_id: string;
      row_no: number;
      state: string;
      work_id: string;
      edition_id: string;
      confidence: number;
    }>(`
      INSERT INTO import_rows (import_id, row_no, raw, state, work_id, edition_id, confidence)
      VALUES ('${importId}', 1, '${rawPayload}'::jsonb, 'matched', '${WORK_1}', '${EDITION_1}', 1.0)
      RETURNING import_id, row_no, state, work_id, edition_id, confidence;
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.import_id).toBe(importId);
    expect(rows[0]?.row_no).toBe(1);
    expect(rows[0]?.state).toBe('matched');
    expect(rows[0]?.work_id).toBe(WORK_1);
    expect(rows[0]?.edition_id).toBe(EDITION_1);
    expect(rows[0]?.confidence).toBe(1.0);
  });

  it('accepts valid state values and rejects invalid ones via import_rows_state_ck', async () => {
    const { rows: imp } = await pgliteDb.query<{ id: string }>(`
      INSERT INTO imports (user_id, source) VALUES ('${USER_1}', 'goodreads') RETURNING id;
    `);
    const importId = imp[0]!.id;

    const validStates = ['matched', 'unmatched', 'resolved', 'skipped'];
    let rowNo = 10;
    for (const st of validStates) {
      rowNo++;
      const { rows } = await pgliteDb.query<{ state: string }>(`
        INSERT INTO import_rows (import_id, row_no, raw, state)
        VALUES ('${importId}', ${rowNo}, '{"title": "Test"}'::jsonb, '${st}')
        RETURNING state;
      `);
      expect(rows[0]?.state).toBe(st);
    }

    // Invalid state
    const fail = await rejected(pgliteDb, `
      INSERT INTO import_rows (import_id, row_no, raw, state)
      VALUES ('${importId}', 999, '{"title": "Test"}'::jsonb, 'invalid_state')
    `);
    expect(fail).toBe(true);
  });

  it('enforces composite primary key (import_id, row_no) preventing duplicate row numbers', async () => {
    const { rows: imp } = await pgliteDb.query<{ id: string }>(`
      INSERT INTO imports (user_id, source) VALUES ('${USER_1}', 'goodreads') RETURNING id;
    `);
    const importId = imp[0]!.id;

    await pgliteDb.query(`
      INSERT INTO import_rows (import_id, row_no, raw, state)
      VALUES ('${importId}', 42, '{"title": "Original"}'::jsonb, 'unmatched');
    `);

    // Duplicate row_no for the same import must fail
    const fail = await rejected(pgliteDb, `
      INSERT INTO import_rows (import_id, row_no, raw, state)
      VALUES ('${importId}', 42, '{"title": "Duplicate"}'::jsonb, 'unmatched');
    `);
    expect(fail).toBe(true);

    // But another import can use row_no 42
    const { rows: imp2 } = await pgliteDb.query<{ id: string }>(`
      INSERT INTO imports (user_id, source) VALUES ('${USER_2}', 'goodreads') RETURNING id;
    `);
    const { rows } = await pgliteDb.query<{ row_no: number }>(`
      INSERT INTO import_rows (import_id, row_no, raw, state)
      VALUES ('${imp2[0]!.id}', 42, '{"title": "Other Import"}'::jsonb, 'unmatched')
      RETURNING row_no;
    `);
    expect(rows[0]?.row_no).toBe(42);
  });

  it('validates confidence score bounds via import_rows_confidence_ck', async () => {
    const { rows: imp } = await pgliteDb.query<{ id: string }>(`
      INSERT INTO imports (user_id, source) VALUES ('${USER_1}', 'goodreads') RETURNING id;
    `);
    const importId = imp[0]!.id;

    // Confidence out of [0, 1] bounds must fail
    const failHigh = await rejected(pgliteDb, `
      INSERT INTO import_rows (import_id, row_no, raw, state, confidence)
      VALUES ('${importId}', 1, '{"title": "High"}'::jsonb, 'matched', 1.5)
    `);
    expect(failHigh).toBe(true);

    const failLow = await rejected(pgliteDb, `
      INSERT INTO import_rows (import_id, row_no, raw, state, confidence)
      VALUES ('${importId}', 2, '{"title": "Low"}'::jsonb, 'matched', -0.1)
    `);
    expect(failLow).toBe(true);

    // NULL confidence is valid
    const { rows } = await pgliteDb.query<{ confidence: number | null }>(`
      INSERT INTO import_rows (import_id, row_no, raw, state, confidence)
      VALUES ('${importId}', 3, '{"title": "Null"}'::jsonb, 'unmatched', NULL)
      RETURNING confidence;
    `);
    expect(rows[0]?.confidence).toBeNull();
  });

  it('cascades user deletion to imports and child import_rows', async () => {
    // Create a temporary user
    const tempUserId = '88888888-8888-8888-8888-888888888888';
    await pgliteDb.exec(`
      INSERT INTO users (id, email, password_hash, date_of_birth)
      VALUES ('${tempUserId}', 'temp@flyleaf.test', 'hash', '2000-01-01');
    `);

    const { rows: imp } = await pgliteDb.query<{ id: string }>(`
      INSERT INTO imports (user_id, source) VALUES ('${tempUserId}', 'goodreads') RETURNING id;
    `);
    const importId = imp[0]!.id;

    await pgliteDb.query(`
      INSERT INTO import_rows (import_id, row_no, raw, state)
      VALUES
        ('${importId}', 1, '{"title": "Book 1"}'::jsonb, 'matched'),
        ('${importId}', 2, '{"title": "Book 2"}'::jsonb, 'unmatched');
    `);

    // Verify rows exist
    const { rows: beforeRows } = await pgliteDb.query(`SELECT * FROM import_rows WHERE import_id = '${importId}';`);
    expect(beforeRows).toHaveLength(2);

    // Delete user
    await pgliteDb.query(`DELETE FROM users WHERE id = '${tempUserId}';`);

    // Both import and import_rows must be cascade-deleted
    const { rows: afterImports } = await pgliteDb.query(`SELECT * FROM imports WHERE id = '${importId}';`);
    const { rows: afterRows } = await pgliteDb.query(`SELECT * FROM import_rows WHERE import_id = '${importId}';`);
    expect(afterImports).toHaveLength(0);
    expect(afterRows).toHaveLength(0);
  });
});

describe('IM-01: Drizzle ORM Schema Integration', () => {
  it('performs type-safe inserts and queries via Drizzle ORM models', async () => {
    const [testUser] = await drizzleDb.insert(users).values({
      email: 'drizzle_import@flyleaf.test',
      passwordHash: 'hash',
      dateOfBirth: '1995-05-05',
    }).returning();

    // Insert an import record
    const [newImport] = await drizzleDb.insert(imports).values({
      userId: testUser!.id,
      source: 'storygraph',
      state: 'processing',
      filename: 'storygraph_export.csv',
      fileSizeBytes: 20480,
      totalRows: 100,
    }).returning();

    expect(newImport).toBeDefined();
    expect(newImport!.source).toBe('storygraph');
    expect(newImport!.state).toBe('processing');
    expect(newImport!.filename).toBe('storygraph_export.csv');
    expect(newImport!.fileSizeBytes).toBe(20480);
    expect(newImport!.totalRows).toBe(100);

    // Insert import rows
    await drizzleDb.insert(importRows).values([
      {
        importId: newImport!.id,
        rowNo: 1,
        raw: { title: 'Piranesi', author: 'Susanna Clarke', rating: '5' },
        state: 'matched',
        confidence: 0.98,
      },
      {
        importId: newImport!.id,
        rowNo: 2,
        raw: { title: 'Unknown Indie Zine', author: 'Anonymous' },
        state: 'unmatched',
        failureReason: 'no_catalog_match',
      },
    ]);

    // Query back
    const fetchedRows = await drizzleDb
      .select()
      .from(importRows)
      .where(eq(importRows.importId, newImport!.id));

    expect(fetchedRows).toHaveLength(2);
    const matchedRow = fetchedRows.find((r) => r.rowNo === 1);
    const unmatchedRow = fetchedRows.find((r) => r.rowNo === 2);

    expect(matchedRow?.state).toBe('matched');
    expect(matchedRow?.confidence).toBeCloseTo(0.98, 2);
    expect(unmatchedRow?.state).toBe('unmatched');
    expect(unmatchedRow?.failureReason).toBe('no_catalog_match');
  });
});
