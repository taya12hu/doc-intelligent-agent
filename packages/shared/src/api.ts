import { z } from 'zod';
import { FieldFlagSchema } from './flags.js';
import { LineItemSchema } from './invoice.js';
import { DOCUMENT_STATUSES, EXTRACTION_STATUSES, FILE_KINDS } from './status.js';

/**
 * Wire types shared by `apps/api` and `apps/web`.
 *
 * Money crosses the wire as a `number | null`, not a string. The DB stores
 * `numeric` (never float — it is money), and the repo layer parses on the way
 * out. Doing it at that one boundary means neither the route handlers nor the
 * frontend ever has to remember which representation they are holding.
 */

/** One recorded step of the repair loop. Surfaced in the UI's extraction log. */
export const RepairStepSchema = z.object({
  attempt: z.number(),
  stage: z.enum(['initial', 'local_repair', 'repair_call', 'escalation']),
  model: z.string(),
  finishReason: z.string().optional(),
  error: z.string().optional(),
  /** What we did about it, in plain English. */
  action: z.string(),
  latencyMs: z.number().optional(),
});
export type RepairStep = z.infer<typeof RepairStepSchema>;

export const DocumentDTOSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  fileKind: z.enum(FILE_KINDS),
  byteSize: z.number(),
  status: z.enum(DOCUMENT_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentDTO = z.infer<typeof DocumentDTOSchema>;

export const LineItemDTOSchema = LineItemSchema.extend({
  id: z.string(),
  position: z.number(),
  description: z.string().nullable(),
  flags: z.array(FieldFlagSchema),
  isEdited: z.boolean(),
});
export type LineItemDTO = z.infer<typeof LineItemDTOSchema>;

export const ExtractionDTOSchema = z.object({
  id: z.string(),
  documentId: z.string(),

  provider: z.string(),
  model: z.string(),
  escalatedTo: z.string().nullable(),
  samples: z.number(),
  attempts: z.number(),
  latencyMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  repairLog: z.array(RepairStepSchema),

  status: z.enum(EXTRACTION_STATUSES),
  confidence: z.number().nullable(),
  flags: z.array(FieldFlagSchema),

  vendorName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  currency: z.string().nullable(),
  subtotal: z.number().nullable(),
  discountTotal: z.number().nullable(),
  taxTotal: z.number().nullable(),
  grandTotal: z.number().nullable(),

  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExtractionDTO = z.infer<typeof ExtractionDTOSchema>;

/** What `GET /api/documents/:id` and `POST /api/documents` return. */
export type FullRecord = {
  document: DocumentDTO;
  extraction: ExtractionDTO | null;
  lineItems: LineItemDTO[];
};

/** The flattened projection `GET /api/documents` returns for the table. */
export type DocumentListItem = {
  id: string;
  filename: string;
  fileKind: DocumentDTO['fileKind'];
  status: DocumentDTO['status'];
  vendorName: string | null;
  grandTotal: number | null;
  currency: string | null;
  confidence: number | null;
  flagCount: number;
  errorFlagCount: number;
  /**
   * Set when a human explicitly accepted the record. A reviewed record keeps
   * its flags, so without this the list cannot tell "extracted cleanly" from
   * "a person signed this off despite outstanding flags".
   */
  reviewedAt: string | null;
  createdAt: string;
};

// ── request bodies ────────────────────────────────────────────────────

/**
 * Only the human-correctable header fields. Provenance, flags, confidence and
 * status are all server-derived — accepting them from the client would let the
 * UI declare its own extraction trustworthy, which defeats the point.
 */
export const PatchExtractionSchema = z
  .object({
    vendorName: z.string().nullable(),
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    currency: z.string().nullable(),
    subtotal: z.number().nullable(),
    discountTotal: z.number().nullable(),
    taxTotal: z.number().nullable(),
    grandTotal: z.number().nullable(),
  })
  .partial();
export type PatchExtraction = z.infer<typeof PatchExtractionSchema>;

export const PatchLineItemSchema = z
  .object({
    description: z.string().nullable(),
    quantity: z.number().nullable(),
    unitPrice: z.number().nullable(),
    lineTotal: z.number().nullable(),
  })
  .partial();
export type PatchLineItem = z.infer<typeof PatchLineItemSchema>;

export const CreateLineItemSchema = z.object({
  description: z.string().nullable().default(null),
  quantity: z.number().nullable().default(null),
  unitPrice: z.number().nullable().default(null),
  lineTotal: z.number().nullable().default(null),
  position: z.number().optional(),
});
export type CreateLineItem = z.infer<typeof CreateLineItemSchema>;

// ── errors ────────────────────────────────────────────────────────────

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
};
