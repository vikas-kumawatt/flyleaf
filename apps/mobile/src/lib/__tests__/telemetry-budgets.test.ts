import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  track,
  getSessionId,
  resetSessionId,
  flushEvents,
  getPendingEventQueue,
  clearEventQueue,
  setTelemetryTransport,
} from '../events';
import { budgetTracker } from '../budgetTracker';

describe('Telemetry Event Queue & Session Management (SL-80, PRD §28.1)', () => {
  beforeEach(() => {
    clearEventQueue();
    setTelemetryTransport(null);
  });

  it('generates a valid UUID v4 session ID and persists across events', () => {
    const s1 = getSessionId();
    assert.match(s1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const s2 = getSessionId();
    assert.equal(s1, s2);
  });

  it('resetSessionId explicitly rotates the session ID', () => {
    const s1 = getSessionId();
    const s2 = resetSessionId();
    assert.notEqual(s1, s2);
    assert.equal(getSessionId(), s2);
  });

  it('buffers events in memory with session_id, timestamp, and platform metadata', () => {
    track('test_event', { foo: 'bar', count: 42 });
    const queue = getPendingEventQueue();
    assert.equal(queue.length, 1);
    const item = queue[0]!;
    const props = getItemProps(item);
    assert.equal(item.name, 'test_event');
    assert.equal(props.foo, 'bar');
    assert.equal(props.count, 42);
    assert.ok(item.session_id);
    assert.ok(item.at);
    assert.equal(item.app_version, '1.0.0');
  });

  it('flushes queued events to transport and clears queue on success', async () => {
    let sentBatch: any[] = [];
    setTelemetryTransport(async (batch: any[]) => {
      sentBatch = batch;
      return { accepted: batch.length };
    });

    track('event_1', { step: 1 });
    track('event_2', { step: 2 });
    assert.equal(getPendingEventQueue().length, 2);

    const accepted = await flushEvents();
    assert.equal(accepted, 2);
    assert.equal(sentBatch.length, 2);
    assert.equal(sentBatch[0]!.name, 'event_1');
    assert.equal(sentBatch[1]!.name, 'event_2');
    assert.equal(getPendingEventQueue().length, 0);
  });

  it('preserves events in queue on delivery failure for offline resilience', async () => {
    setTelemetryTransport(async () => {
      throw new Error('Network error: server unreachable');
    });

    track('offline_event_1', { key: 'val' });
    assert.equal(getPendingEventQueue().length, 1);

    const accepted = await flushEvents();
    assert.equal(accepted, 0);
    // Event must be retained in queue
    assert.equal(getPendingEventQueue().length, 1);
    assert.equal(queueFirst(getPendingEventQueue()).name, 'offline_event_1');
  });
});

function queueFirst(q: any[]) {
  return q[0]!;
}

function getItemProps(item: any): Record<string, any> {
  assert.ok(item && item.properties);
  return item.properties;
}

describe('PRD §4.4 Interaction Budgets Instrumenter (SL-81, PRD §4.4)', () => {
  beforeEach(() => {
    clearEventQueue();
  });

  it('instruments Reading tab progress duration budget (p75 < 5s)', () => {
    budgetTracker.startReadingTab();
    budgetTracker.recordProgressSaved({ method: 'slider', deltaPages: 15 });

    const queue = getPendingEventQueue();
    assert.equal(queue.length, 1);
    const item = queue[0]!;
    const props = getItemProps(item);
    assert.equal(item.name, 'progress_updated');
    assert.equal(props.method, 'slider');
    assert.equal(props.delta_pages, 15);
    assert.ok(typeof props.duration_ms === 'number');
    assert.ok(props.duration_ms >= 0);
  });

  it('instruments Book Shelved tap count budget (p75 <= 2 taps)', () => {
    budgetTracker.recordBookLogged({
      tapCount: 2,
      source: 'work_detail',
      targetStatus: 'want',
    });

    const queue = getPendingEventQueue();
    assert.equal(queue.length, 1);
    const item = queue[0]!;
    const props = getItemProps(item);
    assert.equal(item.name, 'book_logged');
    assert.equal(props.tap_count, 2);
    assert.equal(props.source, 'work_detail');
    assert.equal(props.target_status, 'want');
  });

  it('instruments Finish flow completion duration budget (p75 < 20s)', () => {
    const testReadId = 'read_123';
    budgetTracker.startFinishFlow(testReadId);
    budgetTracker.recordFinishCompleted(testReadId, {
      hadRating: true,
      hadReview: true,
      hearted: true,
      format: 'print',
      pageCount: 320,
    });

    const queue = getPendingEventQueue();
    assert.equal(queue.length, 1);
    const item = queue[0]!;
    const props = getItemProps(item);
    assert.equal(item.name, 'finish_completed');
    assert.equal(props.had_rating, true);
    assert.equal(props.had_review, true);
    assert.equal(props.hearted, true);
    assert.equal(props.format, 'print');
    assert.equal(props.page_count, 320);
    assert.ok(typeof props.duration_ms === 'number');
    assert.ok(typeof props.duration_seconds === 'number');
  });

  it('instruments Finish flow abandonment when dismissed before save (<8% budget)', () => {
    const testReadId = 'read_abandoned_456';
    budgetTracker.startFinishFlow(testReadId);
    budgetTracker.recordFinishAbandoned(testReadId, { stage: 'review' });

    const queue = getPendingEventQueue();
    assert.equal(queue.length, 1);
    const item = queue[0]!;
    const props = getItemProps(item);
    assert.equal(item.name, 'finish_flow_abandoned');
    assert.equal(props.stage, 'review');
    assert.ok(typeof props.time_spent_ms === 'number');
    assert.ok(props.time_spent_ms >= 0);
  });

  it('instruments Log Sheet completion duration budget (p75 < 15s)', () => {
    const testReadId = 'read_sheet_789';
    budgetTracker.startLogSheet();
    budgetTracker.recordLogSheetCompleted(testReadId, {
      deltaPages: 25,
      hadNote: true,
      hadMinutes: false,
    });

    const queue = getPendingEventQueue();
    assert.equal(queue.length, 1);
    const item = queue[0]!;
    const props = getItemProps(item);
    assert.equal(item.name, 'log_sheet_completed');
    assert.equal(props.delta_pages, 25);
    assert.equal(props.had_note, true);
    assert.equal(props.had_minutes, false);
    assert.ok(typeof props.duration_ms === 'number');
  });
});

// Audit 10: a budget event is a measurement or nothing. The tracker used to
// make one up when its clock was never started (1200 ms, 4 s, 3500 ms, all
// inside budget), and re-anchored the progress clock at every save, so the
// §4.4 report could only ever be green (P1 false green).
describe('§4.4 budgets measure, never invent (audit 10)', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  beforeEach(() => {
    clearEventQueue();
    setTelemetryTransport(null);
    Date.now = () => now;
  });
  const names = () => getPendingEventQueue().map((e) => e.name);
  const last = () => {
    const q = getPendingEventQueue();
    return (q[q.length - 1] as unknown as { properties: Record<string, unknown> }).properties;
  };

  it('no clock, no sample: progress, finish and log sheet without a start emit nothing', () => {
    budgetTracker.recordProgressSaved({ method: 'slider' }); // after any earlier sample consumed the focus
    budgetTracker.recordProgressSaved({ method: 'slider' });
    budgetTracker.recordFinishCompleted('never-started');
    budgetTracker.recordLogSheetCompleted({ targetStatus: 'want' });
    assert.deepEqual(names().filter((n) => n !== 'progress_updated'), []);
    assert.ok(names().filter((n) => n === 'progress_updated').length <= 1);
  });

  it('progress is measured from Reading tab focus, once per focus', () => {
    budgetTracker.startReadingTab();
    now += 3_200;
    budgetTracker.recordProgressSaved({ method: 'slider' });
    now += 60_000;
    budgetTracker.recordProgressSaved({ method: 'slider' }); // a second save in the same visit: not a from-focus sample
    assert.deepEqual(names(), ['progress_updated']);
    assert.equal(last().duration_ms, 3_200);
    budgetTracker.startReadingTab();
    now += 900;
    budgetTracker.recordProgressSaved({ method: 'quick_add' });
    assert.equal(last().duration_ms, 900);
  });

  it('finish and log sheet durations run from their own start', () => {
    budgetTracker.startFinishFlow('r1');
    now += 14_000;
    budgetTracker.recordFinishCompleted('r1');
    assert.equal(last().duration_seconds, 14);
    budgetTracker.startLogSheet();
    now += 9_500;
    budgetTracker.recordLogSheetCompleted({ targetStatus: 'reading' });
    assert.equal(last().duration_ms, 9_500);
    budgetTracker.recordLogSheetCompleted({ targetStatus: 'reading' }); // clock consumed
    assert.equal(names().filter((n) => n === 'log_sheet_completed').length, 1);
  });

  it('restores the clock', () => {
    Date.now = realNow;
    assert.ok(Date.now() > 1_000_000_000);
  });
});
