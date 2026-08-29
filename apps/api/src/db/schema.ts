import {
  DOCUMENT_STATUSES,
  EXTRACTION_STATUSES,
  FILE_KINDS,
  type FieldFlag,
  type RepairStep,
} from '@dia/shared';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Three tables. See ARCHITECTURE.md §6 for the reasoning; the short version:
 *
 * - LINE ITEMS ARE NORMALISED, not JSONB. The reviewer edits rows
 *   individually and the server re-runs arithmetic on each save, so they need
 *   to be addressable. JSONB would make every edit a read-modify-write of the
 *   whole array.
 *
 * - THE EXTRACTION *IS* THE RECORD. There is no separate `records` table that
 *   an extraction gets copied into. "The extraction is the record and humans
 *   correct it in place" is the honest mental model, and it saves a join on
 *   the hottest query.
 *
 * - MONEY IS `numeric`, NEVER float. Read back as JS numbers (`mode:
 *   'number'`) so the API, the checks and the UI all hold the same type —
 *   the string/number confusion that `numeric` normally causes is a real
 *   source of bugs, and our magnitudes are far inside the range where a
 *   double represents cents exactly. Postgres still stores it exactly.
 */

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    /** Detected from the bytes, never from the client. */
    fileKind: text('file_kind', { enum: FILE_KINDS }).notNull(),
    /** Supabase Storage object key. */
    storagePath: text('storage_path').notNull(),
    byteSize: integer('byte_size').notNull(),
    status: text('status', { enum: DOCUMENT_STATUSES }).notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_status_idx').on(t.status), index('documents_created_idx').on(t.createdAt)],
);

export const extractions = pgTable(
  'extractions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    // ── provenance ────────────────────────────────────────────────────
    // Kept in full so any run is reproducible and debuggable after the fact,
    // and so the UI can show its receipts rather than asserting them.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** Set only when the repair loop escalated to the stronger model. */
    escalatedTo: text('escalated_to'),
    samples: integer('samples').notNull().default(1),
    attempts: integer('attempts').notNull().default(1),
    latencyMs: integer('latency_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    repairLog: jsonb('repair_log').$type<RepairStep[]>().notNull().default([]),
    /** meta envelope, per-sample invoices, agreement map, raw text on failure. */
    raw: jsonb('raw'),

    // ── verdict ───────────────────────────────────────────────────────
    status: text('status', { enum: EXTRACTION_STATUSES }).notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2, mode: 'number' }),
    flags: jsonb('flags').$type<FieldFlag[]>().notNull().default([]),

    // ── the canonical, human-editable record ──────────────────────────
    vendorName: text('vendor_name'),
    invoiceNumber: text('invoice_number'),
    invoiceDate: date('invoice_date'),
    currency: char('currency', { length: 3 }),
    subtotal: numeric('subtotal', { precision: 14, scale: 2, mode: 'number' }),
    discountTotal: numeric('discount_total', { precision: 14, scale: 2, mode: 'number' }),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2, mode: 'number' }),
    grandTotal: numeric('grand_total', { precision: 14, scale: 2, mode: 'number' }),

    /**
     * Re-extraction inserts a NEW row and supersedes the old one. Free history
     * with no versioning machinery, and the partial index below keeps the hot
     * query ("the current extraction for this document") fast.
     */
    isCurrent: boolean('is_current').notNull().default(true),
    /** Set when a human explicitly takes responsibility for the record. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('extractions_document_current_idx').on(t.documentId, t.isCurrent)],
);

export const lineItems = pgTable(
  'line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    extractionId: uuid('extraction_id')
      .notNull()
      .references(() => extractions.id, { onDelete: 'cascade' }),
    /** Document order. Rows are meaningful in sequence, not as a set. */
    position: integer('position').notNull(),
    description: text('description'),
    quantity: numeric('quantity', { precision: 14, scale: 4, mode: 'number' }),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4, mode: 'number' }),
    lineTotal: numeric('line_total', { precision: 14, scale: 2, mode: 'number' }),
    flags: jsonb('flags').$type<FieldFlag[]>().notNull().default([]),
    /** Distinguishes human-corrected values from model output in the UI. */
    isEdited: boolean('is_edited').notNull().default(false),
  },
  (t) => [index('line_items_extraction_idx').on(t.extractionId, t.position)],
);

export type DocumentRow = typeof documents.$inferSelect;
export type ExtractionRow = typeof extractions.$inferSelect;
export type LineItemRow = typeof lineItems.$inferSelect;
