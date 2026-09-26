// Common passwords (FN-61, PRD §6.3, §25.2, §42 #1; D-04-2).
// Passwords on this list are rejected regardless of length.
//
// The list is bundled, never fetched: signup must not depend on a third party
// or send anything about a password off the machine (D-04-2). It is the
// SecLists top-100k list filtered to the 10-character minimum
// (common-passwords.data.ts, regenerate with scripts/generate-common-passwords.mjs),
// plus the hand-picked entries this file started with.

import { SECLISTS_COMMON_PASSWORDS } from './common-passwords.data.js';

const HAND_PICKED = [
  '1234567890',
  '12345678901',
  '123456789012',
  'password123',
  'password1234',
  'password12345',
  'qwertyuiop',
  'qwertyuiop1',
  'qwerty12345',
  'iloveyou123',
  'iloveyou1234',
  'letmein1234',
  'letmein12345',
  'welcome1234',
  'welcome12345',
  'admin123456',
  'administrator',
  'monkey12345',
  'dragon12345',
  'master12345',
  'trustno1123',
  'sunshine123',
  'princess123',
  'football123',
  'baseball123',
  'superman123',
  'shadow12345',
  'secret12345',
  'passcode123',
  'changeme123',
  'correcthorse',
];

/** The form both the list and a candidate are compared in: NFC like the hash, case and separators ignored. */
function normaliseForList(password: string): string {
  return password.normalize('NFC').toLowerCase().replace(/[\s\-_.]/g, '');
}

const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  ...SECLISTS_COMMON_PASSWORDS.split('\n'),
  ...HAND_PICKED.map(normaliseForList),
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(normaliseForList(password));
}
