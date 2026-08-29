import { z } from 'zod';

/**
 * The canonical invoice shape.
 *
 * Two rules drive every decision in this file (ARCHITECTURE.md §5.1):
 *
 * 1. EVERY FIELD IS NULLABLE, NOTHING IS OPTIONAL.
 *    A missing key is ambiguous — did the model not find the value, or did it
 *    forget to emit it? An explicit `null` is a signal we can flag. Gemini's
 *    responseSchema wants every property required anyway, so this costs us
 *    nothing and buys us a clean "the model said it couldn't find this".
 *
 * 2. NUMBERS ARE NUMBERS.
 *    The prompt tells the model to strip currency symbols and separators.
 *    It will sometimes ignore that, so `coerceMoney` repairs `"1,23,456.00"`
 *    before validation. If coercion fails the field becomes null and gets an
 *    `unparseable` flag — never a crash, never a silent wrong number.
 */

/**
 * A single row of the invoice's line-item table.
 *
 * The `.describe()` calls are not documentation — they are emitted into
 * Gemini's `responseSchema` and are attended to more reliably than the same
 * text in the prompt. Per-field semantics live here; global rules live in
 * `prompt.ts`.
 */
export const LineItemSchema = z.object({
  description: z.string().describe("The item's description text, as printed."),
  quantity: z.number().nullable().describe('Quantity as a plain number. null if not stated.'),
  unitPrice: z
    .number()
    .nullable()
    .describe('Price per unit. Plain number: no currency symbol, no thousands separators.'),
  lineTotal: z
    .number()
    .nullable()
    .describe('Total for this row. Plain number. null if the cell is blank or unreadable.'),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const InvoiceSchema = z.object({
  vendorName: z
    .string()
    .nullable()
    .describe(
      'The company ISSUING the invoice (seller/supplier), not the recipient. ' +
        'It may appear only in a logo or letterhead rather than next to a label.',
    ),
  invoiceNumber: z
    .string()
    .nullable()
    .describe(
      'The invoice identifier. Labels vary widely: "Invoice #", "Bill No.", ' +
        '"Ref", "Document No.". Take the value, not the label.',
    ),

  /**
   * The model is asked for ISO `yyyy-mm-dd`. It often obliges; when it does
   * not, `normalizeDate` handles `14-Mar-2025`, `03/04/2025` and friends.
   * Genuinely ambiguous day/month pairs are resolved to a guess AND flagged —
   * they cannot be resolved from a single document without vendor context.
   */
  invoiceDate: z
    .string()
    .nullable()
    .describe('Date the invoice was ISSUED, as ISO yyyy-mm-dd. Not the due date.'),

  /** ISO-4217. Beyond the brief, but it stops the arithmetic checks from
   *  silently comparing mixed units, and it tells the reviewer "this is INR". */
  currency: z
    .string()
    .nullable()
    .describe('ISO-4217 code: USD, INR, EUR, GBP. Infer from the symbol if not spelled out.'),

  lineItems: z
    .array(LineItemSchema)
    .describe(
      'Every row of the line-item table, in document order. Do NOT put ' +
        'subtotal, discount, tax, shipping or grand-total rows in here — ' +
        'those belong in the dedicated fields below.',
    ),

  /**
   * The adjustment band between the line items and the total.
   *
   * Without these three, ANY invoice carrying tax or a discount makes
   * `sum(lineTotal) !== grandTotal`, and our single strongest check fires a
   * false positive on a perfectly correct extraction — which teaches the
   * reviewer to ignore the flag. Modelling the band explicitly turns one
   * brittle check into the two-stage reconciliation in `checks.ts`, which is
   * both stricter and quieter.
   *
   * The alternative — letting tax and discount masquerade as line items with
   * negative totals — makes the sum balance but corrupts the line-item table
   * the human actually has to review.
   */
  subtotal: z
    .number()
    .nullable()
    .describe(
      'Sum of the line items BEFORE tax and discount. null if the invoice ' +
        'does not state one — do not compute it yourself.',
    ),
  /** Positive magnitude. Subtracted in stage 2. */
  discountTotal: z
    .number()
    .nullable()
    .describe('Total discount as a POSITIVE number. null if there is no discount.'),
  taxTotal: z
    .number()
    .nullable()
    .describe('Total tax / VAT / GST. null if the invoice has none.'),

  grandTotal: z.number().nullable().describe('The final amount payable.'),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/**
 * The model's own report on the extraction, returned alongside the invoice.
 *
 * This is the mechanism that keeps uncertainty alive through the pipeline
 * instead of laundering it into a hallucination: rather than guessing at a
 * smudged number, the model names the fields it could not read, we write
 * `null` for them, and that becomes an `illegible_source` flag in the UI.
 *
 * `meta` NEVER contaminates the canonical record. It lands in
 * `extractions.raw` and feeds the flagging logic. In particular
 * `legibility` is used as a confidence multiplier, not as a confidence
 * score — a model's opinion of itself is weakly calibrated at best.
 */
export const ExtractionMetaSchema = z.object({
  /** Field paths the model could not read, e.g. `["grandTotal", "lineItems[2].unitPrice"]`. */
  illegibleFields: z
    .array(z.string())
    .describe(
      'Paths of fields you could NOT read clearly, e.g. ["grandTotal", ' +
        '"lineItems[2].unitPrice"]. Empty array if everything was legible. ' +
        'Listing a field here is always better than guessing at its value.',
    ),
  /** 0–1 read on source quality. Only meaningful on the scanned path. */
  legibility: z
    .number()
    .describe(
      'How legible the source was overall, 0 to 1. 1 = clean digital text. ' +
        '0.5 = a poor scan you had to work at. 0.2 = mostly unreadable.',
    ),
  /**
   * The date EXACTLY as printed, before ISO conversion.
   *
   * Without this, `MM/DD` vs `DD/MM` ambiguity is undetectable. Once the model
   * has normalised `08/03/2025` to `2025-08-03`, nothing downstream can tell
   * whether that was a reading or a coin flip — the ISO string looks equally
   * confident either way. Keeping the printed form lets `checks.ts` see two
   * components both <= 12 and flag it, which is the honest answer: the
   * ambiguity is a property of the document and cannot be resolved from it.
   */
  invoiceDateAsPrinted: z
    .string()
    .nullable()
    .describe(
      'The invoice date EXACTLY as it appears on the document, before you ' +
        'converted it to ISO. e.g. "14-Mar-2025", "08/03/2025", "March 12, 2025". ' +
        'null if you could not find a date.',
    ),

  /** Free text, e.g. "a discount row and a GST row sit above the total". */
  notes: z
    .string()
    .describe(
      'Anything notable about the layout — unusual labels, a discount or tax ' +
        'row, a second table, a stain over part of the page. Empty string if nothing.',
    ),
});
export type ExtractionMeta = z.infer<typeof ExtractionMetaSchema>;

/** Exactly what one model call is expected to return. */
export const ExtractionEnvelopeSchema = z.object({
  invoice: InvoiceSchema,
  meta: ExtractionMetaSchema,
});
export type ExtractionEnvelope = z.infer<typeof ExtractionEnvelopeSchema>;

/**
 * Fields whose absence is worth flagging.
 *
 * Deliberately NOT the full field list: `subtotal`, `discountTotal` and
 * `taxTotal` are legitimately absent on a simple invoice, so a null there is
 * only interesting when stage-2 reconciliation fails to balance without it.
 * `currency` is a nice-to-have. Flagging those unconditionally would be noise,
 * and a flag that fires when nothing is wrong is worse than no flag at all.
 */
export const REQUIRED_INVOICE_FIELDS = [
  'vendorName',
  'invoiceNumber',
  'invoiceDate',
  'grandTotal',
] as const satisfies readonly (keyof Invoice)[];

/** Scalar fields the consensus pass votes on, field by field. */
export const CONSENSUS_SCALAR_FIELDS = [
  'vendorName',
  'invoiceNumber',
  'invoiceDate',
  'currency',
  'subtotal',
  'discountTotal',
  'taxTotal',
  'grandTotal',
] as const satisfies readonly (keyof Invoice)[];

/** An empty record, used when extraction fails outright but we still want a row. */
export const emptyInvoice = (): Invoice => ({
  vendorName: null,
  invoiceNumber: null,
  invoiceDate: null,
  currency: null,
  lineItems: [],
  subtotal: null,
  discountTotal: null,
  taxTotal: null,
  grandTotal: null,
});
