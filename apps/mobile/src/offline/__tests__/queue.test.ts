// Offline Mutation Queue Test Suite (SL-13, PRD §35, architecture.md §10).
//
// Tests:
// 1. Offline enqueue & optimistic writes
// 2. Idempotent replay with 409 conflict handling
// 3. Strict per-entity FIFO ordering
// 4. Exponential backoff on network errors
// 5. Dead-letter queue after 5 failures & recovery
// 6. Simulated process death across persistent disk restart

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { OfflineDatabase } from '../db';
import { SCHEMA_SQL, type QueuedMutation, type LocalRead } from '../schema';
import { MutationQueue, type MutationHandler } from '../queue';
import { FlyleafApiError } from '@flyleaf/api-client';

export class NodeSqliteDriver implements OfflineDatabase {
  constructor(private db: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: any[] = []): Promise<{ rowsAffected: number; lastInsertRowId?: number }> {
    const stmt = this.db.prepare(sql);
    const res = stmt.run(...params);
    return {
      rowsAffected: Number(res.changes),
      lastInsertRowId: Number(res.lastInsertRowid),
    };
  }

  async getAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  async getFirst<T = any>(sql: string, params: any[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params);
    return (row ?? null) as T | null;
  }

  async transaction<T>(action: (tx: OfflineDatabase) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const res = await action(this);
      this.db.exec('COMMIT');
      return res;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

describe('Offline Mutation Queue & Mirroring', () => {
  let db: NodeSqliteDriver;
  let rawDb: DatabaseSync;

  beforeEach(async () => {
    rawDb = new DatabaseSync(':memory:');
    db = new NodeSqliteDriver(rawDb);
    await db.exec(SCHEMA_SQL);
  });

  afterEach(async () => {
    await db.close();
  });

  test('1. Offline enqueue persists mutation and records optimistic write', async () => {
    const queue = new MutationQueue(db);
    const readId = 'read-123';
    const clientEventId = 'event-uuid-1';

    const mutation = await queue.enqueue(
      'progress_event',
      readId,
      'add_progress',
      { page: 42, percent: 50 },
      clientEventId,
    );

    assert.equal(mutation.entity_id, readId);
    assert.equal(mutation.status, 'pending');
    assert.equal(mutation.client_event_id, clientEventId);

    // Verify persisted in SQLite
    const count = await queue.getPendingCount();
    assert.equal(count, 1);

    const row = await db.getFirst<QueuedMutation>(
      `SELECT * FROM mutation_queue WHERE id = ?`,
      [mutation.id],
    );
    assert.ok(row);
    assert.equal(row.client_event_id, clientEventId);
    assert.equal(row.attempts, 0);
  });

  test('2. Idempotent replay on 409 conflict marks synced and purges queue', async () => {
    const readId = 'read-456';
    const clientEventId = 'dup-event-uuid';

    // Insert optimistic local rows
    await db.run(
      `INSERT INTO reads (id, user_id, work_id, status, created_at, updated_at)
       VALUES (?, 'user-1', 'work-1', 'reading', '2026-01-01', '2026-01-01')`,
      [readId],
    );
    await db.run(
      `INSERT INTO progress_events (id, read_id, at, page, client_event_id, synced)
       VALUES ('pe-1', ?, '2026-01-01', 100, ?, 0)`,
      [readId, clientEventId],
    );

    let called = false;
    const handler: MutationHandler = {
      addProgress: async () => {
        called = true;
        // Simulate server returning 409 Conflict (event already recorded)
        throw new FlyleafApiError('conflict', 'Duplicate client_event_id', undefined, 409);
      },
      upsertRead: async () => {},
    };

    const queue = new MutationQueue(db, handler);
    await queue.enqueue('progress_event', readId, 'add_progress', { page: 100 }, clientEventId);

    const result = await queue.flush();
    assert.equal(called, true);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);

    // Assert queue is empty
    const pendingCount = await queue.getPendingCount();
    assert.equal(pendingCount, 0);

    // Assert local progress_events row was marked synced = 1
    const pe = await db.getFirst<{ synced: number }>(
      `SELECT synced FROM progress_events WHERE client_event_id = ?`,
      [clientEventId],
    );
    assert.equal(pe?.synced, 1);
  });

  test('3. Per-entity FIFO ordering is strictly preserved', async () => {
    const executionOrder: string[] = [];
    const handler: MutationHandler = {
      addProgress: async (readId, page) => {
        executionOrder.push(`${readId}:p${page}`);
      },
      upsertRead: async () => {},
    };

    const queue = new MutationQueue(db, handler);

    // Enqueue 3 mutations for Book A and 2 for Book B
    await queue.enqueue('progress_event', 'book-A', 'add_progress', { page: 10 });
    await queue.enqueue('progress_event', 'book-B', 'add_progress', { page: 5 });
    await queue.enqueue('progress_event', 'book-A', 'add_progress', { page: 20 });
    await queue.enqueue('progress_event', 'book-B', 'add_progress', { page: 15 });
    await queue.enqueue('progress_event', 'book-A', 'add_progress', { page: 30 });

    await queue.flush();

    // Verify book A mutations executed strictly in chronological order: 10 -> 20 -> 30
    const bookAOrder = executionOrder.filter((s) => s.startsWith('book-A'));
    assert.deepEqual(bookAOrder, ['book-A:p10', 'book-A:p20', 'book-A:p30']);

    // Verify book B mutations executed strictly in chronological order: 5 -> 15
    const bookBOrder = executionOrder.filter((s) => s.startsWith('book-B'));
    assert.deepEqual(bookBOrder, ['book-B:p5', 'book-B:p15']);
  });

  test('4. Per-entity FIFO halts subsequent mutations for the same entity if predecessor fails', async () => {
    const executed: number[] = [];
    const handler: MutationHandler = {
      addProgress: async (_, page) => {
        if (page === 20) {
          throw new Error('Network timeout');
        }
        executed.push(page!);
      },
      upsertRead: async () => {},
    };

    const queue = new MutationQueue(db, handler);
    await queue.enqueue('progress_event', 'book-A', 'add_progress', { page: 10 });
    await queue.enqueue('progress_event', 'book-A', 'add_progress', { page: 20 });
    await queue.enqueue('progress_event', 'book-A', 'add_progress', { page: 30 });

    const result = await queue.flush();
    assert.equal(result.succeeded, 1); // page 10
    assert.equal(result.failed, 1);    // page 20 failed

    // Page 30 must NOT execute because page 20 failed (preserves causal ordering)
    assert.deepEqual(executed, [10]);

    // Page 20 and 30 remain in queue
    const remaining = await queue.getPendingCount();
    assert.equal(remaining, 2);
  });

  test('5. Exponential backoff and dead-letter queue after 5 failures', async () => {
    let failCount = 0;
    const handler: MutationHandler = {
      addProgress: async () => {
        failCount++;
        throw new Error('Server unreachable 503');
      },
      upsertRead: async () => {},
    };

    const queue = new MutationQueue(db, handler);
    const m = await queue.enqueue('progress_event', 'read-1', 'add_progress', { page: 50 });

    // Attempt 1: backoff scheduled
    await queue.flush();
    let row = await db.getFirst<QueuedMutation>(`SELECT * FROM mutation_queue WHERE id = ?`, [m.id]);
    assert.equal(row?.attempts, 1);
    assert.equal(row?.status, 'pending');
    assert.ok(row?.next_retry_at);

    // Fast-forward next_retry_at to simulate time passing for attempts 2, 3, 4, 5
    for (let i = 2; i <= 5; i++) {
      await db.run(
        `UPDATE mutation_queue SET next_retry_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`,
        [m.id],
      );
      await queue.flush();
    }

    row = await db.getFirst<QueuedMutation>(`SELECT * FROM mutation_queue WHERE id = ?`, [m.id]);
    assert.equal(row?.attempts, 5);
    assert.equal(row?.status, 'dead_letter');
    assert.ok(row?.last_error?.includes('503'));

    // Verify visible via dead-letter recovery methods
    const deadLetters = await queue.getDeadLetters();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0].id, m.id);

    // Verify retryDeadLetter resets back to pending
    await queue.retryDeadLetter(m.id);
    row = await db.getFirst<QueuedMutation>(`SELECT * FROM mutation_queue WHERE id = ?`, [m.id]);
    assert.equal(row?.status, 'pending');
    assert.equal(row?.attempts, 0);
  });

