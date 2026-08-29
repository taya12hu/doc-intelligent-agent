import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, db } from '../db/client.js';
import { ensureBucket } from '../storage/index.js';

/**
 * `npm run db:migrate`
 *
 * Applies migrations and creates the storage bucket, so a fresh Supabase
 * project is ready in one command. Fewer README steps that can be skipped or
 * done in the wrong order.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '..', '..', 'drizzle');

const main = async () => {
  if (!existsSync(migrationsFolder)) {
    console.error(
      `No migrations found at ${migrationsFolder}.\nRun \`npm run db:generate\` first.`,
    );
    process.exit(1);
  }

  console.log('Applying migrations...');
  await migrate(db, { migrationsFolder });
  console.log('  schema up to date');

  console.log('Ensuring storage bucket...');
  await ensureBucket();
  console.log('  bucket ready');

  await closeDb();
  console.log('\nDatabase is ready.');
};

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
