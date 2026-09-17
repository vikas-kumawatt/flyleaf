// Offline-First Reading Repository (SL-10, SL-11, architecture.md §10).
//
// Governed by: "Progress writes never block on the network."
// Optimistic local write to SQLite -> UI updates immediately -> queued for sync.

import * as Crypto from 'expo-crypto';
import type { OfflineDatabase } from './db';
import { MutationQueue } from './queue';
import type { LocalRead } from './schema';
import { api, type Read, type ReadStatus } from '@/lib/api';

export class OfflineRepository {
  private queue: MutationQueue;

  constructor(private db: OfflineDatabase) {
    this.queue = new MutationQueue(db, {
      addProgress: async (readId, page, percent, minutes, clientEventId) => {
        return api.client.addProgress(readId, {
          client_event_id: clientEventId,
          page,
          percent,
          minutes,
        });
      },
      upsertRead: async (workId, status, rating, hearted) => {
        return api.setStatus(workId, status, rating, hearted);
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
  ): Promise<{ clientEventId: string }> {
    const clientEventId = Crypto.randomUUID();
    const eventId = Crypto.randomUUID();
    const now = new Date().toISOString();

    await this.db.transaction(async (tx) => {
      // 1. Optimistic append to progress_events
      await tx.run(
        `INSERT INTO progress_events (id, read_id, at, page, percent, minutes, client_event_id, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [eventId, readId, now, page, percent, minutes, clientEventId],
      );

      // 2. Optimistic update to reads row
      await tx.run(
        `UPDATE reads SET
          page = COALESCE(?, page),
          percent = COALESCE(?, percent),
          synced = 0,
          updated_at = ?
         WHERE id = ?`,
        [page, percent, now, readId],
      );

      // 3. Enqueue mutation
      await this.queue.enqueue(
        'progress_event',
        readId,
        'add_progress',
        { page, percent, minutes },
        clientEventId,
      );
    });

    // Attempt background flush asynchronously without blocking caller
    void this.queue.flush();

    return { clientEventId };
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
    meta?: { title?: string; author_name?: string; cover_id?: number | null },
  ): Promise<void> {
    const now = new Date().toISOString();
    const readId = Crypto.randomUUID();

    await this.db.transaction(async (tx) => {
      // Check existing read for this work
      const existing = await tx.getFirst<LocalRead>(
        `SELECT id, attempt_no FROM reads WHERE work_id = ? AND user_id = ? ORDER BY attempt_no DESC LIMIT 1`,
        [workId, userId],
      );

      if (existing) {
        await tx.run(
          `UPDATE reads SET
            status = ?,
            rating = COALESCE(?, rating),
            hearted = ?,
            synced = 0,
            updated_at = ?
           WHERE id = ?`,
          [status, rating, hearted ? 1 : 0, now, existing.id],
        );
      } else {
        await tx.run(
          `INSERT INTO reads (
            id, user_id, work_id, status, attempt_no, rating, hearted, visibility,
            title, author_name, cover_id, page, percent, page_count, synced, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, 'public', ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
          [
            readId,
            userId,
            workId,
            status,
            rating,
            hearted ? 1 : 0,
            meta?.title ?? null,
            meta?.author_name ?? null,
            meta?.cover_id ?? null,
            now,
            now,
          ],
        );
      }

      await this.queue.enqueue('read', workId, 'upsert_read', {
        status,
        rating,
        hearted,
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
            id, user_id, work_id, status, attempt_no, rating, hearted, visibility,
            title, author_name, cover_id, page, percent, page_count, synced, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            r.id,
            r.user_id,
            r.work_id,
            r.status,
            r.attempt_no,
            r.rating,
            r.hearted ? 1 : 0,
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

  async getUnsyncedCount(): Promise<number> {
    return this.queue.getPendingCount();
  }
}
