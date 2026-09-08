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
import { reads, works, progressEvents } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';

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
  work_id: z.uuid(),
  status: z.enum(STATUSES),
  rating: ratingSchema.nullish(),
  hearted: z.boolean().nullish(),
});

const progressBody = z
  .object({
    client_event_id: z.uuid(),
    page: z.number().int().min(0).nullish(),
    percent: z.number().min(0).max(100).nullish(),
    minutes: z.number().int().min(0).nullish(),
  })
  .refine((b) => b.page != null || b.percent != null, {
    message: 'Send a page or a percent.',
  });

export type Read = {
  id: string;
  work_id: string;
  status: string;
  attempt_no: number;
  rating: number | null;
  hearted: boolean;
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
          INSERT INTO reads (user_id, work_id, status, attempt_no, started_at, finished_at, rating, hearted)
          VALUES (
            ${viewer}, ${workId}, ${status}, ${(existing?.attemptNo ?? 0) + 1},
            CASE WHEN ${status} IN ('reading','finished') THEN CURRENT_DATE END,
            CASE WHEN ${status} = 'finished' THEN CURRENT_DATE END,
            ${rating ?? null}, ${hearted ?? false}
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
            status      = ${status},
            started_at  = COALESCE(started_at, CASE WHEN ${status} IN ('reading','finished') THEN CURRENT_DATE END),
            finished_at = CASE WHEN ${status} = 'finished' THEN COALESCE(finished_at, CURRENT_DATE) ELSE finished_at END,
            rating      = COALESCE(${rating ?? null}, rating),
            hearted     = COALESCE(${hearted ?? null}, hearted),
            updated_at  = now()
          WHERE id = ${id}
        `);
      }

      const read = await this.#get(tx as unknown as Db, viewer, id);
      if (!read) throw new Error('read vanished mid-transaction');
      return read;
    });
  }

  /** Returns null for another user's read — the route turns that into a 404, never a 403. */
  async get(viewer: string, id: string): Promise<Read | null> {
    return this.#get(this.db, viewer, id);
  }

  async #get(db: Db, viewer: string, id: string): Promise<Read | null> {
    const [row] = await db
      .select({
        id: reads.id,
        workId: reads.workId,
        status: reads.status,
        attemptNo: reads.attemptNo,
        rating: reads.rating,
        hearted: reads.hearted,
      })
      .from(reads)
      .where(sql`${reads.id} = ${id} AND ${reads.userId} = ${viewer}`)
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      work_id: row.workId,
      status: row.status,
      attempt_no: row.attemptNo,
      rating: row.rating === null ? null : Number(row.rating),
      hearted: row.hearted,
    };
  }

  /** Powers the Reading tab and the Diary. */
  async list(viewer: string, status?: string): Promise<Read[]> {
    const rows = await this.db.execute<{
      id: string; work_id: string; status: string; attempt_no: number;
      rating: string | null; hearted: boolean;
      title: string; author_name: string | null; cover_id: number | null;
      page: number | null; percent: string | null; page_count: number | null;
    }>(sql`
      SELECT r.id, r.work_id, r.status, r.attempt_no, r.rating, r.hearted,
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
      WHERE r.user_id = ${viewer}
        AND (${status ?? null}::text IS NULL OR r.status = ${status ?? null})
      ORDER BY r.updated_at DESC
    `);

    return rows.map((r) => ({
      id: r.id,
      work_id: r.work_id,
      status: r.status,
      attempt_no: Number(r.attempt_no),
      rating: r.rating === null ? null : Number(r.rating),
      hearted: r.hearted,
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
  ): Promise<Read> {
    const [owner] = await this.db
      .select({ userId: reads.userId })
      .from(reads)
      .where(eq(reads.id, readId))
      .limit(1);

    if (!owner || owner.userId !== viewer) throw ApiError.notFound('No such read.');

    await this.db.execute(sql`
      INSERT INTO progress_events (read_id, page, percent, minutes, client_event_id)
      VALUES (${readId}, ${page}, ${percent}, ${minutes}, ${clientEventId})
      ON CONFLICT (client_event_id) DO NOTHING
    `);

    const read = await this.get(viewer, readId);
    if (!read) throw ApiError.notFound('No such read.');
    return read;
  }
}

export function readingRoutes(service: ReadingService) {
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { status?: string } }>('/reads', async (req) => {
      const viewer = requireViewer(req);
      const { status } = req.query;
      if (status && !STATUSES.includes(status as Status)) {
        throw ApiError.unprocessable('invalid_status', 'Unknown status filter.', 'status');
      }
      return { data: await service.list(viewer, status) };
    });

    app.post('/reads', async (req) => {
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
      const { work_id, status, rating, hearted } = parsed.data;
      return service.upsert(viewer, work_id, status, rating, hearted);
    });

    app.post<{ Params: { id: string } }>('/reads/:id/progress', async (req) => {
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
      const { client_event_id, page, percent, minutes } = parsed.data;
      return service.addProgress(
        viewer,
        req.params.id,
        client_event_id,
        page ?? null,
        percent ?? null,
        minutes ?? null,
      );
    });
  };
}
