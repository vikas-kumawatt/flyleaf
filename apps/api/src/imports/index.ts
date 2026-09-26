// Import endpoints and service (PRD §6.8, §24.2, AC-9, Architecture §3.7, IM-02).
//
// Creates an import from a completed upload (PV-02) of a CSV export from an
// external service (Goodreads, StoryGraph, LibraryThing, Calibre, OpenLibrary,
// OpenReads). The file never passes through this route: the client sent it to
// object storage and /v1/uploads/:id/complete checked it and hashed it. This
// consumes the upload and enqueues processing in one transaction, returning
// the job ID immediately.

import type { FastifyPluginAsync } from 'fastify';
import { eq, ne, desc, and, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { Db } from '../platform/index.js';
import { imports, importRows, type Import, type ImportRow } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { QUEUES, sendInTx } from '../jobs/index.js';
import {
  errorResponseSchema,
  idParamSchema,
  importResponseSchema,
  importListResponseSchema,
  importRowSchema,
  importRowsResponseSchema,
  importRowsQuerySchema,
  resolveImportRowBodySchema,
  importRowParamSchema,
  createImportBodySchema,
} from '../contract/schemas.js';
import { SOURCE_CONFIGS, goodreadsConfig, normalizeRow } from './configs/index.js';
import { commitImportRow } from './committer.js';
import { lockUploadForConsumer, markUploadConsumed } from '../uploads/index.js';

export * from './types.js';
export * from './parser.js';
export * from './transformers.js';
export * from './detector.js';
export * from './configs/index.js';
export * from './matcher.js';
export * from './committer.js';
export * from './processor.js';

export const IMPORT_SOURCES = [
  'goodreads',
  'storygraph',
  'librarything',
  'calibre',
  'openlibrary',
  'openreads',
] as const;

export type ImportSource = (typeof IMPORT_SOURCES)[number];

export interface ImportResponseItem {
  id: string;
  job_id: string;
  source: string;
  state: string;
  total_rows: number;
  matched: number;
  unmatched: number;
  filename: string | null;
  file_size_bytes: number | null;
  content_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export function toImportResponse(row: Import): ImportResponseItem {
  return {
    id: row.id,
    job_id: row.id,
    source: row.source,
    state: row.state,
    total_rows: row.totalRows,
    matched: row.matched,
    unmatched: row.unmatched,
    filename: row.filename,
    file_size_bytes: row.fileSizeBytes,
    content_hash: row.contentHash,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export interface ImportRowResponseItem {
  import_id: string;
  row_no: number;
  raw: Record<string, unknown>;
  state: string;
  work_id: string | null;
  edition_id: string | null;
  confidence: number | null;
  failure_reason: string | null;
  created_at: string;
}

export function toImportRowResponse(row: ImportRow): ImportRowResponseItem {
  return {
    import_id: row.importId,
    row_no: row.rowNo,
    raw: row.raw as Record<string, unknown>,
    state: row.state,
    work_id: row.workId,
    edition_id: row.editionId,
    confidence: row.confidence,
    failure_reason: row.failureReason,
    created_at: row.createdAt.toISOString(),
  };
}

export interface CreateImportInput {
  uploadId: string;
  source: string;
  force?: boolean;
}

export class ImportService {
  constructor(
    private db: Db,
    private boss?: PgBoss,
  ) {}

  /**
   * `created: false` is a replay: the upload was already consumed by this
   * user, and the import it produced is returned instead of a 409, so a
   * double submit or an offline retry is harmless.
   */
  async create(
    userId: string,
    input: CreateImportInput,
  ): Promise<{ created: boolean; import: ImportResponseItem }> {
    const rawSource = input.source?.trim().toLowerCase();
    if (!IMPORT_SOURCES.includes(rawSource as ImportSource)) {
      throw ApiError.badRequest(
        'invalid_source',
        `Unsupported import source '${input.source}'. Supported sources: ${IMPORT_SOURCES.join(', ')}.`,
        'source',
      );
    }

    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const upload = await lockUploadForConsumer(db, userId, input.uploadId, 'import');

      if (upload.status === 'consumed') {
        const [existing] = await db
          .select()
          .from(imports)
          .where(and(eq(imports.userId, userId), eq(imports.fileKey, upload.key)))
          .limit(1);
        if (!existing) throw ApiError.conflict('upload_consumed', 'This upload has already been used.');
        return { created: false, import: toImportResponse(existing) };
      }

      // Duplicate detection by content hash (PRD §34.4, IM-11): unless
      // force=true, refuse a file identical to an earlier import that did not
      // fail. The upload stays 'uploaded', so "import anyway" reuses it.
      if (!input.force && upload.sha256) {
        const [existing] = await db
          .select({ id: imports.id, createdAt: imports.createdAt })
          .from(imports)
          .where(
            and(
              eq(imports.userId, userId),
              eq(imports.contentHash, upload.sha256),
              ne(imports.state, 'failed'),
            ),
          )
          .orderBy(desc(imports.createdAt))
          .limit(1);

        if (existing) {
          throw ApiError.conflict(
            'duplicate_import',
            `An identical file has already been imported on ${existing.createdAt.toISOString().slice(0, 10)} (import ID: ${existing.id}). Pass force=true to import anyway.`,
          );
        }
      }

      const [row] = await db
        .insert(imports)
        .values({
          userId,
          source: rawSource,
          state: 'queued',
          totalRows: 0,
          matched: 0,
          unmatched: 0,
          fileKey: upload.key,
          filename: upload.filename ?? `${rawSource}_export.csv`,
          fileSizeBytes: upload.size,
          contentHash: upload.sha256,
        })
        .returning();

      await markUploadConsumed(db, upload.id);

      // Same transaction: the upload is consumed and the job exists, or
      // neither (PV-02). A failed enqueue is a failed request, never an
      // import stuck in 'queued'.
      if (this.boss) {
        await sendInTx(this.boss, tx, QUEUES.processImport, {
          importId: row!.id,
          userId,
          source: rawSource,
        });
      }

      return { created: true, import: toImportResponse(row!) };
    });
  }

  async get(userId: string, importId: string): Promise<ImportResponseItem> {
    const [row] = await this.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
      .limit(1);

    if (!row) {
      // PRD & architecture security rule: 404 for another user's private resource
      throw ApiError.notFound('Import job not found.');
    }

    return toImportResponse(row);
  }

  async list(userId: string, limit = 20): Promise<ImportResponseItem[]> {
    const rows = await this.db
      .select()
      .from(imports)
      .where(eq(imports.userId, userId))
      .orderBy(desc(imports.createdAt))
      .limit(Math.min(50, Math.max(1, limit)));

    return rows.map(toImportResponse);
  }

  async getRows(
    userId: string,
    importId: string,
    query: { state?: string; limit?: number; offset?: number },
  ): Promise<{ rows: ImportRowResponseItem[]; total: number; limit: number; offset: number }> {
    // PRD & architecture security rule: check viewer ownership first
    await this.get(userId, importId);

    const conditions = [eq(importRows.importId, importId)];
    if (query.state) {
      conditions.push(eq(importRows.state, query.state));
    }
    const whereClause = and(...conditions);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);

    const [totalResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(importRows)
      .where(whereClause);

    const rows = await this.db
      .select()
      .from(importRows)
      .where(whereClause)
      .orderBy(importRows.rowNo)
      .limit(limit)
      .offset(offset);

    return {
      rows: rows.map(toImportRowResponse),
      total: Number(totalResult?.count ?? 0),
      limit,
      offset,
    };
  }

  async resolveRow(
    userId: string,
    importId: string,
    rowNo: number,
    input: { workId: string; editionId?: string },
  ): Promise<ImportRowResponseItem> {
    const [importRecord] = await this.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
      .limit(1);

    if (!importRecord) {
      throw ApiError.notFound('Import job not found.');
    }

    const [rowRecord] = await this.db
      .select()
      .from(importRows)
      .where(and(eq(importRows.importId, importId), eq(importRows.rowNo, rowNo)))
      .limit(1);

    if (!rowRecord) {
      throw ApiError.notFound('Import row not found.');
    }

    // Idempotent return if already resolved to this work
    if (rowRecord.state === 'resolved' && rowRecord.workId === input.workId) {
      return toImportRowResponse(rowRecord);
    }

    let config = SOURCE_CONFIGS[importRecord.source as ImportSource];
    if (!config) {
      config = goodreadsConfig;
    }

    const normalizedRow = normalizeRow(
      config,
      rowRecord.raw as Record<string, string>,
      rowRecord.rowNo,
    );

    return await this.db.transaction(async (tx) => {
      // 1. Commit to reading spine with source = 'import' and normalized rating (IM-06, IM-07)
      await commitImportRow(tx as unknown as Db, {
        userId,
        importId,
        row: normalizedRow,
        match: {
          state: 'matched',
          workId: input.workId,
          editionId: input.editionId ?? null,
          confidence: 1.0,
          failureReason: null,
          strategy: null,
        },
      });

      // 2. Update import_rows to resolved
      const [updatedRow] = await tx
        .update(importRows)
        .set({
          state: 'resolved',
          workId: input.workId,
          editionId: input.editionId ?? null,
          confidence: 1.0,
          failureReason: null,
        })
        .where(and(eq(importRows.importId, importId), eq(importRows.rowNo, rowNo)))
        .returning();

      // 3. Recompute/update imports counters
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

      return toImportRowResponse(updatedRow!);
    });
  }

  async skipRow(
    userId: string,
    importId: string,
    rowNo: number,
  ): Promise<ImportRowResponseItem> {
    const [importRecord] = await this.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, importId), eq(imports.userId, userId)))
      .limit(1);

    if (!importRecord) {
      throw ApiError.notFound('Import job not found.');
    }

    const [rowRecord] = await this.db
      .select()
      .from(importRows)
      .where(and(eq(importRows.importId, importId), eq(importRows.rowNo, rowNo)))
      .limit(1);

    if (!rowRecord) {
      throw ApiError.notFound('Import row not found.');
    }

    if (rowRecord.state === 'skipped') {
      return toImportRowResponse(rowRecord);
    }

    return await this.db.transaction(async (tx) => {
      const [updatedRow] = await tx
        .update(importRows)
        .set({
          state: 'skipped',
        })
        .where(and(eq(importRows.importId, importId), eq(importRows.rowNo, rowNo)))
        .returning();

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

      return toImportRowResponse(updatedRow!);
    });
  }
}

