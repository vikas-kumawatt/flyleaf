// Shelf Form Validation (SH-02, PRD §15.2)

export interface ShelfFormValues {
  name: string;
  description: string;
  privacy: 'public' | 'followers' | 'private';
  is_ranked: boolean;
}

/**
 * Length in characters (code points), as the server and the database count
 * it. `.length` counts UTF-16 units, so an emoji counted twice (audit 11).
 */
export function charLength(s: string): number {
  return [...s].length;
}

export interface ShelfFormErrors {
  name?: string;
  description?: string;
  privacy?: string;
}

export function validateShelfForm(values: Partial<ShelfFormValues>): {
  isValid: boolean;
  errors: ShelfFormErrors;
} {
  const errors: ShelfFormErrors = {};
  const trimmedName = (values.name ?? '').trim();

  if (!trimmedName) {
    errors.name = 'Shelf name is required.';
  } else if (charLength(trimmedName) > 60) {
    errors.name = 'Shelf name cannot exceed 60 characters.';
  }

  if (values.description && charLength(values.description.trim()) > 2000) {
    errors.description = 'Description cannot exceed 2000 characters.';
  }

  if (
    values.privacy !== undefined &&
    !['public', 'followers', 'private'].includes(values.privacy)
  ) {
    errors.privacy = 'Invalid privacy setting.';
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

export function validateShelfNote(note?: string | null): { isValid: boolean; error?: string } {
  if (!note) return { isValid: true };
  if (charLength(note.trim()) > 280) {
    return { isValid: false, error: 'Note cannot exceed 280 characters.' };
  }
  return { isValid: true };
}

export function formatShelfRank(
  isRanked: boolean,
  position?: number | null,
  index = 0,
): string | null {
  if (!isRanked) return null;
  return `#${position ?? index + 1}`;
}

export function validateShelfName(name?: string | null): { isValid: boolean; error?: string } {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    return { isValid: false, error: 'Shelf name is required.' };
  }
  if (charLength(trimmed) > 60) {
    return { isValid: false, error: 'Shelf name cannot exceed 60 characters.' };
  }
  return { isValid: true };
}

/**
 * Moves an item within an array from fromIndex to toIndex (0-indexed).
 * Returns a new array. If indices are out of bounds or identical, returns a shallow copy.
 */
export function moveItemInArray<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= list.length ||
    toIndex < 0 ||
    toIndex >= list.length
  ) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(fromIndex, 1);
  if (item !== undefined) {
    next.splice(toIndex, 0, item);
  }
  return next;
}

/**
 * Moves an item at fromIndex (0-indexed) to a target 1-indexed position (1..N).
 * The target position is clamped between 1 and list.length.
 */
export function repositionItem<T>(list: T[], fromIndex: number, targetPosition: number): T[] {
  if (!list.length || fromIndex < 0 || fromIndex >= list.length) {
    return [...list];
  }
  const clampedPosition = Math.max(1, Math.min(list.length, Math.floor(targetPosition)));
  const toIndex = clampedPosition - 1;
  return moveItemInArray(list, fromIndex, toIndex);
}

// Starter Shelves & Sorting (SH-06, PRD §6.33, §15.3)

export interface StarterShelfSuggestion {
  id: string;
  name: string;
  description: string;
  is_ranked: boolean;
  privacy: 'public' | 'followers' | 'private';
  tagline: string;
  badge: string;
  icon: 'trophy-outline' | 'heart-outline' | 'chatbubbles-outline';
}

