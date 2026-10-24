// LA-02: the Settings screens' rules (settings.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { NotificationPreferences } from '@flyleaf/api-client';
import {
  applyPatch,
  categoryPatch,
  composeTime,
  displayTime,
  formatTime,
  hourLabel,
  lastUsedLabel,
  LEGAL_LINKS,
  minuteOptions,
  notificationRows,
  parseTime,
  privacyConfirm,
  PRIVATE_ACCOUNT_DETAIL,
  quietHoursError,
  quietHoursSummary,
  reminderPatch,
  reminderSummary,
  REMINDER_TEXT,
  sessionLabel,
  settingsGroups,
  splitTime,
  usernameChangeError,
  versionLabel,
} from '../settings';

// The shape GET /me/notification-preferences answers for a new account (SO-32).
function defaults(): NotificationPreferences {
  const cat = (key: any, push: boolean | null, in_app: boolean | null, live: boolean) => ({ key, push, in_app, live });
  return {
    push_enabled: true,
    categories: [
      cat('new_follower', true, true, true),
      cat('follow_request', true, true, true),
      cat('likes', true, true, true),
      cat('comments', true, true, true),
      cat('comment_replies', true, true, true),
      cat('mentions', true, true, false),
      cat('import_complete', true, true, true),
      cat('year_in_review', true, true, true),
      cat('invite_joined', null, true, false),
      cat('friend_finished_want', false, null, false),
      cat('author_new_book', false, null, false),
      cat('milestones', null, true, true),
      cat('weekly_summary', false, null, false),
    ],
    quiet_hours: { enabled: true, start: '22:00', end: '08:00' },
    timezone: 'Asia/Kolkata',
    reading_reminder: { enabled: false, time: null },
  };
}

describe('settings root', () => {
  test('lists every §6.43 screen that is built, with Libraries left out', () => {
    const keys = settingsGroups({ explicitSettingAvailable: true }).flatMap((g) => g.rows.map((r) => r.key));
    for (const k of ['account', 'privacy', 'notifications', 'content', 'blocked', 'import', 'appearance', 'about', 'delete']) {
      assert.ok(keys.includes(k), `missing ${k}`);
    }
    assert.ok(!keys.includes('libraries'));
  });

  test('Content is hidden entirely when the account cannot use it (§7.8)', () => {
    const keys = settingsGroups({ explicitSettingAvailable: false }).flatMap((g) => g.rows.map((r) => r.key));
    assert.ok(!keys.includes('content'));
  });

  test('every row links to an existing route, and only Delete account is destructive', () => {
    const rows = settingsGroups({ explicitSettingAvailable: true }).flatMap((g) => g.rows);
    for (const r of rows) assert.match(r.href, /^\/(settings|profile)\/[a-z-]+$|^\/import$/);
    assert.deepEqual(rows.filter((r) => r.destructive).map((r) => r.key), ['delete']);
  });

  test('version label, with and without a build number', () => {
    assert.equal(versionLabel('0.1.0-beta.1', 12), 'Version 0.1.0-beta.1 (12)');
    assert.equal(versionLabel('0.1.0', null), 'Version 0.1.0');
    assert.equal(versionLabel(undefined), 'Version unknown');
  });
});

describe('times', () => {
  test('parseTime follows the server: 24-hour HH:MM only', () => {
    assert.equal(parseTime('00:00'), 0);
    assert.equal(parseTime('23:59'), 1439);
    for (const bad of ['24:00', '7:00', '07:60', '0700', '', null, 700]) assert.equal(parseTime(bad), null, String(bad));
  });

  test('formatTime pads and wraps', () => {
    assert.equal(formatTime(0), '00:00');
    assert.equal(formatTime(20 * 60 + 5), '20:05');
    assert.equal(formatTime(1440 + 30), '00:30');
  });

  test('displayTime and hourLabel use am/pm, with 12 for midnight and noon', () => {
    assert.equal(displayTime('20:00'), '8:00 pm');
    assert.equal(displayTime('00:30'), '12:30 am');
    assert.equal(displayTime('12:00'), '12:00 pm');
    assert.equal(hourLabel(0), '12 am');
    assert.equal(hourLabel(13), '1 pm');
  });

  test('composeTime needs both parts: nothing is chosen for the reader', () => {
    assert.equal(composeTime(null, null), null);
    assert.equal(composeTime(20, null), null);
    assert.equal(composeTime(null, 0), null);
    assert.equal(composeTime(20, 0), '20:00');
    assert.equal(composeTime(24, 0), null);
    assert.equal(composeTime(7, 60), null);
  });

  test('splitTime of no time is nothing selected', () => {
    assert.deepEqual(splitTime(null), { hour: null, minute: null });
    assert.deepEqual(splitTime('21:45'), { hour: 21, minute: 45 });
  });

  test('minute options are quarter hours, keeping an odd stored minute', () => {
    assert.deepEqual(minuteOptions(), [0, 15, 30, 45]);
    assert.deepEqual(minuteOptions('22:10'), [0, 10, 15, 30, 45]);
    assert.deepEqual(minuteOptions('22:30'), [0, 15, 30, 45]);
  });
});

