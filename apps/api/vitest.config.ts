import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite unpacks a Postgres image on first boot, which is a few seconds.
    // The default 5s timeout fails the schema suite on a cold cache and looks
    // like a broken migration.
    testTimeout: 60_000,
    hookTimeout: 60_000,

    // Never collect tests out of the build output.
    //
    // `npm run build` compiles src/test/*.test.ts to dist/test/*.test.js, and
    // vitest's default include matches those too -- so once dist/ exists,
    // every suite runs twice: 283 tests instead of 174. It is not just noise.
    // A test that reads its own source (outbound.test.ts checks gapfill.ts for
    // a forbidden provider string) resolves that path relative to itself, and
    // from dist/ the .ts file is not there, so the duplicate FAILS.
    //
    // Found by running the CI script twice in a row, which is exactly the
    // thing a first run cannot tell you.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
