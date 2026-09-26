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
import { parseCsv } from './parser.js';
import { SOURCE_CONFIGS, normalizeImport } from './configs/index.js';
import { detectSource } from './detector.js';
import { matchImportRow, type MatchResult } from './matcher.js';
import { commitImportRow } from './committer.js';
import type { ImportSource } from './index.js';

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

    const fileContent = fileBuffer.toString('utf-8');

    // 4. Determine source configuration
    let config = SOURCE_CONFIGS[job.source as ImportSource];
    if (!config) {
      const parsed = parseCsv(fileContent);
      const detected = detectSource(parsed.headers, Object.values(SOURCE_CONFIGS));
      if (detected && SOURCE_CONFIGS[detected.source]) {
        config = SOURCE_CONFIGS[detected.source];
      } else {
        throw new Error(`Unsupported or unrecognized import source: ${job.source}`);
      }
    }

    // 5. Normalize all rows
    const normalized = normalizeImport(config, fileContent);
    const normalizedRows = normalized.rows;
    const totalRows = normalizedRows.length;

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

    // 9. Chunked loop
    for (let i = 0; i < pendingRows.length; i += chunkSize) {
      const chunk = pendingRows.slice(i, i + chunkSize);

      // Match each row in the chunk
      const matchedChunk: Array<{
        row: (typeof pendingRows)[0];
        match: MatchResult;
      }> = [];

      for (const row of chunk) {
        const match = await matchImportRow(db, row);
        matchedChunk.push({ row, match });
      }

      // Commit chunk in a database transaction
      await db.transaction(async (tx) => {
        // A. Insert into import_rows
        for (const item of matchedChunk) {
          await tx
            .insert(importRows)
            .values({
              importId,
              rowNo: item.row.rowNo,
              raw: item.row.raw,
              state: item.match.state,
              workId: item.match.workId,
              editionId: item.match.editionId,
              confidence: item.match.confidence,
              failureReason: item.match.failureReason,
            })
            .onConflictDoNothing();

          // B. If matched, commit to reads / reviews / shelves
          if (item.match.state === 'matched' && item.match.workId) {
            await commitImportRow(tx as unknown as Db, {
              userId: job.userId,
              importId,
              row: item.row,
              match: item.match,
            });
          }
        }

        // C. Update imports counters after this chunk
        const [counts] = await tx
          .select({
            matched: sql<number>`count(*) FILTER (WHERE ${importRows.state} IN ('matched', 'resolved'))`,
            unmatched: sql<number>`count(*) FILTER (WHERE ${importRows.state} = 'unmatched')`,
          })
          .from(importRows)
          .where(eq(importRows.importId, importId));

        await tx
          .update(imports)
          .set({
            matched: Number(counts?.matched ?? 0),
            unmatched: Number(counts?.unmatched ?? 0),
            updatedAt: new Date(),
          })
          .where(eq(imports.id, importId));
      });
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
