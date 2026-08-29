import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '..', '..', '.env'), quiet: true });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Supabase ships its own schemas in the same database; without this filter
  // drizzle-kit tries to reconcile auth/storage/realtime tables it does not
  // own and generates migrations that would drop them.
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
});
