// Persistent mutation queue (SL-11, PRD §35.2, architecture §10).
//
// - Every queued mutation carries a client_event_id, belongs to one user, and
//   is replayed only while that user is signed in (audit 07, A-07-002).
// - Per-entity FIFO: a read's create, progress, finish and review replay in order.
// - Failures (A-07-001):
//     network / 401   -> persist and wait; does not use up an attempt
//     408, 429, 5xx   -> exponential backoff, dead-letter after 5 attempts
//     any other 4xx   -> dead-letter at once with the server's code. 409 is a
//                        refusal too: the server answers a replay of the same
//                        progress event with 200, never 409.
//   Dead letters are surfaced on the sync-issues screen with retry and discard.
// - A read created offline gets a local id; when the server returns the real
//   one, the local id is remapped everywhere (A-07-005).

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
    note?: string | null,
    audioSeconds?: number | null,
  ) => Promise<unknown>;
  /** Resolves with the server read: its id replaces a local one. */
  upsertRead: (
    workId: string,
    status: string,
    rating?: number | null,
    hearted?: boolean,
    extra?: any,
  ) => Promise<{ id: string } | unknown>;
  finishRead: (
    readId: string,
    payload: {
      finished_at?: string | null;
      rating?: number | null;
      hearted?: boolean | null;
      format_override?: string | null;
      visibility?: any;
    },
  ) => Promise<unknown>;
  dnfRead: (
    readId: string,
    payload: {
      abandoned_page?: number | null;
      dnf_reason?: string | null;
      note?: string | null;
      rating?: number | null;
      visibility?: any;
    },
  ) => Promise<unknown>;
  saveReview: (
    readId: string,
    payload: {
      body: string;
      has_spoilers?: boolean;
      spoiler_after_page?: number | null;
      visibility?: any;
      rating?: number | null;
      hearted?: boolean | null;
    },
  ) => Promise<unknown>;
}

export const MAX_ATTEMPTS = 5;
/** How long to wait before trying again while offline or signed out. */
const WAIT_MS = 15_000;

export type FailureKind = 'wait' | 'retry' | 'refused';

export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof FlyleafApiError && err.status !== undefined) {
    if (err.status === 401) return 'wait';
    if (err.status === 408 || err.status === 429 || err.status >= 500) return 'retry';
    return 'refused';
  }
  // React Native's fetch rejects with a TypeError when there is no network.
  if (err instanceof TypeError) return 'wait';
  return 'retry';
}

/** Screens queue writes through their own repository; the sync provider listens here to re-count. */
const changeListeners = new Set<() => void>();

export function onQueueChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function queueChanged() {
  for (const listener of changeListeners) listener();
}

/** One flush at a time per database, however many queue objects screens create. */
const flushing = new WeakSet<OfflineDatabase>();

type Outcome = 'ok' | 'next' | 'halt_entity' | 'halt_all';

export class MutationQueue {
  constructor(
    private db: OfflineDatabase,
    private userId: string,
    private handler?: MutationHandler,
  ) {}

  setHandler(handler: MutationHandler) {
    this.handler = handler;
  }

