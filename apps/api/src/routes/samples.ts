import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as repo from '../db/repo.js';
import { classify } from '../extraction/classify.js';
import { runExtraction } from '../extraction/index.js';
import { ApiError } from '../lib/errors.js';
import { guardUpload } from '../lib/guards.js';
import { REPO_ROOT } from '../lib/paths.js';
import { createGeminiProvider } from '../llm/gemini.js';
import * as storage from '../storage/index.js';

/**
 * The four bundled samples, ingestible with one click.
 *
 * Worth the ~20 lines: it means a reviewer who has just cloned the repo can
 * see the interesting case — the degraded scan flagging exactly the three
 * values it should — without first finding a PDF and dragging it anywhere.
 * The first thirty seconds of using this thing are the ones that matter.
 *
 * Serving them from `samples/input` rather than copying them into the web
 * app keeps one copy of the fixtures, so regenerating them cannot leave the
 * UI serving a stale document.
 */

const SAMPLES = [
  {
    key: 'acme',
    filename: 'acme-supplies.pdf',
    label: 'Acme Supplies',
    blurb: 'Clean digital PDF. The control case.',
  },
  {
    key: 'northwind',
    filename: 'northwind-trading.pdf',
    label: 'Northwind Trading',
    blurb: 'Unusual labels, Indian digit grouping, discount + GST band.',
  },
  {
    key: 'blueridge',
    filename: 'blue-ridge-scan.pdf',
    label: 'Blue Ridge',
    blurb: 'Degraded scan. Should flag, not guess.',
  },
  {
    key: 'zenith',
    filename: 'zenith-parts.xlsx',
    label: 'Zenith Parts',
    blurb: 'Spreadsheet: offset origin, swapped columns, a blank cell.',
  },
] as const;

const sampleDir = join(REPO_ROOT, 'samples', 'input');

export const samplesRouter: Router = Router();

samplesRouter.get('/', (_req, res) => {
  res.json(
    SAMPLES.map((s) => ({
      ...s,
      available: existsSync(join(sampleDir, s.filename)),
    })),
  );
});

samplesRouter.post('/:key', async (req, res) => {
  const sample = SAMPLES.find((s) => s.key === req.params.key);
  if (!sample) throw ApiError.notFound('Sample');

  const path = join(sampleDir, sample.filename);
  if (!existsSync(path)) {
    throw ApiError.badRequest(
      `${sample.filename} is not in samples/input. Run \`npm run samples:generate\`.`,
    );
  }

  const buffer = await readFile(path);
  const { mimeType } = guardUpload(buffer, sample.filename);
  const classification = await classify(buffer, sample.filename);

  const storagePath = storage.storageKeyFor(sample.filename);
  await storage.upload(buffer, storagePath, mimeType);

  const document = await repo.insertDocument({
    filename: sample.filename,
    mimeType,
    fileKind: classification.kind,
    storagePath,
    byteSize: buffer.length,
  });

  const result = await runExtraction({
    buffer,
    filename: sample.filename,
    provider: createGeminiProvider(),
  });

  res.status(201).json(await repo.saveExtraction(document.id, result));
});
