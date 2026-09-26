// Error-reporting port (PV-06). The API's 500 handler reports through this.
//
// An adapter receives context that is ALREADY scrubbed: sanitizeContext
// (telemetry/errors.ts) runs before capture(), outside every adapter, so
// swapping the vendor cannot reintroduce a leaked token or password.
//
//   noop    the default: nothing leaves the process
//   memory  tests
//   sentry  Sentry's store endpoint over plain HTTPS: no vendor SDK needed

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

export interface ErrorReporter {
  /** The provider's event id, or null when nothing was sent. Never throws. */
  capture(error: Error, context: ErrorContext): Promise<string | null>;
}

export class NoopErrorReporter implements ErrorReporter {
  async capture(): Promise<string | null> {
    return null;
  }
}

export class MemoryErrorReporter implements ErrorReporter {
  readonly captured: { error: Error; context: ErrorContext }[] = [];

  async capture(error: Error, context: ErrorContext): Promise<string | null> {
    this.captured.push({ error, context });
    return `memory-${this.captured.length}`;
  }
}

export interface SentryConfig {
  dsn: string;
  environment?: string;
  release?: string;
}

/** https://<publicKey>@<host>/<projectId> -> its parts, or null. */
export function parseSentryDsn(dsn: string): { host: string; projectId: string; publicKey: string } | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split('/').filter(Boolean).at(-1);
    if (!url.username || !url.host || !projectId) return null;
    return { host: url.host, projectId, publicKey: url.username };
  } catch {
    return null;
  }
}

export class SentryErrorReporter implements ErrorReporter {
  readonly #dsn: { host: string; projectId: string; publicKey: string };

  constructor(
    private readonly config: SentryConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {
    const parsed = parseSentryDsn(config.dsn);
    if (!parsed) throw new Error('SENTRY_DSN is not a valid Sentry DSN.');
    this.#dsn = parsed;
  }

  async capture(error: Error, context: ErrorContext): Promise<string | null> {
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const payload = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: 'error',
      environment: this.config.environment,
      release: this.config.release,
      exception: {
        values: [
          {
            type: error.name,
            value: error.message,
            stacktrace: error.stack
              ? { frames: error.stack.split('\n').map((line) => ({ filename: line.trim() })) }
              : undefined,
          },
        ],
      },
      tags: { route: context.route, method: context.method },
      user: context.userId ? { id: context.userId } : undefined,
      extra: { requestId: context.requestId, query: context.query, params: context.params },
    };

    try {
      const res = await this.fetchFn(`https://${this.#dsn.host}/api/${this.#dsn.projectId}/store/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=flyleaf-api/0.0.1, sentry_key=${this.#dsn.publicKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok ? eventId : null;
    } catch {
      // Reporting an error must never become a second error.
      return null;
    }
  }
}
