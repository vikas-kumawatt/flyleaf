import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateShelfForm,
  validateShelfNote,
  formatShelfRank,
  validateShelfName,
  moveItemInArray,
  repositionItem,
  STARTER_SHELVES,
  sortShelves,
  getShelfShareUrl,
  getShelfShareMessage,
} from '../shelfValidation.js';

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

describe('Shelf Reordering Helpers (SH-05, PRD §6.36, §46.2)', () => {
  test('moveItemInArray moves an item forward', () => {
    const list = ['A', 'B', 'C', 'D'];
    const result = moveItemInArray(list, 0, 2);
    assert.deepEqual(result, ['B', 'C', 'A', 'D']);
  });

  test('moveItemInArray moves an item backward', () => {
    const list = ['A', 'B', 'C', 'D'];
    const result = moveItemInArray(list, 3, 1);
    assert.deepEqual(result, ['A', 'D', 'B', 'C']);
  });

  test('moveItemInArray handles no-op when fromIndex equals toIndex', () => {
    const list = ['A', 'B', 'C'];
    const result = moveItemInArray(list, 1, 1);
    assert.deepEqual(result, ['A', 'B', 'C']);
  });

  test('moveItemInArray gracefully returns shallow copy on out-of-bounds', () => {
    const list = ['A', 'B', 'C'];
    assert.deepEqual(moveItemInArray(list, -1, 1), ['A', 'B', 'C']);
    assert.deepEqual(moveItemInArray(list, 0, 10), ['A', 'B', 'C']);
    assert.deepEqual(moveItemInArray(list, 5, 0), ['A', 'B', 'C']);
  });

  test('repositionItem moves item to 1-indexed target position', () => {
    const list = ['First', 'Second', 'Third', 'Fourth'];
    // Move 'First' (idx 0) to position #3
    const res1 = repositionItem(list, 0, 3);
    assert.deepEqual(res1, ['Second', 'Third', 'First', 'Fourth']);

    // Move 'Fourth' (idx 3) to position #1
    const res2 = repositionItem(list, 3, 1);
    assert.deepEqual(res2, ['Fourth', 'First', 'Second', 'Third']);
  });

  test('repositionItem clamps target position within [1, list.length]', () => {
    const list = ['A', 'B', 'C'];
    // Target position 0 or negative clamps to 1
    assert.deepEqual(repositionItem(list, 2, 0), ['C', 'A', 'B']);
    assert.deepEqual(repositionItem(list, 2, -5), ['C', 'A', 'B']);

    // Target position beyond length clamps to last position
    assert.deepEqual(repositionItem(list, 0, 99), ['B', 'C', 'A']);
  });

  test('repositionItem handles edge cases like empty array or invalid index', () => {
    assert.deepEqual(repositionItem([], 0, 1), []);
    assert.deepEqual(repositionItem(['A', 'B'], -1, 1), ['A', 'B']);
    assert.deepEqual(repositionItem(['A', 'B'], 5, 1), ['A', 'B']);
  });
});

