// The spine of the product: reads and progress events.
//
// Two things here are correct from day one and must not be "simplified":
//
//   1. One row per reading ATTEMPT. A re-read is a new row with attempt_no+1,
//      never an overwrite (PRD §8.1).
//   2. progress_events is APPEND-ONLY and idempotent on client_event_id, so an
//      offline client can replay its queue safely (PRD §8.3).

import { sql, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../platform/index.js';
import { reads, works, progressEvents, profiles } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { canView, type Visibility, VISIBILITIES } from '../authorization/index.js';
import {
  readSchema,
  readListResponseSchema,
  statusQuerySchema,
  idParamSchema,
  upsertReadBodySchema,
  progressEventBodySchema,
  finishReadBodySchema,
  dnfReadBodySchema,
  errorResponseSchema,
} from '../contract/schemas.js';

export const STATUSES = ['want', 'reading', 'paused', 'finished', 'dnf'] as const;
export type Status = (typeof STATUSES)[number];

// Half-steps only, 0.5–5.0. NULL is valid and is the default: finishing a
// book never requires a rating (PRD §9.3).
const ratingSchema = z
  .number()
  .min(0.5)
  .max(5)
  .refine((v) => v * 2 === Math.floor(v * 2), 'Ratings run in half steps.');

const upsertBody = z.object({
  work_id: z.string().uuid(),
  status: z.enum(STATUSES),
  edition_id: z.string().uuid().nullish(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
  abandoned_page: z.number().int().min(0).nullish(),
  dnf_reason: z.string().nullish(),
  rating: ratingSchema.nullish(),
  hearted: z.boolean().nullish(),
  format_override: z.enum(['print', 'ebook', 'audiobook']).nullish(),
  visibility: z.enum(VISIBILITIES).nullish(),
});

const progressBody = z
  .object({
    client_event_id: z.string().uuid(),
    page: z.number().int().min(0).nullish(),
    percent: z.number().min(0).max(100).nullish(),
    audio_seconds: z.number().int().min(0).nullish(),
    minutes: z.number().int().min(0).nullish(),
    note: z.string().max(280).nullish(),
  })
  .refine((b) => b.page != null || b.percent != null || b.audio_seconds != null, {
    message: 'Send a page, percent, or audio_seconds.',
  });

const finishBody = z.object({
  finished_at: z.string().nullish(),
  rating: ratingSchema.nullish(),
  hearted: z.boolean().nullish(),
  format_override: z.enum(['print', 'ebook', 'audiobook']).nullish(),
  review: z.string().nullish(),
  visibility: z.enum(VISIBILITIES).nullish(),
});

const dnfBody = z.object({
  abandoned_page: z.number().int().min(0).nullish(),
  dnf_reason: z.string().nullish(),
  note: z.string().max(280).nullish(),
  rating: ratingSchema.nullish(),
  visibility: z.enum(VISIBILITIES).nullish(),
});

export type Read = {
  id: string;
  user_id: string;
  work_id: string;
  edition_id?: string | null;
  status: string;
  attempt_no: number;
  started_at?: string | null;
  finished_at?: string | null;
  abandoned_at?: string | null;
  abandoned_page?: number | null;
  dnf_reason?: string | null;
  rating: number | null;
  hearted: boolean;
  format_override?: string | null;
  visibility: Visibility;
  title?: string;
  author_name?: string;
  cover_id?: number | null;
  page?: number | null;
  percent?: number | null;
  page_count?: number | null;
};

export class ReadingService {
  constructor(private db: Db) {}

  /**
   * Creates or updates the current attempt.
   *
   * Starting a book that is already finished or abandoned creates a NEW
   * attempt rather than mutating the old one — that is what makes re-reads
   * honest and keeps a DNF-then-finished history true.
   */
  async upsert(
    viewer: string,
    workId: string,
    status: Status,
    rating?: number | null,
    hearted?: boolean | null,
    visibility?: Visibility | null,
    extra?: {
      editionId?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      abandonedPage?: number | null;
      dnfReason?: string | null;
      formatOverride?: string | null;
    },
  ): Promise<Read> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: reads.id, attemptNo: reads.attemptNo, status: reads.status })
        .from(reads)
        .where(sql`${reads.userId} = ${viewer} AND ${reads.workId} = ${workId}`)
        .orderBy(desc(reads.attemptNo))
        .limit(1);

      const startsNewAttempt =
        !existing ||
        ((existing.status === 'finished' || existing.status === 'dnf') &&
          (status === 'reading' || status === 'want'));

      let id: string;

      if (startsNewAttempt) {
        const [row] = await tx.execute<{ id: string }>(sql`
          INSERT INTO reads (
            user_id, work_id, edition_id, status, attempt_no,
            started_at, finished_at, abandoned_at, abandoned_page, dnf_reason,
            rating, hearted, format_override, visibility
          )
          VALUES (
            ${viewer}, ${workId}, ${extra?.editionId ?? null}, ${status}, ${(existing?.attemptNo ?? 0) + 1},
            COALESCE(${extra?.startedAt ?? null}::date, CASE WHEN ${status} IN ('reading','finished') THEN CURRENT_DATE END),
            COALESCE(${extra?.finishedAt ?? null}::date, CASE WHEN ${status} = 'finished' THEN CURRENT_DATE END),
            CASE WHEN ${status} = 'dnf' THEN CURRENT_DATE END,
            ${extra?.abandonedPage ?? null},
            ${extra?.dnfReason ?? null},
            ${rating ?? null}, ${hearted ?? false}, ${extra?.formatOverride ?? null}, ${visibility ?? 'public'}
          )
          RETURNING id
        `);
        if (!row) throw new Error('insert returned no row');
        id = row.id;
        await tx.execute(sql`UPDATE works SET log_count = log_count + 1 WHERE id = ${workId}`);
      } else {
        id = existing.id;
        await tx.execute(sql`
          UPDATE reads SET
            status          = ${status},
            edition_id      = COALESCE(${extra?.editionId ?? null}, edition_id),
            started_at      = COALESCE(${extra?.startedAt ?? null}::date, started_at, CASE WHEN ${status} IN ('reading','finished') THEN CURRENT_DATE END),
            finished_at     = CASE WHEN ${status} = 'finished' THEN COALESCE(${extra?.finishedAt ?? null}::date, finished_at, CURRENT_DATE) ELSE finished_at END,
            abandoned_at    = CASE WHEN ${status} = 'dnf' THEN CURRENT_DATE ELSE abandoned_at END,
            abandoned_page  = COALESCE(${extra?.abandonedPage ?? null}, abandoned_page),
            dnf_reason      = COALESCE(${extra?.dnfReason ?? null}, dnf_reason),
            rating          = COALESCE(${rating ?? null}, rating),
            hearted         = COALESCE(${hearted ?? null}, hearted),
            format_override = COALESCE(${extra?.formatOverride ?? null}, format_override),
            visibility      = COALESCE(${visibility ?? null}, visibility),
            updated_at      = now()
          WHERE id = ${id}
        `);
      }

      const read = await this.#get(tx as unknown as Db, viewer, id);
      if (!read) throw new Error('read vanished mid-transaction');
      return read;
    });
  }

  /**
   * Finishes a read attempt in one atomic call (PRD §6.17, §3389).
   */
  async finish(
    viewer: string,
    readId: string,
    opts: {
      finishedAt?: string | null;
      rating?: number | null;
      hearted?: boolean | null;
      formatOverride?: string | null;
      review?: string | null;
      visibility?: Visibility | null;
    },
  ): Promise<Read> {
    const [read] = await this.db
      .select({ id: reads.id, userId: reads.userId, startedAt: reads.startedAt })
      .from(reads)
      .where(eq(reads.id, readId))
      .limit(1);

    if (!read || read.userId !== viewer) throw ApiError.notFound('No such read.');

    const finishedAt = opts.finishedAt ?? new Date().toISOString().slice(0, 10);
    if (read.startedAt && finishedAt < read.startedAt) {
      throw ApiError.unprocessable('invalid_date', 'Finish date cannot be earlier than started date.', 'finished_at');
    }

    await this.db.execute(sql`
      UPDATE reads SET
        status = 'finished',
        started_at = COALESCE(started_at, CURRENT_DATE),
        finished_at = ${finishedAt}::date,
        rating = COALESCE(${opts.rating ?? null}, rating),
        hearted = COALESCE(${opts.hearted ?? null}, hearted),
        format_override = COALESCE(${opts.formatOverride ?? null}, format_override),
        visibility = COALESCE(${opts.visibility ?? null}, visibility),
        updated_at = now()
      WHERE id = ${readId}
    `);

    const updated = await this.get(viewer, readId);
    if (!updated) throw ApiError.notFound('No such read.');
    return updated;
  }

  /**
   * Marks a read attempt as stopped/abandoned (DNF) with neutral copy and reason (PRD §6.18).
   */
  async dnf(
    viewer: string,
    readId: string,
    opts: {
      abandonedPage?: number | null;
      dnfReason?: string | null;
      note?: string | null;
      rating?: number | null;
      visibility?: Visibility | null;
    },
  ): Promise<Read> {
    const [read] = await this.db
      .select({ id: reads.id, userId: reads.userId })
      .from(reads)
      .where(eq(reads.id, readId))
      .limit(1);

    if (!read || read.userId !== viewer) throw ApiError.notFound('No such read.');

    await this.db.execute(sql`
      UPDATE reads SET
        status = 'dnf',
        abandoned_at = CURRENT_DATE,
        abandoned_page = ${opts.abandonedPage ?? null},
        dnf_reason = ${opts.dnfReason ?? null},
        rating = COALESCE(${opts.rating ?? null}, rating),
        visibility = COALESCE(${opts.visibility ?? null}, visibility),
        updated_at = now()
      WHERE id = ${readId}
    `);

    const updated = await this.get(viewer, readId);
    if (!updated) throw ApiError.notFound('No such read.');
    return updated;
  }

  /**
   * Returns the read if the viewer is authorized to view it (Architecture §4).
   * Returns null for another user's private read — the route turns that into a 404, never a 403.
   */
  async get(viewer: string | null, id: string): Promise<Read | null> {
    return this.#get(this.db, viewer, id);
  }

  async #get(db: Db, viewer: string | null, id: string): Promise<Read | null> {
    const [row] = await db
      .select({
        id: reads.id,
        userId: reads.userId,
        workId: reads.workId,
        editionId: reads.editionId,
        status: reads.status,
        attemptNo: reads.attemptNo,
        startedAt: reads.startedAt,
        finishedAt: reads.finishedAt,
        abandonedAt: reads.abandonedAt,
        abandonedPage: reads.abandonedPage,
        dnfReason: reads.dnfReason,
        rating: reads.rating,
        hearted: reads.hearted,
        formatOverride: reads.formatOverride,
        visibility: reads.visibility,
        isPrivate: profiles.isPrivate,
      })
      .from(reads)
      .innerJoin(profiles, eq(reads.userId, profiles.userId))
      .where(eq(reads.id, id))
      .limit(1);

    if (!row) return null;

    const allowed = canView({
      viewer,
      ownerId: row.userId,
      visibility: row.visibility as Visibility,
      isOwnerPrivate: row.isPrivate,
    });

    if (!allowed) return null;

    return {
      id: row.id,
      user_id: row.userId,
      work_id: row.workId,
      edition_id: row.editionId,
      status: row.status,
      attempt_no: row.attemptNo,
      started_at: row.startedAt,
      finished_at: row.finishedAt,
      abandoned_at: row.abandonedAt,
      abandoned_page: row.abandonedPage,
      dnf_reason: row.dnfReason,
      rating: row.rating === null ? null : Number(row.rating),
      hearted: row.hearted,
      format_override: row.formatOverride,
      visibility: row.visibility as Visibility,
    };
  }

  /**
   * Powers the Reading tab, the Diary, and public profiles.
   * Viewer ID is a required argument (FN-70).
   * Returns only reads the viewer is authorized to see via canView.
   */
  async list(viewer: string | null, userId: string, status?: string): Promise<Read[]> {
    const [profile] = await this.db
      .select({ isPrivate: profiles.isPrivate })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    if (!profile) return [];

    const canViewAccount = canView({
      viewer,
      ownerId: userId,
      isOwnerPrivate: profile.isPrivate,
    });
    if (!canViewAccount) return [];

    const isOwner = viewer !== null && viewer === userId;

    const rows = await this.db.execute<{
      id: string; user_id: string; work_id: string; edition_id: string | null;
      status: string; attempt_no: number;
      started_at: string | null; finished_at: string | null;
      abandoned_at: string | null; abandoned_page: number | null; dnf_reason: string | null;
      rating: string | null; hearted: boolean; format_override: string | null; visibility: string;
      title: string; author_name: string | null; cover_id: number | null;
      page: number | null; percent: string | null; page_count: number | null;
    }>(sql`
      SELECT r.id, r.user_id, r.work_id, r.edition_id, r.status, r.attempt_no,
             r.started_at, r.finished_at, r.abandoned_at, r.abandoned_page, r.dnf_reason,
             r.rating, r.hearted, r.format_override, r.visibility,
             w.title,
             -- Authorship is a join table and covers live on editions now
             -- (FN-10). Same response shape, different storage.
             (SELECT a.name
                FROM work_authors wa JOIN authors a ON a.id = wa.author_id
               WHERE wa.work_id = w.id
               ORDER BY wa.position, a.name
               LIMIT 1) AS author_name,
             (SELECT e.ol_cover_id
                FROM editions e
               WHERE e.work_id = w.id AND e.ol_cover_id IS NOT NULL
               -- Prefer the cover of the edition this person is actually
               -- reading, if they chose one.
               ORDER BY (e.id = r.edition_id) DESC, e.publish_year DESC NULLS LAST
               LIMIT 1) AS cover_id,
             pe.page, pe.percent,
             (SELECT page_count FROM editions e
               WHERE e.id = r.edition_id
                  OR (r.edition_id IS NULL AND e.work_id = r.work_id)
               ORDER BY page_count NULLS LAST LIMIT 1) AS page_count
      FROM reads r
      JOIN works w ON w.id = r.work_id
      LEFT JOIN LATERAL (
        SELECT page, percent FROM progress_events
        WHERE read_id = r.id ORDER BY at DESC LIMIT 1
      ) pe ON true
      WHERE r.user_id = ${userId}
        AND (${isOwner} OR r.visibility = 'public')
        AND (${status ?? null}::text IS NULL OR r.status = ${status ?? null})
      ORDER BY r.updated_at DESC
    `);

    return rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      work_id: r.work_id,
      edition_id: r.edition_id,
      status: r.status,
      attempt_no: Number(r.attempt_no),
      started_at: r.started_at,
      finished_at: r.finished_at,
      abandoned_at: r.abandoned_at,
      abandoned_page: r.abandoned_page,
      dnf_reason: r.dnf_reason,
      rating: r.rating === null ? null : Number(r.rating),
      hearted: r.hearted,
      format_override: r.format_override,
      visibility: r.visibility as Visibility,
      title: r.title,
      author_name: r.author_name ?? 'Unknown',
      cover_id: r.cover_id,
      page: r.page,
      percent: r.percent === null ? null : Number(r.percent),
      page_count: r.page_count,
    }));
  }

  /**
   * Idempotent on clientEventId.
   *
   * This is the single most important property in the offline story: a client
   * replaying its queue must never double-count. A unique index plus
   * ON CONFLICT DO NOTHING is the whole mechanism.
   */
  async addProgress(
    viewer: string,
    readId: string,
    clientEventId: string,
    page: number | null,
    percent: number | null,
    minutes: number | null,
    note?: string | null,
    audioSeconds?: number | null,
  ): Promise<Read> {
    const [owner] = await this.db
      .select({ userId: reads.userId, startedAt: reads.startedAt })
      .from(reads)
      .where(eq(reads.id, readId))
      .limit(1);

    if (!owner || owner.userId !== viewer) throw ApiError.notFound('No such read.');

    await this.db.execute(sql`
      INSERT INTO progress_events (read_id, page, percent, minutes, note, audio_seconds, client_event_id)
      VALUES (${readId}, ${page}, ${percent}, ${minutes}, ${note ?? null}, ${audioSeconds ?? null}, ${clientEventId})
      ON CONFLICT (client_event_id) DO NOTHING
    `);

    if (!owner.startedAt) {
      await this.db.execute(sql`
        UPDATE reads SET started_at = CURRENT_DATE, updated_at = now() WHERE id = ${readId}
      `);
    } else {
      await this.db.execute(sql`
        UPDATE reads SET updated_at = now() WHERE id = ${readId}
      `);
    }

    const read = await this.get(viewer, readId);
    if (!read) throw ApiError.notFound('No such read.');
    return read;
  }
}

