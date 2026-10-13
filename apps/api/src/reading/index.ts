// The spine of the product: reads and progress events.
//
// Two things here are correct from day one and must not be "simplified":
//
//   1. One row per reading ATTEMPT. A re-read is a new row with attempt_no+1,
//      never an overwrite (PRD §8.1).
//   2. progress_events is APPEND-ONLY and idempotent on client_event_id, so an
//      offline client can replay its queue safely (PRD §8.3).

import { sql, eq, desc, and } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../platform/index.js';
import { reads, works, progressEvents, profiles, editions, goals } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { resolveWorkId } from '../catalog/resolve.js';
import { syncReviewActivity } from '../reviews/index.js';
import { type Visibility, VISIBILITIES, canViewWith, loadRelationship, visibleLevels } from '../authorization/index.js';
import {
  readSchema,
  readListResponseSchema,
  userReadPageResponseSchema,
  userReadsQuerySchema,
  statusQuerySchema,
  idParamSchema,
  upsertReadBodySchema,
  progressEventBodySchema,
  finishReadBodySchema,
  dnfReadBodySchema,
  readingStatsQuerySchema,
  readingStatsResponseSchema,
  goalQuerySchema,
  goalBodySchema,
  goalResponseSchema,
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
  // rating: null means "unchanged" here (the offline queue sends it with
  // every status change), so clearing a rating (PRD §9.3) is its own flag.
  clear_rating: z.boolean().nullish(),
  hearted: z.boolean().nullish(),
  format_override: z.enum(['print', 'ebook', 'audiobook']).nullish(),
  visibility: z.enum(VISIBILITIES).nullish(),
  if_absent: z.boolean().nullish(),
}).refine((b) => !(b.clear_rating && b.rating != null), {
  message: 'Send a rating or clear_rating, not both.',
  path: ['clear_rating'],
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
      /** Write only if the viewer has no read of the work (D-11-1); else 409 already_in_library. */
      ifAbsent?: boolean;
      clearRating?: boolean;
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

        // Under the attempts lock, so a replayed swipe cannot race a start.
        if (extra?.ifAbsent && existing) {
          throw ApiError.conflict('already_in_library', 'This book is already in your library.');
        }

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
            rating          = CASE WHEN ${extra?.clearRating === true} THEN NULL ELSE COALESCE(${rating ?? null}, rating) END,
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
      // A review is shown at the stricter of its own and its read's
      // visibility, so its feed card follows the read too (audit 09).
      const [rv] = await db.execute<{ id: string }>(sql`SELECT id FROM reviews WHERE read_id = ${read.id}`);
      if (rv) await syncReviewActivity(db, rv.id);
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
    return (await this.listPage(viewer, userId, status, {})).data;
  }

  /**
   * One page of `list`, newest update first, for GET /users/:id/reads
   * (A-08-027: it returned every read, 628 for one bench user). The cursor
   * is (updated_at, id) with updated_at as Postgres prints it, microseconds
   * included: a JS Date would round it to milliseconds and skip rows that
   * share the millisecond. Without `limit`, every read (GET /reads, the
   * owner's own sync).
   */
  async listPage(
    viewer: string | null,
    userId: string,
    status: string | undefined,
    opts: { cursor?: string; limit?: number },
  ): Promise<{ data: Read[]; next_cursor: string | null }> {
    const after = decodeReadsCursor(opts.cursor);
    // Which visibilities this viewer may see, derived from canView() itself,
    // so an accepted follower gets followers-only reads (Audit 05).
    const rel = await loadRelationship(this.db, viewer, userId);
    const levels = visibleLevels(viewer, userId, rel);
    if (levels.length === 0) return { data: [], next_cursor: null };
    const levelList = sql.join(levels.map((l) => sql`${l}`), sql`, `);
    const limit = opts.limit;

    const rows = await this.db.execute<{
      id: string; user_id: string; work_id: string; edition_id: string | null;
      updated_key: string;
      status: string; attempt_no: number;
      started_at: string | null; finished_at: string | null;
      abandoned_at: string | null; abandoned_page: number | null; dnf_reason: string | null;
      rating: string | null; hearted: boolean; format_override: string | null; visibility: string;
      title: string; author_name: string | null; cover_id: number | null;
      page: number | null; percent: string | null; page_count: number | null;
    }>(sql`
      -- The page first, so the lookups below run for its rows only.
      WITH page AS (
        SELECT r.*
          FROM reads r
         WHERE r.user_id = ${userId}
           AND r.visibility IN (${levelList})
           AND (${status ?? null}::text IS NULL OR r.status = ${status ?? null})
           ${after ? sql`AND (r.updated_at, r.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
         ORDER BY r.updated_at DESC, r.id DESC
         ${limit ? sql`LIMIT ${limit + 1}` : sql``}
      )
      SELECT r.id, r.user_id, r.work_id, r.edition_id, r.status, r.attempt_no,
             r.started_at, r.finished_at, r.abandoned_at, r.abandoned_page, r.dnf_reason,
             r.rating, r.hearted, r.format_override, r.visibility,
             r.updated_at::text AS updated_key,
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
             -- One rule everywhere (D-08-3, migration 0030); it was the
             -- smallest edition, which understated long books.
             flyleaf_page_count(r.edition_id, r.work_id) AS page_count
      FROM page r
      JOIN works w ON w.id = r.work_id
      LEFT JOIN editions re ON re.id = r.edition_id
      LEFT JOIN LATERAL (
        SELECT page, percent FROM progress_events
        WHERE read_id = r.id ORDER BY at DESC LIMIT 1
      ) pe ON true
      ORDER BY r.updated_at DESC, r.id DESC
    `);

    const more = limit !== undefined && rows.length > limit;
    const pageRows = more ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const data = pageRows.map((r) => ({
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
    return { data, next_cursor: more && last ? encodeReadsCursor(last.updated_key, last.id) : null };
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

  /**
   * Reading stats (SL-74, ST-01…ST-03, ST-06; PRD §6.40, §17). The viewer is
   * an input to every query, not a filter on a shared result (§17.5
   * [LOCKED]): each query below reads only the visibility levels this viewer
   * may see, so a private read cannot reach a count, an extreme, the
   * listening hours, the pace, the speed, the time of day or the streak of
   * anyone but its owner (audit 10: audio and streak ignored it).
   *
   * Never fabricate (§17.4, ST-03): a figure that needs data a read lacks
   * leaves that read out, and `coverage` says how many it was based on.
   *
   * `tz` is the IANA zone whose days count (§8.7: the user's local day);
   * absent, days are UTC. `year` is 'all' or YYYY, default this year in `tz`.
   *
   * `publicOnly` (ST-08 stat cards, §17.5 "the share card, being public,
   * uses public-visible figures"): who may ask is unchanged, but only reads
   * whose own visibility is public are counted, whoever asks.
   */
  async getStats(
    viewer: string | null,
    userId: string,
    yearParam?: string,
    tzParam?: string,
    opts: { publicOnly?: boolean } = {},
  ): Promise<ReadingStats> {
    const tz = tzParam ?? 'UTC';
    if (!isTimeZone(tz)) {
      throw ApiError.unprocessable('invalid_timezone', 'Unknown time zone. Send an IANA name such as Europe/London.', 'tz');
    }
    const today = localDate(tz);
    let year: number | null;
    if (yearParam === undefined) year = Number(today.slice(0, 4));
    else if (yearParam === 'all') year = null;
    else if (/^\d{4}$/.test(yearParam) && Number(yearParam) >= 1000) year = Number(yearParam);
    else throw ApiError.unprocessable('invalid_year', 'Year is YYYY or "all".', 'year');

    const rel = await loadRelationship(this.db, viewer, userId);
    if (!canViewWith(viewer, userId, rel)) throw ApiError.notFound('User not found.');
    // Never empty: the account is visible, so its public reads are.
    const levels = visibleLevels(viewer, userId, rel).filter((l) => !opts.publicOnly || l === 'public');
    const levelList = sql.join(levels.map((l) => sql`${l}`), sql`, `);

    // Calendar dates, and the instants where the user's local year begins and ends.
    const ys = year === null ? null : `${year}-01-01`;
    const ye = year === null ? null : `${year + 1}-01-01`;
    const winStart = ys === null ? sql`NULL::timestamptz` : sql`(${ys}::timestamp AT TIME ZONE ${tz})`;
    const winEnd = ye === null ? sql`NULL::timestamptz` : sql`(${ye}::timestamp AT TIME ZONE ${tz})`;
    const effectiveFormat = sql`COALESCE(r.format_override,
      CASE e.format WHEN 'hardcover' THEN 'print' WHEN 'paperback' THEN 'print'
                    WHEN 'ebook' THEN 'ebook' WHEN 'audiobook' THEN 'audiobook' END,
      'unknown')`;

    const [rows, audio, days, inProgress, events] = await Promise.all([
      // Finished and DNF reads in scope. An undated finish comes back too:
      // it counts all-time and is disclosed (§17.4), never placed in a month.
      // others_avg is the book's community average WITHOUT this reader's own
      // counted rating (work_stats less their latest_ratings row), so "you vs
      // the crowd" never compares a rating with itself. It depends on other
      // people's ratings only, so it carries nothing private of this reader.
      this.db.execute<StatsRow>(sql`
        SELECT r.id, r.work_id, r.status,
               r.started_at::text AS started_at,
               r.finished_at::text AS finished_at, r.abandoned_at::text AS abandoned_at,
               r.rating::text AS rating,
               ${effectiveFormat} AS format,
               flyleaf_page_count(r.edition_id, r.work_id) AS page_count,
               w.title,
               w.first_publish_year AS publish_year,
               COALESCE(NULLIF(e.language, 'und'), NULLIF(w.original_language, 'und')) AS language,
               (SELECT s.name FROM work_subjects wsj JOIN subjects s ON s.id = wsj.subject_id AND s.kind = 'genre'
                 WHERE wsj.work_id = w.id ORDER BY wsj.weight DESC, s.name LIMIT 1) AS genre,
               COALESCE(e.ol_cover_id, w.ol_cover_id,
                 (SELECT e2.ol_cover_id FROM editions e2
                   WHERE e2.work_id = w.id AND e2.ol_cover_id IS NOT NULL LIMIT 1)) AS cover_id,
               (SELECT a.name FROM work_authors wa JOIN authors a ON a.id = wa.author_id
                 WHERE wa.work_id = w.id ORDER BY wa.position, a.name LIMIT 1) AS author_name,
               CASE WHEN r.status = 'finished' AND r.rating IS NOT NULL THEN (
                 SELECT CASE WHEN ws.rating_count - mine.n > 0
                             THEN ((ws.rating_sum - mine.s) / (ws.rating_count - mine.n))::float8 END
                   FROM work_stats ws,
                        LATERAL (
                          SELECT COALESCE(sum(m.rating), 0) AS s, count(*) AS n
                            FROM (SELECT r2.rating FROM reads r2
                                   WHERE r2.user_id = r.user_id AND r2.work_id = r.work_id
                                     AND r2.rating IS NOT NULL AND NOT r2.rating_excluded
                                     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND u.ratings_excluded_at IS NOT NULL)
                                   ORDER BY r2.attempt_no DESC LIMIT 1) m
                        ) mine
                  WHERE ws.work_id = r.work_id) END AS others_avg,
               (CASE WHEN ${effectiveFormat} = 'audiobook' THEN
                  e.audio_seconds IS NOT NULL
                  OR EXISTS (SELECT 1 FROM progress_events pa WHERE pa.read_id = r.id AND pa.audio_seconds IS NOT NULL)
                END) AS has_audio
          FROM reads r
          JOIN works w ON w.id = r.work_id
          LEFT JOIN editions e ON e.id = r.edition_id
         WHERE r.user_id = ${userId}
           AND r.visibility IN (${levelList})
           AND r.status IN ('finished', 'dnf')
           AND (${ys}::date IS NULL
                OR (r.status = 'finished' AND (r.finished_at IS NULL
                    OR (r.finished_at >= ${ys}::date AND r.finished_at < ${ye}::date)))
                OR (r.status = 'dnf' AND r.abandoned_at >= ${ys}::date AND r.abandoned_at < ${ye}::date))
      `),
      // Listening. audio_seconds is a POSITION, like page (§8.3: the latest
      // row is the current position), so a window gets the furthest point
      // reached in it minus the furthest point reached before it. A finished
      // audiobook with a known duration has reached its duration on its
      // finish date. Summing the events counted the same hour again and again.
      this.db.execute<{ seconds: string | number }>(sql`
        WITH vr AS (
          SELECT r.id, r.status, r.finished_at,
                 CASE WHEN ${effectiveFormat} = 'audiobook' THEN e.audio_seconds END AS duration
            FROM reads r LEFT JOIN editions e ON e.id = r.edition_id
           WHERE r.user_id = ${userId} AND r.visibility IN (${levelList})
        ), pos AS (
          SELECT vr.id,
                 max(pe.audio_seconds) FILTER (WHERE ${winEnd} IS NULL OR pe.at < ${winEnd}) AS reached,
                 max(pe.audio_seconds) FILTER (WHERE pe.at < ${winStart}) AS before
            FROM vr JOIN progress_events pe ON pe.read_id = vr.id
           WHERE pe.audio_seconds IS NOT NULL
           GROUP BY vr.id
        )
        SELECT COALESCE(sum(GREATEST(0,
                 GREATEST(COALESCE(p.reached, 0),
                          CASE WHEN vr.status = 'finished' AND vr.duration IS NOT NULL
                                AND (${ye}::date IS NULL OR vr.finished_at < ${ye}::date)
                               THEN vr.duration ELSE 0 END)
               - GREATEST(COALESCE(p.before, 0),
                          CASE WHEN vr.status = 'finished' AND vr.duration IS NOT NULL
                                AND vr.finished_at < ${ys}::date
                               THEN vr.duration ELSE 0 END))), 0) AS seconds
          FROM vr LEFT JOIN pos p ON p.id = vr.id
         WHERE p.id IS NOT NULL OR vr.duration IS NOT NULL
      `),
      // Streak days: the user's local dates with activity, visible reads only.
      this.db.execute<{ d: string }>(sql`
        SELECT DISTINCT (pe.at AT TIME ZONE ${tz})::date::text AS d
          FROM reads r JOIN progress_events pe ON pe.read_id = r.id
         WHERE r.user_id = ${userId} AND r.visibility IN (${levelList})
        UNION
        SELECT r.finished_at::text
          FROM reads r
         WHERE r.user_id = ${userId} AND r.visibility IN (${levelList}) AND r.finished_at IS NOT NULL
      `),
      // §17.2 "Books in progress": now, whatever the year.
      this.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM reads r
         WHERE r.user_id = ${userId} AND r.visibility IN (${levelList}) AND r.status IN ('reading', 'paused')
      `),
      // Progress events in the window, per local day and hour: sessions (one
      // event is one session, §8.4), pages read (the rise in page since the
      // read's previous page event, so a first event, a percent-only or an
      // audio event adds no pages: §8.4 "no inference"), and the sample for
      // reading speed (events that carry minutes AND a page rise).
      this.db.execute<EventBucket>(sql`
        WITH ev AS (
          -- One pass over the reader's events up to the window's end. The
          -- window is partitioned by "has a page", so for a page event lag()
          -- is the read's previous PAGE event, skipping percent and audio
          -- ones; for any other event the rise is NULL.
          SELECT pe.at, pe.minutes,
                 pe.page - lag(pe.page) OVER (PARTITION BY pe.read_id, pe.page IS NULL ORDER BY pe.at, pe.id) AS delta
            FROM reads r JOIN progress_events pe ON pe.read_id = r.id
           WHERE r.user_id = ${userId} AND r.visibility IN (${levelList})
             AND (${winEnd} IS NULL OR pe.at < ${winEnd})
        )
        SELECT (at AT TIME ZONE ${tz})::date::text AS d,
               extract(hour FROM at AT TIME ZONE ${tz})::int AS h,
               count(*)::int AS sessions,
               count(delta)::int AS paged,
               COALESCE(sum(GREATEST(delta, 0)), 0)::int AS pages,
               count(*) FILTER (WHERE minutes > 0 AND delta > 0)::int AS timed,
               COALESCE(sum(delta) FILTER (WHERE minutes > 0 AND delta > 0), 0)::int AS timed_pages,
               COALESCE(sum(minutes) FILTER (WHERE minutes > 0 AND delta > 0), 0)::int AS timed_minutes
          FROM ev
         WHERE ${winStart} IS NULL OR at >= ${winStart}
         GROUP BY 1, 2
      `),
    ]);

    const finished = rows.filter((r) => r.status === 'finished' && (year === null || r.finished_at !== null));
    const dnf = rows.filter((r) => r.status === 'dnf');
    const dated = finished.filter((r) => r.finished_at !== null);

    const monthlyPace = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, books: 0, pages: 0 }));
    for (const r of dated) {
      const item = monthlyPace[Number(r.finished_at!.slice(5, 7)) - 1]!;
      item.books += 1;
      item.pages += r.page_count ?? 0;
    }

    const rated = finished.filter((r) => r.rating !== null);
    const ratingDistribution = Object.fromEntries(STATS_RATING_BUCKETS.map((b) => [b, 0])) as Record<string, number>;
    for (const r of rated) ratingDistribution[Number(r.rating).toFixed(1)]! += 1;
    const avgRating = rated.length > 0
      ? round(rated.reduce((sum, r) => sum + Number(r.rating), 0) / rated.length, 2)
      : null;
    // You vs the crowd (§17.2): your rating minus the book's average without
    // you, averaged over the rated books someone else has rated too.
    const compared = rated.filter((r) => r.others_avg !== null);
    const vsCrowd = compared.length > 0
      ? round(compared.reduce((sum, r) => sum + (Number(r.rating) - Number(r.others_avg)), 0) / compared.length, 2)
      : null;

    const formatBreakdown = { print: 0, ebook: 0, audiobook: 0, unknown: 0 };
    for (const r of finished) formatBreakdown[r.format] += 1;

    // Extremes: a fixed order, so equal values do not swap between calls.
    const withPages = finished
      .filter((r) => r.page_count !== null)
      .sort((a, b) => b.page_count! - a.page_count! || a.id.localeCompare(b.id));
    const book = (r: StatsRow): ExtremeBook => ({
      work_id: r.work_id, title: r.title, author_name: r.author_name, page_count: r.page_count, cover_id: r.cover_id,
    });
    const extreme = (r: StatsRow | undefined) => (r ? book(r) : null);

    // Days to finish, start and finish day included (a book started and
    // finished on the same day took 1 day). Needs both dates (§17.4).
    const timed = finished
      .filter((r) => r.started_at !== null && r.finished_at !== null)
      .map((r) => ({ r, days: daysBetween(r.started_at!, r.finished_at!) + 1 }))
      .sort((a, b) => a.days - b.days || a.r.id.localeCompare(b.r.id));
    const byFinishMonth = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      median_days: median(timed.filter((t) => Number(t.r.finished_at!.slice(5, 7)) === i + 1).map((t) => t.days)),
    }));

    const byRating = [...rated].sort((a, b) =>
      Number(b.rating) - Number(a.rating) || (b.finished_at ?? '').localeCompare(a.finished_at ?? '') || a.id.localeCompare(b.id));
    const highest = byRating[0];
    const lowest = [...rated].sort((a, b) =>
      Number(a.rating) - Number(b.rating) || (b.finished_at ?? '').localeCompare(a.finished_at ?? '') || a.id.localeCompare(b.id))[0];

    const withYear = finished
      .filter((r) => r.publish_year !== null)
      .sort((a, b) => a.publish_year! - b.publish_year! || a.id.localeCompare(b.id));

    // Most re-read: finished attempts per work in scope, two or more.
    const attempts = new Map<string, { r: StatsRow; count: number }>();
    for (const r of finished) {
      const a = attempts.get(r.work_id);
      if (a) a.count += 1;
      else attempts.set(r.work_id, { r, count: 1 });
    }
    const reread = [...attempts.values()]
      .filter((a) => a.count >= 2)
      .sort((a, b) => b.count - a.count || a.r.title.localeCompare(b.r.title) || a.r.work_id.localeCompare(b.r.work_id))[0];

    // Most-read author: a book with no author is not "Unknown Author"'s book.
    const authorCounts = new Map<string, number>();
    for (const r of finished) {
      if (r.author_name !== null) authorCounts.set(r.author_name, (authorCounts.get(r.author_name) ?? 0) + 1);
    }
    let mostReadAuthor: { name: string; count: number } | null = null;
    for (const [name, count] of [...authorCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!mostReadAuthor || count > mostReadAuthor.count) mostReadAuthor = { name, count };
    }

    // Genre donut (§17.2): each book once, under its strongest genre; top 8 plus Other.
    const genreCounts = tally(finished.map((r) => r.genre));
    const genreTop = genreCounts.slice(0, 8);
    const genreOther = genreCounts.slice(8).reduce((n, g) => n + g.count, 0);
    const decades = tally(finished.map((r) => (r.publish_year === null ? null : String(Math.floor(r.publish_year / 10) * 10))))
      .map((g) => ({ decade: Number(g.name), count: g.count }))
      .sort((a, b) => a.decade - b.decade);
    const languages = tally(finished.map((r) => r.language)).map((g) => ({ language: g.name, count: g.count }));

    // Progress events: sessions, time of day, pace and speed.
    let sessions = 0;
    let paged = 0;
    let timedSessions = 0;
    let timedPages = 0;
    let timedMinutes = 0;
    const timeOfDay = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const pagesByDay = new Map<string, number>();
    for (const e of events) {
      sessions += e.sessions;
      paged += e.paged;
      timedSessions += e.timed;
      timedPages += e.timed_pages;
      timedMinutes += e.timed_minutes;
      timeOfDay[isoWeekday(e.d)]![e.h]! += e.sessions;
      if (e.paged > 0) pagesByDay.set(e.d, (pagesByDay.get(e.d) ?? 0) + e.pages);
    }

    const audiobooks = finished.filter((r) => r.format === 'audiobook');
    const booksCount = finished.length;
    const dnfCount = dnf.length;
    const audioSeconds = Number(audio[0]?.seconds ?? 0);
    const streaks = computeStreaks(days.map((d) => d.d), today);
    const cover = (basedOn: number, of: number) => ({ based_on: basedOn, of });

    return {
      year: year === null ? 'all' : String(year),
      books_count: booksCount,
      distinct_works_count: new Set(finished.map((r) => r.work_id)).size,
      books_in_progress: inProgress[0]?.n ?? 0,
      pages_count: withPages.reduce((acc, r) => acc + r.page_count!, 0),
      audio_hours: round(audioSeconds / 3600, 1),
      avg_rating: avgRating,
      vs_crowd: vsCrowd,
      rating_distribution: ratingDistribution,
      format_breakdown: formatBreakdown,
      monthly_pace: monthlyPace,
      genres: { top: genreTop, other: genreOther },
      decades,
      languages,
      velocity: { median_days: median(timed.map((t) => t.days)), by_month: byFinishMonth },
      speed: {
        pages_per_hour: timedMinutes > 0 ? round((timedPages / timedMinutes) * 60, 1) : null,
        pages: timedPages,
        minutes: timedMinutes,
      },
      pace: weeklyPace(pagesByDay),
      time_of_day: timeOfDay,
      longest_book: extreme(withPages[0]),
      shortest_book: extreme(withPages[withPages.length - 1]),
      fastest_read: timed[0] ? { ...book(timed[0].r), days: timed[0].days } : null,
      slowest_read: timed.length > 0 ? { ...book(timed[timed.length - 1]!.r), days: timed[timed.length - 1]!.days } : null,
      highest_rated: highest ? { ...book(highest), rating: Number(highest.rating) } : null,
      lowest_rated: lowest ? { ...book(lowest), rating: Number(lowest.rating) } : null,
      oldest_publication: withYear[0] ? { ...book(withYear[0]), year: withYear[0].publish_year! } : null,
      most_reread: reread ? { ...book(reread.r), count: reread.count } : null,
      most_read_author: mostReadAuthor,
      dnf_count: dnfCount,
      dnf_rate: booksCount + dnfCount > 0 ? round(dnfCount / (booksCount + dnfCount), 2) : 0,
      current_streak: streaks.currentStreak,
      longest_streak: streaks.longestStreak,
      current_streak_range: streaks.currentRange,
      longest_streak_range: streaks.longestRange,
      // §17.4: what the figures above leave out, so the client can say so.
      // Undated finishes (every visible one) never reach a month or a year;
      // books without a page count add nothing to pages or the extremes.
      excluded: {
        undated: rows.filter((r) => r.status === 'finished' && r.finished_at === null).length,
        missing_page_count: finished.filter((r) => r.page_count === null).length,
      },
      // ST-03: every figure that needs data a book or session may lack, as
      // "based on N of M". Counts per finished read in scope unless named.
      coverage: {
        pages: cover(withPages.length, booksCount),
        months: cover(dated.length, booksCount),
        ratings: cover(rated.length, booksCount),
        vs_crowd: cover(compared.length, rated.length),
        formats: cover(booksCount - formatBreakdown.unknown, booksCount),
        authors: cover(finished.filter((r) => r.author_name !== null).length, booksCount),
        genres: cover(finished.filter((r) => r.genre !== null).length, booksCount),
        decades: cover(withYear.length, booksCount),
        languages: cover(finished.filter((r) => r.language !== null).length, booksCount),
        velocity: cover(timed.length, booksCount),
        audio: cover(audiobooks.filter((r) => r.has_audio === true).length, audiobooks.length),
        // Sessions (progress events in the window), not books.
        pace: cover(paged, sessions),
        speed: cover(timedSessions, sessions),
      },
    };
  }

  /**
   * ST-05, PRD §8.6 [LOCKED]: the reading goal for a year and the progress
   * towards it, as THIS viewer may count it (§17.5): the owner's finished
   * books include private reads, anyone else's only the reads they may see,
   * like the stats. A goal is account-level, visible exactly where the
   * stats are (§16.3). Shown only as the profile ring: nothing here says
   * "behind", and nothing else reads it.
   */
  async getGoal(viewer: string | null, userId: string, yearParam?: string, tzParam?: string): Promise<GoalResponse> {
    const tz = tzParam ?? 'UTC';
    if (!isTimeZone(tz)) {
      throw ApiError.unprocessable('invalid_timezone', 'Unknown time zone. Send an IANA name such as Europe/London.', 'tz');
    }
    const year = yearParam === undefined ? Number(localDate(tz).slice(0, 4)) : parseGoalYear(yearParam);
    const rel = await loadRelationship(this.db, viewer, userId);
    if (!canViewWith(viewer, userId, rel)) throw ApiError.notFound('User not found.');
    const [goal] = await this.db.select().from(goals).where(and(eq(goals.userId, userId), eq(goals.year, year))).limit(1);
    if (!goal) return { year, goal: null };
    const levelList = sql.join(visibleLevels(viewer, userId, rel).map((l) => sql`${l}`), sql`, `);
    // Dated finishes in the calendar year only, as the stats' year count
    // (an undated import belongs to no year, §17.4); pages by the D-08-3 rule.
    const [p] = await this.db.execute<{ books: number; pages: number; with_pages: number }>(sql`
      SELECT count(*)::int AS books,
             COALESCE(sum(pc), 0)::int AS pages,
             count(pc)::int AS with_pages
        FROM reads r, LATERAL (SELECT flyleaf_page_count(r.edition_id, r.work_id) AS pc) x
       WHERE r.user_id = ${userId} AND r.visibility IN (${levelList}) AND r.status = 'finished'
         AND r.finished_at >= ${`${year}-01-01`}::date AND r.finished_at < ${`${year + 1}-01-01`}::date
    `);
    const books = p?.books ?? 0;
    const pages = p?.pages ?? 0;
    return {
      year,
      goal: {
        target_books: goal.targetBooks,
        target_pages: goal.targetPages,
        books_count: books,
        pages_count: pages,
        books_reached: books >= goal.targetBooks,
        pages_reached: goal.targetPages === null ? null : pages >= goal.targetPages,
        // ST-03: a book without a page count adds no pages, and says so.
        pages_coverage: { based_on: p?.with_pages ?? 0, of: books },
      },
    };
  }

  /** Set or change the viewer's goal for a year; downward and any time (§8.6). */
  async setGoal(viewer: string, year: number, targetBooks: number, targetPages: number | null, tz?: string): Promise<GoalResponse> {
    await this.db.execute(sql`
      INSERT INTO goals (user_id, year, target_books, target_pages)
      VALUES (${viewer}, ${year}, ${targetBooks}, ${targetPages})
      ON CONFLICT (user_id, year) DO UPDATE
        SET target_books = EXCLUDED.target_books, target_pages = EXCLUDED.target_pages, updated_at = now()
    `);
    return this.getGoal(viewer, viewer, String(year), tz);
  }

  /** Remove the viewer's goal for a year. Idempotent: no goal is the same answer. */
  async deleteGoal(viewer: string, year: number): Promise<{ year: number; goal: null }> {
    await this.db.delete(goals).where(and(eq(goals.userId, viewer), eq(goals.year, year)));
    return { year, goal: null };
  }
}

