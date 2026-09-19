// IM-05: Catalog Matching Engine Tests (PRD §6.8, §34.4, §40.3, §5141, AC-9, Architecture §3.7).

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
} from '../db/schema.js';
import {
  matchImportRow,
  persistImportRowMatches,
} from '../imports/matcher.js';
import type { NormalizedImportRow } from '../imports/types.js';

describe('IM-05: Import Matching Engine', () => {
  let db: Db;
  let testUserId: string;

  // Stored IDs for seeded entities
  let duneWorkId: string;
  let duneEditionId: string;
  let messiahWorkId: string;
  let hyperionWorkId: string;
  let neuromancerWorkId: string;
  let neuromancerEditionId: string;
  let collectedPoems1Id: string;
  let collectedPoems2Id: string;
  let tomorrowWorkId: string;

  beforeAll(async () => {
    const fixture = await freshDrizzle();
    db = fixture.db;

    // 1. Create a test user
    const [u] = await db
      .insert(users)
      .values({
        email: 'reader@example.com',
        passwordHash: 'argon2id$mock',
        dateOfBirth: '1995-05-15',
      })
      .returning({ id: users.id });
    testUserId = u!.id;

    // 2. Create authors
    const [herbert] = await db
      .insert(authors)
      .values({ name: 'Frank Herbert' })
      .returning({ id: authors.id });
    const [simmons] = await db
      .insert(authors)
      .values({ name: 'Dan Simmons' })
      .returning({ id: authors.id });
    const [gibson] = await db
      .insert(authors)
      .values({ name: 'William Gibson' })
      .returning({ id: authors.id });
    const [yeats] = await db
      .insert(authors)
      .values({ name: 'W.B. Yeats' })
      .returning({ id: authors.id });
    const [zevin] = await db
      .insert(authors)
      .values({ name: 'Gabrielle Zevin' })
      .returning({ id: authors.id });

    // 3. Seed Work: "Dune" with Edition
    const [dune] = await db
      .insert(works)
      .values({
        title: 'Dune',
        firstPublishYear: 1965,
        logCount: 50000,
      })
      .returning({ id: works.id });
    duneWorkId = dune!.id;

    await db.insert(workAuthors).values({
      workId: duneWorkId,
      authorId: herbert!.id,
      position: 0,
    });

    const [duneEd] = await db
      .insert(editions)
      .values({
        workId: duneWorkId,
        isbn13: '9780441478125',
        isbn10: '0441478123',
        format: 'paperback',
        publishYear: 1990,
      })
      .returning({ id: editions.id });
    duneEditionId = duneEd!.id;

    await db
      .update(works)
      .set({ defaultEditionId: duneEditionId })
      .where(eq(works.id, duneWorkId));

    // 4. Seed Work: "Dune Messiah"
    const [messiah] = await db
      .insert(works)
      .values({
        title: 'Dune Messiah',
        firstPublishYear: 1969,
        logCount: 20000,
      })
      .returning({ id: works.id });
    messiahWorkId = messiah!.id;

    await db.insert(workAuthors).values({
      workId: messiahWorkId,
      authorId: herbert!.id,
      position: 0,
    });

    await db.insert(editions).values({
      workId: messiahWorkId,
      isbn13: '9780441172696',
      format: 'paperback',
      publishYear: 1975,
    });

    // 5. Seed Work: "Hyperion" (no ISBN seeded on edition)
    const [hyperion] = await db
      .insert(works)
      .values({
        title: 'Hyperion',
        firstPublishYear: 1989,
        logCount: 30000,
      })
      .returning({ id: works.id });
    hyperionWorkId = hyperion!.id;

    await db.insert(workAuthors).values({
      workId: hyperionWorkId,
      authorId: simmons!.id,
      position: 0,
    });

    const [hypEd] = await db
      .insert(editions)
      .values({
        workId: hyperionWorkId,
        format: 'paperback',
      })
      .returning({ id: editions.id });

    await db
      .update(works)
      .set({ defaultEditionId: hypEd!.id })
      .where(eq(works.id, hyperionWorkId));

    // 6. Seed Work: "Neuromancer" with OpenLibrary Keys
    const [neuromancer] = await db
      .insert(works)
      .values({
        title: 'Neuromancer',
        olWorkKey: 'OL82563W',
        firstPublishYear: 1984,
        logCount: 40000,
      })
      .returning({ id: works.id });
    neuromancerWorkId = neuromancer!.id;

    await db.insert(workAuthors).values({
      workId: neuromancerWorkId,
      authorId: gibson!.id,
      position: 0,
    });

    const [neuroEd] = await db
      .insert(editions)
      .values({
        workId: neuromancerWorkId,
        olEditionKey: 'OL24364628M',
        format: 'paperback',
      })
      .returning({ id: editions.id });
    neuromancerEditionId = neuroEd!.id;

    await db
      .update(works)
      .set({ defaultEditionId: neuromancerEditionId })
      .where(eq(works.id, neuromancerWorkId));

    // 7. Seed Duplicate/Homonymous Works: "Collected Poems" by W.B. Yeats
    const [poems1] = await db
      .insert(works)
      .values({
        title: 'Collected Poems',
        firstPublishYear: 1933,
        logCount: 1500,
      })
      .returning({ id: works.id });
    collectedPoems1Id = poems1!.id;

    await db.insert(workAuthors).values({
      workId: collectedPoems1Id,
      authorId: yeats!.id,
      position: 0,
    });

    const [poems2] = await db
      .insert(works)
      .values({
        title: 'Collected Poems',
        firstPublishYear: 1956,
        logCount: 1200,
      })
      .returning({ id: works.id });
    collectedPoems2Id = poems2!.id;

    await db.insert(workAuthors).values({
      workId: collectedPoems2Id,
      authorId: yeats!.id,
      position: 0,
    });

    // 8. Seed Work: "Tomorrow, and Tomorrow, and Tomorrow"
    const [tomorrow] = await db
      .insert(works)
      .values({
        title: 'Tomorrow, and Tomorrow, and Tomorrow',
        firstPublishYear: 2022,
        logCount: 25000,
      })
      .returning({ id: works.id });
    tomorrowWorkId = tomorrow!.id;

    await db.insert(workAuthors).values({
      workId: tomorrowWorkId,
      authorId: zevin!.id,
      position: 0,
    });
  });

  function createMockRow(overrides: Partial<NormalizedImportRow>): NormalizedImportRow {
    return {
      rowNo: 1,
      title: 'Mock Title',
      author: 'Mock Author',
      additionalAuthors: [],
      isbn: null,
      isbn10: null,
      isbn13: null,
      sourceId: null,
      status: 'finished',
      rating: 4.5,
      startedAt: null,
      finishedAt: null,
      review: null,
      shelves: [],
      readCount: null,
      owned: null,
      format: null,
      notes: null,
      errors: [],
      raw: { Title: 'Mock Title', Author: 'Mock Author' },
      ...overrides,
    };
  }

  it('Stage 1: Matches exact ISBN-13 with confidence 1.0', async () => {
    const row = createMockRow({
      title: 'Dune',
      author: 'Frank Herbert',
      isbn13: '9780441478125',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('matched');
    expect(result.confidence).toBe(1.0);
    expect(result.strategy).toBe('isbn');
    expect(result.workId).toBe(duneWorkId);
    expect(result.editionId).toBe(duneEditionId);
    expect(result.failureReason).toBeNull();
  });

  it('Stage 1: Matches exact ISBN-10 with confidence 1.0', async () => {
    const row = createMockRow({
      title: 'Dune',
      author: 'Frank Herbert',
      isbn10: '0441478123',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('matched');
    expect(result.confidence).toBe(1.0);
    expect(result.strategy).toBe('isbn');
    expect(result.workId).toBe(duneWorkId);
    expect(result.editionId).toBe(duneEditionId);
  });

  it('Stage 2: Matches OpenLibrary work key with confidence 0.98', async () => {
    const row = createMockRow({
      title: 'Neuromancer',
      author: 'William Gibson',
      sourceId: '/works/OL82563W',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('matched');
    expect(result.confidence).toBe(0.98);
    expect(result.strategy).toBe('source_id');
    expect(result.workId).toBe(neuromancerWorkId);
    expect(result.editionId).toBe(neuromancerEditionId);
  });

  it('Stage 2: Matches OpenLibrary edition key with confidence 0.98', async () => {
    const row = createMockRow({
      title: 'Neuromancer',
      author: 'William Gibson',
      sourceId: 'OL24364628M',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('matched');
    expect(result.confidence).toBe(0.98);
    expect(result.strategy).toBe('source_id');
    expect(result.workId).toBe(neuromancerWorkId);
    expect(result.editionId).toBe(neuromancerEditionId);
  });

  it('Stage 3: Matches exact Title + Author when ISBN is absent', async () => {
    const row = createMockRow({
      title: 'Hyperion',
      author: 'Dan Simmons',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('matched');
    expect(result.confidence).toBe(0.92);
    expect(result.strategy).toBe('exact_title_author');
    expect(result.workId).toBe(hyperionWorkId);
  });

  it('Stage 3: Normalizes subtitle when matching title', async () => {
    const row = createMockRow({
      title: 'Hyperion: A Cantos Masterpiece',
      author: 'Dan Simmons',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('matched');
    expect(result.workId).toBe(hyperionWorkId);
  });

  it('Stage 4: Matches fuzzy Title when slight typo or punctuation omitted', async () => {
    // Missing commas in "Tomorrow and Tomorrow and Tomorrow"
    // Typo in title: "Tomorow" instead of "Tomorrow"
    const row = createMockRow({
      title: 'Tomorrow, and Tomorow, and Tomorrow',
      author: 'Gabrielle Zevin',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('matched');
    expect(result.confidence).toBeGreaterThanOrEqual(0.80);
    expect(result.strategy).toBe('fuzzy_title_author');
    expect(result.workId).toBe(tomorrowWorkId);
  });

  it('CRITICAL PRD AC-9 RULE: Ambiguous matches NEVER guessed when multiple works share title', async () => {
    // Both collectedPoems1Id and collectedPoems2Id exist in the catalog
    const row = createMockRow({
      title: 'Collected Poems',
      author: 'W.B. Yeats',
    });

    const result = await matchImportRow(db, row);

    // MUST NOT GUESS!
    expect(result.state).toBe('unmatched');
    expect(result.workId).toBeNull();
    expect(result.failureReason).toBe('ambiguous_match');
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL PRD AC-9 RULE: Ambiguous matches NEVER guessed when runner-up margin < 0.15', async () => {
    // Truncated title "Dune Mess" matches both Dune and Dune Messiah with close scores
    const row = createMockRow({
      title: 'Dune Mess',
      author: 'Frank Herbert',
    });

    const result = await matchImportRow(db, row);

    // If margin between Dune and Dune Messiah is tight, it MUST go unmatched
    expect(result.state).toBe('unmatched');
    expect(result.workId).toBeNull();
    expect(result.failureReason).toBe('ambiguous_match');
  });

  it('Flags missing title as unmatched with missing_title reason', async () => {
    const row = createMockRow({
      title: '',
      author: 'Unknown',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('unmatched');
    expect(result.confidence).toBe(0);
    expect(result.failureReason).toBe('missing_title');
    expect(result.workId).toBeNull();
  });

  it('Flags nonexistent book as unmatched with no_confident_match', async () => {
    const row = createMockRow({
      title: 'Completely Fictional Book XYZ 987654',
      author: 'Nobody At All',
    });

    const result = await matchImportRow(db, row);

    expect(result.state).toBe('unmatched');
    expect(result.failureReason).toBe('no_confident_match');
    expect(result.workId).toBeNull();
  });

  it('persistImportRowMatches writes records and updates import summary counters', async () => {
    // 1. Create import record
    const [imp] = await db
      .insert(imports)
      .values({
        userId: testUserId,
        source: 'goodreads',
        state: 'processing',
        totalRows: 0,
        matched: 0,
        unmatched: 0,
      })
      .returning({ id: imports.id });
    const importId = imp!.id;

    // 2. Prepare 3 rows: 2 matched, 1 ambiguous/unmatched
    const row1 = createMockRow({
      rowNo: 1,
      title: 'Dune',
      author: 'Frank Herbert',
      isbn13: '9780441478125',
    });
    const match1 = await matchImportRow(db, row1);

    const row2 = createMockRow({
      rowNo: 2,
      title: 'Hyperion',
      author: 'Dan Simmons',
    });
    const match2 = await matchImportRow(db, row2);

    const row3 = createMockRow({
      rowNo: 3,
      title: 'Collected Poems',
      author: 'W.B. Yeats',
    });
    const match3 = await matchImportRow(db, row3);

    // 3. Persist batch
    const summary = await persistImportRowMatches(db, importId, [
      { row: row1, match: match1 },
      { row: row2, match: match2 },
      { row: row3, match: match3 },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.matched).toBe(2);
    expect(summary.unmatched).toBe(1);

    // 4. Verify database persistence in import_rows
    const dbRows = await db
      .select()
      .from(importRows)
      .where(eq(importRows.importId, importId))
      .orderBy(importRows.rowNo);

    expect(dbRows).toHaveLength(3);

    // Row 1: Matched by ISBN
    expect(dbRows[0]?.rowNo).toBe(1);
    expect(dbRows[0]?.state).toBe('matched');
    expect(dbRows[0]?.workId).toBe(duneWorkId);
    expect(dbRows[0]?.editionId).toBe(duneEditionId);
    expect(dbRows[0]?.confidence).toBe(1.0);
    expect(dbRows[0]?.raw).toEqual(row1.raw);

    // Row 2: Matched by Title + Author
    expect(dbRows[1]?.rowNo).toBe(2);
    expect(dbRows[1]?.state).toBe('matched');
    expect(dbRows[1]?.workId).toBe(hyperionWorkId);
    expect(dbRows[1]?.confidence).toBe(0.92);

    // Row 3: Ambiguous match -> UNMATCHED
    expect(dbRows[2]?.rowNo).toBe(3);
    expect(dbRows[2]?.state).toBe('unmatched');
    expect(dbRows[2]?.workId).toBeNull();
    expect(dbRows[2]?.failureReason).toBe('ambiguous_match');

    // 5. Verify parent imports table counters
    const [updatedImport] = await db
      .select()
      .from(imports)
      .where(eq(imports.id, importId));

    expect(updatedImport?.totalRows).toBe(3);
    expect(updatedImport?.matched).toBe(2);
    expect(updatedImport?.unmatched).toBe(1);
  });
});