  test('6. Simulated process death across persistent disk restart', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyleaf-offline-test-'));
    const dbPath = path.join(tmpDir, 'test_flyleaf.db');

    try {
      // 1. Process 1: Open disk database, enqueue mutations offline
      const rawDb1 = new DatabaseSync(dbPath);
      const driver1 = new NodeSqliteDriver(rawDb1);
      await driver1.exec(SCHEMA_SQL);

      const queue1 = new MutationQueue(driver1);
      const m1 = await queue1.enqueue('progress_event', 'read-offline-1', 'add_progress', { page: 50 }, 'uuid-off-1');
      const m2 = await queue1.enqueue('progress_event', 'read-offline-1', 'add_progress', { page: 60 }, 'uuid-off-2');
      const m3 = await queue1.enqueue('progress_event', 'read-offline-2', 'add_progress', { page: 120 }, 'uuid-off-3');

      assert.equal(await queue1.getPendingCount(), 3);

      // 2. SIMULATE PROCESS DEATH: Abruptly close DB connection and destroy queue instance
      await driver1.close();

      // 3. Process 2: Start fresh app process, open database from disk file
      const rawDb2 = new DatabaseSync(dbPath);
      const driver2 = new NodeSqliteDriver(rawDb2);

      const replayedCalls: string[] = [];
      const handler: MutationHandler = {
        addProgress: async (readId, page, _, __, clientEventId) => {
          replayedCalls.push(`${readId}:p${page}:${clientEventId}`);
        },
        upsertRead: async () => {},
      };

      const queue2 = new MutationQueue(driver2, handler);

      // Verify all 3 mutations survived process death with intact client_event_ids
      const recoveredCount = await queue2.getPendingCount();
      assert.equal(recoveredCount, 3);

      // 4. Flush recovered queue online
      const flushResult = await queue2.flush();
      assert.equal(flushResult.succeeded, 3);
      assert.equal(flushResult.failed, 0);

      // Assert exact execution with preserved client_event_id
      assert.deepEqual(replayedCalls, [
        'read-offline-1:p50:uuid-off-1',
        'read-offline-1:p60:uuid-off-2',
        'read-offline-2:p120:uuid-off-3',
      ]);

      // Queue is now completely clean
      assert.equal(await queue2.getPendingCount(), 0);

      await driver2.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
