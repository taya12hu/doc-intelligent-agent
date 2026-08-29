import type { ExtractionMeta, ExtractionStatus, FieldFlag, Invoice } from '@dia/shared';
import type { ExtractionRow, LineItemRow } from '../db/schema.js';
import { runChecks } from './checks.js';
import { deriveStatus, scoreConfidence } from './confidence.js';

/**
 * Re-derive the verdict after a human edits a record.
 *
 * THE SERVER IS THE AUTHORITY ON MONEY. The UI runs the same arithmetic live
 * as you type, because waiting on a round trip to find out your correction
 * balances is a miserable way to review fifty invoices. But that is a
 * convenience, not a source of truth — the client is not trusted to tell us
 * its own record is now correct.
 *
 * Re-running the same pure `runChecks` that produced the original flags is
 * what makes the flags MEAN something after an edit. A flag that never
 * clears is decoration; one that disappears the moment the reviewer fixes the
 * number underneath it is feedback.
 */

export type Verdict = {
  flags: FieldFlag[];
  confidence: number;
  status: ExtractionStatus;
  /** Per-row flags, keyed by line item id, for writing back to their rows. */
  lineItemFlags: Map<string, FieldFlag[]>;
};

const metaFrom = (raw: unknown): ExtractionMeta => {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    illegibleFields: Array.isArray(r.illegibleFields) ? (r.illegibleFields as string[]) : [],
    legibility: typeof r.legibility === 'number' ? r.legibility : 1,
    notes: typeof r.notes === 'string' ? r.notes : '',
    invoiceDateAsPrinted:
      typeof r.invoiceDateAsPrinted === 'string' ? r.invoiceDateAsPrinted : null,
  };
};

export const invoiceFrom = (extraction: ExtractionRow, rows: LineItemRow[]): Invoice => ({
  vendorName: extraction.vendorName,
  invoiceNumber: extraction.invoiceNumber,
  invoiceDate: extraction.invoiceDate,
  currency: extraction.currency,
  lineItems: [...rows]
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      description: r.description ?? '',
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      lineTotal: r.lineTotal,
    })),
  subtotal: extraction.subtotal,
  discountTotal: extraction.discountTotal,
  taxTotal: extraction.taxTotal,
  grandTotal: extraction.grandTotal,
});

export const recheck = (extraction: ExtractionRow, rows: LineItemRow[]): Verdict => {
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const invoice = invoiceFrom(extraction, ordered);
  const meta = metaFrom(extraction.raw);

  /**
   * A field the model could not read stays flagged only while nobody has
   * touched it. Once a human has typed a value in, "the model reported this
   * as unreadable" is no longer a reason to distrust the number — the human
   * read it. Keeping the flag would mean the reviewer can never clear the
   * record no matter what they do.
   */
  const editedPaths = new Set(
    ordered.flatMap((r, i) =>
      r.isEdited
        ? [
            `lineItems[${i}].description`,
            `lineItems[${i}].quantity`,
            `lineItems[${i}].unitPrice`,
            `lineItems[${i}].lineTotal`,
          ]
        : [],
    ),
  );
  const survivingIllegible = meta.illegibleFields.filter((f) => !editedPaths.has(f));

  const flags = runChecks({
    invoice,
    meta: { ...meta, illegibleFields: survivingIllegible },
    // Both describe the ORIGINAL model call, not this record's current state.
    // Re-asserting them after a human has corrected the record would hold the
    // reviewer responsible for a model failure they already fixed.
    truncated: false,
    repaired: false,
  });

  const lineItemFlags = new Map<string, FieldFlag[]>();
  for (const [i, row] of ordered.entries()) {
    lineItemFlags.set(
      row.id,
      flags.filter((f) => f.field.startsWith(`lineItems[${i}]`)),
    );
  }

  return {
    flags,
    confidence: scoreConfidence(flags, meta.legibility, false),
    status: deriveStatus(flags, true),
    lineItemFlags,
  };
};
