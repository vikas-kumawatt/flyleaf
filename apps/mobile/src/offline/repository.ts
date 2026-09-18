// Offline-First Reading Repository (SL-10, SL-11, SL-50, SL-51, architecture.md §10).
//
// Governed by: "Progress writes never block on the network."
// Optimistic local write to SQLite -> UI updates immediately -> queued for sync.

import type { OfflineDatabase } from './db';
import { MutationQueue, type MutationHandler } from './queue';
import type { LocalRead, LocalProgressEvent } from './schema';
import type { Read, ReadStatus } from '@/lib/api';

function randomUUID(): string {
  if (typeof crypto !== 'undefined' && crypto?.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {
      // Fallback
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class OfflineRepository {
  private queue: MutationQueue;

  constructor(private db: OfflineDatabase, handler?: MutationHandler) {
    this.queue = new MutationQueue(db, handler || {
      addProgress: async (readId, page, percent, minutes, clientEventId, note, audioSeconds) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { api } = require('@/lib/api');
        return api.client.addProgress(readId, {
          client_event_id: clientEventId,
          page,
          percent,
          minutes,
          note,
          audio_seconds: audioSeconds,
        });
      },
      upsertRead: async (workId, status, rating, hearted, extra) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { api } = require('@/lib/api');
        return api.setStatus(workId, status, rating, hearted, extra);
      },
      finishRead: async (readId, payload) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { api } = require('@/lib/api');
        return api.client.finishRead(readId, payload);
      },
      dnfRead: async (readId, payload) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { api } = require('@/lib/api');
        return api.client.dnfRead(readId, payload);
      },
      saveReview: async (readId, payload) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { api } = require('@/lib/api');
        return api.client.createReview(readId, payload);
      },
    });
  }

  getQueue(): MutationQueue {
    return this.queue;
  }

  /**
   * Records progress with instant optimistic write to SQLite.
   * Never blocks on network roundtrip.
   */
  async saveProgress(
    readId: string,
    page: number | null,
    percent: number | null,
    minutes: number | null = null,
    note: string | null = null,
    audioSeconds: number | null = null,
  ): Promise<{ clientEventId: string }> {
    const clientEventId = randomUUID();
    const eventId = randomUUID();
    const now = new Date().toISOString();

    await this.db.transaction(async (tx) => {
      // 1. Optimistic append to progress_events
      await tx.run(
        `INSERT INTO progress_events (id, read_id, at, page, percent, audio_seconds, minutes, note, client_event_id, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [eventId, readId, now, page, percent, audioSeconds, minutes, note, clientEventId],
      );

      // 2. Optimistic update to reads row
      await tx.run(
        `UPDATE reads SET
          page = COALESCE(?, page),
          percent = COALESCE(?, percent),
          started_at = COALESCE(started_at, ?),
          synced = 0,
          updated_at = ?
         WHERE id = ?`,
        [page, percent, now.slice(0, 10), now, readId],
      );

      // 3. Enqueue mutation
      await this.queue.enqueue(
        'progress_event',
        readId,
        'add_progress',
        { page, percent, minutes, note, audio_seconds: audioSeconds },
        clientEventId,
      );
    });

    // Attempt background flush asynchronously without blocking caller
    void this.queue.flush();

    return { clientEventId };
  }

  /**
   * Finishes a read attempt atomically in SQLite and enqueues sync (SL-54).
   */
  async finishRead(
    readId: string,
    opts: {
      finishedAt?: string;
      rating?: number | null;
      hearted?: boolean;
      formatOverride?: string | null;
      review?: string | null;
      visibility?: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const finishedAt = opts.finishedAt ?? now.slice(0, 10);

    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE reads SET
          status = 'finished',
          finished_at = ?,
          rating = COALESCE(?, rating),
          hearted = COALESCE(?, hearted),
          format_override = COALESCE(?, format_override),
          visibility = COALESCE(?, visibility),
          percent = 100,
          synced = 0,
          updated_at = ?
         WHERE id = ?`,
        [
          finishedAt,
          opts.rating ?? null,
          opts.hearted != null ? (opts.hearted ? 1 : 0) : null,
          opts.formatOverride ?? null,
          opts.visibility ?? null,
          now,
          readId,
        ],
      );

      await this.queue.enqueue('read', readId, 'finish_read', {
        finished_at: finishedAt,
        rating: opts.rating ?? null,
        hearted: opts.hearted ?? null,
        format_override: opts.formatOverride ?? null,
        review: opts.review ?? null,
        visibility: opts.visibility ?? null,
      });
    });

    void this.queue.flush();
  }

  /**
   * Marks a read as stopped/abandoned (DNF) in SQLite and enqueues sync (SL-55).
   */
  async dnfRead(
    readId: string,
    opts: {
      abandonedPage?: number | null;
      dnfReason?: string | null;
      note?: string | null;
      rating?: number | null;
      visibility?: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const abandonedAt = now.slice(0, 10);

    await this.db.transaction(async (tx) => {
      await tx.run(
        `UPDATE reads SET
          status = 'dnf',
          abandoned_at = ?,
          abandoned_page = COALESCE(?, page),
          dnf_reason = ?,
          rating = COALESCE(?, rating),
          visibility = COALESCE(?, visibility),
          synced = 0,
          updated_at = ?
         WHERE id = ?`,
        [
          abandonedAt,
          opts.abandonedPage ?? null,
          opts.dnfReason ?? null,
          opts.rating ?? null,
          opts.visibility ?? null,
          now,
          readId,
        ],
      );

      await this.queue.enqueue('read', readId, 'dnf_read', {
        abandoned_page: opts.abandonedPage ?? null,
        dnf_reason: opts.dnfReason ?? null,
        note: opts.note ?? null,
        rating: opts.rating ?? null,
        visibility: opts.visibility ?? null,
      });
    });

    void this.queue.flush();
  }

  /**
   * Sets or changes reading status with optimistic local write.
   */
  async saveReadStatus(
    workId: string,
    userId: string,
    status: string,
    rating: number | null = null,
    hearted = false,
    meta?: {
      title?: string;
      author_name?: string;
      cover_id?: number | null;
      page_count?: number | null;
      format_override?: string | null;
      edition_id?: string | null;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const readId = randomUUID();

    await this.db.transaction(async (tx) => {
      // Check existing read for this work
      const existing = await tx.getFirst<LocalRead>(
        `SELECT id, attempt_no, status FROM reads WHERE work_id = ? AND user_id = ? ORDER BY attempt_no DESC LIMIT 1`,
        [workId, userId],
      );

      const startsNewAttempt =
        !existing ||
        ((existing.status === 'finished' || existing.status === 'dnf') &&
          (status === 'reading' || status === 'want'));

      if (existing && !startsNewAttempt) {
        await tx.run(
          `UPDATE reads SET
            status = ?,
            rating = COALESCE(?, rating),
            hearted = ?,
            format_override = COALESCE(?, format_override),
            edition_id = COALESCE(?, edition_id),
            started_at = CASE WHEN ? = 'reading' THEN COALESCE(started_at, ?) ELSE started_at END,
            synced = 0,
            updated_at = ?
           WHERE id = ?`,
          [
            status,
            rating,
            hearted ? 1 : 0,
            meta?.format_override ?? null,
            meta?.edition_id ?? null,
            status,
            now.slice(0, 10),
            now,
            existing.id,
          ],
        );
      } else {
        const nextAttempt = (existing?.attempt_no ?? 0) + 1;
        await tx.run(
          `INSERT INTO reads (
            id, user_id, work_id, edition_id, status, attempt_no, started_at, finished_at,
            rating, hearted, format_override, visibility,
            title, author_name, cover_id, page, percent, page_count, synced, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'public', ?, ?, ?, NULL, NULL, ?, 0, ?, ?)`,
          [
            readId,
            userId,
            workId,
            meta?.edition_id ?? null,
            status,
            nextAttempt,
            status === 'reading' ? now.slice(0, 10) : null,
            rating,
            hearted ? 1 : 0,
            meta?.format_override ?? null,
            meta?.title ?? null,
            meta?.author_name ?? null,
            meta?.cover_id ?? null,
            meta?.page_count ?? null,
            now,
            now,
          ],
        );
      }

      await this.queue.enqueue('read', workId, 'upsert_read', {
        status,
        rating,
        hearted,
        extra: {
          edition_id: meta?.edition_id,
          format_override: meta?.format_override,
          started_at: status === 'reading' ? now.slice(0, 10) : null,
        },
      });
    });

    void this.queue.flush();
  }

  /**
   * Caches reads retrieved from the server into SQLite with synced = 1.
   */
  async cacheServerReads(serverReads: Read[]): Promise<void> {
    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      for (const r of serverReads) {
        // Do not overwrite un-synced dirty local writes
        const local = await tx.getFirst<LocalRead>(
          `SELECT synced FROM reads WHERE id = ?`,
          [r.id],
        );
        if (local && local.synced === 0) {
          continue;
        }

        await tx.run(
          `INSERT OR REPLACE INTO reads (
            id, user_id, work_id, edition_id, status, attempt_no,
            started_at, finished_at, abandoned_at, abandoned_page, dnf_reason,
            rating, hearted, format_override, visibility,
            title, author_name, cover_id, page, percent, page_count, synced, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            r.id,
            r.user_id,
            r.work_id,
            r.edition_id ?? null,
            r.status,
            r.attempt_no,
            r.started_at ?? null,
            r.finished_at ?? null,
            r.abandoned_at ?? null,
            r.abandoned_page ?? null,
            r.dnf_reason ?? null,
            r.rating,
            r.hearted ? 1 : 0,
            r.format_override ?? null,
            r.visibility,
            r.title ?? null,
            r.author_name ?? null,
            r.cover_id ?? null,
            r.page ?? null,
            r.percent ?? null,
            r.page_count ?? null,
            now,
            now,
          ],
        );
      }
    });
  }

  /**
   * Retrieves reads cached in SQLite.
   */
  async getLocalReads(status?: ReadStatus): Promise<LocalRead[]> {
    if (status) {
      return this.db.getAll<LocalRead>(
        `SELECT * FROM reads WHERE status = ? ORDER BY updated_at DESC`,
        [status],
      );
    }
    return this.db.getAll<LocalRead>(`SELECT * FROM reads ORDER BY updated_at DESC`);
  }

  /**
   * Retrieves progress events for a specific read.
   */
  async getProgressEvents(readId: string): Promise<LocalProgressEvent[]> {
    return this.db.getAll<LocalProgressEvent>(
      `SELECT * FROM progress_events WHERE read_id = ? ORDER BY at DESC`,
      [readId],
    );
  }

  async getUnsyncedCount(): Promise<number> {
    return this.queue.getPendingCount();
  }

  /**
   * Saves a review with local optimistic write and persistent queue replay (SL-63).
   */
  async saveReview(
    readId: string,
    data: {
      body: string;
      has_spoilers?: boolean;
      spoiler_after_page?: number | null;
      visibility?: 'public' | 'followers' | 'private';
      rating?: number | null;
      hearted?: boolean | null;
    },
  ): Promise<void> {
    if (data.rating !== undefined || data.hearted !== undefined) {
      const updates: string[] = [];
      const params: any[] = [];
      if (data.rating !== undefined) {
        updates.push('rating = ?');
        params.push(data.rating);
      }
      if (data.hearted !== undefined && data.hearted !== null) {
        updates.push('hearted = ?');
        params.push(data.hearted ? 1 : 0);
      }
      if (updates.length > 0) {
        params.push(new Date().toISOString(), readId);
        await this.db.run(
          `UPDATE reads SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`,
          params,
        );
      }
    }

    await this.queue.enqueue('read', readId, 'save_review', data);
    void this.queue.flush();
  }
}
