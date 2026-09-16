// API Contract and Schema Verification Tests (FN-80, FN-81, Architecture §6).
//
// Asserts:
//   1. openapi.yaml on disk matches the Fastify route schemas (catches contract drift).
//   2. All Phase 0–1 endpoints are covered in the spec.
//   3. Typed FlyleafClient works with the API surface.

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
import { ApiError, sendError } from '../http.js';

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
    expect(paths).toContain('/me');
    expect(paths).toContain('/users/{id}');
    expect(paths).toContain('/search');
    expect(paths).toContain('/works/{id}');
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
    app.decorateRequest('viewer', null);
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ApiError) return sendError(reply, err);
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      return reply.status(500).send({ error: { code: 'internal', message } });
    });

    await app.register(identityRoutes(identityService), { prefix: '/v1' });
    await app.register(catalogRoutes(catalogService), { prefix: '/v1' });
    await app.register(readingRoutes(readingService), { prefix: '/v1' });
    await app.ready();

    // Wire client to route through app.inject
    client = new FlyleafClient({
      baseUrl: 'http://localhost/v1',
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
});
