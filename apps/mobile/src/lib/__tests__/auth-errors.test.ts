// Beta bug (Oct 2026): every sign-in failure said "Email or password is
// incorrect". Only the server's 401 invalid_credentials may say that.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { INCORRECT_CREDENTIALS, UNREACHABLE, loginErrorMessage, transientAuthError, tryAgainIn } from '../authErrors';

const apiError = (status: number, code: string, retryAfterSeconds?: number) =>
  Object.assign(new Error(code), { status, code, retryAfterSeconds });

describe('sign-in error messages', () => {
  test('401 invalid_credentials, and only that, says incorrect', () => {
    assert.equal(loginErrorMessage(apiError(401, 'invalid_credentials')), INCORRECT_CREDENTIALS);
    for (const err of [
      apiError(401, 'unauthorized'),
      apiError(429, 'rate_limited', 120),
      apiError(500, 'internal_error'),
      apiError(503, 'unknown_error'),
      apiError(422, 'invalid_field'),
      new TypeError('Network request failed'),
      new Error('SecureStore: could not save'),
      undefined,
    ]) {
      assert.notEqual(loginErrorMessage(err), INCORRECT_CREDENTIALS, String((err as Error | undefined)?.message));
    }
  });

  test('429 says when to try again, from Retry-After, rounded up to whole minutes', () => {
    assert.equal(loginErrorMessage(apiError(429, 'rate_limited', 30)), 'Too many attempts. Try again in 1 minute.');
    assert.equal(loginErrorMessage(apiError(429, 'rate_limited', 61)), 'Too many attempts. Try again in 2 minutes.');
    assert.equal(loginErrorMessage(apiError(429, 'rate_limited', 3600)), 'Too many attempts. Try again in 60 minutes.');
    assert.equal(loginErrorMessage(apiError(429, 'rate_limited')), 'Too many attempts. Try again in a few minutes.');
    assert.equal(tryAgainIn(Number.NaN), 'Try again in a few minutes.');
  });

  test('no connection and 5xx say the server could not be reached', () => {
    assert.equal(loginErrorMessage(new TypeError('Network request failed')), UNREACHABLE);
    assert.equal(loginErrorMessage(apiError(502, 'unknown_error')), UNREACHABLE);
    assert.equal(loginErrorMessage(apiError(500, 'internal_error')), UNREACHABLE);
  });

  test('transientAuthError leaves request errors to the caller', () => {
    assert.equal(transientAuthError(apiError(400, 'invalid_or_expired_token')), null);
    assert.equal(transientAuthError(apiError(422, 'invalid_field')), null);
    assert.equal(transientAuthError(apiError(401, 'invalid_credentials')), null);
    assert.equal(transientAuthError(new Error('plain')), null);
  });

  test('no message names the account: the same for any email (enumeration-safe)', () => {
    const all = [
      loginErrorMessage(apiError(401, 'invalid_credentials')),
      loginErrorMessage(apiError(429, 'rate_limited', 60)),
      loginErrorMessage(new TypeError('x')),
    ];
    for (const m of all) assert.doesNotMatch(m, /account|registered|exist|no user/i);
  });
});
