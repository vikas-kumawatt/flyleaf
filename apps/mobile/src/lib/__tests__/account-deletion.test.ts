// LA-01: the delete-account flow's words and errors (accountDeletion.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deletedMessage, deleteErrorMessage, formatPurgeDate, GRACE_DAYS, GRACE_PROMISE, WHAT_IS_LOST } from '../accountDeletion';

describe('account deletion copy', () => {
  test('the grace period matches the server (30 days) and is stated before and after', () => {
    assert.equal(GRACE_DAYS, 30);
    assert.match(GRACE_PROMISE, /30 days/);
    assert.match(deletedMessage('2026-11-22T21:00:00.000Z'), /Sign in before 22 November 2026/);
  });

  test('what is lost names reads, reviews, shelves and the profile', () => {
    const all = WHAT_IS_LOST.join(' ');
    for (const word of ['read', 'reviews', 'shelves', 'profile']) assert.match(all, new RegExp(word));
  });

  test('the purge date is the UTC day the server gave, and survives a bad value', () => {
    assert.equal(formatPurgeDate('2026-01-01T00:30:00.000Z'), '1 January 2026');
    assert.equal(formatPurgeDate('nonsense'), 'in 30 days');
  });
});

describe('deleteErrorMessage', () => {
  test('a wrong password says so; nothing else does', () => {
    assert.equal(deleteErrorMessage({ status: 422, code: 'wrong_password' }), 'That password is not right.');
    assert.equal(deleteErrorMessage({ status: 422, code: 'invalid_field' }), 'Enter your password.');
  });

  test('a 429 gives the wait, a dropped connection and a 5xx say nothing was deleted', () => {
    assert.equal(deleteErrorMessage({ status: 429, retryAfterSeconds: 90 }), 'Too many attempts. Try again in 2 minutes.');
    assert.match(deleteErrorMessage(new TypeError('Network request failed')), /Nothing was deleted/);
    assert.match(deleteErrorMessage({ status: 503 }), /Nothing was deleted/);
  });

  test('an ended session asks to sign in again', () => {
    assert.match(deleteErrorMessage({ status: 401, code: 'unauthorized' }), /Sign in again/);
  });
});
