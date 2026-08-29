import { Router } from 'express';
import multer from 'multer';
import { classify } from '../extraction/classify.js';
import { runExtraction } from '../extraction/index.js';
import { ApiError } from '../lib/errors.js';
import { MAX_UPLOAD_BYTES, guardUpload } from '../lib/guards.js';
import { createGeminiProvider } from '../llm/gemini.js';
import * as repo from '../db/repo.js';
import * as storage from '../storage/index.js';

/**
 * Document routes.
 *
 * Extraction runs SYNCHRONOUSLY inside the upload request. At four documents,
 * one user and no deployment, a queue is ceremony: it costs an hour, adds a
 * polling endpoint and a worker process, and improves nothing a reviewer can
 * see. The `pending`/`processing` statuses and the timestamps are modelled as
 * if it were async, so moving to a queue later is a change to this file
 * rather than to the schema. That is written up in the README rather than
 * built.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

export const documentsRouter: Router = Router();

documentsRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    throw ApiError.badRequest('No file uploaded. Send it as multipart field "file".');
  }

  const { buffer, originalname } = req.file;
  const { mimeType } = guardUpload(buffer, originalname);

  // Classify BEFORE storing, so an unreadable file is rejected without
  // leaving an orphan object in the bucket.
  const classification = await classify(buffer, originalname);

  const storagePath = storage.storageKeyFor(originalname);
  await storage.upload(buffer, storagePath, mimeType);

  const document = await repo.insertDocument({
    filename: originalname,
    mimeType,
    fileKind: classification.kind,
    storagePath,
    byteSize: buffer.length,
  });

  const result = await runExtraction({
    buffer,
    filename: originalname,
    provider: createGeminiProvider(),
  });

  const record = await repo.saveExtraction(document.id, result);

  // 201 even when `result.status === 'failed'`. A failed extraction is a
  // legitimate outcome we successfully recorded, not a server error — the
  // record exists, it carries flags and the raw model output, and the UI can
  // show the reviewer exactly what happened. Returning 5xx would make it
  // indistinguishable from the server being broken.
  res.status(201).json(record);
});

documentsRouter.get('/', async (_req, res) => {
  res.json(await repo.listDocuments());
});

documentsRouter.get('/:id', async (req, res) => {
  const record = await repo.getFullRecord(req.params.id);
  if (!record) throw ApiError.notFound('Document');
  res.json(record);
});

/**
 * The source file, for the review pane.
 *
 * Redirects to a short-lived signed URL rather than proxying the bytes. The
 * bucket stays private, the service-role key stays server-side, and the
 * browser still gets a URL it can point an <iframe> at.
 */
documentsRouter.get('/:id/file', async (req, res) => {
  const document = await repo.getDocument(req.params.id);
  if (!document) throw ApiError.notFound('Document');
  res.redirect(await storage.signedUrl(document.storagePath));
});

documentsRouter.post('/:id/reextract', async (req, res) => {
  const document = await repo.getDocument(req.params.id);
  if (!document) throw ApiError.notFound('Document');

  await repo.touchDocument(document.id, 'processing');
  const buffer = await storage.download(document.storagePath);

  const result = await runExtraction({
    buffer,
    filename: document.filename,
    provider: createGeminiProvider(),
  });

  // Inserts a new extraction and supersedes the old one, so the previous
  // reading — including any human corrections to it — survives as history.
  res.json(await repo.saveExtraction(document.id, result));
});
