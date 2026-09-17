import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUsername,
  validatePassword,
  validateDob,
  RESERVED_USERNAMES,
} from '../auth-validation.js';

describe('Auth Validation Suite (SL-21, SL-22)', () => {
  describe('Username Validation', () => {
    test('accepts valid usernames', () => {
      const valid = ['reader_99', 'bookworm', 'alice_bob', 'charlie123', 'a_b_c'];
      for (const u of valid) {
        const res = validateUsername(u);
        assert.equal(res.valid, true, `Expected "${u}" to be valid`);
      }
    });

    test('rejects empty or short usernames (< 3 chars)', () => {
      assert.equal(validateUsername('').valid, false);
      assert.equal(validateUsername('a').valid, false);
      assert.equal(validateUsername('ab').valid, false);
    });

    test('rejects long usernames (> 20 chars)', () => {
      assert.equal(validateUsername('a'.repeat(21)).valid, false);
    });

    test('rejects invalid characters (spaces, hyphens, uppercase, symbols)', () => {
      assert.equal(validateUsername('user-name').valid, false);
      assert.equal(validateUsername('user name').valid, false);
      assert.equal(validateUsername('user@name').valid, false);
      assert.equal(validateUsername('user!').valid, false);
    });

    test('rejects reserved usernames', () => {
      const reserved = ['admin', 'Flyleaf', 'support', 'help', 'guest', 'mod'];
      for (const u of reserved) {
        const res = validateUsername(u);
        assert.equal(res.valid, false, `Expected "${u}" to be reserved`);
        assert.match(res.error || '', /reserved/i);
      }
    });
  });

  describe('Password Validation & Scoring', () => {
    test('rejects empty or short passwords (< 10 chars)', () => {
      assert.equal(validatePassword('').valid, false);
      assert.equal(validatePassword('short').valid, false);
      assert.equal(validatePassword('123456789').valid, false);
    });

    test('scores password strength accurately', () => {
      // 10 chars, all lowercase => score 1
      const p1 = validatePassword('abcdefghij');
      assert.equal(p1.valid, true);
      assert.equal(p1.score, 1);

      // 12 chars, letters + numbers => score 3
      const p2 = validatePassword('reader123456');
      assert.equal(p2.valid, true);
      assert.equal(p2.score, 3);

      // 16+ chars, letters + numbers + special => score 4
      const p3 = validatePassword('ExtraStrongP@ssw0rd!2026');
      assert.equal(p3.valid, true);
      assert.equal(p3.score, 4);
    });
  });

  describe('Date of Birth & Age Verification', () => {
    test('rejects invalid format', () => {
      assert.equal(validateDob('01/01/2000').valid, false);
      assert.equal(validateDob('2000-1-1').valid, false);
      assert.equal(validateDob('invalid').valid, false);
    });

    test('rejects under 13 age requirement (PRD §6.3)', () => {
      const today = new Date();
      const tenYearsAgo = `${today.getFullYear() - 10}-01-01`;
      const res = validateDob(tenYearsAgo);
      assert.equal(res.valid, false);
      assert.match(res.error || '', /13 years old/i);
    });

    test('accepts 13 and older', () => {
      const today = new Date();
      const fourteenYearsAgo = `${today.getFullYear() - 14}-01-01`;
      assert.equal(validateDob(fourteenYearsAgo).valid, true);
      assert.equal(validateDob('1990-05-15').valid, true);
    });
  });
});
