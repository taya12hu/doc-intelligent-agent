import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertDbReachable, closeDb } from './db/client.js';
import { env } from './env.js';
import { errorHandler } from './lib/errors.js';
import { REPO_ROOT } from './lib/paths.js';
import { documentsRouter } from './routes/documents.js';
import { extractionsRouter } from './routes/extractions.js';
import { lineItemsRouter } from './routes/lineItems.js';
import { samplesRouter } from './routes/samples.js';
import { ensureBucket } from './storage/index.js';

/**
 * API bootstrap.
 *
 * Express 5, so async errors thrown in a handler propagate to `errorHandler`
 * on their own — no `asyncHandler` wrapper around every route, and no risk of
 * forgetting one and getting a silently hung request.
 */

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: env.GEMINI_MODEL, samples: env.EXTRACTION_SAMPLES });
});

app.use('/api/documents', documentsRouter);
app.use('/api/extractions', extractionsRouter);
app.use('/api/line-items', lineItemsRouter);
app.use('/api/samples', samplesRouter);

/**
 * Serve the built frontend from the same origin, when it exists.
 *
 * The client calls relative `/api/...` paths. In development Vite proxies
 * those to this server; in production there is no proxy, so the built assets
 * are served from here instead. Same origin means no CORS, and no API URL
 * baked in at build time — which would otherwise have to be known before the
 * API had been deployed.
 *
 * Absent in development, where Vite serves the frontend itself.
 */
const webDist = join(REPO_ROOT, 'apps', 'web', 'dist');

if (existsSync(webDist)) {
  app.use(express.static(webDist));

  // Client-side routes (/records/:id) must return index.html rather than 404.
  // The negative lookahead keeps /api out of it: an unknown API path should
  // still be a JSON 404, not the HTML shell.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
});

app.use(errorHandler);

const start = async () => {
  // Check the things that will otherwise fail on the first real request. A
  // missing bucket or an unreachable database should stop the process now,
  // with a message naming the variable, rather than surfacing as a 500 to
  // someone who just dragged a file onto the page.
  await assertDbReachable();
  await ensureBucket();

  const server = app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
    console.log(`  model    ${env.GEMINI_MODEL}  (escalates to ${env.GEMINI_ESCALATION_MODEL})`);
    console.log(`  samples  ${env.EXTRACTION_SAMPLES} per document`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((err) => {
  console.error(`\nCould not start the API.\n  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

export { app };
