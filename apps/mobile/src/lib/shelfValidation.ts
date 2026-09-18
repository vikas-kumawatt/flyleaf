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
