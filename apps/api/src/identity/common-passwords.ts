// Top common passwords list (FN-61, PRD §25.1).
// Passwords on this list are rejected regardless of length.

const COMMON_PASSWORDS = new Set([
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
]);

export function isCommonPassword(password: string): boolean {
  const norm = password.toLowerCase().replace(/[\s\-_.]/g, '');
  return COMMON_PASSWORDS.has(norm);
}
