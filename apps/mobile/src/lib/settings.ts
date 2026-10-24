// LA-02: the Settings screens' words and rules (PRD §6.43, §19.2, §19.4).
//
// Pure, so node:test can run it: the settings list, notification rows from
// GET /me/notification-preferences, HH:MM times for quiet hours and the
// reading reminder, session labels and the error copy. The screens under
// app/settings only draw what this returns.
//
// Reading reminder (§19.2 item 14 [LOCKED]): off by default and the user
// picks the time. Nothing here proposes one: a time is a string only once
// both an hour and a minute have been chosen.

import type {
  NotificationCategoryKey,
  NotificationPreferences,
  Session,
  UpdateNotificationPreferencesRequest,
} from '@flyleaf/api-client';

// ---------------------------------------------------------------- Settings root

export interface SettingsRow {
  key: string;
  label: string;
  detail: string;
  href: string;
  destructive?: boolean;
}

export interface SettingsGroup {
  title: string;
  rows: SettingsRow[];
}

/**
 * The grouped list on the Settings root (§6.43). Content exists only for
 * accounts that can use it (§7.8: hidden entirely under 18). Libraries is
 * not listed: "Where to read" is Phase 9 and has no backend yet.
 */
export function settingsGroups(opts: { explicitSettingAvailable: boolean }): SettingsGroup[] {
  return [
    {
      title: 'Account',
      rows: [
        { key: 'account', label: 'Account', detail: 'Email, username, password and signed-in devices.', href: '/settings/account' },
        { key: 'privacy', label: 'Privacy', detail: 'Who can see your reading.', href: '/settings/privacy' },
        { key: 'notifications', label: 'Notifications', detail: 'What reaches you, quiet hours and a reading reminder.', href: '/settings/notifications' },
      ],
    },
    {
      title: 'Content & people',
      rows: [
        ...(opts.explicitSettingAvailable
          ? [{ key: 'content', label: 'Content', detail: 'Explicit titles in search.', href: '/profile/content' }]
          : []),
        { key: 'blocked', label: 'Blocked accounts', detail: 'People you have blocked.', href: '/profile/blocked' },
        { key: 'muted', label: 'Muted', detail: 'Muted people and books.', href: '/profile/muted' },
        { key: 'reports', label: 'Your reports', detail: 'What you reported, and decisions about your content.', href: '/profile/reports' },
      ],
    },
    {
      title: 'Your data',
      rows: [
        { key: 'import', label: 'Import & export', detail: 'Bring in Goodreads or StoryGraph, or take a copy of your library.', href: '/import' },
      ],
    },
    {
      title: 'App',
      rows: [
        { key: 'appearance', label: 'Appearance', detail: 'Theme and text size.', href: '/settings/appearance' },
        { key: 'about', label: 'About & legal', detail: 'Terms, privacy policy, licences and data sources.', href: '/settings/about' },
      ],
    },
    {
      title: 'Danger zone',
      rows: [
        { key: 'delete', label: 'Delete account', detail: 'Permanently delete your account after 30 days.', href: '/profile/delete-account', destructive: true },
      ],
    },
  ];
}

/** "Version 0.1.0-beta.1 (12)"; the build number only when there is one. */
export function versionLabel(version: string | null | undefined, build?: string | number | null): string {
  const v = version?.trim() || 'unknown';
  const b = build === null || build === undefined || String(build).trim() === '' ? '' : ` (${String(build).trim()})`;
  return `Version ${v}${b}`;
}

// ---------------------------------------------------------------- Times (HH:MM, 24-hour)

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight, or null: the same rule as the server (notify/preferences.ts). */
export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "8:00 pm", "12:30 am". The stored value stays HH:MM. */
export function displayTime(value: string): string {
  const m = parseTime(value);
  if (m === null) return value;
  const h = Math.floor(m / 60);
  const min = String(m % 60).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${min} ${h < 12 ? 'am' : 'pm'}`;
}

export function hourLabel(hour: number): string {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'am' : 'pm'}`;
}

export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

