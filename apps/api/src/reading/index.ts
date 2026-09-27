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
import { reads, works, progressEvents, profiles, editions } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { resolveWorkId } from '../catalog/resolve.js';
import { type Visibility, VISIBILITIES, canViewWith, loadRelationship, visibleLevels } from '../authorization/index.js';
import {
  readSchema,
  readListResponseSchema,
  statusQuerySchema,
  idParamSchema,
  upsertReadBodySchema,
  progressEventBodySchema,
  finishReadBodySchema,
  dnfReadBodySchema,
  readingStatsQuerySchema,
  readingStatsResponseSchema,
  deleteReadResponseSchema,
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

/**
 * A calendar date, YYYY-MM-DD, that exists (2026-02-30 does not) and is not
 * in the future. "Today" is the user's, not the server's (PRD §8.5): a finish
 * logged at 00:30 in Auckland is already tomorrow in UTC, so up to one day
 * ahead of the server's UTC date is accepted and anything later is refused.
 * Before this, a bad string reached `::date` and came back as the database's
 * generic 422 ("A date is out of range"), with no field (audit 08).
 */
const readDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD.')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`))
    && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'That date does not exist.')
  .refine((d) => d <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), 'That date is in the future.');

const upsertBody = z.object({
  work_id: z.string().uuid(),
  status: z.enum(STATUSES),
  edition_id: z.string().uuid().nullish(),
  started_at: readDate.nullish(),
  finished_at: readDate.nullish(),
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
    // Optional and never prompted (§8.4); one day at most, so a typo cannot
    // wreck a reading-speed statistic or overflow the integer (audit 08).
    minutes: z.number().int().min(0).max(1440).nullish(),
    note: z.string().max(280).nullish(),
  })
  .refine((b) => b.page != null || b.percent != null || b.audio_seconds != null, {
    message: 'Send a page, percent, or audio_seconds.',
  });

const finishBody = z.object({
  finished_at: readDate.nullish(),
  rating: ratingSchema.nullish(),
  hearted: z.boolean().nullish(),
  format_override: z.enum(['print', 'ebook', 'audiobook']).nullish(),
  // Refused, not dropped (audit 08, A-07-006): a review is published with
  // POST /reads/:id/review, which applies the verified-email gate and the
  // review rules. The app has queued it that way since Part 07.
  review: z.null({ message: 'Publish a review with POST /reads/{id}/review, not with the finish.' }).optional(),
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
  dnf_note?: string | null;
  rating: number | null;
  hearted: boolean;
  format_override?: string | null;
  visibility: Visibility;
  source?: string;
  title?: string;
  author_name?: string;
  cover_id?: number | null;
  page?: number | null;
  percent?: number | null;
  page_count?: number | null;
};

import { ActivityService } from '../activity/index.js';

/**
 * PRD §8.1 / §8.2 [LOCKED]: `finished` and `dnf` are terminal. Moving a
 * terminal attempt to any OTHER status is a new attempt, so a finished or
 * abandoned record is never overwritten: a DNF followed by a finish is two
 * rows (§6.18, §34.2), a finished book started again is a re-read (§6.17).
 * The same status again edits the attempt (a rating changed later, §34.2).
 * Non-terminal statuses move freely within one attempt.
 *
 * The mobile app applies the same rule offline (saveReadStatus).
 */
export function startsNewAttempt(current: Status | null, next: Status): boolean {
  if (current === null) return true;
  return (current === 'finished' || current === 'dnf') && next !== current;
}

/**
 * The activity a status change writes. `paused` is silent (§8.2). `want` is
 * "low, aggregated", which the feed cannot express yet (Part 14), so it writes
 * none rather than telling followers the book was started.
 */
function verbFor(status: Status): 'started' | 'finished' | 'dnf' | null {
  return status === 'reading' ? 'started' : status === 'finished' ? 'finished' : status === 'dnf' ? 'dnf' : null;
}

/** A CHECK violation on reads_dates_ck. §8.5 wants a clear message, not the generic "A value is out of range". */
function isDateOrderViolation(err: unknown): boolean {
  let e = err as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 5; depth++) {
    if (e.code === '23514' && (e.constraint_name ?? e.constraint) === 'reads_dates_ck') return true;
    e = e.cause as typeof e;
  }
  return false;
}