export const STARTER_SHELVES: StarterShelfSuggestion[] = [
  {
    id: 'starter_favourites_2026',
    name: 'Favourites of 2026',
    description: 'My personal favourites and top reads of the year.',
    is_ranked: true,
    privacy: 'public',
    tagline: 'Ranked list of the best books you read this year',
    badge: 'Ranked List',
    icon: 'trophy-outline',
  },
  {
    id: 'starter_comfort_reads',
    name: 'Comfort reads',
    description: 'Books to return to when you need warmth, solace, and familiar magic.',
    is_ranked: false,
    privacy: 'public',
    tagline: 'Stories that feel like a warm cup of tea and a blanket',
    badge: 'Themed List',
    icon: 'heart-outline',
  },
  {
    id: 'starter_recommended_to_me',
    name: 'Recommended to me',
    description: 'Books recommended by friends, book clubs, podcasts, and fellow readers.',
    is_ranked: false,
    privacy: 'public',
    tagline: 'Reading queue for recommendations and word-of-mouth gems',
    badge: 'Reading Queue',
    icon: 'chatbubbles-outline',
  },
];

export type ShelfSortOption = 'updated' | 'alpha' | 'books';

export function sortShelves<T extends { name: string; created_at: string; item_count: number }>(
  shelves: T[],
  sortBy: ShelfSortOption,
): T[] {
  const copy = [...shelves];
  switch (sortBy) {
    case 'updated':
      return copy.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    case 'alpha':
      return copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'books':
      return copy.sort((a, b) => b.item_count - a.item_count);
    default:
      return copy;
  }
}

/**
 * Generates the canonical web URL for a shelf (PRD §15.2, §29.1).
 */
export function getShelfShareUrl(
  shelf: { owner?: { username?: string | null }; slug?: string; id?: string },
  baseUrl = 'https://flyleaf.app',
): string {
  const username = shelf.owner?.username;
  const slug = shelf.slug;
  if (username && slug) {
    return `${baseUrl}/u/${encodeURIComponent(username)}/shelves/${encodeURIComponent(slug)}`;
  }
  return `${baseUrl}/shelf/${shelf.id || ''}`;
}

/**
 * Generates the descriptive share message for a shelf (PRD §6.34, §29.1).
 */
export function getShelfShareMessage(shelf: {
  name: string;
  owner?: { displayName?: string | null; username?: string | null };
  item_count?: number;
}): string {
  const curator =
    shelf.owner?.displayName || (shelf.owner?.username ? `@${shelf.owner.username}` : 'a reader');
  const countStr =
    shelf.item_count != null ? ` (${shelf.item_count} book${shelf.item_count === 1 ? '' : 's'})` : '';
  return `Check out "${shelf.name}"${countStr} on Flyleaf — curated by ${curator}.`;
}




/** The API's largest page of shelf items. */
export const SHELF_ITEMS_PAGE = 100;

/**
 * Every item of a shelf, a page of 100 at a time (the API's maximum; the
 * reorder screen asked for 200 in one call and got a 422, audit 11 A-11-012).
 * Stops on a short page, so a stale `total` cannot loop.
 */
export async function fetchAllShelfItems<T>(
  fetchPage: (page: { limit: number; offset: number }) => Promise<{ data: T[]; total: number }>,
): Promise<T[]> {
  const all: T[] = [];
  // A shelf holds at most 1,000 books (PRD §15.6); the bound is a backstop.
  for (let offset = 0; offset <= 1000; offset += SHELF_ITEMS_PAGE) {
    const page = await fetchPage({ limit: SHELF_ITEMS_PAGE, offset });
    all.push(...page.data);
    if (page.data.length < SHELF_ITEMS_PAGE || all.length >= page.total) break;
  }
  return all;
}

/**
 * True when an add failed only because the book is already on the shelf:
 * the state the user asked for, so the optimistic toggle stays on (A-11-025).
 */
export function isAlreadyOnShelf(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'duplicate_shelf_item');
}

/**
 * The existing shelf name a new name collides with (same letters, ignoring
 * case and surrounding space), or null. PRD §6.35: a collision is allowed but
 * warned (audit 11, A-11-026).
 */
export function findNameCollision(name: string, existing: readonly string[]): string | null {
  const key = (s: string) => s.trim().normalize('NFC').toLocaleLowerCase();
  const k = key(name);
  if (!k) return null;
  return existing.find((e) => key(e) === k) ?? null;
}
