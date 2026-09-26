// The provider factory (PV-08). The ONE place that reads *_DRIVER and vendor
// credentials, and the one place that decides which adapter the API and the
// worker use. Swapping a provider = one adapter file + one env line.
//
// Production refuses to start rather than run on a development adapter or
// half a set of credentials: a console mailer or a local-disk store in
// production does not fail loudly, it silently loses mail and files.

import { DiskObjectStorage, MemoryObjectStorage, S3ObjectStorage, type ObjectStorage } from './storage/index.js';
import { ConsoleEmailSender, MemoryEmailSender, SmtpEmailSender, type EmailSender } from './email/index.js';
import { ExpoPushSender, MemoryPushSender, type PushSender } from './push/index.js';
import { MemoryErrorReporter, NoopErrorReporter, SentryErrorReporter, type ErrorReporter } from './errors/index.js';
import { OpenLibrarySource, type CatalogSource } from './catalog/index.js';
import { outbound } from '../platform/outbound.js';

export * from './storage/index.js';
export * from './email/index.js';
export * from './push/index.js';
export * from './errors/index.js';
export * from './catalog/index.js';

type Env = Record<string, string | undefined>;

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

const isProduction = (env: Env) => env.NODE_ENV === 'production';

/**
 * The driver named by `name`. Unset: `devDefault` outside production; in
 * production `prodDefault` if the port has a safe one (error reporting's
 * noop), otherwise a refusal to start.
 */
function driver<T extends string>(
  env: Env,
  name: string,
  allowed: readonly T[],
  devDefault: T,
  prodAllowed: readonly T[],
  prodDefault?: T,
): T {
  const raw = env[name]?.trim();
  if (!raw) {
    if (isProduction(env)) {
      if (prodDefault) return prodDefault;
      throw new ProviderConfigError(`${name} must be set when NODE_ENV=production (one of: ${prodAllowed.join(', ')}).`);
    }
    return devDefault;
  }
  if (!allowed.includes(raw as T)) {
    throw new ProviderConfigError(`${name}=${raw} is not one of: ${allowed.join(', ')}.`);
  }
  if (isProduction(env) && !prodAllowed.includes(raw as T)) {
    throw new ProviderConfigError(
      `${name}=${raw} is a development adapter and cannot run when NODE_ENV=production (use: ${prodAllowed.join(', ')}).`,
    );
  }
  return raw as T;
}

function required(env: Env, driverVar: string, value: string, names: string[]): Record<string, string> {
  const missing = names.filter((n) => !env[n]?.trim());
  if (missing.length) {
    throw new ProviderConfigError(`${driverVar}=${value} needs ${missing.join(', ')}.`);
  }
  return Object.fromEntries(names.map((n) => [n, env[n]!.trim()]));
}

export function createStorage(env: Env = process.env): ObjectStorage {
  const kind = driver(env, 'STORAGE_DRIVER', ['disk', 'memory', 's3'] as const, 'disk', ['s3'] as const);
  switch (kind) {
    case 'memory':
      return new MemoryObjectStorage({ publicUrl: env.STORAGE_PUBLIC_URL, secret: env.STORAGE_SIGNING_SECRET });
    case 'disk':
      return new DiskObjectStorage({
        // Where the phone reaches this API: set it to the LAN address for a device.
        publicUrl: env.STORAGE_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`,
        secret: env.STORAGE_SIGNING_SECRET,
        baseDir: env.STORAGE_DISK_DIR,
      });
    case 's3': {
      const c = required(env, 'STORAGE_DRIVER', kind, ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
      return new S3ObjectStorage({
        bucket: c.S3_BUCKET!,
        region: c.S3_REGION!,
        accessKeyId: c.S3_ACCESS_KEY_ID!,
        secretAccessKey: c.S3_SECRET_ACCESS_KEY!,
        endpoint: env.S3_ENDPOINT?.trim() || undefined,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      });
    }
  }
}

export function createMailer(env: Env = process.env): EmailSender {
  const kind = driver(env, 'EMAIL_DRIVER', ['console', 'memory', 'smtp'] as const, 'console', ['smtp'] as const);
  switch (kind) {
    case 'console':
      return new ConsoleEmailSender();
    case 'memory':
      return new MemoryEmailSender();
    case 'smtp': {
      const c = required(env, 'EMAIL_DRIVER', kind, ['SMTP_URL', 'EMAIL_FROM']);
      return SmtpEmailSender.fromUrl(c.SMTP_URL!, c.EMAIL_FROM!);
    }
  }
}

/** Nothing sends push until SO-30; the driver is still checked at startup. */
export function createPush(env: Env = process.env): PushSender {
  const kind = driver(env, 'PUSH_DRIVER', ['memory', 'expo'] as const, 'memory', ['expo'] as const);
  // EXPO_ACCESS_TOKEN is optional: Expo requires it only when "enhanced push
  // security" is switched on for the project.
  return kind === 'expo' ? new ExpoPushSender(env.EXPO_ACCESS_TOKEN?.trim() || undefined) : new MemoryPushSender();
}

export function createErrorReporter(env: Env = process.env): ErrorReporter {
  const kind = driver(env, 'ERROR_DRIVER', ['noop', 'memory', 'sentry'] as const, 'noop', ['noop', 'sentry'] as const, 'noop');
  switch (kind) {
    case 'noop':
      return new NoopErrorReporter();
    case 'memory':
      return new MemoryErrorReporter();
    case 'sentry': {
      const c = required(env, 'ERROR_DRIVER', kind, ['SENTRY_DSN']);
      try {
        return new SentryErrorReporter({
          dsn: c.SENTRY_DSN!,
          environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || 'development',
          release: env.SENTRY_RELEASE?.trim() || undefined,
        });
      } catch (err) {
        throw new ProviderConfigError((err as Error).message);
      }
    }
  }
}

/**
 * Open Library, through the one shared OutboundClient: its rate limit and
 * breaker are shared with every other caller (architecture §5.2). No driver
 * variable: it is the only source whose data we may store.
 */
export function createCatalogSource(): CatalogSource {
  return new OpenLibrarySource(outbound);
}

export interface Providers {
  storage: ObjectStorage;
  mailer: EmailSender;
  push: PushSender;
  errors: ErrorReporter;
  catalog: CatalogSource;
}

/**
 * Every provider, from the environment. The API (server.ts) and the worker
 * (worker.ts) call this FIRST, before the database: a production process with
 * a development adapter or missing credentials exits at once with a message
 * naming the variable, instead of starting and failing on the first upload.
 */
export function createProviders(env: Env = process.env): Providers {
  return {
    storage: createStorage(env),
    mailer: createMailer(env),
    push: createPush(env),
    errors: createErrorReporter(env),
    catalog: createCatalogSource(),
  };
}