/** Opaque cursor for GET /users/:id/reads: updated_at as Postgres text, then the id. */
function encodeReadsCursor(updatedAt: string, id: string): string {
  return Buffer.from(`${updatedAt}|${id}`, 'utf8').toString('base64url');
}

function decodeReadsCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  // Postgres's own text form: 2026-01-01 10:00:00.123003+00
  if (!at || !id || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/.test(at) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw ApiError.badRequest('invalid_cursor', 'Cursor is not valid.', 'cursor');
  }
  return { at, id };
}

/** The stats histogram's buckets: the same ten half stars as the book page (A-09-043). */
const STATS_RATING_BUCKETS = ['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0'] as const;

type StatsRow = {
  id: string;
  work_id: string;
  status: 'finished' | 'dnf';
  started_at: string | null;
  finished_at: string | null;
  abandoned_at: string | null;
  rating: string | null;
  format: 'print' | 'ebook' | 'audiobook' | 'unknown';
  page_count: number | null;
  title: string;
  publish_year: number | null;
  language: string | null;
  genre: string | null;
  cover_id: number | null;
  author_name: string | null;
  others_avg: number | null;
  has_audio: boolean | null;
};

/** One (local day, local hour) of progress events. */
type EventBucket = {
  d: string;
  h: number;
  sessions: number;
  paged: number;
  pages: number;
  timed: number;
  timed_pages: number;
  timed_minutes: number;
};

