// Import Background Processor (PRD §6.8, §24.2, §34.4, §4404, §4408, Architecture §3.7, §9, IM-08).
//
// Features:
// 1. Chunked processing (default CHUNK_SIZE = 50) for memory and lock efficiency.
// 2. Resumability: checks existing import_rows to resume from last committed chunk without duplicates.
// 3. Progress reporting: updates imports.total_rows, matched, unmatched, state='processing' after each chunk.
// 4. PRD AC-9 rules:
//    - Ambiguous matches are marked 'unmatched' with failure_reason = 'ambiguous_match' and work_id = null.
//    - Unrated books (My Rating = 0) import as rating = NULL in reads.
//    - All created reads have source = 'import' and are excluded from activity feed.

import crypto from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { imports, importRows } from '../db/schema.js';
import { readAll, type ObjectStorage } from '../providers/storage/index.js';
import { parseCsv, type ParsedCsvResult } from './parser.js';
import { SOURCE_CONFIGS, normalizeRow } from './configs/index.js';
import { scoreHeaderMatch } from './detector.js';
import { lookupIsbns, matchImportRow, rowIsbns, type IsbnLookup, type MatchResult } from './matcher.js';
import { commitImportRow } from './committer.js';
import type { ImportSource } from './index.js';
import type { NormalizedImportRow, SourceColumnConfig } from './types.js';

export interface ProcessImportOptions {
  chunkSize?: number;
  sourceOverride?: ImportSource;
}

export interface ProcessImportResult {
  importId: string;
  totalRows: number;
  matched: number;
  unmatched: number;
  state: 'completed' | 'failed';
  error?: string;
  durationMs: number;
}

/**
 * Executes chunked, resumable, progress-reported import processing.
 */
