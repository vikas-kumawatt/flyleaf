// Offline Mutation Queue Test Suite (SL-13, PRD §35, architecture.md §10).
//
// Tests:
// 1. Offline enqueue & optimistic writes
// 2. A 409 is a refusal the user must hear about, not a duplicate (audit 07 lead 1)
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
import type { QueuedMutation } from '../schema';
import { migrateOfflineDb } from '../migrations';
import { MutationQueue, type MutationHandler } from '../queue';
import { FlyleafApiError } from '@flyleaf/api-client';

import { NodeSqliteDriver } from './sqlite-driver';
export { NodeSqliteDriver };

const USER = 'user-1';

/** A handler whose unlisted actions fail loudly, so a test notices an unexpected call. */
function handlerWith(overrides: Partial<MutationHandler>): MutationHandler {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name}`);
  };
  return {
    addProgress: unexpected('addProgress'),
    upsertRead: unexpected('upsertRead'),
    finishRead: unexpected('finishRead'),
    dnfRead: unexpected('dnfRead'),
    saveReview: unexpected('saveReview'),
    ...overrides,
  };
}

describe('Offline Mutation Queue & Mirroring', () => {
  let db: NodeSqliteDriver;
  let rawDb: DatabaseSync;

  beforeEach(async () => {
    rawDb = new DatabaseSync(':memory:');
    db = new NodeSqliteDriver(rawDb);
    await migrateOfflineDb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  test('1. Offline enqueue persists mutation and records optimistic write', async () => {
    const queue = new MutationQueue(db, USER);
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

  // Inherited version asserted "409 → synced" and so encoded the bug (Rule 9).
  // The server answers a replay of the same event with 200; a 409 means it
  // refused the write, which must reach the user (PRD §35.2 "surface conflict").
  test('2. A 409 dead-letters at once with its code; the write is not marked synced', async () => {
    const readId = 'read-456';
    const clientEventId = 'dup-event-uuid';

    await db.run(
      `INSERT INTO reads (id, user_id, work_id, status, synced, created_at, updated_at)
       VALUES (?, ?, 'work-1', 'reading', 0, '2026-01-01', '2026-01-01')`,
      [readId, USER],
    );
    await db.run(
      `INSERT INTO progress_events (id, read_id, at, page, client_event_id, synced)
       VALUES ('pe-1', ?, '2026-01-01', 100, ?, 0)`,
      [readId, clientEventId],
    );

    let calls = 0;
    const handler = handlerWith({
      addProgress: async () => {
        calls++;
        throw new FlyleafApiError('client_event_conflict', 'This client_event_id was already used for another read.', undefined, 409);
      },
    });

    const queue = new MutationQueue(db, USER, handler);
    const m = await queue.enqueue('progress_event', readId, 'add_progress', { page: 100 }, clientEventId);

    const result = await queue.flush();
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    await queue.flush(true);
    assert.equal(calls, 1, 'a refusal is not retried');

    const row = await db.getFirst<QueuedMutation>(`SELECT * FROM mutation_queue WHERE id = ?`, [m.id]);
    assert.equal(row?.status, 'dead_letter');
    assert.equal(row?.error_code, 'client_event_conflict');
    assert.equal((await queue.getDeadLetters()).length, 1);

    const pe = await db.getFirst<{ synced: number }>(
      `SELECT synced FROM progress_events WHERE client_event_id = ?`,
      [clientEventId],
    );
    assert.equal(pe?.synced, 0);
  });

  test('2b. Every other refusal (403, 404, 409, 410, 422) dead-letters at once with its code', async () => {
    for (const [status, code] of [[403, 'email_unverified'], [404, 'not_found'], [409, 'thread_locked'], [410, 'gone'], [422, 'invalid_progress']] as const) {
      const queue = new MutationQueue(db, USER, handlerWith({
        saveReview: async () => {
          throw new FlyleafApiError(code, 'no', undefined, status);
        },
      }));
      const m = await queue.enqueue('review', `read-${status}`, 'save_review', { body: 'x' });
      await queue.flush();
      const row = await db.getFirst<QueuedMutation>(`SELECT * FROM mutation_queue WHERE id = ?`, [m.id]);
      assert.equal(row?.status, 'dead_letter', String(status));
      assert.equal(row?.error_code, code);
      assert.equal(row?.attempts, 1);
    }
  });

  test('2c. Offline (TypeError) and 401 wait without using an attempt, and stop the flush', async () => {
    for (const failure of [new TypeError('Network request failed'), new FlyleafApiError('unauthorized', 'no', undefined, 401)]) {
      const sent: string[] = [];
      const queue = new MutationQueue(db, USER, handlerWith({
        addProgress: async (readId) => {
          sent.push(readId);
          throw failure;
        },
      }));
      await queue.enqueue('progress_event', 'wait-A', 'add_progress', { page: 1 });
      await queue.enqueue('progress_event', 'wait-B', 'add_progress', { page: 1 });
      await queue.flush();
      assert.deepEqual(sent, ['wait-A'], 'one failed request is enough to know');
      const rows = await db.getAll<QueuedMutation>(`SELECT * FROM mutation_queue WHERE entity_id LIKE 'wait-%'`);
      assert.deepEqual(rows.map((r) => [r.status, r.attempts]), [['pending', 0], ['pending', 0]]);
      await db.run(`DELETE FROM mutation_queue`);
    }
  });

  test('3. Per-entity FIFO ordering is strictly preserved', async () => {
    const executionOrder: string[] = [];
    const handler = handlerWith({
      addProgress: async (readId, page) => {
        executionOrder.push(`${readId}:p${page}`);
      },
    });

    const queue = new MutationQueue(db, USER, handler);

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
    const handler = handlerWith({
      addProgress: async (_, page) => {
        if (page === 20) {
          throw new Error('Network timeout');
        }
        executed.push(page!);
      },
    });

    const queue = new MutationQueue(db, USER, handler);
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
    const handler = handlerWith({
      addProgress: async () => {
        failCount++;
        throw new Error('Server unreachable 503');
      },
    });

    const queue = new MutationQueue(db, USER, handler);
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
    assert.equal(deadLetters[0]!.id, m.id);

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
      await migrateOfflineDb(driver1);

      const queue1 = new MutationQueue(driver1, USER);
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
      const handler = handlerWith({
        addProgress: async (readId, page, _, __, clientEventId) => {
          replayedCalls.push(`${readId}:p${page}:${clientEventId}`);
        },
      });

      const queue2 = new MutationQueue(driver2, USER, handler);

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

  test('7. Offline review creation and queue replay (SL-63)', async () => {
    let replayedReadId: string | null = null;
    let replayedReview: any = null;
    const handler = handlerWith({
      addProgress: async () => {},
      saveReview: async (readId, payload) => {
        replayedReadId = readId;
        replayedReview = payload;
      },
    });
    const queue = new MutationQueue(db, USER, handler);

    await queue.enqueue(
      'review',
      'read-rev-100',
      'save_review',
      {
        body: 'A truly magnificent novel with intricate worldbuilding.',
        containsSpoilers: true,
        spoilerPage: 240,
        visibility: 'public',
      },
      'event-rev-uuid-1'
    );

    assert.equal(await queue.getPendingCount(), 1);

    const res = await queue.flush();
    assert.equal(res.succeeded, 1);
    assert.equal(res.failed, 0);
    assert.equal(await queue.getPendingCount(), 0);

    assert.equal(replayedReadId, 'read-rev-100');
    // client_event_id is queue bookkeeping; the review body goes out without it.
    assert.deepEqual(replayedReview, {
      body: 'A truly magnificent novel with intricate worldbuilding.',
      containsSpoilers: true,
      spoilerPage: 240,
      visibility: 'public',
    });
  });
});

