import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Environment, validated once at import time.
 *
 * Two deliberate choices here:
 *
 * 1. FAIL FAST, WITH A READABLE MESSAGE. A missing GEMINI_API_KEY should stop
 *    the process at boot with a line telling you which variable and where to
 *    get it — not surface as a 500 three layers into a request handler.
 *
 * 2. THE DATABASE AND STORAGE ARE OPTIONAL. The extraction pipeline is the
 *    interesting part of this project, and it does not need Postgres. Keeping
 *    those vars optional means `npm run extract samples/input/foo.pdf` works
 *    with nothing but an API key — which is how I develop the pipeline, and
 *    how a reviewer can try it without provisioning a Supabase project first.
 *    The API server calls `requireDb()` / `requireStorage()` at boot, so the
 *    server still fails fast; only the CLI gets the lighter requirement.
 */

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '..', '..', '..', '.env'), quiet: true });

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, 'get one at https://aistudio.google.com/apikey'),
  GEMINI_MODEL: z.string().default('gemini-3.7-flash'),
  GEMINI_ESCALATION_MODEL: z.string().default('gemini-2.5-pro'),

  /**
   * Independent extraction passes to vote across.
   *
   * 3 is the design (ARCHITECTURE.md §5.6) but the default is 2, because the
   * Gemini free tier is 20 requests PER DAY per model — 3 passes means a
   * single eval run consumes 12 of them. 2 still measures instability; it
   * just grades every disagreement as an error rather than distinguishing a
   * 2-of-3 majority from a 3-way split. 1 disables self-consistency, leaving
   * the arithmetic checks, which are the stronger signal anyway.
   */
  EXTRACTION_SAMPLES: z.coerce.number().int().min(1).max(5).default(2),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_BUCKET: z.string().default('invoices'),
  DATABASE_URL: z.string().optional(),

  PORT: z.coerce.number().int().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(
    ['', 'Environment is not configured.', ...lines, '', 'Copy .env.example to .env and fill it in.', ''].join(
      '\n',
    ),
  );
  process.exit(1);
}

export const env = parsed.data;

export const requireDb = (): string => {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Supabase -> Settings -> Database -> Connection string (URI). ' +
        'Use the session pooler (:5432) for this long-running server.',
    );
  }
  return env.DATABASE_URL;
};

export const requireStorage = (): { url: string; key: string; bucket: string } => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to store uploads. ' +
        'Supabase -> Settings -> API. Use the service_role key: it is server-side only.',
    );
  }
  return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.SUPABASE_BUCKET };
};