export async function processImport(
  db: Db,
  storage: ObjectStorage,
  importId: string,
  options: ProcessImportOptions = {},
): Promise<ProcessImportResult> {
  const startTime = Date.now();
  const chunkSize = options.chunkSize ?? 50;

  // 1. Fetch import job record
  const [job] = await db
    .select()
    .from(imports)
    .where(eq(imports.id, importId))
    .limit(1);

  if (!job) {
    throw new Error(`Import job not found: ${importId}`);
  }

  // If already completed, return existing results
  if (job.state === 'completed') {
    return {
      importId,
      totalRows: job.totalRows,
      matched: job.matched,
      unmatched: job.unmatched,
      state: 'completed',
      durationMs: 0,
    };
  }

  try {
    // 2. Mark processing
    await db
      .update(imports)
      .set({ state: 'processing', error: null, updatedAt: new Date() })
      .where(eq(imports.id, importId));

    // 3. Read file payload
    if (!job.fileKey) {
      throw new Error(`Import ${importId} has no file_key attached.`);
    }

    const stream = await storage.getStream(job.fileKey);
    const fileBuffer = stream ? await readAll(stream) : null;
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error(`File payload not found in storage for key: ${job.fileKey}`);
    }

    // The presigned upload URL stays valid after /complete checked the file,
    // so the object could have been replaced since (PV-02). Process only the
    // bytes that were checked.
    if (job.contentHash) {
      const actual = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      if (actual !== job.contentHash) {
        throw new Error('The uploaded file changed after it was checked. Upload it again.');
      }
    }

    // 4. Parse (any encoding, A-12-004), then choose the source by the
    // columns: the declared one unless another fits the file better
    // (A-12-008). A file no source fits fails, naming its columns.
    const parsed = parseCsv(fileBuffer);
    const declared = SOURCE_CONFIGS[job.source as ImportSource];
    const config = chooseConfig(parsed.headers, declared);
    if (!config) {
      const cols = parsed.headers.filter(Boolean);
      const shown = cols.slice(0, 20).join(', ') + (cols.length > 20 ? ', …' : '');
      throw new Error(
        cols.length === 0
          ? 'The file is empty.'
          : `Unrecognised file: its columns do not match any supported export (found: ${shown}). Choose the service it came from, or export it again.`,
      );
    }
    if (config.source !== job.source) {
      await db.update(imports).set({ source: config.source, updatedAt: new Date() }).where(eq(imports.id, importId));
    }

    // 5. Normalize all rows
    const normalized = normalizeParsed(config, parsed);
    const normalizedRows = normalized.rows;
    const totalRows = normalizedRows.length;
    if (totalRows === 0) {
      throw new Error('The file has no books in it, only a header row.');
    }

    // 7. Update total_rows on imports record
    await db
      .update(imports)
      .set({ totalRows, updatedAt: new Date() })
      .where(eq(imports.id, importId));

    // 8. Resumption: check which rows have already been persisted
    const existingImportRows = await db
      .select({ rowNo: importRows.rowNo })
      .from(importRows)
      .where(eq(importRows.importId, importId));

    const processedRowNos = new Set(existingImportRows.map((r) => r.rowNo));

    // Filter to remaining pending rows
    const pendingRows = normalizedRows.filter((r) => !processedRowNos.has(r.rowNo));

    // 9. Chunked loop. Matching reads the catalog outside the transaction;
    // the chunk's reads, reviews, shelves and its import_rows commit together,
    // so a crash resumes after the last whole chunk with no duplicate.
    for (let i = 0; i < pendingRows.length; i += chunkSize) {
      const chunk = pendingRows.slice(i, i + chunkSize);
      const isbnLookup = await lookupIsbns(db, chunk.flatMap(rowIsbns));
      const matchedChunk: Array<{ row: NormalizedImportRow; match: MatchResult }> = [];
      for (const row of chunk) {
        matchedChunk.push({ row, match: await matchRow(db, row, isbnLookup) });
      }

      try {
        await db.transaction(async (tx) => commitChunk(tx as unknown as Db, job.userId, importId, matchedChunk, false));
      } catch {
        // One row the database refused (a constraint, a trigger) must not
        // fail the import (A-12-006): redo this chunk with each row in its
        // own savepoint, recording a refused row as commit_failed.
        await db.transaction(async (tx) => commitChunk(tx as unknown as Db, job.userId, importId, matchedChunk, true));
      }
    }

    // 10. Mark import completed
    const [finalCounts] = await db
      .select({
        matched: sql<number>`count(*) FILTER (WHERE ${importRows.state} IN ('matched', 'resolved'))`,
        unmatched: sql<number>`count(*) FILTER (WHERE ${importRows.state} = 'unmatched')`,
      })
      .from(importRows)
      .where(eq(importRows.importId, importId));

    const finalMatched = Number(finalCounts?.matched ?? 0);
    const finalUnmatched = Number(finalCounts?.unmatched ?? 0);

    await db
      .update(imports)
      .set({
        state: 'completed',
        matched: finalMatched,
        unmatched: finalUnmatched,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importId));

    return {
      importId,
      totalRows,
      matched: finalMatched,
      unmatched: finalUnmatched,
      state: 'completed',
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    await db
      .update(imports)
      .set({
        state: 'failed',
        error: errorMsg,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(imports.id, importId));

    throw err;
  }
}

/**
 * The source whose columns fit the file: every required column present,
 * best signature score, the declared source winning ties. null when none fits.
 */
export function chooseConfig(headers: string[], declared: SourceColumnConfig | undefined): SourceColumnConfig | null {
  let best: { config: SourceColumnConfig; confidence: number } | null = null;
  const ordered = declared ? [declared, ...Object.values(SOURCE_CONFIGS).filter((c) => c !== declared)] : Object.values(SOURCE_CONFIGS);
  for (const config of ordered) {
    const score = scoreHeaderMatch(headers, config);
    if (score.missingRequiredHeaders.length > 0) continue;
    if (!best || score.confidence > best.confidence) best = { config, confidence: score.confidence };
  }
  return best?.config ?? null;
}

function normalizeParsed(config: SourceColumnConfig, parsed: ParsedCsvResult): { rows: NormalizedImportRow[] } {
  return {
    rows: parsed.rows.map((r) => {
      const row = normalizeRow(config, r.data, r.rowNo);
      if (r.malformed) row.malformed = true;
      return row;
    }),
  };
}

const unmatched = (failureReason: string): MatchResult => ({
  state: 'unmatched',
  workId: null,
  editionId: null,
  confidence: null,
  failureReason: failureReason as MatchResult['failureReason'],
  strategy: null,
});

/** Rows the parser or the source rule out are recorded without matching. */
async function matchRow(db: Db, row: NormalizedImportRow, isbnLookup: IsbnLookup): Promise<MatchResult> {
  if (row.malformed) return unmatched('malformed_row');
  if (row.excluded) return { ...unmatched('excluded_by_source'), state: 'skipped' as MatchResult['state'] };
  return matchImportRow(db, row, isbnLookup);
}

/**
 * One chunk: commit each matched row, record every row's outcome in one
 * insert, refresh the counters. `isolate`: each commit in its own savepoint.
 */
async function commitChunk(
  tx: Db,
  userId: string,
  importId: string,
  items: Array<{ row: NormalizedImportRow; match: MatchResult }>,
  isolate: boolean,
): Promise<void> {
  const shelfCache = new Map<string, string | null>();
  const records: Array<typeof importRows.$inferInsert> = [];
  for (const { row, match } of items) {
    let state: string = match.state;
    let failureReason: string | null = match.failureReason;
    if (match.state === 'matched' && match.workId) {
      try {
        const commit = (db: Db) => commitImportRow(db, { userId, importId, row, match }, { shelfCache });
        const result = isolate ? await tx.transaction(async (sp) => commit(sp as unknown as Db)) : await commit(tx);
        // Matched and committed rows are 'resolved'; a book already in the
        // library is matched, with the reason it added nothing.
        if (result.committed) state = 'resolved';
        else failureReason = result.reason ?? null;
      } catch (err) {
        if (!isolate) throw err;
        shelfCache.clear();
        state = 'unmatched';
        failureReason = 'commit_failed';
      }
    }
    records.push({
      importId,
      rowNo: row.rowNo,
      raw: row.raw,
      state,
      workId: match.workId,
      editionId: match.editionId,
      confidence: match.confidence,
      failureReason,
    });
  }
  if (records.length > 0) await tx.insert(importRows).values(records).onConflictDoNothing();

  const [counts] = await tx
    .select({
      matched: sql<number>`count(*) FILTER (WHERE ${importRows.state} IN ('matched', 'resolved'))`,
      unmatched: sql<number>`count(*) FILTER (WHERE ${importRows.state} = 'unmatched')`,
    })
    .from(importRows)
    .where(eq(importRows.importId, importId));
  await tx
    .update(imports)
    .set({ matched: Number(counts?.matched ?? 0), unmatched: Number(counts?.unmatched ?? 0), updatedAt: new Date() })
    .where(eq(imports.id, importId));
}
