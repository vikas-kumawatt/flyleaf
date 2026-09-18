import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateShelfForm, validateShelfNote, formatShelfRank } from '../shelfValidation.js';

describe('Shelf Form Validation (SH-02)', () => {
  test('accepts valid shelf details', () => {
    const res = validateShelfForm({
      name: 'Best Sci-Fi 2026',
      description: 'A curated list of mind-bending science fiction.',
      privacy: 'public',
      is_ranked: true,
    });
    assert.equal(res.isValid, true);
    assert.deepEqual(res.errors, {});
  });

  test('accepts minimal shelf without description', () => {
    const res = validateShelfForm({
      name: 'To Read Someday',
    });
    assert.equal(res.isValid, true);
    assert.deepEqual(res.errors, {});
  });

  test('rejects empty name or whitespace-only name', () => {
    const resEmpty = validateShelfForm({ name: '' });
    assert.equal(resEmpty.isValid, false);
    assert.equal(resEmpty.errors.name, 'Shelf name is required.');

    const resWhitespace = validateShelfForm({ name: '   \n  \t  ' });
    assert.equal(resWhitespace.isValid, false);
    assert.equal(resWhitespace.errors.name, 'Shelf name is required.');
  });

  test('rejects shelf name exceeding 60 characters', () => {
    const res = validateShelfForm({
      name: 'A'.repeat(61),
    });
    assert.equal(res.isValid, false);
    assert.equal(res.errors.name, 'Shelf name cannot exceed 60 characters.');
  });

  test('accepts exactly 60 characters shelf name', () => {
    const res = validateShelfForm({
      name: 'A'.repeat(60),
    });
    assert.equal(res.isValid, true);
  });

  test('rejects description exceeding 2000 characters', () => {
    const res = validateShelfForm({
      name: 'My Shelf',
      description: 'D'.repeat(2001),
    });
    assert.equal(res.isValid, false);
    assert.equal(res.errors.description, 'Description cannot exceed 2000 characters.');
  });

  test('accepts exactly 2000 characters description', () => {
    const res = validateShelfForm({
      name: 'My Shelf',
      description: 'D'.repeat(2000),
    });
    assert.equal(res.isValid, true);
  });

  test('rejects invalid privacy enum', () => {
    const res = validateShelfForm({
      name: 'Valid Name',
      privacy: 'unlisted' as any,
    });
    assert.equal(res.isValid, false);
    assert.equal(res.errors.privacy, 'Invalid privacy setting.');
  });

  test('accepts valid privacy values: public, followers, private', () => {
    for (const privacy of ['public', 'followers', 'private'] as const) {
      const res = validateShelfForm({
        name: 'Valid Name',
        privacy,
      });
      assert.equal(res.isValid, true);
    }
  });
});

describe('Shelf Items & Note Validation (SH-03, PRD §15.2)', () => {
  test('validates note within 280 characters limit', () => {
    assert.equal(validateShelfNote(null).isValid, true);
    assert.equal(validateShelfNote('').isValid, true);
    assert.equal(validateShelfNote('A brief note on why this book matters.').isValid, true);
    assert.equal(validateShelfNote('N'.repeat(280)).isValid, true);
  });

  test('rejects notes exceeding 280 characters', () => {
    const res = validateShelfNote('N'.repeat(281));
    assert.equal(res.isValid, false);
    assert.equal(res.error, 'Note cannot exceed 280 characters.');
  });

  test('formats ranked shelf numbers properly', () => {
    assert.equal(formatShelfRank(true, 1), '#1');
    assert.equal(formatShelfRank(true, 10), '#10');
    assert.equal(formatShelfRank(true, null, 2), '#3');
    assert.equal(formatShelfRank(false, 1), null);
  });
});

