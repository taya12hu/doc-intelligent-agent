import { coerceMoney } from '@dia/shared';
import { normaliseFieldPath } from './checks.js';

/**
 * Normalise a parsed model response before zod sees it.
 *
 * The schema demands numbers; the model sometimes sends `"1,234.50"`. Failing
 * validation over that would spend an API round trip fixing a comma, so we
 * fix it here for free — this is the "cheapest fix first" rule applied to
 * types rather than syntax.
 *
 * Two things this is careful about:
 *
 *  - It only touches KNOWN paths. A blanket "coerce anything that looks like a
 *    number" would turn an invoice number of "2025" into the integer 2025 and
 *    a description of "12" into a quantity.
 *  - Unrecoverable values become null, never a guess. `coerceMoney` returns
 *    null for anything ambiguous, and null is a value the flagging layer
 *    understands. Silently substituting 0 would let a blank cell reconcile as
 *    if it were a real zero.
 */

const MONEY_FIELDS = ['subtotal', 'discountTotal', 'taxTotal', 'grandTotal'] as const;
const LINE_MONEY_FIELDS = ['quantity', 'unitPrice', 'lineTotal'] as const;
const TEXT_FIELDS = ['vendorName', 'invoiceNumber', 'invoiceDate', 'currency'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Empty and placeholder strings mean "absent", and absent is null. */
const cleanText = (v: unknown): string | null => {
  if (typeof v !== 'string') return v === null || v === undefined ? null : v as never;
  const t = v.trim();
  if (!t || ['n/a', 'na', 'none', 'null', 'unknown', '-', '?'].includes(t.toLowerCase())) {
    return null;
  }
  return t;
};

export const coerceEnvelope = (value: unknown): unknown => {
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = { ...value };

  if (isRecord(out.invoice)) {
    const invoice: Record<string, unknown> = { ...out.invoice };

    for (const field of TEXT_FIELDS) {
      if (field in invoice) invoice[field] = cleanText(invoice[field]);
    }
    // ISO-4217 codes are conventionally upper case; the model is inconsistent.
    if (typeof invoice.currency === 'string') {
      invoice.currency = invoice.currency.toUpperCase().slice(0, 3);
    }

    for (const field of MONEY_FIELDS) {
      if (field in invoice) invoice[field] = coerceMoney(invoice[field]);
    }

    // A discount written as -6292.50 means the same as 6292.50. The schema says
    // positive magnitude and stage-2 reconciliation subtracts it, so a negative
    // here would add the discount to the total instead.
    if (typeof invoice.discountTotal === 'number' && invoice.discountTotal < 0) {
      invoice.discountTotal = Math.abs(invoice.discountTotal);
    }

    if (Array.isArray(invoice.lineItems)) {
      invoice.lineItems = invoice.lineItems.map((row) => {
        if (!isRecord(row)) return row;
        const item: Record<string, unknown> = { ...row };
        item.description = typeof item.description === 'string' ? item.description.trim() : '';
        for (const field of LINE_MONEY_FIELDS) {
          if (field in item) item[field] = coerceMoney(item[field]);
        }
        return item;
      });
    } else {
      // The model omitted the array entirely. `[]` is the honest reading —
      // "no rows were returned" — and it lets validation proceed so the
      // missing-field check can flag it properly.
      invoice.lineItems = [];
    }

    out.invoice = invoice;
  }

  if (isRecord(out.meta)) {
    const meta: Record<string, unknown> = { ...out.meta };
    const legibility = coerceMoney(meta.legibility);
    meta.legibility = legibility === null ? 1 : Math.min(1, Math.max(0, legibility));
    // Normalise here, at the single point where model output is parsed, so
    // everything downstream — flags, the persisted `raw`, and the
    // edited-field comparison in recheck.ts — sees the same path spelling.
    // Doing it only at flag-creation time left recheck comparing the model's
    // "invoice.lineItems[2].unitPrice" against our "lineItems[2].unitPrice",
    // so an illegibility flag would never clear after a human fixed the field.
    meta.illegibleFields = Array.isArray(meta.illegibleFields)
      ? meta.illegibleFields
          .filter((f): f is string => typeof f === 'string')
          .map(normaliseFieldPath)
      : [];
    meta.notes = typeof meta.notes === 'string' ? meta.notes : '';
    meta.invoiceDateAsPrinted = cleanText(meta.invoiceDateAsPrinted);
    out.meta = meta;
  } else {
    out.meta = { illegibleFields: [], legibility: 1, notes: '', invoiceDateAsPrinted: null };
  }

  return out;
};
