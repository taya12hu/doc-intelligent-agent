import { PatchLineItemSchema } from '@dia/shared';
import { Router } from 'express';
import * as repo from '../db/repo.js';
import { recheck } from '../extraction/recheck.js';
import { ApiError } from '../lib/errors.js';

export const lineItemsRouter: Router = Router();

/**
 * Both handlers re-run the checks on the PARENT extraction, not just the row.
 *
 * Editing one line total changes whether the whole invoice reconciles. A
 * per-row recheck would leave the subtotal mismatch flag standing after the
 * reviewer had just fixed the thing causing it — which is precisely the
 * behaviour that trains people to ignore flags.
 */

lineItemsRouter.patch('/:id', async (req, res) => {
  const patch = PatchLineItemSchema.parse(req.body);

  const updated = await repo.updateLineItem(req.params.id, patch);
  if (!updated) throw ApiError.notFound('Line item');

  const extraction = await repo.getExtraction(updated.extractionId);
  if (!extraction) throw ApiError.notFound('Extraction');

  const rows = await repo.getLineItemsFor(extraction.id);
  await repo.updateVerdict(extraction.id, recheck(extraction, rows));

  res.json(await repo.getFullRecord(extraction.documentId));
});

lineItemsRouter.delete('/:id', async (req, res) => {
  const row = await repo.getLineItem(req.params.id);
  if (!row) throw ApiError.notFound('Line item');

  await repo.deleteLineItem(row.id);

  const extraction = await repo.getExtraction(row.extractionId);
  if (!extraction) throw ApiError.notFound('Extraction');

  const rows = await repo.getLineItemsFor(extraction.id);
  await repo.updateVerdict(extraction.id, recheck(extraction, rows));

  res.json(await repo.getFullRecord(extraction.documentId));
});
