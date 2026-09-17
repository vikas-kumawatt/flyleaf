// OpenAPI 3.1 & Client Generator (FN-80, FN-81, Architecture §6).
//
// Extracts OpenAPI 3.1 document from Fastify route schemas and writes openapi.yaml
// at the repository root. Supports --check for CI enforcement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import YAML from 'yaml';

import { registerSwagger } from './index.js';
import { identityRoutes } from '../identity/index.js';
import { catalogRoutes } from '../catalog/index.js';
import { readingRoutes } from '../reading/index.js';
import { adminDedupeRoutes } from '../admin/dedupe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../../..');
const OPENAPI_PATH = path.join(ROOT, 'openapi.yaml');

export async function buildOpenApiSpec(): Promise<object> {
  const app = Fastify();

  await registerSwagger(app);

  // Mock services solely for schema inspection during spec generation
  const mockIdentity = {} as any;
  const mockCatalog = {} as any;
  const mockReading = {} as any;
  const mockDb = {} as any;

  await app.register(identityRoutes(mockIdentity), { prefix: '/v1' });
  await app.register(catalogRoutes(mockCatalog), { prefix: '/v1' });
  await app.register(readingRoutes(mockReading), { prefix: '/v1' });
  await app.register(adminDedupeRoutes(mockDb));

  // System endpoints
  app.get(
    '/healthz',
    {
      schema: {
        tags: ['System'],
        summary: 'Liveness probe',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] } },
            required: ['status'],
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        tags: ['System'],
        summary: 'Readiness probe',
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ready'] } },
            required: ['status'],
          },
          503: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['code', 'message'],
              },
            },
            required: ['error'],
          },
        },
      },
    },
    async () => ({ status: 'ready' }),
  );

  await app.ready();

  const spec = app.swagger();
  await app.close();
  return spec;
}

export async function main() {
  const isCheck = process.argv.includes('--check');
  const spec = await buildOpenApiSpec();
  const yamlContent = YAML.stringify(spec, { indent: 2 });

  if (isCheck) {
    if (!fs.existsSync(OPENAPI_PATH)) {
      console.error('openapi.yaml does not exist. Run: npm run spec:generate');
      process.exit(1);
    }
    const current = fs.readFileSync(OPENAPI_PATH, 'utf8');
    if (current.replace(/\r\n/g, '\n').trim() !== yamlContent.replace(/\r\n/g, '\n').trim()) {
      console.error('openapi.yaml is out of sync with route schemas! Run: npm run spec:generate');
      process.exit(1);
    }
    console.log('openapi.yaml is up to date.');
    return;
  }

  fs.writeFileSync(OPENAPI_PATH, yamlContent, 'utf8');
  console.log(`Generated openapi.yaml at ${OPENAPI_PATH}`);
}

// Run directly if invoked from CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
