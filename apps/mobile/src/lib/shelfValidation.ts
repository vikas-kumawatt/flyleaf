// Shelf Form Validation (SH-02, PRD §15.2)

export interface ShelfFormValues {
  name: string;
  description: string;
  privacy: 'public' | 'followers' | 'private';
  is_ranked: boolean;
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
  } else if (trimmedName.length > 60) {
    errors.name = 'Shelf name cannot exceed 60 characters.';
  }

  if (values.description && values.description.length > 2000) {
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
  if (note.length > 280) {
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
  if (trimmed.length > 60) {
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



