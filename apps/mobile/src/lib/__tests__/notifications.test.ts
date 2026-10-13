// SO-33: the notification centre's grouping and badge, and deep links with a
// synthesised back stack (PRD §6.14, §19.5, §35.3).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME,
  actionForResponse,
  backStackFor,
  badgeLabel,
  groupNotifications,
  markLocallyRead,
  mergePages,
  notificationRows,
  readPushPayload,
  sectionFor,
  shouldRefreshToken,
  targetOf,
  TOKEN_REFRESH_MS,
  TURN_OFF_ACTION,
} from '../notifications.js';

const U = '11111111-2222-3333-4444-555555555555';
const W = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const R = '99999999-8888-7777-6666-555555555555';

describe('sections: Today / This week / Earlier, by the device calendar', () => {
  const now = new Date(2026, 9, 12, 9, 0); // 12 Oct, 09:00 local

  test('today from local midnight, the six days before, then earlier', () => {
    assert.equal(sectionFor(new Date(2026, 9, 12, 0, 0).toISOString(), now), 'Today');
    assert.equal(sectionFor(new Date(2026, 9, 11, 23, 59).toISOString(), now), 'This week');
    assert.equal(sectionFor(new Date(2026, 9, 6, 0, 0).toISOString(), now), 'This week');
    assert.equal(sectionFor(new Date(2026, 9, 5, 23, 59).toISOString(), now), 'Earlier');
  });

  test('groups keep the API order and leave empty sections out', () => {
    const items = [
      { id: 'a', read: false, updated_at: new Date(2026, 9, 12, 8).toISOString() },
      { id: 'b', read: true, updated_at: new Date(2026, 9, 1).toISOString() },
      { id: 'c', read: true, updated_at: new Date(2026, 8, 1).toISOString() },
    ];
    assert.deepEqual(groupNotifications(items, now).map((s) => [s.title, s.data.map((d) => d.id)]), [
      ['Today', ['a']],
      ['Earlier', ['b', 'c']],
    ]);
    assert.deepEqual(notificationRows(items, now).map((r) => (r.kind === 'header' ? r.title : r.item.id)), [
      'Today', 'a', 'Earlier', 'b', 'c',
    ]);
    assert.deepEqual(groupNotifications([], now), []);
  });
});

describe('badge, paging and read state', () => {
  test('no badge at 0, the number up to 99, then 99+', () => {
    assert.equal(badgeLabel(0), null);
    assert.equal(badgeLabel(-1), null);
    assert.equal(badgeLabel(Number.NaN), null);
    assert.equal(badgeLabel(7), '7');
    assert.equal(badgeLabel(99), '99');
    assert.equal(badgeLabel(100), '99+');
  });

  test('a row that moved between pages is not shown twice', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    assert.deepEqual(mergePages([a, b], [b, { id: 'c' }]).map((i) => i.id), ['a', 'b', 'c']);
  });

  test('mark read: the given ids, or all', () => {
    const items = [
      { id: 'a', read: false, updated_at: '' },
      { id: 'b', read: false, updated_at: '' },
    ];
    assert.deepEqual(markLocallyRead(items, ['b']).map((i) => i.read), [false, true]);
    assert.deepEqual(markLocallyRead(items).map((i) => i.read), [true, true]);
  });
});

