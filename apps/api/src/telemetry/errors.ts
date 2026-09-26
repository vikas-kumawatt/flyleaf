// API error reporting (SL-82, Architecture §10.2, PV-06).
//
// The 500 handler reports through an injected ErrorReporter (providers/
// errors). The scrubbing lives HERE, outside every adapter: whatever vendor
// is configured only ever sees the sanitized context.

import type { ErrorContext, ErrorReporter } from '../providers/errors/index.js';

export type { ErrorContext } from '../providers/errors/index.js';

/**
 * Sanitizes headers and payload to prevent token/cookie/credential leakage.
 */
export function sanitizeContext(context: ErrorContext): ErrorContext {
  const sanitized = { ...context };

  if (sanitized.headers) {
    const safeHeaders: Record<string, any> = {};
    for (const [k, v] of Object.entries(sanitized.headers)) {
      const lower = k.toLowerCase();
      if (
        lower === 'authorization' ||
        lower === 'cookie' ||
        lower === 'set-cookie' ||
        lower.includes('secret') ||
        lower.includes('token') ||
        lower.includes('key')
      ) {
        safeHeaders[k] = '[REDACTED]';
      } else {
        safeHeaders[k] = v;
      }
    }
    sanitized.headers = safeHeaders;
  }

  if (sanitized.body && typeof sanitized.body === 'object') {
    const safeBody = { ...sanitized.body };
    for (const k of ['password', 'newPassword', 'token', 'refreshToken', 'secret', 'totp', 'backupCode']) {
      if (k in safeBody) {
        safeBody[k] = '[REDACTED]';
      }
    }
    sanitized.body = safeBody;
  }

  // The export download link carries its token in the query (Audit 05).
  if (sanitized.query && typeof sanitized.query === 'object') {
    const safeQuery = { ...sanitized.query };
    for (const k of Object.keys(safeQuery)) {
      if (/token|secret|password/i.test(k)) safeQuery[k] = '[REDACTED]';
    }
    sanitized.query = safeQuery;
  }

  return sanitized;
}

/** Scrub, then report. Never throws: the caller is already handling a failure. */
export async function reportApiError(
  reporter: ErrorReporter,
  error: unknown,
  context: ErrorContext = {},
): Promise<string | null> {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    return await reporter.capture(err, sanitizeContext(context));
  } catch {
    return null;
  }
}