type ExtremeBook = { work_id: string; title: string; author_name: string | null; page_count: number | null; cover_id: number | null };
type Coverage = { based_on: number; of: number };
type DateRange = { start: string; end: string };

export type ReadingStats = {
  year: string;
  books_count: number;
  distinct_works_count: number;
  books_in_progress: number;
  pages_count: number;
  audio_hours: number;
  avg_rating: number | null;
  vs_crowd: number | null;
  rating_distribution: Record<string, number>;
  format_breakdown: { print: number; ebook: number; audiobook: number; unknown: number };
  monthly_pace: Array<{ month: number; books: number; pages: number }>;
  genres: { top: Array<{ name: string; count: number }>; other: number };
  decades: Array<{ decade: number; count: number }>;
  languages: Array<{ language: string; count: number }>;
  velocity: { median_days: number | null; by_month: Array<{ month: number; median_days: number | null }> };
  speed: { pages_per_hour: number | null; pages: number; minutes: number };
  pace: Array<{ week_start: string; pages: number; pages_per_day: number }>;
  time_of_day: number[][];
  longest_book: ExtremeBook | null;
  shortest_book: ExtremeBook | null;
  fastest_read: (ExtremeBook & { days: number }) | null;
  slowest_read: (ExtremeBook & { days: number }) | null;
  highest_rated: (ExtremeBook & { rating: number }) | null;
  lowest_rated: (ExtremeBook & { rating: number }) | null;
  oldest_publication: (ExtremeBook & { year: number }) | null;
  most_reread: (ExtremeBook & { count: number }) | null;
  most_read_author: { name: string; count: number } | null;
  dnf_count: number;
  dnf_rate: number;
  current_streak: number;
  longest_streak: number;
  current_streak_range: DateRange | null;
  longest_streak_range: DateRange | null;
  excluded: { undated: number; missing_page_count: number };
  coverage: Record<
    'pages' | 'months' | 'ratings' | 'vs_crowd' | 'formats' | 'authors' | 'genres' | 'decades' | 'languages' | 'velocity' | 'audio' | 'pace' | 'speed',
    Coverage
  >;
};

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Whole days from a to b (YYYY-MM-DD). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The median, null for none; the mean of the middle two for an even count. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : round((s[mid - 1]! + s[mid]!) / 2, 1);
}

