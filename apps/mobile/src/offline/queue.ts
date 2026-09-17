// Architecture §10:
// "Progress writes never block on the network. Every queued mutation carries a client_event_id.
// Replay is safe. Per-entity FIFO; independent entities in parallel. 2xx or 409 dup -> mark synced."

import type { OfflineDatabase } from './db';
import type { QueuedMutation, MutationAction } from './schema';
import { FlyleafApiError } from '@flyleaf/api-client';

function generateUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface MutationHandler {
  addProgress: (
    readId: string,
    page: number | null,
    percent: number | null,
    minutes: number | null,
    clientEventId: string,
  ) => Promise<any>;
  upsertRead: (
    workId: string,
    status: string,
    rating?: number | null,
    hearted?: boolean,
  ) => Promise<any>;
}

export class MutationQueue {
  private processing = false;

  constructor(
    private db: OfflineDatabase,
    private handler?: MutationHandler,
  ) {}

  setHandler(handler: MutationHandler) {
    this.handler = handler;
  }

  /**
   * Enqueues a new mutation into persistent SQLite storage.
   * Generates client_event_id if not provided.
   */
  async enqueue(
    entityType: 'read' | 'progress_event',
    entityId: string,
    action: MutationAction,
    payload: Record<string, any>,
    clientEventId?: string,
  ): Promise<QueuedMutation> {
    const id = generateUuid();
    const eventId = clientEventId ?? generateUuid();
    const now = new Date().toISOString();

    const mutationPayload = {
      ...payload,
      client_event_id: eventId,
    };

    await this.db.run(
      `INSERT INTO mutation_queue (
        id, entity_type, entity_id, action, payload, client_event_id,
        attempts, last_error, status, next_retry_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 'pending', ?, ?, ?)`,
      [
        id,
        entityType,
        entityId,
        action,
        JSON.stringify(mutationPayload),
        eventId,
        now,
        now,
        now,
      ],
    );

    return {
      id,
      entity_type: entityType,
      entity_id: entityId,
      action,
      payload: JSON.stringify(mutationPayload),
      client_event_id: eventId,
      attempts: 0,
      last_error: null,
      status: 'pending',
      next_retry_at: now,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Flushes eligible mutations with per-entity FIFO ordering.
   * Independent entities can process in parallel.
   */
  async flush(): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.processing || !this.handler) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    this.processing = true;
    let succeeded = 0;
    let failed = 0;

    try {
      const now = new Date().toISOString();
      const eligible = await this.db.getAll<QueuedMutation>(
        `SELECT * FROM mutation_queue
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC`,
        [now],
      );

      if (eligible.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      // Group by entity_id to guarantee per-entity FIFO
      const entityMap = new Map<string, QueuedMutation[]>();
      for (const m of eligible) {
        const group = entityMap.get(m.entity_id) ?? [];
        group.push(m);
        entityMap.set(m.entity_id, group);
      }

      // Process each entity's queue sequentially
      for (const [, mutations] of entityMap.entries()) {
        for (const m of mutations) {
          const success = await this.processMutation(m);
          if (success) {
            succeeded++;
          } else {
            failed++;
            // If an entity mutation fails, stop processing further mutations for THIS entity
            // to preserve strict causal sequence.
            break;
          }
        }
      }

      return {
        processed: succeeded + failed,
        succeeded,
        failed,
      };
    } finally {
      this.processing = false;
    }
  }

  private async processMutation(m: QueuedMutation): Promise<boolean> {
    if (!this.handler) return false;
    const payload = JSON.parse(m.payload);

    try {
      if (m.action === 'add_progress') {
        await this.handler.addProgress(
          m.entity_id,
          payload.page ?? null,
          payload.percent ?? null,
          payload.minutes ?? null,
          m.client_event_id,
        );
      } else if (m.action === 'upsert_read') {
        await this.handler.upsertRead(
          m.entity_id,
          payload.status,
          payload.rating,
          payload.hearted,
        );
      }

      // Success: delete from mutation queue and mark local mirrored record synced
      await this.markSuccess(m);
      return true;
    } catch (err: any) {
      // 409 Conflict check: duplicate client_event_id (Architecture §10: 2xx or 409 dup -> mark synced)
      const isDuplicate =
        (err instanceof FlyleafApiError && err.status === 409) ||
        err?.status === 409 ||
        err?.message?.includes('duplicate') ||
        err?.code === 'conflict';

      if (isDuplicate) {
        await this.markSuccess(m);
        return true;
      }

      // Failure: exponential backoff or dead-letter
      await this.markFailure(m, err?.message ?? 'Unknown error');
      return false;
    }
  }

  private async markSuccess(m: QueuedMutation): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Remove from queue
      await tx.run(`DELETE FROM mutation_queue WHERE id = ?`, [m.id]);

      // Mark mirrored rows synced
      if (m.action === 'add_progress') {
        await tx.run(
          `UPDATE progress_events SET synced = 1 WHERE client_event_id = ?`,
          [m.client_event_id],
        );
        await tx.run(`UPDATE reads SET synced = 1 WHERE id = ?`, [m.entity_id]);
      } else if (m.action === 'upsert_read') {
        await tx.run(`UPDATE reads SET synced = 1 WHERE work_id = ?`, [m.entity_id]);
      }
    });
  }

  private async markFailure(m: QueuedMutation, errorMessage: string): Promise<void> {
    const nextAttempts = m.attempts + 1;
    const now = Date.now();

    if (nextAttempts >= 5) {
      // Transition to dead-letter after 5 failed attempts
      await this.db.run(
        `UPDATE mutation_queue SET
          attempts = ?,
          status = 'dead_letter',
          last_error = ?,
          updated_at = ?
         WHERE id = ?`,
        [nextAttempts, errorMessage, new Date(now).toISOString(), m.id],
      );
    } else {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s... up to 60s
      const delayMs = Math.min(60000, 1000 * Math.pow(2, nextAttempts - 1));
      const nextRetry = new Date(now + delayMs).toISOString();

      await this.db.run(
        `UPDATE mutation_queue SET
          attempts = ?,
          last_error = ?,
          next_retry_at = ?,
          updated_at = ?
         WHERE id = ?`,
        [nextAttempts, errorMessage, nextRetry, new Date(now).toISOString(), m.id],
      );
    }
  }

  // ---------------------------------------------------------------- Monitoring & Recovery
  async getPendingCount(): Promise<number> {
    const row = await this.db.getFirst<{ count: number }>(
      `SELECT COUNT(*) as count FROM mutation_queue WHERE status = 'pending'`,
    );
    return row?.count ?? 0;
  }

  async getDeadLetters(): Promise<QueuedMutation[]> {
    return this.db.getAll<QueuedMutation>(
      `SELECT * FROM mutation_queue WHERE status = 'dead_letter' ORDER BY created_at ASC`,
    );
  }

  async retryDeadLetter(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE mutation_queue SET status = 'pending', attempts = 0, next_retry_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  }

  async dismissDeadLetter(id: string): Promise<void> {
    await this.db.run(`DELETE FROM mutation_queue WHERE id = ?`, [id]);
  }
}
