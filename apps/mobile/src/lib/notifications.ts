// Notification centre and deep links (SO-33; PRD §6.14, §19.5, §35.3).
//
// Pure: no React Native imports, so the node test runner covers it. The
// screen (app/notifications.tsx) and the push bridge (src/lib/push.ts) call
// these.

/** The fields of a notification the list needs (NotificationItem in @flyleaf/api-client). */
export interface ListedNotification {
  id: string;
  read: boolean;
  updated_at: string;
}

export type SectionTitle = 'Today' | 'This week' | 'Earlier';

/** PRD §6.14: "Grouped list (Today / This week / Earlier)", by the device's own calendar. */
export function sectionFor(iso: string, now: Date = new Date()): SectionTitle {
  const at = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (at >= startOfToday) return 'Today';
  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 6);
  return at >= weekAgo ? 'This week' : 'Earlier';
}

export interface NotificationSection<T> {
  title: SectionTitle;
  data: T[];
}

/** Sections in list order, empty ones left out. The list arrives newest first. */
export function groupNotifications<T extends ListedNotification>(items: T[], now: Date = new Date()): NotificationSection<T>[] {
  const order: SectionTitle[] = ['Today', 'This week', 'Earlier'];
  const by = new Map<SectionTitle, T[]>();
  for (const item of items) {
    const s = sectionFor(item.updated_at, now);
    by.set(s, [...(by.get(s) ?? []), item]);
  }
  return order.filter((t) => by.has(t)).map((title) => ({ title, data: by.get(title)! }));
}

/** Flattened for a FlashList: a header row before each section. */
export type NotificationRow<T> = { kind: 'header'; title: SectionTitle } | { kind: 'item'; item: T };

export function notificationRows<T extends ListedNotification>(items: T[], now: Date = new Date()): NotificationRow<T>[] {
  return groupNotifications(items, now).flatMap((s) => [
    { kind: 'header' as const, title: s.title },
    ...s.data.map((item) => ({ kind: 'item' as const, item })),
  ]);
}

/** The bell's badge: nothing at 0, "99+" past 99 (the API stops counting at 100). */
export function badgeLabel(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 99 ? '99+' : String(Math.floor(unread));
}

/** Pages appended without repeats (a row that gained an actor moves up between fetches). */
export function mergePages<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((i) => i.id));
  return [...current, ...next.filter((i) => !seen.has(i.id))];
}

