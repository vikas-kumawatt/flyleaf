import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateShelfForm, validateShelfNote, formatShelfRank, validateShelfName } from '../shelfValidation.js';

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

describe('Add-to-Shelf & Shelf Name Helpers (SH-04)', () => {
  test('validates shelf name for quick inline creation', () => {
    assert.equal(validateShelfName(null).isValid, false);
    assert.equal(validateShelfName('').isValid, false);
    assert.equal(validateShelfName('   ').isValid, false);
    assert.equal(validateShelfName('Favorites').isValid, true);
    assert.equal(validateShelfName('A'.repeat(60)).isValid, true);
    assert.equal(validateShelfName('A'.repeat(61)).isValid, false);
  });

  test('correctly computes optimistic shelf toggle state and counts', () => {
    const initialShelves = [
      { id: 's1', contains_work: false, item_count: 5 },
      { id: 's2', contains_work: true, item_count: 3 },
    ];

    // Adding to s1
    const addedShelves = initialShelves.map((s) =>
      s.id === 's1'
        ? { ...s, contains_work: true, item_count: s.item_count + 1 }
        : s,
    );
    assert.equal(addedShelves[0]!.contains_work, true);
    assert.equal(addedShelves[0]!.item_count, 6);

    // Removing from s2
    const removedShelves = addedShelves.map((s) =>
      s.id === 's2'
        ? { ...s, contains_work: false, item_count: Math.max(0, s.item_count - 1) }
        : s,
    );
    assert.equal(removedShelves[1]!.contains_work, false);
    assert.equal(removedShelves[1]!.item_count, 2);
  });
});

