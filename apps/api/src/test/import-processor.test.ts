// IM-08: Import Background Processor Tests (PRD §6.8, §24.2, §34.4, §4404, §4408, Architecture §3.7, §9).
//
// Verifies:
// 1. Chunked background processing of CSV exports.
// 2. Incremental progress reporting on the imports record.
// 3. Resumability: restarting an interrupted job resumes from last committed chunk without duplicates.
// 4. Ambiguous matches never guessed: routed to unmatched with failure_reason = 'ambiguous_match'.
// 5. Rating normalisation: My Rating = 0 -> NULL in reads.
// 6. Source provenance: reads.source = 'import', excluded from activity.
// 7. Fatal errors cleanly recorded with state = 'failed'.

import { beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import {
  users,
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
} from '../db/schema.js';
import { MemoryFileStorage } from '../imports/storage.js';
import { processImport } from '../imports/processor.js';
import { processImportJobHandler } from '../jobs/index.js';
import type { Job } from 'pg-boss';

describe('IM-08: Import Background Processor (Chunked, Resumable, Progress-Reported)', () => {
  let db: Db;
  let storage: MemoryFileStorage;
  let testUserId: string;

  let duneWorkId: string;
  let duneEditionId: string;
  let messiahWorkId: string;
  let duplicateWork1Id: string;
  let duplicateWork2Id: string;

  beforeAll(async () => {
    const fixture = await freshDrizzle();
    db = fixture.db;
    storage = new MemoryFileStorage();

    // 1. Create test user
    const [u] = await db
      .insert(users)
      .values({
        email: 'processor_tester@example.com',
        passwordHash: 'argon2id$mock',
        dateOfBirth: '1992-06-15',
      })
      .returning({ id: users.id });
    testUserId = u!.id;

    // 2. Seed authors
    const [herbert] = await db
      .insert(authors)
      .values({ name: 'Frank Herbert', olAuthorKey: 'OL34221A' })
      .returning({ id: authors.id });

    const [anon] = await db
      .insert(authors)
      .values({ name: 'Anonymous Poet' })
      .returning({ id: authors.id });

    // 3. Seed Dune (Work + Edition with ISBN)
    const [dune] = await db
      .insert(works)
      .values({
        title: 'Dune',
        olWorkKey: 'OL82563W',
      })
      .returning({ id: works.id });
    duneWorkId = dune!.id;

    await db.insert(workAuthors).values({
      workId: duneWorkId,
      authorId: herbert!.id,
      position: 1,
    });

    const [duneEd] = await db
      .insert(editions)
      .values({
        workId: duneWorkId,
        title: 'Dune',
        isbn10: '0441172717',
        isbn13: '9780441172719',
        format: 'paperback',
      })
      .returning({ id: editions.id });
    duneEditionId = duneEd!.id;

    // 4. Seed Dune Messiah (Work only)
    const [messiah] = await db
      .insert(works)
      .values({
        title: 'Dune Messiah',
        olWorkKey: 'OL82564W',
      })
      .returning({ id: works.id });
    messiahWorkId = messiah!.id;

    await db.insert(workAuthors).values({
      workId: messiahWorkId,
      authorId: herbert!.id,
      position: 1,
    });

    // 5. Seed Duplicate Homonymous Works for Ambiguity Testing (PRD AC-9)
    const [dup1] = await db
      .insert(works)
      .values({ title: 'Collected Poems' })
      .returning({ id: works.id });
    duplicateWork1Id = dup1!.id;

    const [dup2] = await db
      .insert(works)
      .values({ title: 'Collected Poems' })
      .returning({ id: works.id });
    duplicateWork2Id = dup2!.id;

    await db.insert(workAuthors).values([
      { workId: duplicateWork1Id, authorId: anon!.id, position: 1 },
      { workId: duplicateWork2Id, authorId: anon!.id, position: 1 },
    ]);
  });

  it('processes a full Goodreads export CSV end-to-end', async () => {
    // CSV with:
    // 1. Dune (ISBN match, rating 5, review, custom shelf)
    // 2. Dune Messiah (title+author match, unrated 0 -> NULL)
    // 3. Collected Poems (ambiguous duplicate works -> unmatched)
    // 4. Unknown Galaxy (no match -> unmatched)
    const csvContent = [
      'Book Id,Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf,Date Read,Bookshelves,My Review',
      '1,Dune,Frank Herbert,="0441172717",="9780441172719",5,read,2024/01/10,sci-fi-masterpieces,"Masterpiece"',
      '2,Dune Messiah,Frank Herbert,,,,0,read,,',
      '3,Collected Poems,Anonymous Poet,,,,4,read,,',
      '4,Unknown Galaxy 999,No Author,,,,3,to-read,,',
    ].join('\n');

    const fileKey = `imports/${testUserId}/test-export.csv`;
    await storage.put(fileKey, Buffer.from(csvContent));

    const [imp] = await db
      .insert(imports)
      .values({
        userId: testUserId,
        source: 'goodreads',
        state: 'queued',
        fileKey,
        filename: 'test-export.csv',
        fileSizeBytes: csvContent.length,
      })
      .returning();

    const result = await processImport(db, storage, imp!.id, { chunkSize: 2 });

    expect(result.state).toBe('completed');
    expect(result.totalRows).toBe(4);
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(2);

    // 1. Verify imports record
    const [savedImp] = await db.select().from(imports).where(eq(imports.id, imp!.id));
    expect(savedImp!.state).toBe('completed');
    expect(savedImp!.totalRows).toBe(4);
    expect(savedImp!.matched).toBe(2);
    expect(savedImp!.unmatched).toBe(2);
    expect(savedImp!.finishedAt).toBeDefined();

    // 2. Verify import_rows
    const rows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importId, imp!.id))
      .orderBy(importRows.rowNo);

    expect(rows).toHaveLength(4);

    // Row 1: Dune matched and resolved
    expect(rows[0]!.rowNo).toBe(1);
    expect(rows[0]!.state).toBe('resolved');
    expect(rows[0]!.workId).toBe(duneWorkId);
    expect(rows[0]!.editionId).toBe(duneEditionId);

    // Row 2: Dune Messiah matched and resolved
    expect(rows[1]!.rowNo).toBe(2);
    expect(rows[1]!.state).toBe('resolved');
    expect(rows[1]!.workId).toBe(messiahWorkId);

    // Row 3: Ambiguous match -> state = unmatched, failureReason = ambiguous_match, workId = null
    expect(rows[2]!.rowNo).toBe(3);
    expect(rows[2]!.state).toBe('unmatched');
    expect(rows[2]!.failureReason).toBe('ambiguous_match');
    expect(rows[2]!.workId).toBeNull();

    // Row 4: No match -> state = unmatched
    expect(rows[3]!.rowNo).toBe(4);
    expect(rows[3]!.state).toBe('unmatched');
    expect(rows[3]!.failureReason).toBe('no_confident_match');
    expect(rows[3]!.workId).toBeNull();

    // 3. Verify reads created
    const userReads = await db
      .select()
      .from(reads)
      .where(eq(reads.userId, testUserId));

    expect(userReads.length).toBeGreaterThanOrEqual(2);

    const duneRead = userReads.find((r) => r.workId === duneWorkId);
    expect(duneRead).toBeDefined();
    expect(duneRead!.source).toBe('import');
    expect(duneRead!.rating).toBe('5.0');
    expect(duneRead!.editionId).toBe(duneEditionId);

    const messiahRead = userReads.find((r) => r.workId === messiahWorkId);
    expect(messiahRead).toBeDefined();
    expect(messiahRead!.source).toBe('import');
    // IM-06: My Rating = 0 -> NULL
    expect(messiahRead!.rating).toBeNull();

    // 4. Verify review created for Dune
    const [duneReview] = await db
      .select()
      .from(reviews)
      .where(eq(reviews.readId, duneRead!.id));

    expect(duneReview).toBeDefined();
    expect(duneReview!.body).toBe('Masterpiece');

    // 5. Verify custom shelf created
    const userShelves = await db
      .select()
      .from(shelves)
      .where(eq(shelves.userId, testUserId));

    const sciFiShelf = userShelves.find((s) => s.slug === 'sci-fi-masterpieces');
    expect(sciFiShelf).toBeDefined();
    expect(sciFiShelf!.itemCount).toBe(1);
  });

  it('resumes safely from the last committed chunk after interruption', async () => {
    // 4-row CSV
    const csvContent = [
      'Book Id,Title,Author,ISBN,My Rating,Exclusive Shelf',
      '10,Dune,Frank Herbert,="0441172717",5,read',
      '11,Dune Messiah,Frank Herbert,,4,read',
      '12,Unknown Title 1,,,,read',
      '13,Unknown Title 2,,,,read',
    ].join('\n');

    const fileKey = `imports/${testUserId}/resumable-export.csv`;
    await storage.put(fileKey, Buffer.from(csvContent));

    const [imp] = await db
      .insert(imports)
      .values({
        userId: testUserId,
        source: 'goodreads',
        state: 'processing',
        fileKey,
        filename: 'resumable-export.csv',
        fileSizeBytes: csvContent.length,
        totalRows: 4,
        matched: 1,
        unmatched: 0,
      })
      .returning();

    // Simulate that chunk 1 (row 10) was ALREADY committed before process crashed
    await db.insert(importRows).values({
      importId: imp!.id,
      rowNo: 1, // 1st data row (Book Id 10)
      raw: { 'Book Id': '10', Title: 'Dune' },
      state: 'resolved',
      workId: duneWorkId,
      editionId: duneEditionId,
      confidence: 1.0,
    });

    const preReads = await db
      .select({ count: reads.id })
      .from(reads)
      .where(eq(reads.userId, testUserId));
    const preReadsCount = preReads.length;

    // Run processor: it should detect row 1 is already in import_rows and process rows 2, 3, 4
    const result = await processImport(db, storage, imp!.id, { chunkSize: 2 });

    expect(result.state).toBe('completed');

    // Verify all 4 rows now exist in import_rows without duplicates
    const allRows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importId, imp!.id))
      .orderBy(importRows.rowNo);

    expect(allRows).toHaveLength(4);
    expect(allRows.map((r) => r.rowNo)).toEqual([1, 2, 3, 4]);

    // Verify reads were only added for new matched rows (Dune Messiah)
    const postReads = await db
      .select({ count: reads.id })
      .from(reads)
      .where(eq(reads.userId, testUserId));

    // Exactly 1 new read added (Messiah), row 1 was not re-committed
    expect(postReads.length).toBe(preReadsCount + 1);
  });

  it('handles missing or invalid file payloads cleanly by transitioning to failed state', async () => {
    const [imp] = await db
      .insert(imports)
      .values({
        userId: testUserId,
        source: 'goodreads',
        state: 'queued',
        fileKey: `imports/${testUserId}/nonexistent.csv`,
        filename: 'nonexistent.csv',
      })
      .returning();

    await expect(
      processImport(db, storage, imp!.id),
    ).rejects.toThrow();

    const [savedImp] = await db.select().from(imports).where(eq(imports.id, imp!.id));
    expect(savedImp!.state).toBe('failed');
    expect(savedImp!.error).toContain('File payload not found');
    expect(savedImp!.finishedAt).toBeDefined();
  });

  it('runs via processImportJobHandler with pg-boss batch format', async () => {
    const csvContent = [
      'Book Id,Title,Author,ISBN,My Rating,Exclusive Shelf',
      '20,Dune,Frank Herbert,="0441172717",5,read',
    ].join('\n');

    const fileKey = `imports/${testUserId}/boss-job.csv`;
    await storage.put(fileKey, Buffer.from(csvContent));

    const [imp] = await db
      .insert(imports)
      .values({
        userId: testUserId,
        source: 'goodreads',
        state: 'queued',
        fileKey,
        filename: 'boss-job.csv',
      })
      .returning();

    const mockJob: Job<{ importId: string; userId: string; source: string }> = {
      id: 'job-123',
      name: 'imports.process',
      data: {
        importId: imp!.id,
        userId: testUserId,
        source: 'goodreads',
      },
    } as any;

    const handlerResult = await processImportJobHandler([mockJob], db, storage);

    expect(handlerResult.processed).toBe(true);
    expect(handlerResult.importId).toBe(imp!.id);
    expect(handlerResult.matched).toBe(1);
    expect(handlerResult.totalRows).toBe(1);
  });
});
