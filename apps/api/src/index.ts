import cors from 'cors';
import express from 'express';
import { assertDbReachable, closeDb } from './db/client.js';
import { env } from './env.js';
import { errorHandler } from './lib/errors.js';
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