export function readingRoutes(service: ReadingService) {
  return async (app: FastifyInstance) => {
    // Current user's reads (authenticated)
    app.get<{ Querystring: { status?: string } }>(
      '/reads',
      {
        schema: {
          tags: ['Reading'],
          summary: 'List my reads',
          description: 'Returns the authenticated viewer’s reading attempts, ordered by updated_at descending.',
          security: [{ BearerAuth: [] }],
          querystring: statusQuerySchema,
          response: {
            200: readListResponseSchema,
            401: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const { status } = req.query;
        if (status && !STATUSES.includes(status as Status)) {
          throw ApiError.unprocessable('invalid_status', 'Unknown status filter.', 'status');
        }
        return { data: await service.list(viewer, viewer, status) };
      },
    );

    // Single read attempt by ID (optional auth: guest viewer is null)
    app.get<{ Params: { id: string } }>(
      '/reads/:id',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Get read attempt',
          description: 'Returns reading attempt details if authorized. Returns 404 for private reads (Architecture §4).',
          params: idParamSchema,
          response: {
            200: readSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const read = await service.get(req.viewer, req.params.id);
        if (!read) throw ApiError.notFound('No such read.');
        return read;
      },
    );

    // Another user's public reads (optional auth: guest viewer is null)
    app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
      '/users/:id/reads',
      {
        schema: {
          tags: ['Reading'],
          summary: 'List user public reads',
          description: 'Returns public reads for a user. Private accounts return empty list for non-followers.',
          params: idParamSchema,
          querystring: statusQuerySchema,
          response: {
            200: readListResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const { status } = req.query;
        if (status && !STATUSES.includes(status as Status)) {
          throw ApiError.unprocessable('invalid_status', 'Unknown status filter.', 'status');
        }
        return { data: await service.list(req.viewer, req.params.id, status) };
      },
    );

    app.post(
      '/reads',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Log or update read attempt',
          description: 'Creates or updates reading attempt. Starting a finished/dnf book creates attempt_no + 1 (PRD §8.1).',
          security: [{ BearerAuth: [] }],
          body: upsertReadBodySchema,
          response: {
            200: readSchema,
            401: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const parsed = upsertBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable(
            'invalid_field',
            issue?.message ?? 'Check that.',
            String(issue?.path[0] ?? ''),
          );
        }
        const {
          work_id,
          status,
          edition_id,
          started_at,
          finished_at,
          abandoned_page,
          dnf_reason,
          rating,
          hearted,
          format_override,
          visibility,
        } = parsed.data;
        return service.upsert(viewer, work_id, status, rating, hearted, visibility, {
          editionId: edition_id,
          startedAt: started_at,
          finishedAt: finished_at,
          abandonedPage: abandoned_page,
          dnfReason: dnf_reason,
          formatOverride: format_override,
        });
      },
    );

    app.post<{ Params: { id: string } }>(
      '/reads/:id/progress',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Record reading progress',
          description: 'Appends a progress event. Idempotent on client_event_id for offline replay (PRD §8.3).',
          security: [{ BearerAuth: [] }],
          params: idParamSchema,
          body: progressEventBodySchema,
          response: {
            200: readSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const parsed = progressBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable(
            'invalid_progress',
            issue?.message ?? 'Check that.',
            String(issue?.path[0] ?? ''),
          );
        }
        const { client_event_id, page, percent, minutes, note, audio_seconds } = parsed.data;
        return service.addProgress(
          viewer,
          req.params.id,
          client_event_id,
          page ?? null,
          percent ?? null,
          minutes ?? null,
          note ?? null,
          audio_seconds ?? null,
        );
      },
    );

    // Atomically finish a read (PRD §6.17, §3389)
    app.post<{ Params: { id: string } }>(
      '/reads/:id/finish',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Finish reading attempt',
          description: 'Completes a read with finished_at, rating, hearted, and format_override in one call (PRD §6.17).',
          security: [{ BearerAuth: [] }],
          params: idParamSchema,
          body: finishReadBodySchema,
          response: {
            200: readSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const parsed = finishBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable(
            'invalid_finish',
            issue?.message ?? 'Check that.',
            String(issue?.path[0] ?? ''),
          );
        }
        const { finished_at, rating, hearted, format_override, review, visibility } = parsed.data;
        return service.finish(viewer, req.params.id, {
          finishedAt: finished_at,
          rating,
          hearted,
          formatOverride: format_override,
          review,
          visibility,
        });
      },
    );

    // Mark as stopped/DNF (PRD §6.18)
    app.post<{ Params: { id: string } }>(
      '/reads/:id/dnf',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Mark read as stopped (DNF)',
          description: 'Records abandonment respectfully with abandoned_page and dnf_reason (PRD §6.18).',
          security: [{ BearerAuth: [] }],
          params: idParamSchema,
          body: dnfReadBodySchema,
          response: {
            200: readSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const parsed = dnfBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable(
            'invalid_dnf',
            issue?.message ?? 'Check that.',
            String(issue?.path[0] ?? ''),
          );
        }
        const { abandoned_page, dnf_reason, note, rating, visibility } = parsed.data;
        return service.dnf(viewer, req.params.id, {
          abandonedPage: abandoned_page,
          dnfReason: dnf_reason,
          note,
          rating,
          visibility,
        });
      },
    );
  };
}
