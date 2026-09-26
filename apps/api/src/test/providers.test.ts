// PV-08: the provider factory and its guard rails.
//
//   1. createProviders() picks adapters from *_DRIVER, and production refuses
//      a development adapter or missing credentials, naming the variable.
//   2. server.ts and worker.ts really do refuse to start (spawned, with a
//      database that does not exist: the refusal must come first).
//   3. No vendor SDK is imported outside src/providers/.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ConsoleEmailSender,
  DiskObjectStorage,
  ExpoPushSender,
  MemoryEmailSender,
  MemoryObjectStorage,
  MemoryPushSender,
  NoopErrorReporter,
  OpenLibrarySource,
  ProviderConfigError,
  S3ObjectStorage,
  SentryErrorReporter,
  SmtpEmailSender,
  createProviders,
} from '../providers/index.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const API = path.resolve(SRC, '..');

const PROD_OK = {
  NODE_ENV: 'production',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'flyleaf',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  EMAIL_DRIVER: 'smtp',
  SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
  EMAIL_FROM: 'Flyleaf <no-reply@flyleaf.app>',
  PUSH_DRIVER: 'expo',
};

const without = (env: Record<string, string>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)));

describe('createProviders', () => {
  it('development defaults: disk, console, memory push, noop errors, Open Library', () => {
    const p = createProviders({});
    expect(p.storage).toBeInstanceOf(DiskObjectStorage);
    expect(p.mailer).toBeInstanceOf(ConsoleEmailSender);
    expect(p.push).toBeInstanceOf(MemoryPushSender);
    expect(p.errors).toBeInstanceOf(NoopErrorReporter);
    expect(p.catalog).toBeInstanceOf(OpenLibrarySource);
  });

  it('each driver variable selects its adapter', () => {
    const p = createProviders({ STORAGE_DRIVER: 'memory', EMAIL_DRIVER: 'memory' });
    expect(p.storage).toBeInstanceOf(MemoryObjectStorage);
    expect(p.mailer).toBeInstanceOf(MemoryEmailSender);
  });

  it('a complete production configuration builds the real adapters; errors default to noop', () => {
    const p = createProviders(PROD_OK);
    expect(p.storage).toBeInstanceOf(S3ObjectStorage);
    expect(p.mailer).toBeInstanceOf(SmtpEmailSender);
    expect(p.push).toBeInstanceOf(ExpoPushSender);
    expect(p.errors).toBeInstanceOf(NoopErrorReporter);
    expect(createProviders({ ...PROD_OK, ERROR_DRIVER: 'sentry', SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1' }).errors)
      .toBeInstanceOf(SentryErrorReporter);
  });

  it('production refuses an unset driver, naming it', () => {
    for (const name of ['STORAGE_DRIVER', 'EMAIL_DRIVER', 'PUSH_DRIVER']) {
      expect(() => createProviders(without(PROD_OK, name)), name).toThrow(new RegExp(`${name} must be set`));
    }
  });

  it('production refuses every development adapter', () => {
    const cases: [string, string][] = [
      ['STORAGE_DRIVER', 'disk'],
      ['STORAGE_DRIVER', 'memory'],
      ['EMAIL_DRIVER', 'console'],
      ['EMAIL_DRIVER', 'memory'],
      ['PUSH_DRIVER', 'memory'],
      ['ERROR_DRIVER', 'memory'],
    ];
    for (const [name, value] of cases) {
      expect(() => createProviders({ ...PROD_OK, [name]: value }), `${name}=${value}`).toThrow(
        /development adapter/,
      );
    }
  });

  it('refuses missing credentials, naming each missing variable', () => {
    expect(() => createProviders(without(PROD_OK, 'S3_BUCKET', 'S3_SECRET_ACCESS_KEY'))).toThrow(
      /STORAGE_DRIVER=s3 needs S3_BUCKET, S3_SECRET_ACCESS_KEY/,
    );
    expect(() => createProviders(without(PROD_OK, 'SMTP_URL'))).toThrow(/EMAIL_DRIVER=smtp needs SMTP_URL/);
    expect(() => createProviders({ ...PROD_OK, ERROR_DRIVER: 'sentry' })).toThrow(/needs SENTRY_DSN/);
    expect(() => createProviders({ ...PROD_OK, ERROR_DRIVER: 'sentry', SENTRY_DSN: 'nope' })).toThrow(/valid Sentry DSN/);
    // Blank is missing.
    expect(() => createProviders({ ...PROD_OK, S3_BUCKET: '  ' })).toThrow(/needs S3_BUCKET/);
  });

  it('credentials are required outside production too: s3 without a bucket is a mistake anywhere', () => {
    expect(() => createProviders({ STORAGE_DRIVER: 's3' })).toThrow(ProviderConfigError);
  });

  it('refuses an unknown driver', () => {
    expect(() => createProviders({ STORAGE_DRIVER: 'gcs' })).toThrow(/STORAGE_DRIVER=gcs is not one of: disk, memory, s3/);
  });
});

describe('processes refuse to start on bad provider config (before the database)', () => {
  const run = promisify(execFile);

  async function boot(entry: string, env: Record<string, string>) {
    const childEnv: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
      if (process.env[k]) childEnv[k] = process.env[k];
    }
    Object.assign(childEnv, {
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(48),
      // Nothing listens here: reaching the database would hang on retries.
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      ...env,
    });
    const started = Date.now();
    try {
      await run(process.execPath, ['--import', 'tsx', path.join(SRC, entry)], { cwd: API, env: childEnv, timeout: 30_000 });
      return { code: 0, output: '', ms: Date.now() - started };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}`, ms: Date.now() - started };
    }
  }

  it('the API exits naming the problem, without waiting for the database', async () => {
    const r = await boot('server.ts', { ...PROD_OK, STORAGE_DRIVER: 'disk' });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('STORAGE_DRIVER=disk is a development adapter');
    // waitForDb would retry for 15 s first.
    expect(r.ms).toBeLessThan(14_000);
  }, 40_000);

  it('the worker does the same', async () => {
    const r = await boot('worker.ts', without(PROD_OK, 'SMTP_URL'));
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('EMAIL_DRIVER=smtp needs SMTP_URL');
    expect(r.ms).toBeLessThan(14_000);
  }, 40_000);
});

// ---------------------------------------------------------------- boundary

/**
 * Vendor SDKs: swapping a provider must never mean editing app code. This is
 * the ESLint `no-restricted-imports` rule PV-08 asked for, as a test: the
 * repository has no ESLint, and this runs in CI with no new dependency.
 */
const VENDOR = [
  /^@aws-sdk\//,
  /^@smithy\//,
  /^@sentry\//,
  /^nodemailer$/,
  /^expo-server-sdk$/,
  /^@google-cloud\//,
  /^@azure\//,
  /^firebase-admin$/,
  /^cloudinary$/,
  /^resend$/,
  /^postmark$/,
  /^@sendgrid\//,
  /^mailgun/,
  /^@aws-sdk$/,
];

function vendorImports(source: string): string[] {
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]!);
  return specifiers.filter((s) => VENDOR.some((v) => v.test(s)));
}

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

describe('provider boundary', () => {
  it('the check itself finds every import form', () => {
    const sample = [
      "import { S3Client } from '@aws-sdk/client-s3';",
      "import nodemailer from 'nodemailer';",
      "const sdk = await import('@sentry/node');",
      "import 'expo-server-sdk';",
      "const x = require('cloudinary');",
      "import { sql } from 'drizzle-orm';",
    ].join('\n');
    expect(vendorImports(sample)).toEqual(['@aws-sdk/client-s3', 'nodemailer', '@sentry/node', 'expo-server-sdk', 'cloudinary']);
  });

  it('no vendor SDK is imported outside src/providers/ (tests excepted)', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => {
        const rel = path.relative(SRC, f).split(path.sep);
        return rel[0] !== 'providers' && rel[0] !== 'test';
      })
      .flatMap((f) => vendorImports(fs.readFileSync(f, 'utf8')).map((s) => `${path.relative(SRC, f)}: ${s}`));
    expect(offenders).toEqual([]);
  });

  it('the providers do use them (the check is looking in the right place)', () => {
    const inside = tsFiles(path.join(SRC, 'providers')).flatMap((f) => vendorImports(fs.readFileSync(f, 'utf8')));
    expect(inside).toEqual(expect.arrayContaining(['@aws-sdk/client-s3', 'nodemailer']));
  });
});