describe('notification rows', () => {
  test('only live categories, in the server order', () => {
    const rows = notificationRows(defaults());
    assert.deepEqual(rows.map((r) => r.key), [
      'new_follower', 'follow_request', 'likes', 'comments', 'comment_replies', 'import_complete', 'year_in_review', 'milestones',
    ]);
  });

  test('a channel the category lacks stays null (no switch); milestones are in-app only', () => {
    const m = notificationRows(defaults()).find((r) => r.key === 'milestones')!;
    assert.equal(m.push, null);
    assert.equal(m.inApp, true);
  });

  test('a push-only category appears once it goes live, with no in-app switch', () => {
    const p = defaults();
    p.categories.find((c) => c.key === 'weekly_summary')!.live = true;
    const w = notificationRows(p).find((r) => r.key === 'weekly_summary')!;
    assert.equal(w.push, false);
    assert.equal(w.inApp, null);
  });

  test('every category has copy', () => {
    const p = defaults();
    for (const c of p.categories) c.live = true;
    for (const r of notificationRows(p)) {
      assert.notEqual(r.title, r.key);
      assert.ok(r.detail.length > 0);
    }
  });

  test('categoryPatch sends one channel, and refuses one that does not exist', () => {
    const p = defaults();
    assert.deepEqual(categoryPatch(p, 'likes', 'push', false), { categories: { likes: { push: false } } });
    assert.equal(categoryPatch(p, 'milestones', 'push', true), null);
    assert.equal(categoryPatch(p, 'weekly_summary', 'in_app', true), null);
  });

  test('applyPatch mirrors the change without touching a missing channel', () => {
    const p = defaults();
    const next = applyPatch(p, { categories: { likes: { push: false }, milestones: { push: true } as any } });
    assert.equal(next.categories.find((c) => c.key === 'likes')!.push, false);
    assert.equal(next.categories.find((c) => c.key === 'likes')!.in_app, true);
    assert.equal(next.categories.find((c) => c.key === 'milestones')!.push, null);
    assert.equal(p.categories.find((c) => c.key === 'likes')!.push, true, 'the input is not mutated');
  });

  test('applyPatch: master switch, quiet hours and reminder', () => {
    const next = applyPatch(defaults(), { push_enabled: false, quiet_hours: { start: '23:00' }, reading_reminder: { time: '20:30' } });
    assert.equal(next.push_enabled, false);
    assert.deepEqual(next.quiet_hours, { enabled: true, start: '23:00', end: '08:00' });
    assert.deepEqual(next.reading_reminder, { enabled: true, time: '20:30' });
    assert.deepEqual(applyPatch(next, { reading_reminder: { time: null } }).reading_reminder, { enabled: false, time: null });
  });
});

describe('quiet hours', () => {
  test('a window may wrap midnight but may not be empty', () => {
    assert.equal(quietHoursError('22:00', '08:00'), null);
    assert.equal(quietHoursError('01:00', '06:00'), null);
    assert.match(quietHoursError('22:00', '22:00')!, /different/);
    assert.match(quietHoursError('22:00', '8:00')!, /Pick/);
  });

  test('summary says what happens to a push inside them', () => {
    assert.match(quietHoursSummary({ enabled: true, start: '22:00', end: '08:00' }), /10:00 pm to 8:00 am/);
    assert.match(quietHoursSummary({ enabled: false, start: '22:00', end: '08:00' }), /^Off/);
  });
});