/** Quarter hours, plus a minute already stored that is not one (set through the API). */
export function minuteOptions(current?: string | null): number[] {
  const base = [0, 15, 30, 45];
  const m = current ? parseTime(current) : null;
  if (m !== null && !base.includes(m % 60)) base.push(m % 60);
  return base.sort((a, b) => a - b);
}

/** HH:MM once both parts are chosen; null until then. There is no default. */
export function composeTime(hour: number | null, minute: number | null): string | null {
  if (hour === null || minute === null) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return formatTime(hour * 60 + minute);
}

/** The hour and minute of a stored time, or nulls (nothing chosen). */
export function splitTime(value: string | null | undefined): { hour: number | null; minute: number | null } {
  const m = value ? parseTime(value) : null;
  return m === null ? { hour: null, minute: null } : { hour: Math.floor(m / 60), minute: m % 60 };
}

// ---------------------------------------------------------------- Notifications

export const CATEGORY_COPY: Record<NotificationCategoryKey, { title: string; detail: string }> = {
  new_follower: { title: 'New followers', detail: 'Someone follows you.' },
  follow_request: { title: 'Follow requests', detail: 'Someone asks to follow your private account.' },
  likes: { title: 'Likes', detail: 'Someone likes your review.' },
  comments: { title: 'Comments', detail: 'Someone comments on your review.' },
  comment_replies: { title: 'Replies', detail: 'Someone else comments in a thread you commented in.' },
  mentions: { title: 'Mentions', detail: 'Someone mentions you in a review or comment.' },
  import_complete: { title: 'Import finished', detail: 'Your library import is done.' },
  year_in_review: { title: 'Year in Review', detail: 'Your Year in Review is ready.' },
  invite_joined: { title: 'Invites', detail: 'Someone joins from your invite.' },
  friend_finished_want: { title: 'Friends finishing your want-to-reads', detail: 'Someone you follow finishes a book you want to read.' },
  author_new_book: { title: 'New books from authors you follow', detail: 'An author you follow has a new book.' },
  milestones: { title: 'Milestones', detail: 'A reading milestone you reached.' },
  weekly_summary: { title: 'Weekly summary', detail: 'Your week of reading.' },
};

export type Channel = 'push' | 'in_app';

export interface NotificationRow {
  key: NotificationCategoryKey;
  title: string;
  detail: string;
  /** null: this category has no such channel, so there is no switch for it. */
  push: boolean | null;
  inApp: boolean | null;
}

/**
 * One row per category something sends today (`live`), in the server's
 * order (§19.2). A channel the category lacks stays null and gets no switch.
 */
export function notificationRows(prefs: NotificationPreferences): NotificationRow[] {
  return prefs.categories
    .filter((c) => c.live && (c.push !== null || c.in_app !== null))
    .map((c) => ({
      key: c.key,
      title: CATEGORY_COPY[c.key]?.title ?? c.key,
      detail: CATEGORY_COPY[c.key]?.detail ?? '',
      push: c.push,
      inApp: c.in_app,
    }));
}

/** The PATCH body for one switch; refuses a channel the category does not have. */
export function categoryPatch(
  prefs: NotificationPreferences,
  key: NotificationCategoryKey,
  channel: Channel,
  value: boolean,
): UpdateNotificationPreferencesRequest | null {
  const cat = prefs.categories.find((c) => c.key === key);
  if (!cat || cat[channel] === null) return null;
  return { categories: { [key]: { [channel]: value } } };
}

/** The preferences as they will be once a PATCH succeeds, for an immediate redraw. */
export function applyPatch(prefs: NotificationPreferences, patch: UpdateNotificationPreferencesRequest): NotificationPreferences {
  const next: NotificationPreferences = {
    ...prefs,
    categories: prefs.categories.map((c) => {
      const p = patch.categories?.[c.key];
      if (!p) return c;
      return {
        ...c,
        push: c.push !== null && p.push !== undefined ? p.push : c.push,
        in_app: c.in_app !== null && p.in_app !== undefined ? p.in_app : c.in_app,
      };
    }),
    quiet_hours: { ...prefs.quiet_hours, ...(patch.quiet_hours ?? {}) },
    reading_reminder: prefs.reading_reminder,
  };
  if (patch.push_enabled !== undefined) next.push_enabled = patch.push_enabled;
  if (patch.timezone !== undefined) next.timezone = patch.timezone;
  if (patch.reading_reminder !== undefined) {
    const t = patch.reading_reminder.time;
    next.reading_reminder = { enabled: t !== null, time: t };
  }
  return next;
}

