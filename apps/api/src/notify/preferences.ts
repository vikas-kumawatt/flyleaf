// Notification preferences and frequency rules (SO-31, SO-32; PRD §19.2–19.4).
//
// Pure functions: what a stored preferences row means, whether a minute of
// the day is inside quiet hours, when they end. The database holds only what
// the user changed (notification_preferences, 0043); no row is every default.

export type NotificationType =
  | 'follow' | 'follow_request' | 'like' | 'comment' | 'import_complete' | 'reply' | 'moderation'
  // Phase 5 C: PRD §19.2 items 8 and 12.
  | 'year_in_review' | 'milestone';

/** Types a person can switch off: every type but the moderation notice (PRD §27.6 says the user is told). */
export type CategorisedType = Exclude<NotificationType, 'moderation'>;

/**
 * PRD §19.4: "per-category toggles (all 13 live categories), a push/in-app
 * split per category". Items 1–13 of the §19.2 catalogue; item 14 (the reading
 * reminder) is its own setting, a time; 15 and 16 are never built.
 *
 * `push` / `inApp`: the default, or null where §19.2 gives the category no
 * such channel (item 9 is in-app only; 10, 11 and 13 are push only; 12 is
 * in-app only). `emits`: something in the product sends it today. The rest
 * are stored and returned so Settings can show all 13 (LA-02), and switch on
 * when their feature ships (replies since SO-4x; Year in Review and milestones
 * since Phase 5 C; mentions, invites, author follows, the weekly summary).
 */
export const NOTIFICATION_CATEGORIES = [
  { key: 'new_follower', item: 1, push: true, inApp: true, emits: true },
  { key: 'follow_request', item: 2, push: true, inApp: true, emits: true },
  { key: 'likes', item: 3, push: true, inApp: true, emits: true },
  { key: 'comments', item: 4, push: true, inApp: true, emits: true },
  { key: 'comment_replies', item: 5, push: true, inApp: true, emits: true },
  { key: 'mentions', item: 6, push: true, inApp: true, emits: false },
  { key: 'import_complete', item: 7, push: true, inApp: true, emits: true },
  { key: 'year_in_review', item: 8, push: true, inApp: true, emits: true },
  { key: 'invite_joined', item: 9, push: null, inApp: true, emits: false },
  { key: 'friend_finished_want', item: 10, push: false, inApp: null, emits: false },
  { key: 'author_new_book', item: 11, push: false, inApp: null, emits: false },
  { key: 'milestones', item: 12, push: null, inApp: true, emits: true },
  { key: 'weekly_summary', item: 13, push: false, inApp: null, emits: false },
] as const satisfies readonly { key: string; item: number; push: boolean | null; inApp: boolean | null; emits: boolean }[];

export type CategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]['key'];

export const CATEGORY_OF: Record<CategorisedType, CategoryKey> = {
  follow: 'new_follower',
  follow_request: 'follow_request',
  like: 'likes',
  comment: 'comments',
  import_complete: 'import_complete',
  reply: 'comment_replies',
  year_in_review: 'year_in_review',
  milestone: 'milestones',
};

const CATEGORY_BY_KEY = new Map<string, (typeof NOTIFICATION_CATEGORIES)[number]>(
  NOTIFICATION_CATEGORIES.map((c) => [c.key, c]),
);

export function isCategoryKey(key: string): key is CategoryKey {
  return CATEGORY_BY_KEY.has(key);
}

/** PRD §19.3: default quiet hours 10pm–8am local, in minutes after midnight. */
export const DEFAULT_QUIET_START = 22 * 60;
export const DEFAULT_QUIET_END = 8 * 60;

/** PRD §19.3: "Aggregation window: 1 hour for likes and follows". */
export const AGGREGATION_WINDOW_MS = 60 * 60 * 1000;

/** PRD §19.3: "No push in the first 24 hours except import completion". */
export const NEW_USER_GRACE_MS = 24 * 60 * 60 * 1000;