  /**
   * Enqueues a new mutation into persistent SQLite storage for this user.
   * Generates client_event_id if not provided.
   */
  async enqueue(
    entityType: 'read' | 'progress_event' | 'review',
    entityId: string,
    action: MutationAction,
    payload: Record<string, any>,
    clientEventId?: string,
  ): Promise<QueuedMutation> {
    const id = generateUuid();
    const eventId = clientEventId ?? generateUuid();
    const now = new Date().toISOString();
    const body = JSON.stringify({ ...payload, client_event_id: eventId });

    await this.db.run(
      `INSERT INTO mutation_queue (
        id, user_id, entity_type, entity_id, action, payload, client_event_id,
        attempts, last_error, error_code, status, next_retry_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 'pending', ?, ?, ?)`,
      [id, this.userId, entityType, entityId, action, body, eventId, now, now, now],
    );
    queueChanged();

    return {
      id,
      user_id: this.userId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      payload: body,
      client_event_id: eventId,
      attempts: 0,
      last_error: null,
      error_code: null,
      status: 'pending',
      next_retry_at: now,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Replays this user's eligible mutations, per-entity FIFO.
   */
  async flush(force = false): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (flushing.has(this.db) || !this.handler) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }
    flushing.add(this.db);
    let succeeded = 0;
    let failed = 0;

    try {
      const eligible = await this.db.getAll<{ id: string; entity_id: string }>(
        `SELECT id, entity_id FROM mutation_queue
          WHERE user_id = ? AND status = 'pending'
            AND (? OR next_retry_at IS NULL OR next_retry_at <= ?)
          ORDER BY created_at ASC`,
        [this.userId, force ? 1 : 0, new Date().toISOString()],
      );

      const byEntity = new Map<string, string[]>();
      for (const m of eligible) {
        const group = byEntity.get(m.entity_id) ?? [];
        group.push(m.id);
        byEntity.set(m.entity_id, group);
      }

      entities: for (const ids of byEntity.values()) {
        for (const id of ids) {
          // Re-read: an earlier mutation may have remapped this row's read id.
          const m = await this.db.getFirst<QueuedMutation>(
            `SELECT * FROM mutation_queue WHERE id = ? AND status = 'pending'`,
            [id],
          );
          if (!m) continue;
          const outcome = await this.processMutation(m);
          if (outcome === 'ok') {
            succeeded++;
            continue;
          }
          failed++;
          if (outcome === 'halt_all') break entities;
          if (outcome === 'halt_entity') break;
        }
      }

      return { processed: succeeded + failed, succeeded, failed };
    } finally {
      flushing.delete(this.db);
      queueChanged();
    }
  }

  private async processMutation(m: QueuedMutation): Promise<Outcome> {
    const handler = this.handler!;
    // A write queued against a local read id after its remap: send it to the server id.
    const alias = await this.db.getFirst<{ server_id: string }>(
      `SELECT server_id FROM read_aliases WHERE local_id = ?`,
      [m.entity_id],
    );
    if (alias) {
      await this.db.run(`UPDATE mutation_queue SET entity_id = ? WHERE entity_id = ?`, [alias.server_id, m.entity_id]);
      m = { ...m, entity_id: alias.server_id };
    }
    const payload = JSON.parse(m.payload);
    const { client_event_id: _eventId, ...body } = payload;

    let result: unknown;
    try {
      switch (m.action) {
        case 'add_progress':
          result = await handler.addProgress(
            m.entity_id,
            payload.page ?? null,
            payload.percent ?? null,
            payload.minutes ?? null,
            m.client_event_id,
            payload.note ?? null,
            payload.audio_seconds ?? null,
          );
          break;
        case 'upsert_read':
          result = await handler.upsertRead(payload.work_id, payload.status, payload.rating, payload.hearted, payload.extra);
          break;
        case 'finish_read':
          result = await handler.finishRead(m.entity_id, body);
          break;
        case 'dnf_read':
          result = await handler.dnfRead(m.entity_id, body);
          break;
        case 'save_review':
          result = await handler.saveReview(m.entity_id, body);
          break;
        default:
          throw new Error(`Unknown queued action: ${String(m.action)}`);
      }
    } catch (err: unknown) {
      const kind = classifyFailure(err);
      if (kind === 'wait') {
        await this.db.run(
          `UPDATE mutation_queue SET next_retry_at = ?, updated_at = ? WHERE id = ?`,
          [new Date(Date.now() + WAIT_MS).toISOString(), new Date().toISOString(), m.id],
        );
        // Offline or signed out: every other request would fail the same way.
        return 'halt_all';
      }
      if (kind === 'refused') {
        await this.deadLetter(m, m.attempts + 1, err);
        // This row is out of the way; the entity's later writes may still apply.
        return 'next';
      }
      await this.markFailure(m, err);
      return 'halt_entity';
    }

    await this.markSuccess(m, result);
    return 'ok';
  }

  private async markSuccess(m: QueuedMutation, result: unknown): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run(`DELETE FROM mutation_queue WHERE id = ?`, [m.id]);

      let readId = m.entity_id;
      const serverId = (result as { id?: unknown } | null)?.id;
      if (m.action === 'upsert_read' && typeof serverId === 'string' && serverId !== readId) {
        await remapRead(tx, readId, serverId);
        readId = serverId;
      }