/** A start equal to its end is a window of nothing; everything else may wrap midnight. */
export function quietHoursError(start: string, end: string): string | null {
  const s = parseTime(start);
  const e = parseTime(end);
  if (s === null || e === null) return 'Pick a start and an end.';
  if (s === e) return 'Start and end need to be different times.';
  return null;
}

export function quietHoursSummary(q: NotificationPreferences['quiet_hours']): string {
  if (!q.enabled) return 'Off. Pushes can arrive at any hour.';
  return `No pushes from ${displayTime(q.start)} to ${displayTime(q.end)}. They wait until it ends.`;
}

/** The reminder's body, as the server sends it (§19.2 bound 3). Shown so the reader knows what to expect. */
export const REMINDER_TEXT = 'Time to read.';

export function reminderSummary(r: NotificationPreferences['reading_reminder']): string {
  if (!r.enabled || !r.time) return 'Off. Turn it on to pick a time.';
  return `Every day at ${displayTime(r.time)}: "${REMINDER_TEXT}"`;
}

/** The PATCH for the reminder: a chosen time, or null to turn it off. Never a default. */
export function reminderPatch(time: string | null): UpdateNotificationPreferencesRequest | null {
  if (time === null) return { reading_reminder: { time: null } };
  return parseTime(time) === null ? null : { reading_reminder: { time } };
}

export const NOTIFICATIONS_SAVE_ERROR = 'That change was not saved. Check your connection and try again.';

// ---------------------------------------------------------------- Account

export function sessionLabel(s: Pick<Session, 'device'>): string {
  return s.device?.trim() || 'Unknown device';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Active now" within 5 minutes, "3 hours ago" within a day, "4 days ago" within a week, else the date. */
export function lastUsedLabel(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'Last used: unknown';
  const mins = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 60000));
  if (mins < 5) return 'Active now';
  if (mins < 60) return `Last used ${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last used ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Last used ${days} ${days === 1 ? 'day' : 'days'} ago`;
  return `Last used ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

export function usernameChangeError(err: { status?: number; code?: string; message?: string }): string {
  if (err.status === 409) return 'That username is taken.';
  if (err.status === 422 && err.message) return err.message;
  return 'Your username was not changed. Try again in a moment.';
}

/** Change password has no endpoint yet (owner decision on LA-02): Account offers the reset email instead. */
export function passwordResetSent(email: string): string {
  return `We sent a link to ${email}. Open it on this phone to choose a new password.`;
}

export const SIGN_OUT_EVERYWHERE_WARNING =
  'Every device signed in to your account is signed out, this phone included. You can sign in again straight away.';

// ---------------------------------------------------------------- Privacy

export const PRIVATE_ACCOUNT_DETAIL =
  'Only followers you approve see your reads, reviews, shelves, stats and activity. This includes everything you have already shared, not just what comes next.';

export function privacyConfirm(nextPrivate: boolean): { title: string; message: string; action: string } {
  return nextPrivate
    ? {
        title: 'Make your account private?',
        message: 'Your existing reviews and activity will be hidden from anyone who does not follow you. New followers will need your approval.',
        action: 'Make private',
      }
    : {
        title: 'Make your account public?',
        message: 'Anyone will be able to see your reads, reviews and activity marked public, including what you shared while private. Everyone waiting on a follow request becomes a follower.',
        action: 'Make public',
      };
}

// ---------------------------------------------------------------- About

export interface LegalLink {
  key: string;
  label: string;
  /** null: the document is not written yet (LA-13), so the row says so instead of opening a page. */
  url: string | null;
  href?: string;
}

export const LEGAL_LINKS: LegalLink[] = [
  { key: 'terms', label: 'Terms of service', url: null },
  { key: 'privacy', label: 'Privacy policy', url: null },
  { key: 'licences', label: 'Licences', url: null, href: '/licences' },
];

export const LEGAL_PENDING = 'Published before launch.';