describe('deep links resolve to the exact screen, with a back stack that makes sense', () => {
  test('review: Home → Book → Review (PRD §35.3)', () => {
    assert.deepEqual(backStackFor(`flyleaf://review/${R}?work=${W}`), [HOME, `/work/${W}`, `/review/${R}`]);
    // Without the book, still Home → Review: back never leaves the app.
    assert.deepEqual(backStackFor(`flyleaf://review/${R}`), [HOME, `/review/${R}`]);
  });

  test('comment thread: Home → Book → Review → Thread, or Home → Book → Thread when there is no review', () => {
    assert.deepEqual(backStackFor(`flyleaf://read/${U}/comments?work=${W}&review=${R}`), [
      HOME, `/work/${W}`, `/review/${R}`, `/read/${U}/comments`,
    ]);
    assert.deepEqual(backStackFor(`flyleaf://read/${U}/comments?work=${W}`), [HOME, `/work/${W}`, `/read/${U}/comments`]);
  });

  test('people, requests, imports, reading, the centre itself', () => {
    assert.deepEqual(backStackFor(`flyleaf://user/${U}`), [HOME, `/user/${U}`]);
    assert.deepEqual(backStackFor(`flyleaf://user/${U}/followers`), ['/profile', `/user/${U}/followers`]);
    assert.deepEqual(backStackFor('flyleaf://profile/requests'), ['/profile', '/profile/requests']);
    assert.deepEqual(backStackFor('flyleaf://import'), ['/profile', '/import']);
    assert.deepEqual(backStackFor(`flyleaf://import/unmatched?id=${U}`), ['/profile', '/import', `/import/unmatched?id=${U}`]);
    assert.deepEqual(backStackFor('flyleaf://reading'), ['/reading']);
    assert.deepEqual(backStackFor('flyleaf://notifications'), [HOME, '/notifications']);
    assert.deepEqual(backStackFor('flyleaf://stats'), ['/profile', '/stats']);
    assert.deepEqual(backStackFor('flyleaf://year-in-review/2026'), ['/profile', '/stats', '/year-in-review?year=2026']);
  });

  test('every link the API composes resolves to a real screen, not Home', () => {
    // The shapes notify/index.ts compose() produces.
    for (const link of [
      `flyleaf://user/${U}`,
      `flyleaf://user/${U}/followers`,
      'flyleaf://profile/requests',
      `flyleaf://review/${R}?work=${W}`,
      `flyleaf://read/${U}/comments?work=${W}`,
      `flyleaf://read/${U}/comments?work=${W}&review=${R}`,
      `flyleaf://import/unmatched?id=${U}`,
      'flyleaf://import',
      'flyleaf://reading',
      // Phase 5 C: milestones and Year in Review.
      'flyleaf://stats',
      'flyleaf://year-in-review/2026',
    ]) {
      assert.notEqual(targetOf(link), HOME, link);
    }
  });

  test('anything malformed or foreign lands on Home', () => {
    for (const bad of [
      '',
      'not a url',
      'https://evil.example/review/x',
      'flyleaf://review/not-a-uuid',
      `flyleaf://review/${R}/extra`,
      'flyleaf://read/x/comments',
      `flyleaf://read/${U}/likes`,
      'flyleaf://user/../admin',
      'flyleaf://import/unmatched?id=../../x',
      'flyleaf://settings',
      'flyleaf://year-in-review/26',
      'flyleaf://year-in-review/2026/x',
      'flyleaf://stats/x',
      'flyleaf://%E0%A4%A',
    ]) {
      assert.deepEqual(backStackFor(bad), [HOME], bad);
    }
    // A bad optional parent is dropped, the target kept.
    assert.deepEqual(backStackFor(`flyleaf://review/${R}?work=x`), [HOME, `/review/${R}`]);
  });
});

describe('push responses', () => {
  test('a tap opens the stack and marks that notification read', () => {
    assert.deepEqual(
      actionForResponse('expo.modules.notifications.actions.DEFAULT', {
        notification_id: U, type: 'like', url: `flyleaf://review/${R}?work=${W}`,
      }),
      { kind: 'open', stack: [HOME, `/work/${W}`, `/review/${R}`], markRead: U, type: 'like' },
    );
  });

  test('the reminder\'s "Turn off" action turns it off; it opens nothing (bound 6)', () => {
    assert.deepEqual(actionForResponse(TURN_OFF_ACTION, { type: 'reading_reminder', url: 'flyleaf://reading' }), {
      kind: 'turn_off_reminder',
    });
  });

  test('a payload that is not ours is harmless', () => {
    assert.deepEqual(readPushPayload(null), { notificationId: null, type: null, url: null });
    assert.deepEqual(readPushPayload({ notification_id: 'x', url: 5 }), { notificationId: null, type: null, url: null });
    assert.deepEqual(actionForResponse('x', 'junk'), { kind: 'open', stack: [HOME], markRead: null, type: null });
  });

  test('the token is re-registered at most hourly while the app keeps coming back', () => {
    assert.equal(shouldRefreshToken(null, 0), true);
    assert.equal(shouldRefreshToken(1000, 1000 + TOKEN_REFRESH_MS - 1), false);
    assert.equal(shouldRefreshToken(1000, 1000 + TOKEN_REFRESH_MS), true);
  });
});

describe('wiring that only a device would otherwise show', () => {
  const read = (rel: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').readFileSync(require('node:url').fileURLToPath(new URL(rel, import.meta.url)), 'utf8') as string;

  test('the push bridge is mounted inside the session, and the centre is a stack screen', () => {
    const layout = read('../../../app/_layout.tsx');
    const inside = layout.slice(layout.indexOf('<SessionProvider>'), layout.indexOf('</SessionProvider>'));
    assert.match(inside, /<PushBridge \/>/);
    assert.match(layout, /<Stack\.Screen name="notifications"/);
  });

  test('the bell opens the centre, and expo-notifications is in the native config', () => {
    assert.match(read('../../../app/(tabs)/index.tsx'), /router\.push\('\/notifications'\)/);
    const plugins = JSON.parse(read('../../../app.json')).expo.plugins as unknown[];
    assert.ok(plugins.some((p) => (Array.isArray(p) ? p[0] : p) === 'expo-notifications'));
  });

  test('permission is asked after a follow, not at launch (PRD §35.3)', () => {
    assert.match(read('../../offline/sync.tsx'), /if \(following\) void askForPushOnce\(\);/);
    assert.doesNotMatch(read('../../../app/_layout.tsx'), /requestPermissions/);
    assert.doesNotMatch(read('../../ui/PushBridge.tsx'), /requestPermissions|askForPush|enablePush/);
  });
});