      if (m.action === 'add_progress') {
        await tx.run(`UPDATE progress_events SET synced = 1 WHERE client_event_id = ?`, [m.client_event_id]);
      }
      // Clean only when nothing else for this read is waiting, so a server
      // refresh cannot overwrite local state that has not synced yet.
      await tx.run(
        `UPDATE reads SET synced = 1
          WHERE id = ?
            AND NOT EXISTS (SELECT 1 FROM mutation_queue WHERE entity_id = ? AND status = 'pending')`,
        [readId, readId],
      );
    });
  }

  private async markFailure(m: QueuedMutation, err: unknown): Promise<void> {
    const attempts = m.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.deadLetter(m, attempts, err);
      return;
    }
    // Exponential backoff: 1s, 2s, 4s, 8s ... up to 60s
    const delayMs = Math.min(60_000, 1000 * 2 ** (attempts - 1));
    const now = Date.now();
    await this.db.run(
      `UPDATE mutation_queue SET attempts = ?, last_error = ?, error_code = ?, next_retry_at = ?, updated_at = ? WHERE id = ?`,
      [attempts, errorMessage(err), errorCode(err), new Date(now + delayMs).toISOString(), new Date(now).toISOString(), m.id],
    );
  }

  private async deadLetter(m: QueuedMutation, attempts: number, err: unknown): Promise<void> {
    await this.db.run(
      `UPDATE mutation_queue SET attempts = ?, status = 'dead_letter', last_error = ?, error_code = ?, updated_at = ? WHERE id = ?`,
      [attempts, errorMessage(err), errorCode(err), new Date().toISOString(), m.id],
    );
  }

  // ---------------------------------------------------------------- Monitoring & Recovery
  async getPendingCount(): Promise<number> {
    const row = await this.db.getFirst<{ count: number }>(
      `SELECT COUNT(*) as count FROM mutation_queue WHERE user_id = ? AND status = 'pending'`,
      [this.userId],
    );
    return row?.count ?? 0;
  }

  /** This user's dead letters, plus rows from before migration 2 that no account can be matched to. */
  async getDeadLetters(): Promise<QueuedMutation[]> {
    return this.db.getAll<QueuedMutation>(
      `SELECT * FROM mutation_queue
        WHERE status = 'dead_letter' AND (user_id = ? OR user_id IS NULL)
        ORDER BY created_at ASC`,
      [this.userId],
    );
  }

  async retryDeadLetter(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE mutation_queue SET status = 'pending', attempts = 0, error_code = NULL, next_retry_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
      [now, now, id, this.userId],
    );
  }

  async dismissDeadLetter(id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM mutation_queue WHERE id = ? AND status = 'dead_letter' AND (user_id = ? OR user_id IS NULL)`,
      [id, this.userId],
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

function errorCode(err: unknown): string | null {
  return err instanceof FlyleafApiError ? err.code : null;
}

const READ_COLUMNS = [
  'user_id', 'work_id', 'edition_id', 'status', 'attempt_no', 'started_at', 'finished_at',
  'abandoned_at', 'abandoned_page', 'dnf_reason', 'rating', 'hearted', 'format_override',
  'visibility', 'title', 'author_name', 'cover_id', 'page', 'percent', 'page_count', 'synced',
  'created_at', 'updated_at',
].join(', ');

/** Move a read created offline (local id) onto the id the server gave it. */
async function remapRead(tx: OfflineDatabase, localId: string, serverId: string): Promise<void> {
  const serverRow = await tx.getFirst<{ id: string }>(`SELECT id FROM reads WHERE id = ?`, [serverId]);
  if (!serverRow) {
    await tx.run(
      `INSERT INTO reads (id, ${READ_COLUMNS}) SELECT ?, ${READ_COLUMNS} FROM reads WHERE id = ?`,
      [serverId, localId],
    );
  }
  await tx.run(`UPDATE progress_events SET read_id = ? WHERE read_id = ?`, [serverId, localId]);
  await tx.run(`DELETE FROM reads WHERE id = ?`, [localId]);
  await tx.run(`UPDATE mutation_queue SET entity_id = ? WHERE entity_id = ?`, [serverId, localId]);
  // A screen still holding the local id writes through the alias (repository).
  await tx.run(`INSERT OR REPLACE INTO read_aliases (local_id, server_id) VALUES (?, ?)`, [localId, serverId]);
}
