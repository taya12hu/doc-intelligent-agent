import { CreateLineItemSchema, PatchExtractionSchema } from '@dia/shared';
import { Router } from 'express';
import * as repo from '../db/repo.js';
import { recheck } from '../extraction/recheck.js';
import { ApiError } from '../lib/errors.js';

export const extractionsRouter: Router = Router();

/**
 * Correct the header fields.
 *
 * The body schema accepts ONLY the human-correctable fields. Flags,
 * confidence, status and provenance are all server-derived — accepting them
 * from the client would let the UI declare its own extraction trustworthy,
 * which defeats the entire point of the flagging system.
 */
extractionsRouter.patch('/:id', async (req, res) => {
  const patch = PatchExtractionSchema.parse(req.body);

  const updated = await repo.updateExtractionFields(req.params.id, patch);
  if (!updated) throw ApiError.notFound('Extraction');

  const rows = await repo.getLineItemsFor(updated.id);
  await repo.updateVerdict(updated.id, recheck(updated, rows));

  const record = await repo.getFullRecord(updated.documentId);
  res.json(record);
});

extractionsRouter.post('/:id/line-items', async (req, res) => {
  const values = CreateLineItemSchema.parse(req.body);

  const extraction = await repo.getExtraction(req.params.id);
  if (!extraction) throw ApiError.notFound('Extraction');

  await repo.addLineItem(extraction.id, {
    description: values.description,
    quantity: values.quantity,
    unitPrice: values.unitPrice,
    lineTotal: values.lineTotal,
  });

  const rows = await repo.getLineItemsFor(extraction.id);
  await repo.updateVerdict(extraction.id, recheck(extraction, rows));

  res.status(201).json(await repo.getFullRecord(extraction.documentId));
});

/**
 * Sign-off.
 *
 * Allowed with flags still outstanding, on purpose. Some flags cannot be
 * resolved from the document — an ambiguous date is ambiguous however long
 * you stare at it — so a reviewer who has checked the source needs a way to
 * say "I have looked, this is right". The flags stay on the record; what
 * changes is that a person is now accountable for it.
 */
extractionsRouter.post('/:id/review', async (req, res) => {
  const extraction = await repo.getExtraction(req.params.id);
  if (!extraction) throw ApiError.notFound('Extraction');

  await repo.markReviewed(extraction.id);
  res.json(await repo.getFullRecord(extraction.documentId));
});
