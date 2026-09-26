// API Contract and Schema Verification Tests (FN-80, FN-81, Architecture §6).
//
// Asserts:
//   1. openapi.yaml on disk matches the Fastify route schemas (catches contract drift).
//   2. All Phase 0–1 endpoints are covered in the spec.
//   3. Typed FlyleafClient works with the API surface.

import diagnostics from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import YAML from 'yaml';
import Fastify, { type FastifyInstance } from 'fastify';

import { buildOpenApiSpec } from '../contract/generate.js';
import { FlyleafClient, FlyleafApiError } from '../../../../packages/api-client/dist/index.js';
import { readingRoutes, ReadingService } from '../reading/index.js';
import { identityRoutes, IdentityService } from '../identity/index.js';
import { catalogRoutes, CatalogService } from '../catalog/index.js';
import { freshDrizzle } from './pg.js';
import { MemoryCache, PgRateLimiter, type Db } from '../platform/index.js';
import { works } from '../db/schema.js';
import { ApiError } from '../http.js';
import { buildApp, registerCoreHooks } from '../app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../../..');
const OPENAPI_PATH = path.join(ROOT, 'openapi.yaml');

describe('API Contract — openapi.yaml (FN-80)', () => {
  it('openapi.yaml exists at repo root', () => {
    expect(fs.existsSync(OPENAPI_PATH)).toBe(true);
  });

  it('openapi.yaml matches Fastify route schemas (0 contract drift)', async () => {
    const spec = await buildOpenApiSpec();
    const diskContent = fs.readFileSync(OPENAPI_PATH, 'utf8').replace(/\r\n/g, '\n').trim();
    const generatedContent = YAML.stringify(spec, { indent: 2 }).replace(/\r\n/g, '\n').trim();

    expect(diskContent).toBe(generatedContent);
  });

  it('every route buildApp serves is in openapi.yaml, unless its schema hides it (Audit 05)', async () => {
    // The app production runs, with every optional service present. A plugin
    // missing from the spec (as the feed and exports once were) shows up here
    // as a served route with no spec entry. Routes are captured the way
    // bench/routes.ts captures them: an onRoute hook attached through the
    // fastify.initialization channel, before any plugin registers.
    const served = new Set<string>();
    const hidden = new Set<string>();
    const onInit = (msg: unknown) => {
      (msg as { fastify: FastifyInstance }).fastify.addHook('onRoute', (r) => {
        const methods = Array.isArray(r.method) ? r.method : [r.method];
        for (const m of methods) {
          if (m === 'HEAD' || m === 'OPTIONS') continue;
          const key = `${m.toLowerCase()} ${r.url.replace(/^\/v1(?=\/)/, '').replace(/:([A-Za-z]+)/g, '{$1}')}`;
          if ((r.schema as { hide?: boolean } | undefined)?.hide) hidden.add(key);
          else served.add(key);
        }
      });
    };
    diagnostics.channel('fastify.initialization').subscribe(onInit);
    try {
      const app = await buildApp({
        db: {} as Db,
        identity: {} as never,
        catalog: {} as never,
        reading: {} as never,
        // Uploads and exports are served only with a storage (PV-01).
        storage: {} as never,
        limiter: { allow: async () => true },
      });
      await app.close();
    } finally {
      diagnostics.channel('fastify.initialization').unsubscribe(onInit);
    }

    const doc = YAML.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));
    const inSpec = new Set(
      Object.entries(doc.paths as Record<string, Record<string, unknown>>).flatMap(([p, ops]) =>
        Object.keys(ops).map((m) => `${m} ${p}`),
      ),
    );
    expect(served.size).toBeGreaterThan(100);
    expect([...served].filter((k) => !inSpec.has(k))).toEqual([]);
    // Hidden: exactly the server-rendered HTML, never a JSON route. The two
    // share pages (Audit 05), and the admin console's pages and form posts
    // (Audit 06): they render HTML or redirect, and left in the spec they took
    // the path keys of the REST /v1/admin/audit-log and /v1/admin/merges, whose
    // schemas then went missing (A-06-019). Listed by name so a JSON route
    // hidden by mistake still fails here.
    expect([...hidden].sort()).toEqual([
      'get /admin/audit-log',
      'get /admin/catalog/maturity',
      'get /admin/ingest',
      'get /admin/login',
      'get /admin/merges',
      'get /shelf/{id}',
      'get /u/{username}/shelves/{slug}',
      'post /admin/login',
      'post /admin/logout',
    ]);
  });

  it('declares OpenAPI 3.1.0 with BearerAuth security scheme', async () => {
    const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
    const doc = YAML.parse(raw);

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Flyleaf API');
    expect(doc.components.securitySchemes.BearerAuth).toBeDefined();
    expect(doc.components.securitySchemes.BearerAuth.type).toBe('http');
    expect(doc.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  });

  it('defines all Phase 0–1 routes in the spec', () => {
    const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
    const doc = YAML.parse(raw);
    const paths = Object.keys(doc.paths);

    expect(paths).toContain('/auth/register');
    expect(paths).toContain('/auth/login');
    expect(paths).toContain('/auth/refresh');
    expect(paths).toContain('/auth/logout');
    expect(paths).toContain('/auth/verify-email');
    expect(paths).toContain('/auth/resend-verification');
    expect(paths).toContain('/auth/forgot-password');
    expect(paths).toContain('/auth/reset-password');
    expect(paths).toContain('/auth/sessions');
    expect(paths).toContain('/auth/sessions/{id}');
    expect(paths).toContain('/auth/logout-all');
    expect(paths).toContain('/me');
    expect(paths).toContain('/users/{id}');
    expect(paths).toContain('/search');
    expect(paths).toContain('/works/{id}');
    expect(paths).toContain('/editions/isbn/{isbn}');
    expect(paths).toContain('/reads');
    expect(paths).toContain('/reads/{id}');
    expect(paths).toContain('/users/{id}/reads');
    expect(paths).toContain('/reads/{id}/progress');
    expect(paths).toContain('/healthz');
    expect(paths).toContain('/readyz');
  });
});