export interface ImportsPluginOptions {
  db: Db;
  boss?: PgBoss;
}

/**
 * Fastify plugin registering import endpoints.
 */
export const importsPlugin: FastifyPluginAsync<ImportsPluginOptions> = async (fastify, opts) => {
  const service = new ImportService(opts.db, opts.boss);

  fastify.post(
    '/imports',
    {
      schema: {
        tags: ['Imports'],
        summary: 'Start a background import from an uploaded export file',
        description:
          'Takes a completed upload (purpose `import`) of a CSV export from Goodreads, StoryGraph, LibraryThing, Calibre, OpenLibrary, or OpenReads. ' +
          'Returns a job ID immediately and queues processing (PRD §6.8, §24.2, AC-9, IM-02, PV-02). ' +
          'Repeating the request with the same upload returns the same import with 200.',
        body: createImportBodySchema,
        response: {
          200: importResponseSchema,
          201: importResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          410: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const body = request.body as { upload_id: string; source: string; force?: boolean };
      const result = await service.create(viewer, {
        uploadId: body.upload_id,
        source: body.source,
        force: body.force === true,
      });
      return reply.status(result.created ? 201 : 200).send(result.import);
    },
  );

  fastify.get(
    '/imports/:id',
    {
      schema: {
        tags: ['Imports'],
        summary: 'Get import job status and progress',
        description:
          'Retrieves the status, total rows, matched rows, and counters of a reading library import job (PRD §24.2, IM-02).',
        params: idParamSchema,
        response: {
          200: importResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const result = await service.get(viewer, id);
      return reply.send(result);
    },
  );

  fastify.get(
    '/imports',
    {
      schema: {
        tags: ['Imports'],
        summary: 'List user import jobs',
        description:
          'Lists previous and active library import jobs for the authenticated viewer, ordered newest first.',
        response: {
          200: importListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const result = await service.list(viewer);
      return reply.send({ imports: result });
    },
  );

  fastify.get(
    '/imports/:id/rows',
    {
      schema: {
        tags: ['Imports'],
        summary: 'List import rows with optional state filter',
        description:
          'Retrieves paginated import rows for review, filtered by state (e.g. state=unmatched) (PRD §34.4, Architecture §3.7, IM-09).',
        params: idParamSchema,
        querystring: importRowsQuerySchema,
        response: {
          200: importRowsResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const query = request.query as { state?: string; limit?: number; offset?: number };
      const result = await service.getRows(viewer, id, query);
      return reply.send(result);
    },
  );

  fastify.post(
    '/imports/:id/rows/:rowNo/resolve',
    {
      schema: {
        tags: ['Imports'],
        summary: 'Resolve an unmatched import row',
        description:
          'Resolves an unmatched import row by attaching a work ID, committing the read, and updating state to resolved (PRD §34.4, §5141, IM-09).',
        params: importRowParamSchema,
        body: resolveImportRowBodySchema,
        response: {
          200: importRowSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id, rowNo } = request.params as { id: string; rowNo: number };
      const { work_id, edition_id } = request.body as { work_id: string; edition_id?: string };
      const result = await service.resolveRow(viewer, id, rowNo, {
        workId: work_id,
        editionId: edition_id,
      });
      return reply.send(result);
    },
  );

  fastify.post(
    '/imports/:id/rows/:rowNo/skip',
    {
      schema: {
        tags: ['Imports'],
        summary: 'Skip an unmatched import row',
        description:
          'Marks an unmatched import row as skipped without creating a read (PRD §34.4, Architecture §3.7, IM-09).',
        params: importRowParamSchema,
        response: {
          200: importRowSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id, rowNo } = request.params as { id: string; rowNo: number };
      const result = await service.skipRow(viewer, id, rowNo);
      return reply.send(result);
    },
  );
};
