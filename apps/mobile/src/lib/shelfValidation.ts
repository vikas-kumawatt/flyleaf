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

