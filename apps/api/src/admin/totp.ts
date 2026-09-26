// Two-factor authentication (TOTP) engine (FN-90, PRD §27.5).
//
// Implements RFC 6238 (TOTP) and RFC 4226 (HOTP) using node:crypto HMAC-SHA1
// with zero external dependencies. Supports standard 6-digit codes, 30-second
// steps, base32 secrets, clock-drift tolerance windows, and single-use backup codes.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encodes a buffer into an RFC 4648 base32 string without padding.
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]!;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decodes an RFC 4648 base32 string into a Buffer.
 * Ignores spaces, hyphens, and casing.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_CHARS.indexOf(cleaned[i]!);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${cleaned[i]}`);
    }

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generates a 160-bit (20-byte) cryptographically random secret encoded as 32 base32 characters.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Computes the 6-digit TOTP code for a given base32 secret and timestamp.
 */
export function generateTotp(secret: string, timestampMs: number = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter));

  const key = base32Decode(secret);
  const hmac = createHmac('sha1', key).update(counterBuf).digest();

  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 1_000_000;
  return otp.toString().padStart(6, '0');
}

/**
 * The RFC 6238 time step a 6-digit token matches, or null.
 * Evaluates steps [T - window, T + window] to tolerate ±window clock drift.
 * Login stores the step it accepted and refuses any step at or before it,
 * which is what makes a code single-use (Audit 06, A-06-005).
 */
export function matchTotpStep(
  token: string,
  secret: string,
  opts: { window?: number; timestampMs?: number; stepSeconds?: number } = {},
): number | null {
  if (!/^\d{6}$/.test(token.trim())) return null;
  const normalizedToken = token.trim();

  const window = opts.window ?? 1;
  const timestampMs = opts.timestampMs ?? Date.now();
  const stepSeconds = opts.stepSeconds ?? 30;
  const current = Math.floor(timestampMs / 1000 / stepSeconds);

  for (let offset = -window; offset <= window; offset++) {
    const time = timestampMs + offset * stepSeconds * 1000;
    const expected = generateTotp(secret, time, stepSeconds);
    if (timingSafeEqual(Buffer.from(normalizedToken), Buffer.from(expected))) {
      return current + offset;
    }
  }

  return null;
}

/** Whether a token is valid now; says nothing about replay (see matchTotpStep). */
export function verifyTotp(
  token: string,
  secret: string,
  opts: { window?: number; timestampMs?: number; stepSeconds?: number } = {},
): boolean {
  return matchTotpStep(token, secret, opts) !== null;
}

/**
 * Normalizes a backup code and returns its SHA-256 hex digest.
 */
export function hashBackupCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[\s-]/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generates a set of single-use backup recovery codes formatted as `XXXX-XXXX`.
 * Returns both plain text codes (to display once to user) and SHA-256 hashes (to store in db).
 */
export function generateBackupCodes(count = 8): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];

  for (let i = 0; i < count; i++) {
    const raw = randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    plain.push(formatted);
    hashed.push(hashBackupCode(formatted));
  }

  return { plain, hashed };
}

/**
 * Constructs a standard `otpauth://` URI compatible with Google Authenticator,
 * Apple Passwords, 1Password, and Bitwarden.
 */
export function getOtpAuthUri(opts: { email: string; secret: string; issuer?: string }): string {
  const issuer = opts.issuer ?? 'Flyleaf';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(opts.email)}`;
  return `otpauth://totp/${label}?secret=${opts.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