describe('Typed FlyleafClient (FN-81)', () => {
  let db: Db;
  let clientDb: import('@electric-sql/pglite').PGlite;
  let app: FastifyInstance;
  let client: FlyleafClient;
  let currentToken: string | null = null;
  const WORK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    clientDb = fresh.client;

    await db.insert(works).values({
      id: WORK_ID,
      title: 'Neuromancer',
    });

    const limiter = new PgRateLimiter(db);
    const cache = new MemoryCache(100);
    const identityService = new IdentityService(db, limiter);
    const catalogService = new CatalogService(db, cache);
    const readingService = new ReadingService(db);

    app = Fastify();
    registerCoreHooks(app, {
      identityLookup: (token) => identityService.lookup(token),
    });

    await app.register(identityRoutes(identityService), { prefix: '/v1' });
    await app.register(catalogRoutes(catalogService), { prefix: '/v1' });
    await app.register(readingRoutes(readingService), { prefix: '/v1' });
    await app.ready();

    // Wire client to route through app.inject
    client = new FlyleafClient({
      baseUrl: 'http://localhost/v1',
      getToken: () => currentToken,
      fetch: async (url, init) => {
        const u = new URL(url.toString());
        const res = await app.inject({
          method: (init?.method as any) ?? 'GET',
          url: `${u.pathname}${u.search}`,
          headers: init?.headers as any,
          payload: init?.body ? String(init.body) : undefined,
        });

        return {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => res.payload,
        } as unknown as Response;
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await clientDb?.close();
  });

  it('fetches a work using typed getWork()', async () => {
    const work = await client.getWork(WORK_ID);
    expect(work.id).toBe(WORK_ID);
    expect(work.title).toBe('Neuromancer');
  });

  it('handles 404 by throwing FlyleafApiError', async () => {
    try {
      await client.getWork('00000000-0000-0000-0000-000000000000');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FlyleafApiError);
      const apiErr = err as FlyleafApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe('not_found');
    }
  });

  it('performs catalog search using typed search()', async () => {
    const results = await client.search('Neuro');
    expect(Array.isArray(results)).toBe(true);
  });

  it('manages sessions using typed getSessions(), revokeSession(), and logoutAll()', async () => {
    // 1. Register a user via typed client
    const auth = await client.register({
      email: 'client_user@example.com',
      username: 'client_user',
      password: 'goodpassword123',
      dateOfBirth: '1995-01-01',
    });
    expect(auth.accessToken).toBeDefined();
    currentToken = auth.accessToken;

    // 2. Fetch active sessions via typed getSessions()
    const sessions = await client.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBeDefined();

    // 3. Revoke session via typed revokeSession()
    const revokeRes = await client.revokeSession(sessions[0]!.id);
    expect(revokeRes.status).toBe('ok');

    // 4. Session list is now empty
    const remaining = await client.getSessions();
    expect(remaining).toHaveLength(0);

    // 5. Test logoutAll()
    const logoutRes = await client.logoutAll();
    expect(logoutRes.status).toBe('ok');
    currentToken = null;
  });
});
