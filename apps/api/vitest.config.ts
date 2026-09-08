import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite unpacks a Postgres image on first boot, which is a few seconds.
    // The default 5s timeout fails the schema suite on a cold cache and looks
    // like a broken migration.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
