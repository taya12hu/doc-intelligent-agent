import type {
  DocumentDTO,
  DocumentListItem,
  ExtractionDTO,
  ExtractionStatus,
  FieldFlag,
  FullRecord,
  LineItemDTO,
  RepairStep,
} from '@dia/shared';
import { and, asc, desc, eq, sql as raw } from 'drizzle-orm';
import type { RunResult } from '../extraction/index.js';
import { db } from './client.js';
import {
  documents,
  extractions,
  lineItems,
  type DocumentRow,
  type ExtractionRow,
  type LineItemRow,
} from './schema.js';

/**
 * Data access. Route handlers do not write SQL.
 *
 * This layer also owns the ROW -> DTO boundary. Doing the conversion in one
 * place means nothing above it has to remember whether it is holding a
 * `Date` or an ISO string — a distinction that otherwise leaks into every
 * handler and every component.
 */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const toDocumentDTO = (row: DocumentRow): DocumentDTO => ({
  id: row.id,
  filename: row.filename,
  mimeType: row.mimeType,
  fileKind: row.fileKind,
  byteSize: row.byteSize,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toExtractionDTO = (row: ExtractionRow): ExtractionDTO => ({
  id: row.id,
  documentId: row.documentId,
  provider: row.provider,
  model: row.model,
  escalatedTo: row.escalatedTo,
  samples: row.samples,
  attempts: row.attempts,
  latencyMs: row.latencyMs,
  tokensIn: row.tokensIn,
  tokensOut: row.tokensOut,
  repairLog: (row.repairLog ?? []) as RepairStep[],
  status: row.status,
  confidence: row.confidence,
  flags: (row.flags ?? []) as FieldFlag[],
  vendorName: row.vendorName,
  invoiceNumber: row.invoiceNumber,
  invoiceDate: row.invoiceDate,
  currency: row.currency,
  subtotal: row.subtotal,
  discountTotal: row.discountTotal,
  taxTotal: row.taxTotal,
  grandTotal: row.grandTotal,
  reviewedAt: iso(row.reviewedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toLineItemDTO = (row: LineItemRow): LineItemDTO => ({
  id: row.id,
  position: row.position,
  description: row.description,
  quantity: row.quantity,
  unitPrice: row.unitPrice,
  lineTotal: row.lineTotal,
  flags: (row.flags ?? []) as FieldFlag[],
  isEdited: row.isEdited,
});

// ── documents ─────────────────────────────────────────────────────────

export const insertDocument = async (input: {
  filename: string;
  mimeType: string;
  fileKind: DocumentRow['fileKind'];
  storagePath: string;
  byteSize: number;
}): Promise<DocumentRow> => {
  const [row] = await db
    .insert(documents)
    .values({ ...input, status: 'processing' })
    .returning();
  return row!;
};

export const getDocument = async (id: string): Promise<DocumentRow | null> => {
  const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
  return row ?? null;
};

const touchDocument = async (id: string, status: DocumentRow['status']): Promise<void> => {
  await db.update(documents).set({ status, updatedAt: new Date() }).where(eq(documents.id, id));
};

/**
 * The review queue.
 *
 * Ordered so that anything needing a human comes first — a queue whose whole
 * purpose is surfacing problems should not bury them under clean records.
 */
export const listDocuments = async (): Promise<DocumentListItem[]> => {
  const rows = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      fileKind: documents.fileKind,
      status: documents.status,
      createdAt: documents.createdAt,
      vendorName: extractions.vendorName,
      grandTotal: extractions.grandTotal,
      currency: extractions.currency,
      confidence: extractions.confidence,
      flags: extractions.flags,
      reviewedAt: extractions.reviewedAt,
    })
    .from(documents)
    .leftJoin(
      extractions,
      and(eq(extractions.documentId, documents.id), eq(extractions.isCurrent, true)),
    )
    .orderBy(
      raw`case ${documents.status}
            when 'failed' then 0
            when 'needs_review' then 1
            when 'processing' then 2
            when 'pending' then 3
            else 4 end`,
      desc(documents.createdAt),
    );

  return rows.map((r) => {
    const flags = (r.flags ?? []) as FieldFlag[];
    return {
      id: r.id,
      filename: r.filename,
      fileKind: r.fileKind,
      status: r.status,
      vendorName: r.vendorName,
      grandTotal: r.grandTotal,
      currency: r.currency,
      confidence: r.confidence,
      flagCount: flags.length,
      errorFlagCount: flags.filter((f) => f.severity === 'error').length,
      reviewedAt: iso(r.reviewedAt),
      createdAt: r.createdAt.toISOString(),
    };
  });
};

export const getFullRecord = async (documentId: string): Promise<FullRecord | null> => {
  const document = await getDocument(documentId);
  if (!document) return null;

  const [extraction] = await db
    .select()
    .from(extractions)
    .where(and(eq(extractions.documentId, documentId), eq(extractions.isCurrent, true)))
    .limit(1);

  if (!extraction) {
    return { document: toDocumentDTO(document), extraction: null, lineItems: [] };
  }

  const rows = await db
    .select()
    .from(lineItems)
    .where(eq(lineItems.extractionId, extraction.id))
    .orderBy(asc(lineItems.position));

  return {
    document: toDocumentDTO(document),
    extraction: toExtractionDTO(extraction),
    lineItems: rows.map(toLineItemDTO),
  };
};

export const getExtraction = async (id: string): Promise<ExtractionRow | null> => {
  const [row] = await db.select().from(extractions).where(eq(extractions.id, id)).limit(1);
  return row ?? null;
};

// ── writing an extraction ─────────────────────────────────────────────

/**
 * Persist a pipeline run.
 *
 * One transaction, because a superseded old row with no new row to replace it
 * would leave a document with no current extraction — a state nothing else in
 * the system knows how to render.
 */
export const saveExtraction = async (
  documentId: string,
  result: RunResult,
): Promise<FullRecord> => {
  await db.transaction(async (tx) => {
    await tx
      .update(extractions)
      .set({ isCurrent: false })
      .where(and(eq(extractions.documentId, documentId), eq(extractions.isCurrent, true)));

    const [inserted] = await tx
      .insert(extractions)
      .values({
        documentId,
        provider: result.provider,
        model: result.model,
        escalatedTo: result.escalatedTo,
        samples: result.samples,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        repairLog: result.repairLog,
        raw: result.raw,
        status: result.status,
        confidence: result.confidence,
        // Record-level flags stay on the extraction; per-row flags move to
        // their row so the grid can decorate individual cells.
        flags: result.flags.filter((f) => !f.field.startsWith('lineItems[')),
        vendorName: result.invoice.vendorName,
        invoiceNumber: result.invoice.invoiceNumber,
        invoiceDate: result.invoice.invoiceDate,
        currency: result.invoice.currency,
        subtotal: result.invoice.subtotal,
        discountTotal: result.invoice.discountTotal,
        taxTotal: result.invoice.taxTotal,
        grandTotal: result.invoice.grandTotal,
        isCurrent: true,
      })
      .returning();

    const extractionId = inserted!.id;

    if (result.invoice.lineItems.length) {
      await tx.insert(lineItems).values(
        result.invoice.lineItems.map((li, position) => ({
          extractionId,
          position,
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          lineTotal: li.lineTotal,
          flags: result.flags.filter((f) => f.field.startsWith(`lineItems[${position}]`)),
        })),
      );
    }

    await tx
      .update(documents)
      .set({ status: result.status, updatedAt: new Date() })
      .where(eq(documents.id, documentId));
  });

  return (await getFullRecord(documentId))!;
};

// ── human corrections ─────────────────────────────────────────────────

type EditEntry = { field: string; from: unknown; to: unknown; at: string };

/** Append to `raw.edits`. A dedicated audit table is the more-time answer. */
const withEdits = (existingRaw: unknown, entries: EditEntry[]): Record<string, unknown> => {
  const base = (existingRaw ?? {}) as Record<string, unknown>;
  const prior = Array.isArray(base.edits) ? (base.edits as EditEntry[]) : [];
  return { ...base, edits: [...prior, ...entries] };
};

export const updateExtractionFields = async (
  id: string,
  patch: Partial<
    Pick<
      ExtractionRow,
      | 'vendorName'
      | 'invoiceNumber'
      | 'invoiceDate'
      | 'currency'
      | 'subtotal'
      | 'discountTotal'
      | 'taxTotal'
      | 'grandTotal'
    >
  >,
): Promise<ExtractionRow | null> => {
  const current = await getExtraction(id);
  if (!current) return null;

  const at = new Date().toISOString();
  const edits: EditEntry[] = Object.entries(patch)
    .filter(([field, to]) => current[field as keyof ExtractionRow] !== to)
    .map(([field, to]) => ({ field, from: current[field as keyof ExtractionRow], to, at }));

  const [row] = await db
    .update(extractions)
    .set({ ...patch, raw: withEdits(current.raw, edits), updatedAt: new Date() })
    .where(eq(extractions.id, id))
    .returning();
  return row ?? null;
};

export const updateLineItem = async (
  id: string,
  patch: Partial<Pick<LineItemRow, 'description' | 'quantity' | 'unitPrice' | 'lineTotal'>>,
): Promise<LineItemRow | null> => {
  const [row] = await db
    .update(lineItems)
    .set({ ...patch, isEdited: true })
    .where(eq(lineItems.id, id))
    .returning();
  return row ?? null;
};

export const getLineItem = async (id: string): Promise<LineItemRow | null> => {
  const [row] = await db.select().from(lineItems).where(eq(lineItems.id, id)).limit(1);
  return row ?? null;
};

export const addLineItem = async (
  extractionId: string,
  values: Partial<Pick<LineItemRow, 'description' | 'quantity' | 'unitPrice' | 'lineTotal'>>,
): Promise<LineItemRow> => {
  const existing = await db
    .select({ position: lineItems.position })
    .from(lineItems)
    .where(eq(lineItems.extractionId, extractionId));
  const nextPosition = existing.reduce((max, r) => Math.max(max, r.position + 1), 0);

  const [row] = await db
    .insert(lineItems)
    .values({ extractionId, position: nextPosition, ...values, isEdited: true })
    .returning();
  return row!;
};

export const deleteLineItem = async (id: string): Promise<string | null> => {
  const [row] = await db.delete(lineItems).where(eq(lineItems.id, id)).returning();
  return row?.extractionId ?? null;
};

export const getLineItemsFor = async (extractionId: string): Promise<LineItemRow[]> =>
  db
    .select()
    .from(lineItems)
    .where(eq(lineItems.extractionId, extractionId))
    .orderBy(asc(lineItems.position));

/** Write back a re-derived verdict after a human edit. */
export const updateVerdict = async (
  extractionId: string,
  verdict: {
    flags: FieldFlag[];
    confidence: number;
    status: ExtractionStatus;
    lineItemFlags: Map<string, FieldFlag[]>;
  },
): Promise<void> => {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(extractions)
      .set({
        flags: verdict.flags.filter((f) => !f.field.startsWith('lineItems[')),
        confidence: verdict.confidence,
        status: verdict.status,
        updatedAt: new Date(),
      })
      .where(eq(extractions.id, extractionId))
      .returning({ documentId: extractions.documentId });

    for (const [lineItemId, flags] of verdict.lineItemFlags) {
      await tx.update(lineItems).set({ flags }).where(eq(lineItems.id, lineItemId));
    }

    if (row) {
      await tx
        .update(documents)
        .set({ status: verdict.status, updatedAt: new Date() })
        .where(eq(documents.id, row.documentId));
    }
  });
};

/**
 * The human takes responsibility.
 *
 * Deliberately allowed even with flags outstanding. Some flags cannot be
 * resolved from the document — an ambiguous date stays ambiguous — and a
 * reviewer who has checked the source needs a way to say "I have looked at
 * this, it is right". The flags stay on the record as history; `reviewedAt`
 * records that someone signed off anyway.
 */
export const markReviewed = async (extractionId: string): Promise<void> => {
  const now = new Date();
  const [row] = await db
    .update(extractions)
    .set({ reviewedAt: now, status: 'extracted', updatedAt: now })
    .where(eq(extractions.id, extractionId))
    .returning({ documentId: extractions.documentId });
  if (row) await touchDocument(row.documentId, 'extracted');
};

export { touchDocument };
