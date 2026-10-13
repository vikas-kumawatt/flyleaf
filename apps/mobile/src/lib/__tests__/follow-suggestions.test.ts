// SO-51 / SO-52 (app side): the public links match the server's routes, the
// suggestion copy covers every reason the API sends, "Follow all" skips who is
// already followed, and the onboarding screen is wired where PRD §4.1 and
// §6.11 put it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookShareUrl, profileShareUrl, suggestionReason, toFollowAll } from '../followSuggestions';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('public links (SO-50, SO-51)', () => {
  test('profile and book links are the server-rendered routes', () => {
    assert.equal(profileShareUrl('ada_reads'), 'https://flyleaf.app/@ada_reads');
    assert.equal(profileShareUrl('a b'), 'https://flyleaf.app/@a%20b');
    assert.equal(bookShareUrl('6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6'), 'https://flyleaf.app/book/6f1c2a9e-3b4d-4c5e-8f60-718293a4b5c6');
  });

  test('the profile shares flyleaf.app/@username, not the old /u/ address', () => {
    const profile = read('app/(tabs)/profile.tsx');
    assert.match(profile, /profileShareUrl\(user\.username\)/);
    assert.doesNotMatch(profile, /flyleaf\.app\/u\/\$\{user\.username\}/);
  });
});

describe('follow suggestions (SO-52)', () => {
  test('every reason the API can send has reader copy', () => {
    for (const r of ['favourites', 'genres', 'reviewer', 'popular'] as const) assert.ok(suggestionReason(r).length > 0, r);
  });

  test('"Follow all" follows only who is not followed yet, in order', () => {
    assert.deepEqual(toFollowAll([{ id: 'a' }, { id: 'b' }, { id: 'c' }], new Set(['b'])), ['a', 'c']);
    assert.deepEqual(toFollowAll([{ id: 'a' }], new Set(['a'])), []);
  });

  test('the screen is registered, follows through the offline queue, lets unverified accounts follow and sends the PRD events', () => {
    const screen = read('app/onboarding/follow.tsx');
    assert.match(read('app/_layout.tsx'), /name="onboarding\/follow"/);
    assert.match(screen, /api\.followSuggestions\(\)/);
    assert.match(screen, /setFollowing\(id, true\)/);
    // Owner decision on SO-5x: follows are allowed before email verification.
    assert.doesNotMatch(screen, /emailVerified|promptVerify/);
    assert.match(screen, /track\('follow_suggestions_shown'/);
    assert.match(screen, /track\('user_followed', \{ source: 'onboarding' \}\)/);
    assert.match(screen, /Follow all/);
  });

  test('no follow button asks an unverified account to verify first (owner decision on SO-5x)', () => {
    for (const file of ['app/user/[id].tsx', 'app/user/[id]/followers.tsx', 'app/user/[id]/following.tsx', 'app/onboarding/follow.tsx']) {
      assert.doesNotMatch(read(file), /emailVerified === false/, file);
    }
    // Reviews and comments still need it, and the prompt says only that.
    assert.match(read('src/ui/VerifyEmail.tsx'), /Reviews and comments need a verified email address/);
  });

  test('sign-up leads to it (skippable), and an empty Following feed links to it', () => {
    assert.match(read('app/auth.tsx'), /router\.replace\('\/onboarding\/follow'/);
    assert.match(read('app/(tabs)/index.tsx'), /router\.push\('\/onboarding\/follow'/);
    assert.match(read('app/onboarding/follow.tsx'), /'Skip'/);
  });
});
