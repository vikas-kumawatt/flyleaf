// PV-05: one contract, every push adapter.
//
// The Expo adapter runs against a fake of Expo's push API (the documented
// request and ticket shapes, the 100-per-request limit, DeviceNotRegistered,
// and getReceipts, which SO-30 reads), injected as its fetch. No network.

import { describe, expect, it } from 'vitest';
import {
  ExpoPushSender,
  MemoryPushSender,
  type PushMessage,
  type PushSender,
} from '../providers/push/index.js';

interface Harness {
  sender: PushSender;
  /** Make a token behave like an uninstalled app. */
  unregister(token: string): void;
  /** Requests that reached the provider (batches). */
  requests(): number;
  /** The receipt the provider will report for a ticket. */
  failReceipt(ticket: string, error: 'DeviceNotRegistered'): void;
}

function fakeExpo(opts: { status?: number } = {}) {
  const unregistered = new Set<string>();
  const seen: { auth: string | null; body: PushMessage[] }[] = [];
  const receiptRequests: string[][] = [];
  const failed = new Map<string, string>();
  const issued = new Set<string>();
  let n = 0;
  const fetchFn: typeof fetch = async (url, init) => {
    if (String(url) === ExpoPushSender.RECEIPTS_ENDPOINT) {
      const { ids } = JSON.parse(String(init!.body)) as { ids: string[] };
      receiptRequests.push(ids);
      if (opts.status) return new Response('{}', { status: opts.status });
      if (ids.length > 1000) return new Response('{}', { status: 400 });
      // Documented shape: only ids with a receipt appear in `data`.
      const data = Object.fromEntries(
        ids.filter((id) => issued.has(id)).map((id) => [
          id,
          failed.has(id)
            ? { status: 'error', message: 'not registered', details: { error: failed.get(id) } }
            : { status: 'ok' },
        ]),
      );
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(String(init!.body)) as PushMessage[];
    seen.push({ auth: new Headers(init!.headers).get('authorization'), body });
    if (opts.status) return new Response('{}', { status: opts.status });
    if (body.length > 100) return new Response(JSON.stringify({ errors: [{ code: 'PUSH_TOO_MANY_NOTIFICATIONS' }] }), { status: 400 });
    const data = body.map((m) =>
      unregistered.has(m.to)
        ? { status: 'error', message: `${m.to} is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } }
        : (() => {
            const id = `ticket-${++n}`;
            issued.add(id);
            return { status: 'ok', id };
          })(),
    );
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, unregistered, seen, receiptRequests, failed };
}

const ADAPTERS: { name: string; make: () => Harness }[] = [
  {
    name: 'memory',
    make: () => {
      const sender = new MemoryPushSender();
      let calls = 0;
      return {
        sender: { send: (m) => (calls++, sender.send(m)), receipts: (ids) => sender.receipts(ids) },
        unregister: (t) => sender.unregister(t),
        requests: () => calls,
        failReceipt: (ticket) => sender.setReceipt(ticket, { status: 'error', error: 'device_not_registered' }),
      };
    },
  },
  {
    name: 'expo (fake Expo API)',
    make: () => {
      const fake = fakeExpo();
      return {
        sender: new ExpoPushSender(undefined, fake.fetchFn),
        unregister: (t) => fake.unregistered.add(t),
        requests: () => fake.seen.length,
        failReceipt: (ticket, error) => void fake.failed.set(ticket, error),
      };
    },
  },
];

const token = (i: number) => `ExponentPushToken[device-${i}]`;
const msg = (to: string): PushMessage => ({ to, title: 'New follower', body: 'Ana followed you', data: { userId: 'u1' } });

for (const adapter of ADAPTERS) {
  describe(`PushSender contract: ${adapter.name}`, () => {
    it('one ok result per message, in order', async () => {
      const h = adapter.make();
      const results = await h.sender.send([msg(token(1)), msg(token(2))]);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('a malformed token fails alone, without reaching the provider', async () => {
      const h = adapter.make();
      const results = await h.sender.send([msg('not-a-token'), msg(token(3))]);
      expect(results[0]).toEqual({ ok: false, error: 'invalid_token' });
      expect(results[1]!.ok).toBe(true);
    });

    it('an uninstalled app is reported as device_not_registered, so its token can be deleted', async () => {
      const h = adapter.make();
      h.unregister(token(4));
      const results = await h.sender.send([msg(token(4)), msg(token(5))]);
      expect(results[0]).toMatchObject({ ok: false, error: 'device_not_registered' });
      expect(results[1]!.ok).toBe(true);
    });

    it('sends any number of messages (Expo takes 100 per request)', async () => {
      const h = adapter.make();
      const results = await h.sender.send(Array.from({ length: 250 }, (_, i) => msg(token(100 + i))));
      expect(results).toHaveLength(250);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('an empty send is a no-op', async () => {
      const h = adapter.make();
      expect(await h.sender.send([])).toEqual([]);
    });

    it('receipts: ok, or the failure SO-30 acts on (device_not_registered deletes the token)', async () => {
      const h = adapter.make();
      const [a, b] = await h.sender.send([msg(token(6)), msg(token(7))]);
      const ids = [a, b].map((r) => (r!.ok ? r!.id! : ''));
      h.failReceipt(ids[1]!, 'DeviceNotRegistered');
      const receipts = await h.sender.receipts(ids);
      expect(receipts.get(ids[0]!)).toEqual({ status: 'ok' });
      expect(receipts.get(ids[1]!)).toMatchObject({ status: 'error', error: 'device_not_registered' });
    });
  });
}

describe('expo specifics', () => {
  it('sends categoryId and channelId only when set (the reminder\'s "Turn off" action)', async () => {
    const fake = fakeExpo();
    await new ExpoPushSender(undefined, fake.fetchFn).send([
      { ...msg(token(1)), categoryId: 'reading_reminder', channelId: 'default' },
      msg(token(2)),
    ]);
    expect(fake.seen[0]!.body[0]).toMatchObject({ categoryId: 'reading_reminder', channelId: 'default' });
    expect(fake.seen[0]!.body[1]).not.toHaveProperty('categoryId');
  });

  it('receipts: batches of 1,000; an id without a receipt yet, or an outage, is pending', async () => {
    const fake = fakeExpo();
    const sender = new ExpoPushSender(undefined, fake.fetchFn);
    const [sent] = await sender.send([msg(token(1))]);
    const ids = [(sent as { id: string }).id, ...Array.from({ length: 1500 }, (_, i) => `unknown-${i}`)];
    const receipts = await sender.receipts(ids);
    expect(fake.receiptRequests.map((r) => r.length)).toEqual([1000, 501]);
    expect(receipts.get(ids[0]!)).toEqual({ status: 'ok' });
    expect(receipts.get('unknown-0')).toEqual({ status: 'pending' });
    expect(receipts.size).toBe(1501);

    const down = new ExpoPushSender(undefined, fakeExpo({ status: 503 }).fetchFn);
    expect(await down.receipts(['t1'])).toEqual(new Map([['t1', { status: 'pending' }]]));
  });

  it('batches by 100 and sends the access token when configured', async () => {
    const fake = fakeExpo();
    await new ExpoPushSender('expo-secret', fake.fetchFn).send(Array.from({ length: 250 }, (_, i) => msg(token(i))));
    expect(fake.seen.map((r) => r.body.length)).toEqual([100, 100, 50]);
    expect(fake.seen.every((r) => r.auth === 'Bearer expo-secret')).toBe(true);
  });

  it('a provider outage or 429 marks the batch, never throws', async () => {
    const down = new ExpoPushSender(undefined, fakeExpo({ status: 503 }).fetchFn);
    expect(await down.send([msg(token(1))])).toEqual([{ ok: false, error: 'provider_error' }]);

    const limited = new ExpoPushSender(undefined, fakeExpo({ status: 429 }).fetchFn);
    expect(await limited.send([msg(token(1))])).toEqual([{ ok: false, error: 'rate_limited' }]);

    const unreachable = new ExpoPushSender(undefined, async () => {
      throw new TypeError('fetch failed');
    });
    expect(await unreachable.send([msg(token(1))])).toEqual([{ ok: false, error: 'provider_error' }]);
  });
});