/** PRD §19.2 item 14 bound 4: suspended after 14 days without opening the app. */
export const REMINDER_LAPSE_DAYS = 14;

/** PRD §19.2 item 14 bound 3: no guilt, no streak, no counts, no title. Fixed. */
export const READING_REMINDER_TEXT = 'Time to read.';

/** The app registers this category with a "Turn off" action (bound 6). */
export const READING_REMINDER_CATEGORY = 'reading_reminder';

/** How long after its scheduled minute a reminder may still go out (a worker restart, a slow tick). */
export const REMINDER_SEND_WINDOW_MIN = 30;

export interface StoredPreferences {
  pushEnabled: boolean;
  categories: unknown;
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  timezone: string;
  reminderTime: number | null;
}

export interface CategoryPreference {
  key: CategoryKey;
  /** null: the category has no push channel (PRD §19.2). */
  push: boolean | null;
  in_app: boolean | null;
  /** Something sends it today. */
  live: boolean;
}

export interface ResolvedPreferences {
  pushEnabled: boolean;
  categories: Record<CategoryKey, CategoryPreference>;
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  timezone: string;
  reminderTime: number | null;
}

/** What a stored row (or none) means, every category filled in. */
export function resolvePreferences(row: StoredPreferences | null | undefined): ResolvedPreferences {
  const stored = (row?.categories && typeof row.categories === 'object' ? row.categories : {}) as Record<
    string,
    { push?: unknown; in_app?: unknown } | undefined
  >;
  const categories = {} as Record<CategoryKey, CategoryPreference>;
  for (const c of NOTIFICATION_CATEGORIES) {
    const s = stored[c.key] ?? {};
    categories[c.key] = {
      key: c.key,
      push: c.push === null ? null : typeof s.push === 'boolean' ? s.push : c.push,
      in_app: c.inApp === null ? null : typeof s.in_app === 'boolean' ? s.in_app : c.inApp,
      live: c.emits,
    };
  }
  return {
    pushEnabled: row?.pushEnabled ?? true,
    categories,
    quietEnabled: row?.quietEnabled ?? true,
    quietStart: row?.quietStart ?? DEFAULT_QUIET_START,
    quietEnd: row?.quietEnd ?? DEFAULT_QUIET_END,
    timezone: row?.timezone ?? 'UTC',
    reminderTime: row?.reminderTime ?? null,
  };
}

/** Whether a notification of this type is wanted at all, and on which channels. */
export function channelsFor(prefs: ResolvedPreferences, type: NotificationType): { inApp: boolean; push: boolean } {
  // A moderation notice is not a category (§19.2 has none): always in the
  // list, never pushed. The user is told which rule applied (PRD §27.6).
  if (type === 'moderation') return { inApp: true, push: false };
  const c = prefs.categories[CATEGORY_OF[type]];
  return { inApp: c.in_app === true, push: prefs.pushEnabled && c.push === true };
}

/** Minutes after local midnight in `timeZone` at `at`. An unknown zone reads as UTC. */
export function localMinutes(at: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/**
 * Inside [start, end), wrapping midnight when start > end (22:00–08:00).
 * start === end is an empty window: no quiet hours.
 */
export function inQuietHours(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** When quiet hours end, as an instant: the next local `end` minute after `at`. */
export function quietHoursEnd(at: Date, timeZone: string, end: number): Date {
  const now = localMinutes(at, timeZone);
  const minutes = (end - now + 1440) % 1440 || 1440;
  const next = new Date(at.getTime() + minutes * 60_000);
  next.setUTCSeconds(0, 0);
  return next;
}

/** Quiet right now for this user? */
export function isQuiet(prefs: ResolvedPreferences, at: Date): boolean {
  return prefs.quietEnabled && inQuietHours(localMinutes(at, prefs.timezone), prefs.quietStart, prefs.quietEnd);
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "20:30" -> 1230; anything else -> null. */
export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
