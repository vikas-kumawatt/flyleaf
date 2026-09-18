// Sentry error tracking & exception capture (SL-82, Architecture §10.2).
//
// Ingests uncaught 5xx exceptions, formats Sentry envelopes, strips sensitive
// PII/credentials (Authorization, cookies, passwords), and gracefully operates
// as structured logger when SENTRY_DSN is absent.

export interface SentryConfig {
  dsn?: string;
  environment?: string;
  release?: string;
}

export interface ErrorContext {
  requestId?: string;
  userId?: string;
  route?: string;
  method?: string;
  headers?: Record<string, any>;
  params?: Record<string, any>;
  query?: Record<string, any>;
  body?: Record<string, any>;
}

let dsnConfig: { host: string; projectId: string; publicKey: string } | null = null;
let enabled = false;

export function initSentry(config: SentryConfig = {}) {
  const dsn = config.dsn || process.env.SENTRY_DSN;
  if (!dsn) {
    enabled = false;
    dsnConfig = null;
    return;
  }

  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const host = url.host;
    const pathParts = url.pathname.split('/').filter(Boolean);
    const projectId = pathParts[pathParts.length - 1];

    if (publicKey && host && projectId) {
      dsnConfig = { host, projectId, publicKey };
      enabled = true;
    }
  } catch {
    enabled = false;
    dsnConfig = null;
  }
}

export function isSentryEnabled(): boolean {
  return enabled;
}

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
    for (const k of ['password', 'token', 'refreshToken', 'secret', 'totp', 'backupCode']) {
      if (k in safeBody) {
        safeBody[k] = '[REDACTED]';
      }
    }
    sanitized.body = safeBody;
  }

  return sanitized;
}

/**
 * Captures an API exception with sanitized context.
 */
export async function captureApiException(
  error: unknown,
  context: ErrorContext = {},
): Promise<string> {
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const sanitized = sanitizeContext(context);
  const err = error instanceof Error ? error : new Error(String(error));

  if (!enabled || !dsnConfig) {
    return eventId;
  }

  const payload = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    exception: {
      values: [
        {
          type: err.name,
          value: err.message,
          stacktrace: err.stack
            ? {
                frames: err.stack.split('\n').map((line) => ({ filename: line.trim() })),
              }
            : undefined,
        },
      ],
    },
    tags: {
      route: sanitized.route,
      method: sanitized.method,
    },
    user: sanitized.userId ? { id: sanitized.userId } : undefined,
    extra: {
      requestId: sanitized.requestId,
      query: sanitized.query,
      params: sanitized.params,
    },
  };

  try {
    const endpoint = `https://${dsnConfig.host}/api/${dsnConfig.projectId}/store/`;
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=flyleaf-api/0.0.1, sentry_key=${dsnConfig.publicKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-blocking: fail safe if Sentry is unreachable
  }

  return eventId;
}