/** Marks rows read locally after a mark-read call. `ids` absent: all. */
export function markLocallyRead<T extends ListedNotification>(items: T[], ids?: string[]): T[] {
  const set = ids ? new Set(ids) : null;
  return items.map((i) => (!i.read && (!set || set.has(i.id)) ? { ...i, read: true } : i));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Home, where an unknown or malformed link lands: never a dead end. */
export const HOME = '/';

/**
 * The screens to stack for a deep link, root first (PRD §35.3: "A deep link to
 * a review synthesises Home → Book → Review so back behaves sensibly").
 *
 *   flyleaf://review/R?work=W                → Home → Book W → Review R
 *   flyleaf://read/D/comments?work=W&review=R → Home → Book W → Review R → Thread D
 *   flyleaf://user/U                          → Home → Profile U
 *   flyleaf://user/U/followers                → Profile tab → Followers of U
 *   flyleaf://profile/requests                → Profile tab → Follow requests
 *   flyleaf://import[/unmatched?id=I]         → Profile tab → Import (→ Unmatched rows)
 *   flyleaf://reading                         → Reading tab
 *   flyleaf://notifications                   → Home → Notifications
 *   flyleaf://moderation/M                    → Profile tab → Moderation notice M (SO-42)
 *   flyleaf://stats                           → Profile tab → Stats (a milestone, ST-10)
 *   flyleaf://year-in-review/YYYY             → Profile tab → Stats → Year in Review (ST-09)
 *
 * Ids must be UUIDs; anything else, or an unknown path, is Home. The links
 * come from our own server, but a push payload is still input.
 */
export function backStackFor(url: string): string[] {
  // Parsed by hand: React Native's URL polyfill does not implement hostname
  // or searchParams on every version, and a throw here would strand a tap.
  const m = /^flyleaf:\/\/([^?#]*)(?:\?([^#]*))?/.exec(typeof url === 'string' ? url : '');
  if (!m) return [HOME];
  let parts: string[];
  try {
    parts = m[1]!.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return [HOME];
  }
  const q = new Map<string, string>();
  for (const pair of (m[2] ?? '').split('&')) {
    const [k, v] = pair.split('=');
    if (k && v !== undefined) q.set(k, v);
  }
  const id = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);
  const work = id(q.get('work'));
  const review = id(q.get('review'));

  const [head, a, b] = parts;
  switch (head) {
    case 'review': {
      const r = id(a);
      if (!r || parts.length !== 2) return [HOME];
      return [HOME, ...(work ? [`/work/${work}`] : []), `/review/${r}`];
    }
    case 'read': {
      const d = id(a);
      if (!d || b !== 'comments' || parts.length !== 3) return [HOME];
      return [HOME, ...(work ? [`/work/${work}`] : []), ...(review ? [`/review/${review}`] : []), `/read/${d}/comments`];
    }
    case 'user': {
      const u = id(a);
      if (!u) return [HOME];
      if (parts.length === 2) return [HOME, `/user/${u}`];
      if (b === 'followers' && parts.length === 3) return ['/profile', `/user/${u}/followers`];
      return [HOME];
    }
    case 'profile':
      return a === 'requests' && parts.length === 2 ? ['/profile', '/profile/requests'] : [HOME];
    case 'import': {
      if (parts.length === 1) return ['/profile', '/import'];
      const i = id(q.get('id'));
      return a === 'unmatched' && parts.length === 2 && i ? ['/profile', '/import', `/import/unmatched?id=${i}`] : [HOME];
    }
    case 'reading':
      return parts.length === 1 ? ['/reading'] : [HOME];
    case 'stats':
      // A milestone (ST-10): your stats, under the Profile tab.
      return parts.length === 1 ? ['/profile', '/stats'] : [HOME];
    case 'year-in-review': {
      // ST-09: Profile → Stats → that year's Year in Review.
      const y = /^\d{4}$/.test(a ?? '') ? a : null;
      return y && parts.length === 2 ? ['/profile', '/stats', `/year-in-review?year=${y}`] : [HOME];
    }
    case 'notifications':
      return parts.length === 1 ? [HOME, '/notifications'] : [HOME];
    case 'moderation': {
      // A decision about your content (PRD §27.6): under the Profile tab.
      const m = id(a);
      return m && parts.length === 2 ? ['/profile', `/moderation/${m}`] : [HOME];
    }
    default:
      return [HOME];
  }
}

/** The screen a link ends on (the in-app list pushes just this: its own back stack is already right). */
export function targetOf(url: string): string {
  return backStackFor(url).at(-1)!;
}

/** What a tapped push carries (notify/delivery.ts: data = { notification_id, type, url }). */
export interface PushPayload {
  notificationId: string | null;
  type: string | null;
  url: string | null;
}

export function readPushPayload(data: unknown): PushPayload {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length < 2048 ? v : null);
  const nid = str(d.notification_id);
  return { notificationId: nid && UUID.test(nid) ? nid : null, type: str(d.type), url: str(d.url) };
}

/** The reading reminder's "Turn off" action (PRD §19.2 item 14 bound 6). */
export const REMINDER_CATEGORY = 'reading_reminder';
export const TURN_OFF_ACTION = 'turn_off';

/** What a notification response asks the app to do. */
export type ResponseAction =
  | { kind: 'turn_off_reminder' }
  | { kind: 'open'; stack: string[]; markRead: string | null; type: string | null };

export function actionForResponse(actionIdentifier: string, data: unknown): ResponseAction {
  const p = readPushPayload(data);
  if (actionIdentifier === TURN_OFF_ACTION) return { kind: 'turn_off_reminder' };
  return { kind: 'open', stack: p.url ? backStackFor(p.url) : [HOME], markRead: p.notificationId, type: p.type };
}

/** Re-register the token at most this often while the app keeps coming to the foreground. */
export const TOKEN_REFRESH_MS = 60 * 60 * 1000;

export function shouldRefreshToken(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= TOKEN_REFRESH_MS;
}
