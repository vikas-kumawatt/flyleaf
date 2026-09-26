// Audit 07b (D-07-2): likes and follows go through the offline queue.
//  - queued as the wanted state; an opposite write still waiting cancels it
//  - a row a flush is already sending is never cancelled (claimed)
//  - a write queued during a flush is sent when that flush ends
//  - a row left mid-send by a killed process is sent again
//  - reconnect detection, and how refusals read on the sync-issues screen

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FlyleafApiError } from '@flyleaf/api-client';

import type { QueuedMutation } from '../schema';
import { migrateOfflineDb } from '../migrations';
import { MutationQueue, type MutationHandler } from '../queue';
import { OfflineRepository } from '../repository';
import { isOnline, reconnectDetector } from '../connectivity';
import { describeSyncIssue } from '../syncIssues';
import { NodeSqliteDriver } from './sqlite-driver';

const USER = 'user-a';

/** Records social calls; `offline` makes every call fail like React Native's fetch with no network. */
function socialHandler(log: string[], net: { offline: boolean }, gate?: Promise<void>): MutationHandler {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name}`);
  };
  const send = async (entry: string) => {
    if (net.offline) throw new TypeError('Network request failed');
    if (gate) await gate;
    log.push(entry);
  };
  return {
    addProgress: unexpected('addProgress'),
    upsertRead: unexpected('upsertRead'),
    finishRead: unexpected('finishRead'),
    dnfRead: unexpected('dnfRead'),
    saveReview: unexpected('saveReview'),
    setLiked: (readId, liked) => send(`like:${readId}:${liked}`),
    setFollowing: (userId, following) => send(`follow:${userId}:${following}`),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function rows(db: NodeSqliteDriver): Promise<QueuedMutation[]> {
  return db.getAll<QueuedMutation>(`SELECT * FROM mutation_queue ORDER BY created_at, rowid`);
}

describe('social writes through the offline queue (D-07-2)', () => {
  let db: NodeSqliteDriver;

  beforeEach(async () => {
    db = new NodeSqliteDriver(new DatabaseSync(':memory:'));
    await migrateOfflineDb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  test('like then unlike offline sends nothing, also after reconnect', async () => {
    const log: string[] = [];
    const net = { offline: true };
    const repo = new OfflineRepository(db, USER, socialHandler(log, net));

    await repo.setLiked('read-1', true);
    await tick(); // the flush setLiked starts finds no network and waits
    await repo.setLiked('read-1', false);
    await tick();

    assert.deepEqual(await rows(db), []);
    assert.equal(await repo.getUnsyncedCount(), 0);

    net.offline = false;
    await repo.getQueue().flush(true);
    assert.deepEqual(log, []);
  });

  test('follow, unfollow, follow offline sends one follow; repeating a state queues nothing new', async () => {
    const log: string[] = [];
    const net = { offline: true };
    const queue = new MutationQueue(db, USER, socialHandler(log, net));

    assert.equal(await queue.enqueueDesiredState('set_follow', 'user-x', true), 'queued');
    assert.equal(await queue.enqueueDesiredState('set_follow', 'user-x', true), 'unchanged');
    assert.equal(await queue.enqueueDesiredState('set_follow', 'user-x', false), 'cancelled');
    assert.equal(await queue.enqueueDesiredState('set_follow', 'user-x', true), 'queued');
    assert.equal(await queue.getPendingCount(), 1);

    net.offline = false;
    await queue.flush(true);
    assert.deepEqual(log, ['follow:user-x:true']);
    assert.equal(await queue.getPendingCount(), 0);
  });

  test('only the same user, action and target coalesce', async () => {
    const log: string[] = [];
    const net = { offline: false };
    const a = new MutationQueue(db, USER, socialHandler(log, net));
    const b = new MutationQueue(db, 'user-b', socialHandler(log, net));

    await a.enqueueDesiredState('set_like', 'read-1', true);
    // Another target, another action, another user: none of these cancel it.
    assert.equal(await a.enqueueDesiredState('set_like', 'read-2', false), 'queued');
    assert.equal(await a.enqueueDesiredState('set_follow', 'read-1', false), 'queued');
    assert.equal(await b.enqueueDesiredState('set_like', 'read-1', false), 'queued');

    await a.flush(true);
    // Sent per entity group, so compare what was sent, not the order across groups.
    assert.deepEqual([...log].sort(), ['follow:read-1:false', 'like:read-1:true', 'like:read-2:false']);
    await b.flush(true);
    assert.deepEqual(log.slice(3), ['like:read-1:false']);
  });

  test('an unlike while the like is being sent is queued behind it, and sent without another trigger', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const repo = new OfflineRepository(db, USER, socialHandler(log, { offline: false }, gate));

    await repo.setLiked('read-1', true); // its flush claims the row and waits on the gate
    await tick();
    const [sending] = await rows(db);
    assert.equal(sending?.status, 'processing');

    await repo.setLiked('read-1', false); // cannot take back a like already on the wire
    assert.equal((await rows(db)).length, 2);

    release();
    for (let i = 0; i < 50 && log.length < 2; i++) await tick();
    assert.deepEqual(log, ['like:read-1:true', 'like:read-1:false']);
    assert.equal(await repo.getUnsyncedCount(), 0);
  });

  test('a row left mid-send by a killed process is counted and sent again', async () => {
    const log: string[] = [];
    const queue = new MutationQueue(db, USER, socialHandler(log, { offline: false }));
    await queue.enqueueDesiredState('set_follow', 'user-x', true);
    await db.run(`UPDATE mutation_queue SET status = 'processing'`);

    assert.equal(await queue.getPendingCount(), 1);
    // Its opposite cannot cancel it: it may have reached the server.
    assert.equal(await queue.enqueueDesiredState('set_follow', 'user-x', false), 'queued');

    await queue.flush(true);
    assert.deepEqual(log, ['follow:user-x:true', 'follow:user-x:false']);
  });

  test('a refused like or follow is a dead letter that says what it was', async () => {
    const handler: MutationHandler = {
      ...socialHandler([], { offline: false }),
      setLiked: async () => {
        throw new FlyleafApiError('not_found', 'Not found.', undefined, 404);
      },
      setFollowing: async () => {
        throw new FlyleafApiError('not_found', 'User not found.', undefined, 404);
      },
    };
    const queue = new MutationQueue(db, USER, handler);
    await queue.enqueueDesiredState('set_like', 'read-1', false);
    await queue.enqueueDesiredState('set_follow', 'user-x', true);
    await queue.flush(true);

    const issues = (await queue.getDeadLetters()).map(describeSyncIssue);
    assert.deepEqual(
      issues.map((i) => [i.label, i.reason, i.canRetry]),
      [
        ['Unlike', 'This read is no longer available.', true],
        ['Follow', 'This account is no longer available.', true],
      ],
    );
  });
});

test('an unverified follow says what to do about a follow, not a review', () => {
  const row = { id: 'm1', user_id: USER, error_code: 'email_unverified', last_error: 'Verify your email address to do that.' };
  assert.equal(
    describeSyncIssue({ ...row, action: 'set_follow', payload: '{"following":true}' }).reason,
    'Verify your email address to follow people. Then retry.',
  );
  assert.equal(
    describeSyncIssue({ ...row, action: 'save_review', payload: '{"body":"x"}' }).reason,
    'Verify your email address to post reviews. Then retry.',
  );
});

describe('connectivity (D-07-2)', () => {
  test('only a definite no is offline', () => {
    assert.equal(isOnline({ isConnected: true, isInternetReachable: true }), true);
    assert.equal(isOnline({ isConnected: true, isInternetReachable: null }), true);
    assert.equal(isOnline({ isConnected: null, isInternetReachable: null }), true);
    assert.equal(isOnline({ isConnected: true, isInternetReachable: false }), false);
    assert.equal(isOnline({ isConnected: false, isInternetReachable: null }), false);
  });

  test('a reconnect is offline followed by online, once', () => {
    const reconnected = reconnectDetector();
    const on = { isConnected: true, isInternetReachable: true };
    const off = { isConnected: false, isInternetReachable: false };
    assert.deepEqual(
      [on, off, off, on, on, off, on].map(reconnected),
      [false, false, false, true, false, false, true],
    );
  });
});
