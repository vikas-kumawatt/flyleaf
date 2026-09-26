// SL-04 refresh interceptor (audit 07). The server revokes the whole token
// family when a refresh token is used twice (A-04-005), so these are the
// properties that stop random logouts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAuthFetch, type AuthFetchDeps } from '../authFetch';

const REFRESH_URL = 'http://api/v1/auth/refresh';

function harness(refreshResponse: () => Promise<Response>) {
  const store = { access: 'old-access', refresh: 'rt-1' };
  const calls = { refresh: 0, ended: 0, cleared: 0, retriedWith: [] as string[] };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === REFRESH_URL) {
      calls.refresh++;
      return refreshResponse();
    }
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth === `Bearer ${store.access}` && store.access !== 'old-access') {
      calls.retriedWith.push(store.access);
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 401 });
  }) as typeof fetch;

  const deps: AuthFetchDeps = {
    fetch: fetchImpl,
    refreshUrl: REFRESH_URL,
    loadAccessToken: async () => store.access,
    loadRefreshToken: async () => store.refresh,
    saveTokens: async (a, r) => {
      store.access = a;
      store.refresh = r;
    },
    clearTokens: async () => {
      calls.cleared++;
    },
    onSessionEnded: () => {
      calls.ended++;
    },
  };
  return { authFetch: createAuthFetch(deps), store, calls };
}

const authed = { headers: { Authorization: 'Bearer old-access' } };
const rotated = () =>
  new Promise<Response>((resolve) =>
    setTimeout(() => resolve(new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'rt-2' }), { status: 200 })), 20),
  );

describe('refresh interceptor (SL-04)', () => {
  test('N parallel 401s make exactly one refresh call, and every request is retried with the new token', async () => {
    const { authFetch, calls } = harness(rotated);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => authFetch(`http://api/v1/r/${i}`, authed)));
    assert.equal(calls.refresh, 1);
    assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
    assert.equal(calls.ended, 0);
  });

  test('a 401 that arrives after the refresh finished retries with the current token, without a second refresh', async () => {
    const { authFetch, calls } = harness(rotated);
    await authFetch('http://api/v1/a', authed);
    const late = await authFetch('http://api/v1/b', authed); // sent with the old token
    assert.equal(late.status, 200);
    assert.equal(calls.refresh, 1);
  });

  test('a 5xx, 429 or network error on refresh keeps the session', async () => {
    for (const failing of [
      async () => new Response('{}', { status: 503 }),
      async () => new Response('{}', { status: 429 }),
      async () => {
        throw new TypeError('Network request failed');
      },
    ]) {
      const { authFetch, calls } = harness(failing);
      const res = await authFetch('http://api/v1/a', authed);
      assert.equal(res.status, 401);
      assert.equal(calls.cleared, 0);
      assert.equal(calls.ended, 0);
    }
  });

  test('a refused refresh token ends the session once, for all waiting requests', async () => {
    const { authFetch, calls } = harness(async () => new Response('{}', { status: 401 }));
    const results = await Promise.all([authFetch('http://api/v1/a', authed), authFetch('http://api/v1/b', authed)]);
    assert.deepEqual(results.map((r) => r.status), [401, 401]);
    assert.equal(calls.refresh, 1);
    assert.equal(calls.ended, 1);
    assert.equal(calls.cleared, 1);
  });

  test('a guest request (no bearer) is not refreshed; auth endpoints are never intercepted', async () => {
    const { authFetch, calls } = harness(rotated);
    assert.equal((await authFetch('http://api/v1/me')).status, 401);
    assert.equal((await authFetch('http://api/v1/auth/login', authed)).status, 401);
    assert.equal(calls.refresh, 0);
    assert.equal(calls.ended, 0);
  });
});