const dateOrderError = () =>
  ApiError.unprocessable('invalid_date', 'Finish date cannot be earlier than started date.', 'finished_at');

type AttemptRow = {
  id: string; user_id: string; work_id: string; status: Status; attempt_no: number;
  started_at: string | null; finished_at: string | null; source: string; visibility: Visibility;
};

export class ReadingService {
  private activityService: ActivityService;

  constructor(private db: Db) {
    this.activityService = new ActivityService(db);
  }

  /**
   * Creates or updates the current attempt of a work (see startsNewAttempt).
   *
   * One transaction: the work id is resolved to the survivor of a dedupe
   * merge under a lock (D3), attempts for this user and work are serialised
   * (SL-56: two concurrent starts could compute the same attempt_no), and
   * activity is written only when the status changes.
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
    try {
      return await this.db.transaction(async (tx) => {
        const db = tx as unknown as Db;
        const resolved = await resolveWorkId(db, workId, { lock: true });
        if (!resolved) throw ApiError.notFound('No such work.');
        await this.#lockAttempts(db, viewer, resolved);

        const [existing] = await db.execute<{ id: string; status: Status; attempt_no: number }>(sql`
          SELECT id, status, attempt_no FROM reads
          WHERE user_id = ${viewer} AND work_id = ${resolved}
          ORDER BY attempt_no DESC LIMIT 1`);

        if (startsNewAttempt(existing?.status ?? null, status)) {
          const id = await this.#insertAttempt(db, viewer, resolved, status, Number(existing?.attempt_no ?? 0) + 1, {
            rating, hearted, visibility, ...extra,
          });
          return this.#afterWrite(db, viewer, id, { statusChanged: true, visibilityChanged: false });
        }

        const current = existing!;
        await db.execute(sql`
          UPDATE reads SET
            status          = ${status},
            edition_id      = COALESCE(${extra?.editionId ?? null}, edition_id),
            started_at      = COALESCE(${extra?.startedAt ?? null}::date, started_at, CASE WHEN ${status} IN ('reading','finished') THEN CURRENT_DATE END),
            finished_at     = CASE WHEN ${status} = 'finished' THEN COALESCE(${extra?.finishedAt ?? null}::date, finished_at, CURRENT_DATE) ELSE finished_at END,
            abandoned_at    = CASE WHEN ${status} = 'dnf' THEN COALESCE(abandoned_at, CURRENT_DATE) ELSE abandoned_at END,
            abandoned_page  = COALESCE(${extra?.abandonedPage ?? null}, abandoned_page),
            dnf_reason      = COALESCE(${extra?.dnfReason ?? null}, dnf_reason),
            rating          = COALESCE(${rating ?? null}, rating),
            hearted         = COALESCE(${hearted ?? null}, hearted),
            format_override = COALESCE(${extra?.formatOverride ?? null}, format_override),
            visibility      = COALESCE(${visibility ?? null}, visibility),
            updated_at      = now()
          WHERE id = ${current.id}
        `);
        return this.#afterWrite(db, viewer, current.id, {
          statusChanged: current.status !== status,
          visibilityChanged: visibility != null,
        });
      });
    } catch (err) {
      if (isDateOrderViolation(err)) throw dateOrderError();
      throw err;
    }
  }

  /**
   * Finishes a read attempt in one transaction (PRD §6.17).
   *
   *   want / reading / paused    → this attempt becomes finished; one activity.
   *   finished, same or no date  → an edit (a replay, a double tap, a rating
   *                                changed later): no new row, no activity.
   *   finished, another date     → a re-read: a new finished attempt (§6.17).
   *   dnf                        → a new finished attempt; the DNF stays (§6.18).
   */
  async finish(
    viewer: string,
    readId: string,
    opts: {
      finishedAt?: string | null;
      rating?: number | null;
      hearted?: boolean | null;
      formatOverride?: string | null;
      visibility?: Visibility | null;
    },
  ): Promise<Read> {
    try {
      return await this.db.transaction(async (tx) => {
        const db = tx as unknown as Db;
        const read = await this.#lockOwnRead(db, viewer, readId);
        const finishedAt = opts.finishedAt ?? null;

        const newAttempt = read.status === 'dnf'
          || (read.status === 'finished' && finishedAt !== null && finishedAt !== read.finished_at);
        if (newAttempt) {
          const id = await this.#insertAttempt(db, viewer, read.work_id, 'finished', await this.#nextAttempt(db, viewer, read.work_id), {
            rating: opts.rating, hearted: opts.hearted, visibility: opts.visibility ?? read.visibility,
            finishedAt, formatOverride: opts.formatOverride,
          });
          return this.#afterWrite(db, viewer, id, { statusChanged: true, visibilityChanged: false });
        }

        if (finishedAt && read.started_at && finishedAt < read.started_at) throw dateOrderError();
        await db.execute(sql`
          UPDATE reads SET
            status = 'finished',
            finished_at = COALESCE(${finishedAt}::date, finished_at, CURRENT_DATE),
            -- Never after the finish: a want finished with a past date used
            -- to get started_at = today, trip reads_dates_ck and be refused.
            started_at = COALESCE(started_at, ${finishedAt}::date, finished_at, CURRENT_DATE),
            rating = COALESCE(${opts.rating ?? null}, rating),
            hearted = COALESCE(${opts.hearted ?? null}, hearted),
            format_override = COALESCE(${opts.formatOverride ?? null}, format_override),
            visibility = COALESCE(${opts.visibility ?? null}, visibility),
            updated_at = now()
          WHERE id = ${readId}
        `);
        return this.#afterWrite(db, viewer, readId, {
          statusChanged: read.status !== 'finished',
          visibilityChanged: opts.visibility != null,
        });
      });
    } catch (err) {
      if (isDateOrderViolation(err)) throw dateOrderError();
      throw err;
    }
  }

  /**
   * Marks a read attempt as stopped (DNF) with neutral copy and reason (PRD §6.18).
   * A finished attempt is never overwritten: stopping it records a new attempt.
   * Stopping a DNF again edits it, with no new activity.
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
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const read = await this.#lockOwnRead(db, viewer, readId);

      if (read.status === 'finished') {
        const id = await this.#insertAttempt(db, viewer, read.work_id, 'dnf', await this.#nextAttempt(db, viewer, read.work_id), {
          rating: opts.rating, visibility: opts.visibility ?? read.visibility,
          abandonedPage: opts.abandonedPage, dnfReason: opts.dnfReason, dnfNote: opts.note,
        });
        return this.#afterWrite(db, viewer, id, { statusChanged: true, visibilityChanged: false });
      }

      await db.execute(sql`
        UPDATE reads SET
          status = 'dnf',
          abandoned_at = COALESCE(abandoned_at, CURRENT_DATE),
          abandoned_page = COALESCE(${opts.abandonedPage ?? null}, abandoned_page),
          dnf_reason = COALESCE(${opts.dnfReason ?? null}, dnf_reason),
          dnf_note = COALESCE(${opts.note ?? null}, dnf_note),
          rating = COALESCE(${opts.rating ?? null}, rating),
          visibility = COALESCE(${opts.visibility ?? null}, visibility),
          updated_at = now()
        WHERE id = ${readId}
      `);
      return this.#afterWrite(db, viewer, readId, {
        statusChanged: read.status !== 'dnf',
        visibilityChanged: opts.visibility != null,
      });
    });
  }

  /**
   * Deletes one of the viewer's reads (PRD §34.2 "Deleting a finished read";
   * SL-57's "remove from want to read"). Its progress history, likes,
   * comments and review go with it (foreign keys cascade); its activity and
   * its review's activity are removed here, because activity has no foreign
   * key to what it describes. The reads triggers then recompute work_stats and
   * the reader count. Someone else's read, or one already deleted, is a 404.
   */
  async delete(viewer: string, readId: string): Promise<{ deleted: true; id: string }> {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await this.#lockOwnRead(db, viewer, readId);
      await db.execute(sql`
        DELETE FROM activity
        WHERE (object_type = 'read' AND object_id = ${readId})
           OR (object_type = 'review' AND object_id IN (SELECT id FROM reviews WHERE read_id = ${readId}))`);
      await db.execute(sql`DELETE FROM reads WHERE id = ${readId}`);
      return { deleted: true as const, id: readId };
    });
  }

  /** SL-56: one writer at a time decides the next attempt for (user, work). Released at commit. */
  async #lockAttempts(db: Db, viewer: string, workId: string): Promise<void> {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reads:${viewer}:${workId}`}, 0))`);
  }

  async #nextAttempt(db: Db, viewer: string, workId: string): Promise<number> {
    await this.#lockAttempts(db, viewer, workId);
    const [max] = await db.execute<{ n: number }>(sql`
      SELECT max(attempt_no)::int AS n FROM reads WHERE user_id = ${viewer} AND work_id = ${workId}`);
    return Number(max?.n ?? 0) + 1;
  }

  /** The viewer's own read, locked for the transaction; anyone else's is a 404, never a 403. */
  async #lockOwnRead(db: Db, viewer: string, readId: string): Promise<AttemptRow> {
    const [read] = await db.execute<AttemptRow>(sql`
      SELECT id, user_id, work_id, status, attempt_no,
             started_at::text AS started_at, finished_at::text AS finished_at, source, visibility
      FROM reads WHERE id = ${readId} FOR UPDATE`);
    if (!read || read.user_id !== viewer) throw ApiError.notFound('No such read.');
    return read;
  }

  async #insertAttempt(
    db: Db,
    viewer: string,
    workId: string,
    status: Status,
    attemptNo: number,
    v: {
      rating?: number | null; hearted?: boolean | null; visibility?: Visibility | null;
      editionId?: string | null; startedAt?: string | null; finishedAt?: string | null;
      abandonedPage?: number | null; dnfReason?: string | null; dnfNote?: string | null;
      formatOverride?: string | null;
    },
  ): Promise<string> {
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO reads (
        user_id, work_id, edition_id, status, attempt_no,
        started_at, finished_at, abandoned_at, abandoned_page, dnf_reason, dnf_note,
        rating, hearted, format_override, visibility
      )
      VALUES (
        ${viewer}, ${workId}, ${v.editionId ?? null}, ${status}, ${attemptNo},
        -- A finish logged with a past date and no start starts that day, not
        -- today, which would fail reads_dates_ck and refuse a valid log.
        COALESCE(${v.startedAt ?? null}::date,
                 CASE WHEN ${status} = 'finished' THEN COALESCE(${v.finishedAt ?? null}::date, CURRENT_DATE)
                      WHEN ${status} = 'reading' THEN CURRENT_DATE END),
        COALESCE(${v.finishedAt ?? null}::date, CASE WHEN ${status} = 'finished' THEN CURRENT_DATE END),
        CASE WHEN ${status} = 'dnf' THEN CURRENT_DATE END,
        ${v.abandonedPage ?? null},
        ${v.dnfReason ?? null},
        ${v.dnfNote ?? null},
        ${v.rating ?? null}, ${v.hearted ?? false}, ${v.formatOverride ?? null}, ${v.visibility ?? 'public'}
      )
      RETURNING id
    `);
    if (!row) throw new Error('insert returned no row');
    // works.reader_count (and so log_count) is kept by the reads trigger:
    // distinct readers, so a re-read does not count again (0026).
    return row.id;
  }

  /**
   * Activity for a write, in the write's transaction. A new row only when the
   * status changed: a rating, heart or date edit writes none (§34.2), and a
   * replayed or double-tapped finish writes one, not two. A visibility change
   * is carried to the read's existing activity (private removes it).
   */
  async #afterWrite(
    db: Db,
    viewer: string,
    readId: string,
    change: { statusChanged: boolean; visibilityChanged: boolean },
  ): Promise<Read> {
    const read = await this.#get(db, viewer, readId);
    if (!read) throw new Error('read vanished mid-transaction');
    if ((read.source ?? 'app') === 'import') return read;

    if (change.visibilityChanged) {
      await this.activityService.updateActivityVisibility(
        db, 'read', read.id, await this.#activityVisibility(db, viewer, read.visibility));
    }
    const verb = change.statusChanged ? verbFor(read.status as Status) : null;
    if (verb) {
      await this.activityService.recordActivity(db, {
        actorId: viewer,
        verb,
        workId: read.work_id,
        objectType: 'read',
        objectId: read.id,
        metadata: verb === 'dnf'
          ? { abandonedPage: read.abandoned_page, dnfReason: read.dnf_reason, attemptNo: read.attempt_no }
          : { rating: read.rating, attemptNo: read.attempt_no, finishedAt: read.finished_at },
        visibility: read.visibility,
        source: read.source ?? 'app',
      });
    }
    return read;
  }

  /** What recordActivity stores: a private account's activity is followers-only (PRD §26.2). */
  async #activityVisibility(db: Db, viewer: string, visibility: Visibility): Promise<Visibility> {
    if (visibility === 'private') return 'private';
    const [p] = await db
      .select({ isPrivate: profiles.isPrivate })
      .from(profiles)
      .where(eq(profiles.userId, viewer))
      .limit(1);
    return p?.isPrivate ? 'followers' : visibility;
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
        dnfNote: reads.dnfNote,
        rating: reads.rating,
        hearted: reads.hearted,
        formatOverride: reads.formatOverride,
        visibility: reads.visibility,
        source: reads.source,
        isPrivate: profiles.isPrivate,
      })
      .from(reads)
      .innerJoin(profiles, eq(reads.userId, profiles.userId))
      .where(eq(reads.id, id))
      .limit(1);

    if (!row) return null;

    const rel = await loadRelationship(db, viewer, row.userId);
    if (!canViewWith(viewer, row.userId, rel, row.visibility)) return null;

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
      dnf_note: row.dnfNote,
      rating: row.rating === null ? null : Number(row.rating),
      hearted: row.hearted,
      format_override: row.formatOverride,
      visibility: row.visibility as Visibility,
      source: row.source,
    };
  }

  /**
   * Powers the Reading tab, the Diary, and public profiles.
   * Viewer ID is a required argument (FN-70).
   * Returns only reads the viewer is authorized to see via canView.
   */
  async list(viewer: string | null, userId: string, status?: string): Promise<Read[]> {
    // Which visibilities this viewer may see, derived from canView() itself,
    // so an accepted follower gets followers-only reads (Audit 05).
    const rel = await loadRelationship(this.db, viewer, userId);
    const levels = visibleLevels(viewer, userId, rel);
    if (levels.length === 0) return [];
    const levelList = sql.join(levels.map((l) => sql`${l}`), sql`, `);

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
             -- The cover of the edition this person is reading, else the
             -- work's own (denormalised at ingest for exactly this), else the
             -- newest edition's. COALESCE is lazy, so the edition scan runs
             -- only for the ~1% with neither. It used to run for every row,
             -- sorting all of a popular work's editions (audit 08: 2.3 s and
             -- 133k buffers for a 628-read user on flyleaf_dev).
             COALESCE(re.ol_cover_id, w.ol_cover_id,
               (SELECT e.ol_cover_id
                  FROM editions e
                 WHERE e.work_id = w.id AND e.ol_cover_id IS NOT NULL
                 ORDER BY e.publish_year DESC NULLS LAST
                 LIMIT 1)) AS cover_id,
             pe.page, pe.percent,
             CASE WHEN r.edition_id IS NOT NULL THEN re.page_count
                  ELSE (SELECT page_count FROM editions e
                         WHERE e.work_id = r.work_id
                         ORDER BY page_count NULLS LAST LIMIT 1) END AS page_count
      FROM reads r
      JOIN works w ON w.id = r.work_id
      LEFT JOIN editions re ON re.id = r.edition_id
      LEFT JOIN LATERAL (
        SELECT page, percent FROM progress_events
        WHERE read_id = r.id ORDER BY at DESC LIMIT 1
      ) pe ON true
      WHERE r.user_id = ${userId}
        AND r.visibility IN (${levelList})
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

    const inserted = await this.db.execute<{ read_id: string }>(sql`
      INSERT INTO progress_events (read_id, page, percent, minutes, note, audio_seconds, client_event_id)
      VALUES (${readId}, ${page}, ${percent}, ${minutes}, ${note ?? null}, ${audioSeconds ?? null}, ${clientEventId})
      ON CONFLICT (client_event_id) DO NOTHING
      RETURNING read_id
    `);
    if (inserted.length === 0) {
      // A replay onto the same read is the idempotent success. The id is
      // globally unique, so one spent on another read (or another user's) is a
      // client bug the queue must surface, not a write to drop (Audit 07).
      const [existing] = await this.db.execute<{ read_id: string }>(sql`
        SELECT read_id FROM progress_events WHERE client_event_id = ${clientEventId}
      `);
      if (existing && existing.read_id !== readId) {
        throw ApiError.conflict('client_event_conflict', 'This client_event_id was already used for another read.');
      }
    }

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

  async getStats(
    viewer: string | null,
    userId: string,
    yearParam?: string,
  ): Promise<any> {
    const rel = await loadRelationship(this.db, viewer, userId);
      if (!canViewWith(viewer, userId, rel)) throw ApiError.notFound('User not found.');

      const currentYear = new Date().getFullYear();
      const yearStr = yearParam && (yearParam === 'all' || /^\d{4}$/.test(yearParam)) ? yearParam : String(currentYear);
      const isAllTime = yearStr === 'all';
      const selectedYear = isAllTime ? null : Number(yearStr);

      const userReads = await this.db
        .select({
          id: reads.id,
          workId: reads.workId,
          editionId: reads.editionId,
          status: reads.status,
          startedAt: reads.startedAt,
          finishedAt: reads.finishedAt,
          abandonedAt: reads.abandonedAt,
          rating: reads.rating,
          formatOverride: reads.formatOverride,
          title: works.title,
          coverId: sql<number | null>`COALESCE(
            ${editions.olCoverId},
            ${works.olCoverId},
            (SELECT e.ol_cover_id FROM editions e WHERE e.work_id = works.id AND e.ol_cover_id IS NOT NULL LIMIT 1)
          )`.as('cover_id'),
          pageCount: sql<number | null>`COALESCE(
            ${editions.pageCount},
            (SELECT e.page_count FROM editions e WHERE e.work_id = works.id AND e.page_count IS NOT NULL LIMIT 1)
          )`.as('page_count'),
          authorName: sql<string>`COALESCE((
            SELECT a.name
            FROM work_authors wa JOIN authors a ON a.id = wa.author_id
            WHERE wa.work_id = works.id
            ORDER BY wa.position, a.name
            LIMIT 1
          ), 'Unknown Author')`.as('author_name'),
          visibility: reads.visibility,
        })
        .from(reads)
        .innerJoin(works, eq(reads.workId, works.id))
        .leftJoin(editions, eq(reads.editionId, editions.id))
        .where(eq(reads.userId, userId));

      const visibleReads = userReads.filter((r) =>
        // With the relationship: a follower's stats include followers-only reads.
        canViewWith(viewer, userId, rel, r.visibility),
      );

      const finishedInYear = visibleReads.filter((r) => {
        if (r.status !== 'finished') return false;
        if (isAllTime) return true;
        if (!r.finishedAt) return false;
        return new Date(r.finishedAt).getFullYear() === selectedYear;
      });

      const dnfInYear = visibleReads.filter((r) => {
        if (r.status !== 'dnf') return false;
        if (isAllTime) return true;
        const d = r.abandonedAt ? new Date(r.abandonedAt).getFullYear() : null;
        return d === selectedYear;
      });

      const monthlyPace = Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        books: 0,
        pages: 0,
      }));

      for (const r of finishedInYear) {
        if (r.finishedAt) {
          const m = new Date(r.finishedAt).getMonth();
          const item = monthlyPace[m];
          if (item) {
            item.books += 1;
            item.pages += r.pageCount ?? 0;
          }
        }
      }

      const booksCount = finishedInYear.length;
      const pagesCount = finishedInYear.reduce((acc, r) => acc + (r.pageCount ?? 0), 0);

      const audioQuery = await this.db.execute<{ total_seconds: string | number }>(sql`
        SELECT COALESCE(SUM(pe.audio_seconds), 0) as total_seconds
        FROM progress_events pe
        JOIN reads r ON pe.read_id = r.id
        WHERE r.user_id = ${userId}
        ${selectedYear ? sql`AND EXTRACT(YEAR FROM pe.at) = ${selectedYear}` : sql``}
      `);
      const audioRows = (audioQuery as any)?.rows ?? (audioQuery as any);
      const audioSeconds = Number(audioRows?.[0]?.total_seconds ?? 0);
      const audioHours = Math.round((audioSeconds / 3600) * 10) / 10;

      const ratedReads = finishedInYear.filter((r) => r.rating !== null);
      const avgRating =
        ratedReads.length > 0
          ? Math.round(
              (ratedReads.reduce((sum, r) => sum + Number(r.rating), 0) / ratedReads.length) * 100
            ) / 100
          : null;

      const ratingDistribution: Record<string, number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
      for (const r of ratedReads) {
        const rounded = Math.min(5, Math.max(1, Math.round(Number(r.rating))));
        const key = String(rounded);
        ratingDistribution[key] = (ratingDistribution[key] ?? 0) + 1;
      }

      const formatBreakdown = { print: 0, ebook: 0, audiobook: 0 };
      for (const r of finishedInYear) {
        const fmt = r.formatOverride ?? 'print';
        if (fmt === 'ebook') {
          formatBreakdown.ebook += 1;
        } else if (fmt === 'audiobook') {
          formatBreakdown.audiobook += 1;
        } else {
          formatBreakdown.print += 1;
        }
      }

      const booksWithPages = finishedInYear.filter((r) => (r.pageCount ?? 0) > 0);
      booksWithPages.sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0));

      const longest = booksWithPages[0];
      const longestBook = longest ? {
        work_id: longest.workId,
        title: longest.title,
        author_name: longest.authorName,
        page_count: longest.pageCount,
        cover_id: longest.coverId,
      } : null;

      const shortest = booksWithPages[booksWithPages.length - 1];
      const shortestBook = shortest ? {
        work_id: shortest.workId,
        title: shortest.title,
        author_name: shortest.authorName,
        page_count: shortest.pageCount,
        cover_id: shortest.coverId,
      } : null;

      const authorCounts = new Map<string, number>();
      for (const r of finishedInYear) {
        if (r.authorName) {
          authorCounts.set(r.authorName, (authorCounts.get(r.authorName) ?? 0) + 1);
        }
      }
      let mostReadAuthor: { name: string; count: number } | null = null;
      for (const [name, count] of authorCounts.entries()) {
        if (!mostReadAuthor || count > mostReadAuthor.count) {
          mostReadAuthor = { name, count };
        }
      }

      const dnfCount = dnfInYear.length;
      const totalFinishedOrDnf = booksCount + dnfCount;
      const dnfRate = totalFinishedOrDnf > 0 ? Math.round((dnfCount / totalFinishedOrDnf) * 100) / 100 : 0;

      const activityDatesRes = await this.db.execute<{ activity_date: string }>(sql`
        SELECT DISTINCT to_char(pe.at, 'YYYY-MM-DD') as activity_date
        FROM progress_events pe
        JOIN reads r ON pe.read_id = r.id
        WHERE r.user_id = ${userId}
        UNION
        SELECT DISTINCT finished_at::text as activity_date
        FROM reads
        WHERE user_id = ${userId} AND finished_at IS NOT NULL
        ORDER BY activity_date DESC
      `);
      const activityRows = (activityDatesRes as any)?.rows ?? (activityDatesRes as any);
      const dateStrings = (Array.isArray(activityRows) ? activityRows : []).map((r: any) => r.activity_date);
      const { currentStreak, longestStreak } = computeStreaks(dateStrings);

      return {
        year: yearStr,
        books_count: booksCount,
        pages_count: pagesCount,
        audio_hours: audioHours,
        avg_rating: avgRating,
        rating_distribution: ratingDistribution,
        format_breakdown: formatBreakdown,
        monthly_pace: monthlyPace,
        longest_book: longestBook,
        shortest_book: shortestBook,
        most_read_author: mostReadAuthor,
        dnf_count: dnfCount,
        dnf_rate: dnfRate,
        current_streak: currentStreak,
        longest_streak: longestStreak,
      };
  }
}

export function computeStreaks(dateStrings: string[]): { currentStreak: number; longestStreak: number } {
  if (dateStrings.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  const uniqueDates = Array.from(new Set(dateStrings)).sort().reverse();
  const dateObjs = uniqueDates.map((d) => new Date(`${d}T00:00:00Z`));

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let currentStreak = 0;
  if (uniqueDates.includes(todayStr) || uniqueDates.includes(yesterdayStr)) {
    let expected = uniqueDates.includes(todayStr)
      ? new Date(`${todayStr}T00:00:00Z`)
      : new Date(`${yesterdayStr}T00:00:00Z`);

    for (const d of dateObjs) {
      const diffDays = Math.round((expected.getTime() - d.getTime()) / 86400000);
      if (diffDays === 0) {
        currentStreak++;
        expected = new Date(expected.getTime() - 86400000);
      } else if (diffDays > 0) {
        break;
      }
    }
  }

  let longestStreak = 0;
  let currentRun = 0;
  let prevDate: Date | null = null;

  for (const d of dateObjs) {
    if (!prevDate) {
      currentRun = 1;
    } else {
      const diff = Math.round((prevDate.getTime() - d.getTime()) / 86400000);
      if (diff === 1) {
        currentRun++;
      } else {
        currentRun = 1;
      }
    }
    if (currentRun > longestStreak) {
      longestStreak = currentRun;
    }
    prevDate = d;
  }

  return { currentStreak, longestStreak };
}

export function readingRoutes(service: ReadingService) {
  return async (app: FastifyInstance) => {
    // Current user's reading stats (authenticated)
    app.get<{ Querystring: { year?: string } }>(
      '/me/stats',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Get my reading stats',
          description: 'Returns volume, pace, taste, extremes, and streak statistics for the authenticated viewer (PRD §6.40, SL-74).',
          security: [{ BearerAuth: [] }],
          querystring: readingStatsQuerySchema,
          response: {
            200: readingStatsResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        return service.getStats(viewer, viewer, req.query.year);
      },
    );

    // Another user's reading stats
    app.get<{ Params: { id: string }; Querystring: { year?: string } }>(
      '/users/:id/stats',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Get user reading stats',
          description: 'Returns reading stats for a user if authorized (PRD §6.40, SL-74).',
          params: idParamSchema,
          querystring: readingStatsQuerySchema,
          response: {
            200: readingStatsResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        return service.getStats(req.viewer, req.params.id, req.query.year);
      },
    );

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
          description: 'Appends a progress event. Idempotent on client_event_id for offline replay (PRD §8.3): a replay onto the same read returns 200; an id already used on another read returns 409 client_event_conflict.',
          security: [{ BearerAuth: [] }],
          params: idParamSchema,
          body: progressEventBodySchema,
          response: {
            200: readSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
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
        const { finished_at, rating, hearted, format_override, visibility } = parsed.data;
        return service.finish(viewer, req.params.id, {
          finishedAt: finished_at,
          rating,
          hearted,
          formatOverride: format_override,
          visibility,
        });
      },
    );

    // Delete a read and everything hanging off it (PRD §34.2)
    app.delete<{ Params: { id: string } }>(
      '/reads/:id',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Delete a read attempt',
          description: 'Deletes one of the viewer’s read attempts with its progress history, review, likes, comments and activity (PRD §34.2). The client confirms first, naming what will be lost. Another user’s read, or one already deleted, is 404.',
          security: [{ BearerAuth: [] }],
          params: idParamSchema,
          response: {
            200: deleteReadResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => service.delete(requireViewer(req), req.params.id),
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
