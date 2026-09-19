// Import endpoints and service (PRD §6.8, §24.2, AC-9, Architecture §3.7, IM-02).
//
// Handles multipart CSV/text export uploads from external services (Goodreads,
// StoryGraph, LibraryThing, Calibre, OpenLibrary, OpenReads), validates file limits,
// stores raw payload, computes SHA-256 content hash, and enqueues asynchronous
// processing jobs via pg-boss, returning job ID immediately to the caller.

import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { Db } from '../platform/index.js';
import { imports, type Import } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { QUEUES } from '../jobs/index.js';
import {
  errorResponseSchema,
  idParamSchema,
  importResponseSchema,
  importListResponseSchema,
  uploadImportQuerySchema,
} from '../contract/schemas.js';
import { type FileStorage, DiskFileStorage } from './storage.js';

export * from './storage.js';
export * from './types.js';
export * from './parser.js';
export * from './transformers.js';
export * from './detector.js';
export * from './configs/index.js';

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

export interface CreateImportInput {
  source: string;
  filename: string;
  buffer: Buffer;
  mimeType?: string;
}

export class ImportService {
  constructor(
    private db: Db,
    private storage: FileStorage,
    private boss?: PgBoss,
  ) {}

  async create(userId: string, input: CreateImportInput): Promise<ImportResponseItem> {
    const rawSource = input.source?.trim().toLowerCase();
    if (!rawSource) {
      throw ApiError.badRequest('missing_source', 'Import source is required.');
    }

    if (!IMPORT_SOURCES.includes(rawSource as ImportSource)) {
      throw ApiError.badRequest(
        'invalid_source',
        `Unsupported import source '${input.source}'. Supported sources: ${IMPORT_SOURCES.join(', ')}.`,
        'source',
      );
    }

    if (!input.buffer || input.buffer.length === 0) {
      throw ApiError.badRequest('empty_file', 'Uploaded file is empty.');
    }

    // SHA-256 for duplicate-import detection per IM-11 and integrity verification
    const contentHash = crypto.createHash('sha256').update(input.buffer).digest('hex');

    // Safe sanitized filename key
    const sanitizedName = path
      .basename(input.filename || 'export.csv')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileKey = `imports/${userId}/${crypto.randomUUID()}-${sanitizedName}`;

    // Store raw file payload
    await this.storage.put(fileKey, input.buffer, input.mimeType);

    // Write database record in queued state
    const [row] = await this.db
      .insert(imports)
      .values({
        userId,
        source: rawSource,
        state: 'queued',
        totalRows: 0,
        matched: 0,
        unmatched: 0,
        fileKey,
        filename: input.filename || sanitizedName,
        fileSizeBytes: input.buffer.length,
        contentHash,
      })
      .returning();

    if (!row) {
      throw new ApiError(500, 'import_create_failed', 'Failed to create import job record.');
    }

    // Enqueue background processing job via pg-boss if configured
    if (this.boss) {
      try {
        await this.boss.send(QUEUES.processImport, {
          importId: row.id,
          userId,
          source: rawSource,
        });
      } catch (err) {
        // Warning: if boss fails, the record remains queued and will be picked up by reconciler/retry
      }
    }

    return toImportResponse(row);
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
}

export interface ImportsPluginOptions {
  db: Db;
  storage?: FileStorage;
  boss?: PgBoss;
}

/**
 * Fastify plugin registering import endpoints.
 */
export const importsPlugin: FastifyPluginAsync<ImportsPluginOptions> = async (fastify, opts) => {
  const storage = opts.storage ?? new DiskFileStorage();
  const service = new ImportService(opts.db, storage, opts.boss);

  fastify.post(
    '/imports',
    {
      schema: {
        tags: ['Imports'],
        summary: 'Upload export file for background import',
        description:
          'Uploads an export CSV from Goodreads, StoryGraph, LibraryThing, Calibre, OpenLibrary, or OpenReads. Returns a job ID immediately and queues processing (PRD §6.8, §24.2, AC-9, IM-02).',
        consumes: ['multipart/form-data'],
        querystring: uploadImportQuerySchema,
        response: {
          201: importResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          413: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);

      if (!request.isMultipart()) {
        throw ApiError.badRequest('invalid_content_type', 'Request must be multipart/form-data.');
      }

      let sourceField: string | undefined;
      let fileBuffer: Buffer | null = null;
      let filename: string | null = null;
      let mimeType: string | undefined;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          filename = part.filename;
          mimeType = part.mimetype;
          fileBuffer = await part.toBuffer();
        } else if (part.type === 'field' && part.fieldname === 'source') {
          sourceField = typeof part.value === 'string' ? part.value : undefined;
        }
      }

      const querySource = (request.query as { source?: string })?.source;
      const source = querySource || sourceField;

      if (!source) {
        throw ApiError.badRequest('missing_source', 'Import source is required.', 'source');
      }

      if (!fileBuffer) {
        throw ApiError.badRequest('missing_file', 'No file was uploaded in the form data.', 'file');
      }

      const result = await service.create(viewer, {
        source,
        filename: filename || 'export.csv',
        buffer: fileBuffer,
        mimeType,
      });

      return reply.status(201).send(result);
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
};