describe('Starter Shelves & Grid Sorting (SH-06, PRD §6.33)', () => {
  test('STARTER_SHELVES provides the 3 required starter lists with valid parameters', () => {
    assert.equal(STARTER_SHELVES.length, 3);
    const [favs, comfort, recs] = STARTER_SHELVES;

    assert.equal(favs!.name, 'Favourites of 2026');
    assert.equal(favs!.is_ranked, true);
    assert.equal(favs!.privacy, 'public');
    assert.ok(favs!.description.length > 0);

    assert.equal(comfort!.name, 'Comfort reads');
    assert.equal(comfort!.is_ranked, false);
    assert.equal(comfort!.privacy, 'public');
    assert.ok(comfort!.description.length > 0);

    assert.equal(recs!.name, 'Recommended to me');
    assert.equal(recs!.is_ranked, false);
    assert.equal(recs!.privacy, 'public');
    assert.ok(recs!.description.length > 0);
  });

  test('sortShelves sorts shelves by updated (newest created_at first)', () => {
    const list = [
      { name: 'Shelf B', created_at: '2026-01-01T00:00:00Z', item_count: 5 },
      { name: 'Shelf C', created_at: '2026-03-01T00:00:00Z', item_count: 2 },
      { name: 'Shelf A', created_at: '2026-02-01T00:00:00Z', item_count: 10 },
    ];
    const sorted = sortShelves(list, 'updated');
    assert.deepEqual(
      sorted.map((s) => s.name),
      ['Shelf C', 'Shelf A', 'Shelf B'],
    );
  });

  test('sortShelves sorts shelves alphabetically by name (A to Z)', () => {
    const list = [
      { name: 'Sci-Fi Gems', created_at: '2026-01-01T00:00:00Z', item_count: 5 },
      { name: 'All-Time Best', created_at: '2026-03-01T00:00:00Z', item_count: 2 },
      { name: 'Mystery Thrillers', created_at: '2026-02-01T00:00:00Z', item_count: 10 },
    ];
    const sorted = sortShelves(list, 'alpha');
    assert.deepEqual(
      sorted.map((s) => s.name),
      ['All-Time Best', 'Mystery Thrillers', 'Sci-Fi Gems'],
    );
  });

  test('sortShelves sorts shelves by book count (most books first)', () => {
    const list = [
      { name: 'Shelf A', created_at: '2026-01-01T00:00:00Z', item_count: 3 },
      { name: 'Shelf B', created_at: '2026-03-01T00:00:00Z', item_count: 42 },
      { name: 'Shelf C', created_at: '2026-02-01T00:00:00Z', item_count: 15 },
    ];
    const sorted = sortShelves(list, 'books');
    assert.deepEqual(
      sorted.map((s) => s.name),
      ['Shelf B', 'Shelf C', 'Shelf A'],
    );
  });
});

describe('Shelf Sharing Helpers (SH-10, PRD §6.34, §15.2, §29.1)', () => {
  test('getShelfShareUrl produces canonical vanity URL when owner username and slug are available', () => {
    const url = getShelfShareUrl({
      id: 'shelf-123',
      slug: 'cyberpunk-classics',
      owner: { username: 'alice' },
    });
    assert.equal(url, 'https://flyleaf.app/u/alice/shelves/cyberpunk-classics');
  });

  test('getShelfShareUrl properly URL-encodes usernames and slugs with special characters', () => {
    const url = getShelfShareUrl({
      id: 'shelf-456',
      slug: 'best-of-2026!',
      owner: { username: 'user name' },
    });
    assert.equal(url, 'https://flyleaf.app/u/user%20name/shelves/best-of-2026!');
  });

  test('getShelfShareUrl falls back to direct ID URL when username or slug is missing', () => {
    const fallbackNoUser = getShelfShareUrl({
      id: 'shelf-999',
      slug: 'sci-fi',
    });
    assert.equal(fallbackNoUser, 'https://flyleaf.app/shelf/shelf-999');

    const fallbackNoSlug = getShelfShareUrl({
      id: 'shelf-888',
      owner: { username: 'bob' },
    });
    assert.equal(fallbackNoSlug, 'https://flyleaf.app/shelf/shelf-888');
  });

  test('getShelfShareMessage generates friendly message with display name and book count', () => {
    const msg = getShelfShareMessage({
      name: 'Favorite Sci-Fi',
      owner: { displayName: 'Alice Wonder', username: 'alice' },
      item_count: 5,
    });
    assert.equal(
      msg,
      'Check out "Favorite Sci-Fi" (5 books) on Flyleaf — curated by Alice Wonder.',
    );
  });

  test('getShelfShareMessage handles singular book count and fallback handle curator', () => {
    const msg = getShelfShareMessage({
      name: 'Single Read',
      owner: { username: 'soloreader' },
      item_count: 1,
    });
    assert.equal(
      msg,
      'Check out "Single Read" (1 book) on Flyleaf — curated by @soloreader.',
    );
  });

  test('getShelfShareMessage handles missing owner and count gracefully', () => {
    const msg = getShelfShareMessage({
      name: 'Anonymous List',
    });
    assert.equal(
      msg,
      'Check out "Anonymous List" on Flyleaf — curated by a reader.',
    );
  });
});




