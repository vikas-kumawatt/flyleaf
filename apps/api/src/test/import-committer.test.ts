// IM-06 & IM-07: Import Committer, Rating Normalisation (0 -> NULL), and Activity Exclusion (source='import')
// Architecture §3.7, §8, §9, PRD §6.8, §1833, §34.4, §4409, §4410, AC-9.

import { beforeAll, describe, expect, it } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
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
  events,
} from '../db/schema.js';
import {
  normalizeRatingForPersistence,
  isExcludedFromActivity,
  isEligibleForActivityFeed,
  feedExcludesImportsSql,
  commitImportRow,
  commitImportBatch,
} from '../imports/committer.js';
import type { NormalizedImportRow } from '../imports/types.js';
import type { MatchResult } from '../imports/matcher.js';

describe('IM-06 & IM-07: Import Committer, Rating Normalisation & Activity Exclusion', () => {
  let db: Db;
  let testUserId: string;
  let duneWorkId: string;
  let duneEditionId: string;
  let messiahWorkId: string;
  let testImportId: string;

  beforeAll(async () => {
    const fixture = await freshDrizzle();
    db = fixture.db;

    // 1. Create a test user
    const [u] = await db
      .insert(users)
      .values({
        email: 'committer_test@example.com',
        passwordHash: 'argon2id$mock',
        dateOfBirth: '1990-01-01',
      })
      .returning({ id: users.id });
    testUserId = u!.id;

    // 2. Create test authors
    const [authorFrank] = await db
      .insert(authors)
      .values({ name: 'Frank Herbert', olAuthorKey: 'OL34221A' })
      .returning({ id: authors.id });

    // 3. Seed Dune Work & Edition
    const [wDune] = await db
      .insert(works)
      .values({
        title: 'Dune',
        olWorkKey: 'OL82563W',
      })
      .returning({ id: works.id });
    duneWorkId = wDune!.id;

    await db.insert(workAuthors).values({
      workId: duneWorkId,
      authorId: authorFrank!.id,
      position: 1,
    });

    const [eDune] = await db
      .insert(editions)
      .values({
        workId: duneWorkId,
        title: 'Dune',
        isbn10: '0441172717',
        isbn13: '9780441172719',
        format: 'paperback',
      })
      .returning({ id: editions.id });
    duneEditionId = eDune!.id;

    // 4. Seed Dune Messiah Work
    const [wMessiah] = await db
      .insert(works)
      .values({
        title: 'Dune Messiah',
        olWorkKey: 'OL82564W',
      })
      .returning({ id: works.id });
    messiahWorkId = wMessiah!.id;

    // 5. Seed an Import Job container
    const [imp] = await db
      .insert(imports)
      .values({
        userId: testUserId,
        source: 'goodreads',
        state: 'processing',
        totalRows: 10,
        matched: 8,
        unmatched: 2,
      })
      .returning({ id: imports.id });
    testImportId = imp!.id;
  });

  // =========================================================================
  // IM-06: Rating Normalisation Tests (My Rating = 0 -> NULL)
  // =========================================================================
  describe('IM-06: Rating Normalisation (0 -> NULL)', () => {
    it('normalizes unrated indicators (0, "0", 0.0, empty, null) to null', () => {
      expect(normalizeRatingForPersistence(0)).toBeNull();
      expect(normalizeRatingForPersistence('0')).toBeNull();
      expect(normalizeRatingForPersistence('0.0')).toBeNull();
      expect(normalizeRatingForPersistence(null)).toBeNull();
      expect(normalizeRatingForPersistence(undefined)).toBeNull();
      expect(normalizeRatingForPersistence('')).toBeNull();
      expect(normalizeRatingForPersistence('   ')).toBeNull();
      expect(normalizeRatingForPersistence(-1)).toBeNull();
    });

    it('formats valid half-star ratings correctly in range 0.5 to 5.0', () => {
      expect(normalizeRatingForPersistence(0.5)).toBe('0.5');
      expect(normalizeRatingForPersistence(1)).toBe('1.0');
      expect(normalizeRatingForPersistence(2.5)).toBe('2.5');
      expect(normalizeRatingForPersistence(4)).toBe('4.0');
      expect(normalizeRatingForPersistence('4.5')).toBe('4.5');
      expect(normalizeRatingForPersistence(5)).toBe('5.0');
    });

    it('rounds quarter-star ratings to nearest half-star', () => {
      expect(normalizeRatingForPersistence(3.25)).toBe('3.5');
      expect(normalizeRatingForPersistence(3.75)).toBe('4.0');
      expect(normalizeRatingForPersistence(4.25)).toBe('4.5');
    });

    it('rejects out of range ratings (> 5.0 or < 0.5) to null', () => {
      expect(normalizeRatingForPersistence(5.5)).toBeNull();
      expect(normalizeRatingForPersistence(10)).toBeNull();
      expect(normalizeRatingForPersistence(0.2)).toBeNull();
    });

    it('persists My Rating = 0 as rating = NULL in reads table without constraint error', async () => {
      // Seed an import row record
      await db.insert(importRows).values({
        importId: testImportId,
        rowNo: 1,
        raw: { Title: 'Dune', 'My Rating': '0' },
        state: 'matched',
        workId: duneWorkId,
      });

      const row: NormalizedImportRow = {
        rowNo: 1,
        raw: { Title: 'Dune', 'My Rating': '0' },
        title: 'Dune',
        author: 'Frank Herbert',
        additionalAuthors: [],
        isbn: null,
        isbn10: null,
        isbn13: null,
        sourceId: null,
        status: 'finished',
        rating: 0, // Unrated Goodreads book!
        startedAt: null,
        finishedAt: '2023-01-15',
        review: null,
        shelves: [],
        readCount: 1,
        owned: true,
        format: 'print',
        notes: null,
        errors: [],
      };

      const match: MatchResult = {
        state: 'matched',
        workId: duneWorkId,
        editionId: duneEditionId,
        confidence: 1.0,
        strategy: 'isbn',
        failureReason: null,
      };

      const result = await commitImportRow(db, {
        userId: testUserId,
        importId: testImportId,
        row,
        match,
      });

      expect(result.committed).toBe(true);
      expect(result.readId).toBeDefined();

      // Verify row in database: rating MUST be NULL (not '0', not 0)
      const [savedRead] = await db
        .select()
        .from(reads)
        .where(eq(reads.id, result.readId!));

      expect(savedRead).toBeDefined();
      expect(savedRead!.rating).toBeNull();
      expect(savedRead!.status).toBe('finished');
      expect(savedRead!.workId).toBe(duneWorkId);
      expect(savedRead!.editionId).toBe(duneEditionId);
    });

    it('stores valid ratings accurately in reads table', async () => {
      await db.insert(importRows).values({
        importId: testImportId,
        rowNo: 2,
        raw: { Title: 'Dune Messiah', 'My Rating': '4.5' },
        state: 'matched',
        workId: messiahWorkId,
      });

      const row: NormalizedImportRow = {
        rowNo: 2,
        raw: { Title: 'Dune Messiah', 'My Rating': '4.5' },
        title: 'Dune Messiah',
        author: 'Frank Herbert',
        additionalAuthors: [],
        isbn: null,
        isbn10: null,
        isbn13: null,
        sourceId: null,
        status: 'finished',
        rating: 4.5,
        startedAt: null,
        finishedAt: '2023-02-20',
        review: null,
        shelves: [],
        readCount: 1,
        owned: true,
        format: 'ebook',
        notes: null,
        errors: [],
      };

      const match: MatchResult = {
        state: 'matched',
        workId: messiahWorkId,
        editionId: null,
        confidence: 0.92,
        strategy: 'exact_title_author',
        failureReason: null,
      };

      const result = await commitImportRow(db, {
        userId: testUserId,
        importId: testImportId,
        row,
        match,
      });

      expect(result.committed).toBe(true);
      const [savedRead] = await db
        .select()
        .from(reads)
        .where(eq(reads.id, result.readId!));

      expect(savedRead).toBeDefined();
      expect(savedRead!.rating).toBe('4.5');
    });

    it('demonstrates that inserting 0 directly violates reads_rating_ck constraint', async () => {
      // Attempting to write '0' into reads.rating must fail Postgres check constraint
      await expect(
        db.insert(reads).values({
          userId: testUserId,
          workId: messiahWorkId,
          status: 'finished',
          rating: '0' as any,
          source: 'import',
        }),
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // IM-07: Source = 'import' & Activity Exclusion Tests
  // =========================================================================
  describe('IM-07: Source = "import" & Activity Feed Exclusion', () => {
    it('sets source = "import" on all committed import reads', async () => {
      const allUserReads = await db
        .select()
        .from(reads)
        .where(eq(reads.userId, testUserId));

      expect(allUserReads.length).toBeGreaterThanOrEqual(2);
      for (const r of allUserReads) {
        expect(r.source).toBe('import');
      }
    });

    it('validates helper functions isExcludedFromActivity and isEligibleForActivityFeed', () => {
      expect(isExcludedFromActivity({ source: 'import' })).toBe(true);
      expect(isExcludedFromActivity({ source: 'app' })).toBe(false);

      expect(isEligibleForActivityFeed({ source: 'import' })).toBe(false);
      expect(isEligibleForActivityFeed({ source: 'app' })).toBe(true);
    });

    it('excludes imported reads from activity feed queries using SQL filter', async () => {
      // Create one genuine app read for contrast
      const [appRead] = await db
        .insert(reads)
        .values({
          userId: testUserId,
          workId: duneWorkId,
          status: 'reading',
          source: 'app',
          attemptNo: 2, // Second attempt
        })
        .returning();

      // Feed query with filter
      const feedEligible = await db
        .select()
        .from(reads)
        .where(and(eq(reads.userId, testUserId), feedExcludesImportsSql()));

      expect(feedEligible).toHaveLength(1);
      expect(feedEligible[0]!.id).toBe(appRead!.id);
      expect(feedEligible[0]!.source).toBe('app');

      // The 2 imported reads are excluded completely
      const importedReads = await db
        .select()
        .from(reads)
        .where(and(eq(reads.userId, testUserId), eq(reads.source, 'import')));

      expect(importedReads.length).toBeGreaterThanOrEqual(2);
    });

    it('ensures zero telemetry events are logged during import commit', async () => {
      const beforeEventsCount = await db.select({ count: sql<number>`count(*)` }).from(events);

      // Commit another row
      await db.insert(importRows).values({
        importId: testImportId,
        rowNo: 3,
        raw: { Title: 'Dune Messiah' },
        state: 'matched',
        workId: messiahWorkId,
      });

      await commitImportRow(db, {
        userId: testUserId,
        importId: testImportId,
        row: {
          rowNo: 3,
          raw: { Title: 'Dune Messiah' },
          title: 'Dune Messiah',
          author: 'Frank Herbert',
          additionalAuthors: [],
          isbn: null,
          isbn10: null,
          isbn13: null,
          sourceId: null,
          status: 'want',
          rating: null,
          startedAt: null,
          finishedAt: null,
          review: null,
          shelves: [],
          readCount: 0,
          owned: null,
          format: null,
          notes: null,
          errors: [],
        },
        match: {
          state: 'matched',
          workId: messiahWorkId,
          editionId: null,
          confidence: 0.92,
          strategy: 'exact_title_author',
          failureReason: null,
        },
      });

      const afterEventsCount = await db.select({ count: sql<number>`count(*)` }).from(events);
      expect(Number(afterEventsCount[0]!.count)).toBe(Number(beforeEventsCount[0]!.count));
    });
  });

  // =========================================================================
  // Reviews and Custom Shelves Persistence
  // =========================================================================
  describe('Reviews and Shelves Persistence', () => {
    it('persists attached review linked to readId', async () => {
      await db.insert(importRows).values({
        importId: testImportId,
        rowNo: 4,
        raw: { Title: 'Dune', Review: 'A monumental science fiction epic.' },
        state: 'matched',
        workId: duneWorkId,
      });

      const result = await commitImportRow(db, {
        userId: testUserId,
        importId: testImportId,
        row: {
          rowNo: 4,
          raw: { Title: 'Dune', Review: 'A monumental science fiction epic.' },
          title: 'Dune',
          author: 'Frank Herbert',
          additionalAuthors: [],
          isbn: null,
          isbn10: null,
          isbn13: null,
          sourceId: null,
          status: 'finished',
          rating: 5.0,
          startedAt: null,
          finishedAt: '2024-03-01',
          review: 'A monumental science fiction epic.',
          shelves: ['Sci-Fi Classics', 'All-Time Favorites'],
          readCount: 1,
          owned: true,
          format: 'print',
          notes: null,
          errors: [],
        },
        match: {
          state: 'matched',
          workId: duneWorkId,
          editionId: duneEditionId,
          confidence: 1.0,
          strategy: 'isbn',
          failureReason: null,
        },
      });

      expect(result.committed).toBe(true);
      expect(result.reviewId).toBeDefined();
      expect(result.shelfIds).toHaveLength(2);

      // Verify review row in DB
      const [savedReview] = await db
        .select()
        .from(reviews)
        .where(eq(reviews.id, result.reviewId!));

      expect(savedReview).toBeDefined();
      expect(savedReview!.body).toBe('A monumental science fiction epic.');
      expect(savedReview!.readId).toBe(result.readId);
      expect(savedReview!.workId).toBe(duneWorkId);
      expect(savedReview!.userId).toBe(testUserId);

      // Verify custom shelves in DB
      const userShelves = await db
        .select()
        .from(shelves)
        .where(eq(shelves.userId, testUserId));

      expect(userShelves.length).toBeGreaterThanOrEqual(2);
      const shelfSlugs = userShelves.map((s) => s.slug);
      expect(shelfSlugs).toContain('sci-fi-classics');
      expect(shelfSlugs).toContain('all-time-favorites');

      // Verify shelf items
      const items = await db
        .select()
        .from(shelfItems)
        .where(eq(shelfItems.workId, duneWorkId));

      expect(items.length).toBeGreaterThanOrEqual(2);
    });

    it('increments attempt_no on subsequent reads for the same work', async () => {
      // Find current max attempt for duneWorkId
      const currentReads = await db
        .select({ attemptNo: reads.attemptNo })
        .from(reads)
        .where(and(eq(reads.userId, testUserId), eq(reads.workId, duneWorkId)));

      const maxAttempt = Math.max(...currentReads.map((r) => r.attemptNo));

      await db.insert(importRows).values({
        importId: testImportId,
        rowNo: 5,
        raw: { Title: 'Dune' },
        state: 'matched',
        workId: duneWorkId,
      });

      const result = await commitImportRow(db, {
        userId: testUserId,
        importId: testImportId,
        row: {
          rowNo: 5,
          raw: { Title: 'Dune' },
          title: 'Dune',
          author: 'Frank Herbert',
          additionalAuthors: [],
          isbn: null,
          isbn10: null,
          isbn13: null,
          sourceId: null,
          status: 'finished',
          rating: 4.5,
          startedAt: null,
          finishedAt: '2024-06-01',
          review: null,
          shelves: [],
          readCount: 1,
          owned: true,
          format: 'audiobook',
          notes: null,
          errors: [],
        },
        match: {
          state: 'matched',
          workId: duneWorkId,
          editionId: duneEditionId,
          confidence: 1.0,
          strategy: 'isbn',
          failureReason: null,
        },
      });

      const [newRead] = await db
        .select()
        .from(reads)
        .where(eq(reads.id, result.readId!));

      expect(newRead).toBeDefined();
      expect(newRead!.attemptNo).toBe(maxAttempt + 1);
    });
  });

  // =========================================================================
  // Batch Committer Tests (commitImportBatch)
  // =========================================================================
  describe('Batch Committer (commitImportBatch)', () => {
    it('commits matched rows in transaction and skips unmatched rows', async () => {
      await db.insert(importRows).values([
        {
          importId: testImportId,
          rowNo: 10,
          raw: { Title: 'Dune Messiah' },
          state: 'matched',
          workId: messiahWorkId,
        },
        {
          importId: testImportId,
          rowNo: 11,
          raw: { Title: 'Unknown Mystery Novel' },
          state: 'unmatched',
          workId: null,
        },
      ]);

      const items = [
        {
          row: {
            rowNo: 10,
            raw: { Title: 'Dune Messiah' },
            title: 'Dune Messiah',
            author: 'Frank Herbert',
            additionalAuthors: [],
            isbn: null,
            isbn10: null,
            isbn13: null,
            sourceId: null,
            status: 'finished' as const,
            rating: 3.5,
            startedAt: null,
            finishedAt: '2024-07-01',
            review: null,
            shelves: [],
            readCount: 1,
            owned: true,
            format: 'ebook' as const,
            notes: null,
            errors: [],
          },
          match: {
            state: 'matched' as const,
            workId: messiahWorkId,
            editionId: null,
            confidence: 0.92,
            strategy: 'exact_title_author' as const,
            failureReason: null,
          },
        },
        {
          row: {
            rowNo: 11,
            raw: { Title: 'Unknown Mystery Novel' },
            title: 'Unknown Mystery Novel',
            author: 'Anon',
            additionalAuthors: [],
            isbn: null,
            isbn10: null,
            isbn13: null,
            sourceId: null,
            status: 'finished' as const,
            rating: null,
            startedAt: null,
            finishedAt: null,
            review: null,
            shelves: [],
            readCount: 1,
            owned: false,
            format: null,
            notes: null,
            errors: [],
          },
          match: {
            state: 'unmatched' as const,
            workId: null,
            editionId: null,
            confidence: null,
            strategy: null,
            failureReason: 'no_confident_match' as const,
          },
        },
      ];

      const batchResult = await commitImportBatch(db, testUserId, testImportId, items);

      expect(batchResult.totalProcessed).toBe(2);
      expect(batchResult.committed).toBe(1);
      expect(batchResult.skipped).toBe(1);
      expect(batchResult.readIds).toHaveLength(1);

      // Verify importRows state updated to resolved for matched row
      const [resolvedRow] = await db
        .select()
        .from(importRows)
        .where(and(eq(importRows.importId, testImportId), eq(importRows.rowNo, 10)));

      expect(resolvedRow).toBeDefined();
      expect(resolvedRow!.state).toBe('resolved');
    });
  });
});
