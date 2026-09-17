// Auth validation, password strength, and reserved username rules (PRD §6.3, §6.7, SL-22).

export const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'flyleaf',
  'support',
  'help',
  'root',
  'api',
  'staff',
  'moderator',
  'mod',
  'official',
  'system',
  'about',
  'legal',
  'terms',
  'privacy',
  'security',
  'billing',
  'press',
  'contact',
  'null',
  'undefined',
  'guest',
  'anonymous',
  'me',
  'you',
  'everyone',
]);

const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;

export interface UsernameValidationResult {
  valid: boolean;
  error?: string;
}

export function validateUsername(username: string): UsernameValidationResult {
  const normalized = username.trim().toLowerCase();
  if (normalized.length === 0) {
    return { valid: false, error: 'Username is required.' };
  }
  if (normalized.length < 3) {
    return { valid: false, error: 'Must be at least 3 characters.' };
  }
  if (normalized.length > 20) {
    return { valid: false, error: 'Must be at most 20 characters.' };
  }
  if (!USERNAME_REGEX.test(normalized)) {
    return { valid: false, error: 'Use lowercase letters, numbers, and underscores only.' };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, error: 'That username is reserved.' };
  }
  return { valid: true };
}

export function validatePassword(password: string): { valid: boolean; error?: string; score: number } {
  if (!password || password.length === 0) {
    return { valid: false, error: 'Password is required.', score: 0 };
  }
  if (password.length < 10) {
    return { valid: false, error: 'Password must be at least 10 characters.', score: 1 };
  }

  // Simple entropy/strength score: 1 (weak) to 4 (strong)
  let score = 1;
  if (password.length >= 12) score++;
  if (/[0-9]/.test(password) && /[a-zA-Z]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password) || password.length >= 16) score++;

  return { valid: true, score: Math.min(4, score) };
}

export function validateDob(dobStr: string): { valid: boolean; error?: string } {
  if (!dobStr || !/^\d{4}-\d{2}-\d{2}$/.test(dobStr)) {
    return { valid: false, error: 'Use YYYY-MM-DD for date of birth.' };
  }
  const dob = new Date(dobStr);
  if (Number.isNaN(dob.getTime())) {
    return { valid: false, error: 'Invalid date.' };
  }
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  if (age < 13) {
    return { valid: false, error: 'You must be at least 13 years old to use Flyleaf.' };
  }
  return { valid: true };
}
