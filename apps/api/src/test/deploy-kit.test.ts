// The deploy kit (deploy/) against the code it deploys. Two files there
// restate facts that live in this codebase, and would drift silently:
//
// - deploy/config/catalog-tables.txt decides which tables' ROWS leave the
//   laptop (Export-Catalog.ps1) and which are left out of the 6-hourly
//   backup. A name that is not a table, or a catalog table that grows a
//   user reference, is a privacy or data-loss bug in a shell script that no
//   other test would notice.
// - deploy/env.production.example is the production environment. If a
//   provider gains a required variable, production would refuse to start
//   (PV-08) on the first deploy after it.
//
// The scripts themselves are tested end to end by deploy/test/ (Docker).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema.js';
import { createProviders } from '../providers/index.js';
import { resolveJwtSecret, parseTrustProxy } from '../platform/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const tables = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((t) => getTableConfig(t));
const byName = new Map(tables.map((t) => [t.name, t]));

const catalogList = read('deploy/config/catalog-tables.txt')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [name, flag] = l.split(/\s+/);
    return { name: name!, optional: flag === 'optional' };
  });

describe('deploy/config/catalog-tables.txt', () => {
  it('names only real tables, once each', () => {
    const names = catalogList.map((c) => c.name);
    expect(names.filter((n) => !byName.has(n))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no catalog table references a user-owned table', () => {
    const catalog = new Set(catalogList.map((c) => c.name));
    const outward = catalogList.flatMap(({ name }) =>
      byName.get(name)!.foreignKeys.map((fk) => {
        const target = getTableConfig(fk.reference().foreignTable).name;
        return catalog.has(target) ? null : `${name} -> ${target}`;
      }),
    ).filter(Boolean);
    expect(outward).toEqual([]);
  });

  it('the only user-id column in the catalog is works.created_by_user_id, and nothing writes it yet', () => {
    // A user id in a catalog row would travel to the server with the catalog.
    // This one has no foreign key and no writer today; if a feature starts
    // writing it, the transfer must decide what to do with those rows first.
    const userColumns = catalogList.flatMap(({ name }) =>
      byName.get(name)!.columns.filter((c) => /user_id$|^user/.test(c.name)).map((c) => `${name}.${c.name}`),
    );
    expect(userColumns).toEqual(['works.created_by_user_id']);
  });

  it('the user-data side holds the tables people write', () => {
    const catalog = new Set(catalogList.map((c) => c.name));
    for (const t of ['users', 'profiles', 'reads', 'reviews', 'shelves', 'follows', 'activity', 'events', 'work_stats', 'work_merges']) {
      expect(byName.has(t), t).toBe(true);
      expect(catalog.has(t), t).toBe(false);
    }
  });

  it('raw_payloads is the one optional table', () => {
    expect(catalogList.filter((c) => c.optional).map((c) => c.name)).toEqual(['raw_payloads']);
  });
});

/** The template as bash would read it: KEY='literal' or KEY="with ${OTHER}". */
function parseEnvTemplate(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(?:'([^']*)'|"([^"]*)")\s*$/.exec(line);
    if (!m) continue;
    const value = m[2] ?? m[3]!.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k: string) => env[k] ?? '');
    env[m[1]!] = value;
  }
  return env;
}

describe('deploy/env.production.example', () => {
  const template = parseEnvTemplate(read('deploy/env.production.example'));
  // What configure-env.sh fills in: a value for every <placeholder>.
  const filled = Object.fromEntries(
    Object.entries(template).map(([k, v]) => [k, v.replace(/<[^>@]*>/g, 'x'.repeat(48))]),
  );
  const derived = parseEnvTemplate(
    read('deploy/env.production.example').replace(/<[^>@]*>/g, 'x'.repeat(48)),
  );

  it('is a production environment the providers accept (PV-08 would refuse a gap)', () => {
    expect(filled.NODE_ENV).toBe('production');
    expect(() => createProviders(derived)).not.toThrow();
    const providers = createProviders(derived);
    expect(providers.storage.constructor.name).toBe('S3ObjectStorage');
    expect(providers.mailer.constructor.name).toBe('SmtpEmailSender');
    expect(providers.push.constructor.name).toBe('ExpoPushSender');
  });

  it('has a JWT_SECRET slot the API accepts once filled, and refuses unfilled', () => {
    expect(() => resolveJwtSecret('production', template.JWT_SECRET)).toThrow(/JWT_SECRET/);
    expect(resolveJwtSecret('production', filled.JWT_SECRET)).toHaveLength(48);
  });

  it('trusts exactly loopback, where Caddy is', () => {
    expect(parseTrustProxy(template.TRUST_PROXY)).toBe('127.0.0.1');
  });

  it('derives every public URL from the one host variable', () => {
    expect(derived.APP_BASE_URL).toBe(`https://${derived.FLYLEAF_HOST}`);
    expect(derived.S3_ENDPOINT).toBe(`https://${derived.FLYLEAF_HOST}`);
    expect(derived.S3_FORCE_PATH_STYLE).toBe('true');
    expect(derived.DATABASE_URL).toBe(`postgres://flyleaf:${derived.POSTGRES_PASSWORD}@127.0.0.1:5432/flyleaf`);
    expect(derived.HOST).toBe('127.0.0.1');
  });

  it('pins its images and the bucket path cannot shadow an API route', () => {
    expect(template.POSTGRES_IMAGE).toMatch(/^postgres:18[-.]/);
    expect(template.MINIO_IMAGE).not.toMatch(/:latest$/);
    expect(template.S3_BUCKET).not.toMatch(/^(v1|admin|healthz|readyz|verify-email|reset-password|\.well-known|u|s|book|@.*)$/);
  });
});
