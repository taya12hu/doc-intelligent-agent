import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { requireDb } from '../env.js';
import * as schema from './schema.js';

/**
 * Postgres connection.
 *
 * Supabase offers three ways in and the choice matters:
 *
 *   :5432 direct / session pooler — a real session per connection. Prepared
 *                                   statements work. This is what a
 *                                   long-running Express server wants.
 *   :6543 transaction pooler      — connections are multiplexed per
 *                                   transaction, so a prepared statement
 *                                   created on one may not exist on the next.
 *                                   postgres.js MUST be told `prepare: false`
 *                                   or queries fail intermittently, which is
 *                                   a miserable bug to chase.
 *
 * Rather than documenting that and hoping, detect the pooler port and set the
 * flag. Getting this wrong produces failures that look random.
 */

const connectionString = requireDb();
const isTransactionPooler = /:6543\b/.test(connectionString);

export const sql = postgres(connectionString, {
  // One server, four documents, synchronous extraction: a big pool buys
  // nothing and Supabase's free tier has a modest connection ceiling.
  max: 5,
  idle_timeout: 20,
  connect_timeout: 15,
  prepare: !isTransactionPooler,
});

export const db = drizzle(sql, { schema });

export const closeDb = async (): Promise<void> => {
  await sql.end({ timeout: 5 });
};

/** Fail loudly at boot rather than on the first request. */
export const assertDbReachable = async (): Promise<void> => {
  try {
    await sql`select 1`;
  } catch (err) {
    throw new Error(
      `Could not reach Postgres. Check DATABASE_URL in .env.\n` +
        `  ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
