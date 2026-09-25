// OpenAPI 3.1 & Client Generator (FN-80, FN-81, Architecture §6).
//
// Extracts OpenAPI 3.1 document from Fastify route schemas and writes openapi.yaml
// at the repository root. Supports --check for CI enforcement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { buildApp } from '../app.js';
import type { Db } from '../platform/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../../..');
const OPENAPI_PATH = path.join(ROOT, 'openapi.yaml');

/**
 * The spec is read off the real app: buildApp() with every optional service
 * present (stubs, never called while describing routes). It used to register
 * its own plugin list, which drifted twice (the feed until SO-21, exports
 * until Audit 05). Now a route cannot be served without being in the spec,
 * unless its schema says `hide: true`.
 */
export async function buildOpenApiSpec(): Promise<object> {
  const stub = {} as never;
  const app = await buildApp({
    spec: true,
    db: {} as Db,
    identity: stub,
    catalog: stub,
    reading: stub,
    limiter: { allow: async () => true },
  });
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
