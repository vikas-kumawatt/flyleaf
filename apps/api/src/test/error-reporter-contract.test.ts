// PV-06: one contract, every error-reporting adapter. Sentry runs against a
// fake of its store endpoint, injected as its fetch. No network.

import { describe, expect, it } from 'vitest';
import {
  MemoryErrorReporter,
  NoopErrorReporter,
  SentryErrorReporter,
  parseSentryDsn,
  type ErrorContext,
  type ErrorReporter,
} from '../providers/errors/index.js';

const DSN = 'https://publickey123@o1.ingest.sentry.io/4242';

function fakeSentry(status = 200) {
  const requests: { url: string; auth: string | null; body: any }[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    requests.push({
      url: String(url),
      auth: new Headers(init!.headers).get('x-sentry-auth'),
      body: JSON.parse(String(init!.body)),
    });
    return new Response('{}', { status });
  };
  return { fetchFn, requests };
}

const ADAPTERS: { name: string; make: () => { reporter: ErrorReporter; sent: () => number } }[] = [
  { name: 'noop', make: () => ({ reporter: new NoopErrorReporter(), sent: () => 0 }) },
  {
    name: 'memory',
    make: () => {
      const r = new MemoryErrorReporter();
      return { reporter: r, sent: () => r.captured.length };
    },
  },
  {
    name: 'sentry (fake store endpoint)',
    make: () => {
      const fake = fakeSentry();
      return { reporter: new SentryErrorReporter({ dsn: DSN }, fake.fetchFn), sent: () => fake.requests.length };
    },
  },
];

const CONTEXT: ErrorContext = { requestId: 'req-1', userId: 'user-1', route: '/v1/things', method: 'POST' };

for (const adapter of ADAPTERS) {
  describe(`ErrorReporter contract: ${adapter.name}`, () => {
    it('capture resolves with an event id or null, and never throws', async () => {
      const { reporter } = adapter.make();
      const id = await reporter.capture(new Error('boom'), CONTEXT);
      expect(id === null || (typeof id === 'string' && id.length > 0)).toBe(true);
    });

    it('accepts an error with no stack and an empty context', async () => {
      const { reporter } = adapter.make();
      const err = new Error('stackless');
      err.stack = undefined;
      const id = await reporter.capture(err, {});
      expect(id === null || typeof id === 'string').toBe(true);
    });
  });
}

describe('sentry specifics', () => {
  it('posts one event to the DSN project with the key, error, user and request id', async () => {
    const fake = fakeSentry();
    const reporter = new SentryErrorReporter({ dsn: DSN, environment: 'production', release: '1.2.3' }, fake.fetchFn);
    const id = await reporter.capture(new TypeError('bad thing'), CONTEXT);

    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req!.url).toBe('https://o1.ingest.sentry.io/api/4242/store/');
    expect(req!.auth).toContain('sentry_key=publickey123');
    expect(req!.body.event_id).toBe(id);
    expect(req!.body.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'bad thing' });
    expect(req!.body.user).toEqual({ id: 'user-1' });
    expect(req!.body.extra.requestId).toBe('req-1');
    expect(req!.body).toMatchObject({ environment: 'production', release: '1.2.3' });
  });

  it('sends only what it is given: headers and body never leave (they are scrubbed upstream, and not sent at all)', async () => {
    const fake = fakeSentry();
    await new SentryErrorReporter({ dsn: DSN }, fake.fetchFn).capture(new Error('x'), {
      headers: { authorization: 'Bearer should-not-appear' },
      body: { password: 'should-not-appear' },
    });
    expect(JSON.stringify(fake.requests[0]!.body)).not.toContain('should-not-appear');
  });

  it('an unreachable or failing Sentry returns null instead of throwing', async () => {
    const down = new SentryErrorReporter({ dsn: DSN }, fakeSentry(503).fetchFn);
    expect(await down.capture(new Error('x'), {})).toBeNull();
    const unreachable = new SentryErrorReporter({ dsn: DSN }, async () => {
      throw new TypeError('fetch failed');
    });
    expect(await unreachable.capture(new Error('x'), {})).toBeNull();
  });

  it('refuses an invalid DSN at construction, not at the first error', () => {
    expect(parseSentryDsn('not a url')).toBeNull();
    expect(parseSentryDsn('https://o1.ingest.sentry.io/4242')).toBeNull(); // no key
    expect(() => new SentryErrorReporter({ dsn: 'nope' })).toThrow(/valid Sentry DSN/);
  });
});
