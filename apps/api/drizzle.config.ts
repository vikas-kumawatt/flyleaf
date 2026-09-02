import type { Config } from 'drizzle-kit';

// Phase -1 applies the schema via the Postgres container's init directory.
// drizzle-kit takes over in FN-01; this config exists so that switch is a
// one-line change rather than a fresh decision.
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://flyleaf:flyleaf@localhost:5432/flyleaf',
  },
} satisfies Config;
