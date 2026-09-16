// ISBN detection, validation, and conversion (FN-42, PRD §14.2, §14.4).

/** Strips spaces, hyphens, and whitespace, uppercasing any 'X' check digit. */
export function cleanIsbn(raw: string): string {
  return raw.replace(/[^0-9Xx]/g, '').toUpperCase();
}

/**
 * Validates a 10-character ISBN using modulo-11 checksum.
 * Formula: sum_{i=0}^9 (d_i * (10 - i)) mod 11 === 0, with 'X' representing 10.
 */
export function isValidIsbn10(str: string): boolean {
  if (!/^[0-9]{9}[0-9X]$/.test(str)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(str[i]) * (10 - i);
  }
  const lastChar = str[9];
  sum += lastChar === 'X' ? 10 : Number(lastChar);

  return sum % 11 === 0;
}

/**
 * Validates a 13-character ISBN using modulo-10 checksum with alternating weights (1, 3).
 * Formula: sum_{i=0}^12 (d_i * (i % 2 === 0 ? 1 : 3)) mod 10 === 0.
 */
export function isValidIsbn13(str: string): boolean {
  if (!/^[0-9]{13}$/.test(str)) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(str[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(str[12]);
}

/**
 * Converts a valid ISBN-10 to its 13-digit EAN counterpart (978 prefix).
 */
export function isbn10ToIsbn13(isbn10: string): string {
  const core = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${core}${check}`;
}

/**
 * Converts an ISBN-13 beginning with 978 to its 10-digit counterpart.
 * Returns null if the ISBN-13 does not start with 978 (e.g. 979 prefixes have no 10-digit form).
 */
export function isbn13ToIsbn10(isbn13: string): string | null {
  if (!isbn13.startsWith('978')) return null;

  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(core[i]) * (10 - i);
  }
  const remainder = (11 - (sum % 11)) % 11;
  const checkChar = remainder === 10 ? 'X' : String(remainder);
  return `${core}${checkChar}`;
}

export type DetectedIsbn = {
  isbn10?: string;
  isbn13?: string;
  canonical: string;
};

/**
 * Detects if a query looks like an ISBN-10 or ISBN-13.
 * Returns both forms (where convertible) if valid, or null if not an ISBN.
 */
export function detectIsbn(query: string): DetectedIsbn | null {
  const cleaned = cleanIsbn(query);
  if (cleaned.length !== 10 && cleaned.length !== 13) {
    return null;
  }

  if (cleaned.length === 10 && isValidIsbn10(cleaned)) {
    return {
      isbn10: cleaned,
      isbn13: isbn10ToIsbn13(cleaned),
      canonical: cleaned,
    };
  }

  if (cleaned.length === 13 && isValidIsbn13(cleaned)) {
    const isbn10 = isbn13ToIsbn10(cleaned);
    return {
      isbn13: cleaned,
      ...(isbn10 ? { isbn10 } : {}),
      canonical: cleaned,
    };
  }

  return null;
}