describe('reading reminder (§19.2 item 14)', () => {
  test('off by default says so, and on shows the user time and the fixed copy', () => {
    assert.match(reminderSummary({ enabled: false, time: null }), /^Off/);
    assert.equal(reminderSummary({ enabled: true, time: '20:00' }), 'Every day at 8:00 pm: "Time to read."');
  });

  test('the copy carries no guilt, streak, count or title (bound 3)', () => {
    assert.equal(REMINDER_TEXT, 'Time to read.');
    assert.doesNotMatch(reminderSummary({ enabled: true, time: '07:15' }), /streak|haven|days|\d+ books/i);
  });

  test('reminderPatch: a chosen time, or null to turn off; never a made-up or malformed time', () => {
    assert.deepEqual(reminderPatch('20:00'), { reading_reminder: { time: '20:00' } });
    assert.deepEqual(reminderPatch(null), { reading_reminder: { time: null } });
    assert.equal(reminderPatch('8pm'), null);
  });
});

describe('account', () => {
  test('session labels', () => {
    assert.equal(sessionLabel({ device: 'Android' }), 'Android');
    assert.equal(sessionLabel({ device: null }), 'Unknown device');
    assert.equal(sessionLabel({ device: '  ' }), 'Unknown device');
  });

  test('last used', () => {
    const now = new Date('2026-10-24T12:00:00Z');
    assert.equal(lastUsedLabel('2026-10-24T11:58:00Z', now), 'Active now');
    assert.equal(lastUsedLabel('2026-10-24T11:30:00Z', now), 'Last used 30 minutes ago');
    assert.equal(lastUsedLabel('2026-10-24T11:00:00Z', now), 'Last used 1 hour ago');
    assert.equal(lastUsedLabel('2026-10-21T12:00:00Z', now), 'Last used 3 days ago');
    assert.equal(lastUsedLabel('2026-09-01T12:00:00Z', now), 'Last used 1 September 2026');
    assert.equal(lastUsedLabel('nonsense', now), 'Last used: unknown');
  });

  test('username errors', () => {
    assert.equal(usernameChangeError({ status: 409, code: 'username_taken' }), 'That username is taken.');
    assert.equal(usernameChangeError({ status: 422, message: 'That username is reserved.' }), 'That username is reserved.');
    assert.match(usernameChangeError({ status: 500 }), /not changed/);
  });
});

describe('about', () => {
  test('terms and privacy policy are placeholders until LA-13; licences opens its screen', () => {
    const byKey = Object.fromEntries(LEGAL_LINKS.map((l) => [l.key, l]));
    assert.equal(byKey.terms?.url, null);
    assert.equal(byKey.privacy?.url, null);
    assert.equal(byKey.licences?.href, '/licences');
  });
});

describe('privacy', () => {
  test('the confirmations say what the server does: hides existing activity, and going public accepts pending requests', () => {
    assert.match(privacyConfirm(true).message, /existing reviews and activity will be hidden/);
    assert.match(privacyConfirm(false).message, /follow request becomes a follower/);
    assert.match(PRIVATE_ACCOUNT_DETAIL, /already shared/);
  });
});

describe('routes', () => {
  const app = (rel: string) => fileURLToPath(new URL(`../../../app/${rel}`, import.meta.url));
  const screenFor = (href: string) => [app(`${href.slice(1)}.tsx`), app(`${href.slice(1)}/index.tsx`)].find((f) => existsSync(f));

  test('every Settings row and legal link opens a screen that exists', () => {
    const hrefs = [
      ...settingsGroups({ explicitSettingAvailable: true }).flatMap((g) => g.rows.map((r) => r.href)),
      ...LEGAL_LINKS.flatMap((l) => (l.href ? [l.href] : [])),
    ];
    for (const href of hrefs) assert.ok(screenFor(href), `no screen for ${href}`);
  });

  test('the Profile tab opens Settings, and the settings screens are registered without a second header', () => {
    const profile = readFileSync(app('(tabs)/profile.tsx'), 'utf8');
    assert.match(profile, /router\.push\('\/settings'/);
    // Privacy is owned by Settings → Privacy; the edit modal must not send a stale value.
    assert.doesNotMatch(profile, /isPrivate: edit/);
    const layout = readFileSync(app('_layout.tsx'), 'utf8');
    for (const s of ['index', 'account', 'privacy', 'notifications', 'appearance', 'about']) {
      assert.ok(existsSync(app(`settings/${s}.tsx`)), `settings/${s}.tsx`);
      assert.match(layout, new RegExp(`name="settings/${s}" options=\\{\\{[^}]*headerShown: false`));
    }
  });
});
