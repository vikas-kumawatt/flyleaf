import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getFollowButtonText,
  getFollowButtonVariant,
  isProfileViewRestricted,
  formatFollowCount,
  appendFollowPage,
  hasMoreFollows,
} from '../socialValidation.js';

describe('Social Follow UI Helpers (SO-02)', () => {
  test('returns correct follow button text', () => {
    assert.equal(getFollowButtonText('none'), 'Follow');
    assert.equal(getFollowButtonText('pending'), 'Requested');
    assert.equal(getFollowButtonText('accepted'), 'Following');
    assert.equal(getFollowButtonText('self'), '');
  });

  test('returns correct follow button variant', () => {
    assert.equal(getFollowButtonVariant('none'), 'primary');
    assert.equal(getFollowButtonVariant('pending'), 'outline');
    assert.equal(getFollowButtonVariant('accepted'), 'outline');
    assert.equal(getFollowButtonVariant('self'), 'outline');
  });

  test('evaluates profile view restriction accurately', () => {
    // Explicit isRestricted takes precedence
    assert.equal(isProfileViewRestricted({ isPrivate: true, isRestricted: true }), true);
    assert.equal(isProfileViewRestricted({ isPrivate: true, isRestricted: false }), false);

    // Private account & non-follower -> restricted
    assert.equal(
      isProfileViewRestricted({ isPrivate: true, followStatus: 'none' }),
      true,
    );
    assert.equal(
      isProfileViewRestricted({ isPrivate: true, followStatus: 'pending' }),
      true,
    );

    // Private account & accepted follower -> unrestricted
    assert.equal(
      isProfileViewRestricted({ isPrivate: true, followStatus: 'accepted' }),
      false,
    );

    // Private account & self -> unrestricted
    assert.equal(
      isProfileViewRestricted({ isPrivate: true, followStatus: 'self' }),
      false,
    );

    // Public account -> unrestricted
    assert.equal(
      isProfileViewRestricted({ isPrivate: false, followStatus: 'none' }),
      false,
    );
  });

  test('formats follower and following counts cleanly', () => {
    assert.equal(formatFollowCount(0), '0');
    assert.equal(formatFollowCount(42), '42');
    assert.equal(formatFollowCount(999), '999');
    assert.equal(formatFollowCount(1000), '1k');
    assert.equal(formatFollowCount(1500), '1.5k');
    assert.equal(formatFollowCount(1000000), '1M');
    assert.equal(formatFollowCount(2500000), '2.5M');
  });
});

// Audit 13 (A-13-013): the followers / following screens showed the first page only.
describe('followers / following paging (A-13-013)', () => {
  test('a page is appended after the rows shown, and a row shown already is not repeated', () => {
    const shown = [{ id: 'a' }, { id: 'b' }];
    // A follow between the two requests shifts the offset page by one: 'b' comes again.
    assert.deepEqual(appendFollowPage(shown, [{ id: 'b' }, { id: 'c' }]), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  test('more to load while fewer are shown than the total, never after an empty page', () => {
    assert.equal(hasMoreFollows(50, 2000, 50), true);
    assert.equal(hasMoreFollows(2000, 2000, 50), false);
    assert.equal(hasMoreFollows(40, 50, 0), false); // the total shrank under us: stop
  });
});