/** Counts of the non-null values, most first, then by name. */
function tally(values: Array<string | null>): Array<{ name: string; count: number }> {
  const m = new Map<string, number>();
  for (const v of values) if (v !== null) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Monday = 0 … Sunday = 6, for a YYYY-MM-DD date. */
function isoWeekday(d: string): number {
  return (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * §17.2 "reading pace over time, 7-day rolling average", sampled once a week:
 * each Monday-to-Sunday week from the first week with pages to the last, its
 * pages and pages per day. Weeks between with nothing logged are 0, which is
 * what they were; nothing is drawn before the first page or after the last.
 */
export function weeklyPace(pagesByDay: Map<string, number>): Array<{ week_start: string; pages: number; pages_per_day: number }> {
  if (pagesByDay.size === 0) return [];
  const weekOf = (d: string) => {
    const t = Date.parse(`${d}T00:00:00Z`) - isoWeekday(d) * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const weeks = new Map<string, number>();
  for (const [d, pages] of pagesByDay) weeks.set(weekOf(d), (weeks.get(weekOf(d)) ?? 0) + pages);
  const sorted = [...weeks.keys()].sort();
  const out: Array<{ week_start: string; pages: number; pages_per_day: number }> = [];
  for (let t = Date.parse(`${sorted[0]}T00:00:00Z`); t <= Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`); t += 7 * 86_400_000) {
    const w = new Date(t).toISOString().slice(0, 10);
    const pages = weeks.get(w) ?? 0;
    out.push({ week_start: w, pages, pages_per_day: round(pages / 7, 1) });
  }
  return out;
}

export type GoalResponse = {
  year: number;
  goal: {
    target_books: number;
    target_pages: number | null;
    books_count: number;
    pages_count: number;
    books_reached: boolean;
    pages_reached: boolean | null;
    pages_coverage: { based_on: number; of: number };
  } | null;
};

/** A goal's year: YYYY, 1900–9999 (0046's check). */
function parseGoalYear(raw: string): number {
  if (!/^\d{4}$/.test(raw) || Number(raw) < 1900) {
    throw ApiError.unprocessable('invalid_year', 'Year is YYYY, 1900 or later.', 'year');
  }
  return Number(raw);
}

const goalBody = z.object({
  year: z.number().int().min(1900).max(9999),
  target_books: z.number().int().min(1, 'A goal is at least 1 book.').max(10_000, 'A goal is at most 10,000 books.'),
  target_pages: z.number().int().min(1, 'A page goal is at least 1 page.').max(10_000_000, 'A page goal is at most 10,000,000 pages.').nullish(),
});

/**
 * An IANA zone Intl knows. The character check keeps anything odd away from
 * Postgres, which answers an unknown zone with an error rather than a value.
 */
export function isTimeZone(tz: string): boolean {
  if (tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The date, YYYY-MM-DD, in `tz`. */
export function localDate(tz: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** PRD §8.7: up to two days without reading do not end a streak. */
export const STREAK_GRACE_DAYS = 2;

/**
 * Current and longest streak (ST-06, PRD §8.7) from the active dates
 * (YYYY-MM-DD, already in the user's zone).
 *
 * A streak is a run of active days in which no gap has more than
 * STREAK_GRACE_DAYS days without reading. Its length is the run's calendar
 * span, first active day to last, both included, so it matches the date range
 * shown beside it ("47 days, 12 Mar – 27 Apr"). It is current while today
 * is still within the grace of its last active day; once broken it is only
 * ever shown as the longest, never as a loss.
 */
export function computeStreaks(
  dateStrings: string[],
  today = new Date().toISOString().slice(0, 10),
): {
  currentStreak: number;
  longestStreak: number;
  currentRange: { start: string; end: string } | null;
  longestRange: { start: string; end: string } | null;
} {
  const dates = Array.from(new Set(dateStrings)).sort();
  if (dates.length === 0) return { currentStreak: 0, longestStreak: 0, currentRange: null, longestRange: null };

  const day = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const runs: Array<{ start: string; end: string }> = [];
  let start = dates[0]!;
  let prev = dates[0]!;
  for (const d of dates.slice(1)) {
    if (day(d) - day(prev) - 1 > STREAK_GRACE_DAYS) {
      runs.push({ start, end: prev });
      start = d;
    }
    prev = d;
  }
  runs.push({ start, end: prev });

  const length = (r: { start: string; end: string }) => day(r.end) - day(r.start) + 1;
  // The earliest of equal runs, so the range does not move between calls.
  let longest = runs[0]!;
  for (const r of runs) if (length(r) > length(longest)) longest = r;
  const last = runs[runs.length - 1]!;
  const current = day(today) - day(last.end) - 1 <= STREAK_GRACE_DAYS ? last : null;

  return {
    currentStreak: current ? length(current) : 0,
    longestStreak: length(longest),
    currentRange: current,
    longestRange: longest,
  };
}

export function readingRoutes(service: ReadingService) {
  return async (app: FastifyInstance) => {
    // Current user's reading stats (authenticated)
    app.get<{ Querystring: { year?: string; tz?: string } }>(
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
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        return service.getStats(viewer, viewer, req.query.year, req.query.tz);
      },
    );

    // Another user's reading stats
    app.get<{ Params: { id: string }; Querystring: { year?: string; tz?: string } }>(
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
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        return service.getStats(req.viewer, req.params.id, req.query.year, req.query.tz);
      },
    );

    // ST-05 goals (PRD §8.6 [LOCKED]): the ring on the profile, nowhere else.
    app.get<{ Querystring: { year?: string; tz?: string } }>(
      '/me/goal',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Get my reading goal',
          description: 'The viewer\'s goal for a year (default: this year in tz) and progress, private reads included (PRD §8.6, §17.5). goal is null when none is set. For the profile ring only.',
          security: [{ BearerAuth: [] }],
          querystring: goalQuerySchema,
          response: { 200: goalResponseSchema, 401: errorResponseSchema, 422: errorResponseSchema },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        return service.getGoal(viewer, viewer, req.query.year, req.query.tz);
      },
    );

    app.get<{ Params: { id: string }; Querystring: { year?: string; tz?: string } }>(
      '/users/:id/goal',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Get a user\'s reading goal',
          description: 'A user\'s goal and progress as this viewer may count it: only reads the viewer may see (PRD §17.5). Visible exactly where their stats are (§16.3); otherwise the random-id 404.',
          params: idParamSchema,
          querystring: goalQuerySchema,
          response: { 200: goalResponseSchema, 404: errorResponseSchema, 422: errorResponseSchema },
        },
      },
      async (req) => service.getGoal(req.viewer, req.params.id, req.query.year, req.query.tz),
    );

    app.put<{ Querystring: { tz?: string } }>(
      '/me/goal',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Set my reading goal',
          description: 'Sets or changes the goal for a year: a book target (1–10,000) and an optional page target (1–10,000,000). Any time, downward included, no friction (PRD §8.6).',
          security: [{ BearerAuth: [] }],
          querystring: goalQuerySchema,
          body: goalBodySchema,
          response: { 200: goalResponseSchema, 401: errorResponseSchema, 422: errorResponseSchema },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const parsed = goalBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable('invalid_goal', issue?.message ?? 'Check that.', String(issue?.path[0] ?? ''));
        }
        const { year, target_books, target_pages } = parsed.data;
        if (req.query.tz !== undefined && !isTimeZone(req.query.tz)) {
          throw ApiError.unprocessable('invalid_timezone', 'Unknown time zone. Send an IANA name such as Europe/London.', 'tz');
        }
        return service.setGoal(viewer, year, target_books, target_pages ?? null, req.query.tz);
      },
    );

    app.delete<{ Querystring: { year?: string } }>(
      '/me/goal',
      {
        schema: {
          tags: ['Reading'],
          summary: 'Remove my reading goal',
          description: 'Removes the goal for ?year=YYYY. Idempotent.',
          security: [{ BearerAuth: [] }],
          querystring: goalQuerySchema,
          response: { 200: goalResponseSchema, 401: errorResponseSchema, 422: errorResponseSchema },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        if (req.query.year === undefined) throw ApiError.unprocessable('invalid_year', 'Say which year: ?year=YYYY.', 'year');
        return service.deleteGoal(viewer, parseGoalYear(req.query.year));
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
    app.get<{ Params: { id: string }; Querystring: { status?: string; cursor?: string; limit?: number } }>(
      '/users/:id/reads',
      {
        schema: {
          tags: ['Reading'],
          summary: 'List a user\'s reads, newest update first, cursor-paginated',
          description:
            'The reads this viewer may see (PRD §17.5: visibility per item, the account\'s privacy, blocks). ' +
            'A private account the viewer does not follow, a blocked or missing user all answer an empty page. ' +
            '`limit` 1-100, default 50; pass `next_cursor` back as `cursor` (A-08-027).',
          params: idParamSchema,
          querystring: userReadsQuerySchema,
          response: {
            200: userReadPageResponseSchema,
            400: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const { status, cursor, limit } = req.query;
        if (status && !STATUSES.includes(status as Status)) {
          throw ApiError.unprocessable('invalid_status', 'Unknown status filter.', 'status');
        }
        return service.listPage(req.viewer, req.params.id, status, { cursor, limit: limit ?? 50 });
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
            409: errorResponseSchema,
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
          clear_rating,
          hearted,
          format_override,
          visibility,
          if_absent,
        } = parsed.data;
        return service.upsert(viewer, work_id, status, rating, hearted, visibility, {
          ifAbsent: if_absent === true,
          clearRating: clear_rating === true,
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
