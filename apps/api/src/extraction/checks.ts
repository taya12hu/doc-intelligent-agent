import {
  REQUIRED_INVOICE_FIELDS,
  flag,
  type ExtractionMeta,
  type FieldFlag,
  type Invoice,
  MONEY_EPSILON,
  moneyEquals,
  round2,
} from '@dia/shared';
import { isImplausibleDate, normaliseDate } from '../lib/date.js';

/**
 * Deterministic checks. Nothing here calls a model.
 *
 * Consensus catches UNCERTAINTY — fields the model was unstable about. These
 * checks catch ERROR — fields it was perfectly confident about and still got
 * wrong. Three passes can agree on a hallucinated total; they cannot make it
 * add up. That makes this file the strongest signal in the pipeline, and it
 * costs nothing per document.
 *
 * All pure functions, so all of it is tested without a network.
 */

export type CheckContext = {
  invoice: Invoice;
  meta: ExtractionMeta;
  /** Output was cut off at the token ceiling. */
  truncated: boolean;
  /** The repair loop had to intervene at least once. */
  repaired: boolean;
};

const fmt = (n: number): string =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

// ── line totals we can recover ────────────────────────────────────────

export type DerivedTotal = { row: number; value: number };

/**
 * Fill blank line totals from quantity x unit price — FOR CHECKING ONLY.
 *
 * Sample #4 leaves an Amount cell blank. The correct extraction returns null
 * there (the document does not contain that number), but then the line items
 * legitimately fail to sum to the printed subtotal, and a naive stage-1 check
 * would flag a perfectly correct reading.
 *
 * So we derive the value, use it to reconcile, and DO NOT write it into the
 * record. The reviewer still sees a blank cell and a flag telling them what
 * it would be — a suggestion they can accept, not a number we quietly
 * invented on the document's behalf.
 */
export const deriveMissingLineTotals = (invoice: Invoice): DerivedTotal[] => {
  const derived: DerivedTotal[] = [];
  for (const [row, item] of invoice.lineItems.entries()) {
    if (item.lineTotal !== null) continue;
    if (item.quantity === null || item.unitPrice === null) continue;
    derived.push({ row, value: round2(item.quantity * item.unitPrice) });
  }
  return derived;
};

// ── reconciliation ────────────────────────────────────────────────────

/**
 * Stage 1: do the line items add up to the subtotal?
 *
 * Falls back to comparing against the grand total ONLY when there is no
 * subtotal and no adjustments — otherwise a tax line makes a correct invoice
 * look broken, which is the false positive that teaches reviewers to ignore
 * flags.
 */
export const checkReconciliationStage1 = (
  invoice: Invoice,
  derived: DerivedTotal[],
): FieldFlag[] => {
  const { lineItems, subtotal, discountTotal, taxTotal, grandTotal } = invoice;
  if (lineItems.length === 0) return [];

  const hasAdjustments = discountTotal !== null || taxTotal !== null;
  const target = subtotal ?? (hasAdjustments ? null : grandTotal);
  const targetField = subtotal !== null ? 'subtotal' : 'grandTotal';
  if (target === null) return [];

  const derivedByRow = new Map(derived.map((d) => [d.row, d.value]));
  const values = lineItems.map((li, i) => li.lineTotal ?? derivedByRow.get(i) ?? null);

  // A row we could neither read nor derive makes the sum meaningless. The
  // blank itself is already flagged by the missing-field check; adding a
  // mismatch on top would be two flags for one problem.
  if (values.some((v) => v === null)) return [];

  const sum = round2((values as number[]).reduce((a, v) => a + v, 0));
  if (moneyEquals(sum, target)) return [];

  const usedDerived = derived.length > 0 ? ' (including recovered blank cells)' : '';
  return [
    flag(
      targetField,
      'math_mismatch',
      `line items total ${fmt(sum)}${usedDerived} but the document states ${fmt(target)} ` +
        `— off by ${fmt(Math.abs(sum - target))}`,
    ),
  ];
};

/**
 * Stage 2: subtotal - discount + tax = grand total?
 *
 * When it does not balance and an adjustment field is null, the null is the
 * more likely culprit: an unexplained delta usually means we failed to read a
 * row that exists, rather than that the arithmetic on the page is wrong. So
 * the flag lands on the missing adjustment, which is where a reviewer should
 * look first.
 */
export const checkReconciliationStage2 = (invoice: Invoice): FieldFlag[] => {
  const { subtotal, discountTotal, taxTotal, grandTotal } = invoice;
  if (subtotal === null || grandTotal === null) return [];

  const computed = round2(subtotal - (discountTotal ?? 0) + (taxTotal ?? 0));
  if (moneyEquals(computed, grandTotal)) return [];

  const delta = round2(grandTotal - computed);
  const parts = [
    `subtotal ${fmt(subtotal)}`,
    discountTotal !== null ? `less discount ${fmt(discountTotal)}` : null,
    taxTotal !== null ? `plus tax ${fmt(taxTotal)}` : null,
  ].filter(Boolean);

  const flags: FieldFlag[] = [
    flag(
      'grandTotal',
      'math_mismatch',
      `${parts.join(', ')} comes to ${fmt(computed)}, but the total states ` +
        `${fmt(grandTotal)} — off by ${fmt(Math.abs(delta))}`,
    ),
  ];

  // A positive delta with no tax field read is very likely an unread tax row.
  if (delta > MONEY_EPSILON && taxTotal === null) {
    flags.push(
      flag(
        'taxTotal',
        'missing',
        `the total is ${fmt(delta)} more than the subtotal — there is probably a tax ` +
          `or charge row that was not read`,
      ),
    );
  }
  if (delta < -MONEY_EPSILON && discountTotal === null) {
    flags.push(
      flag(
        'discountTotal',
        'missing',
        `the total is ${fmt(Math.abs(delta))} less than the subtotal — there is probably ` +
          `a discount row that was not read`,
      ),
    );
  }

  return flags;
};

/** Per-row: quantity x unit price should equal the row total. */
export const checkRowArithmetic = (invoice: Invoice): FieldFlag[] => {
  const flags: FieldFlag[] = [];
  for (const [row, item] of invoice.lineItems.entries()) {
    const { quantity, unitPrice, lineTotal } = item;
    if (quantity === null || unitPrice === null || lineTotal === null) continue;
    const computed = round2(quantity * unitPrice);
    if (moneyEquals(computed, lineTotal)) continue;
    flags.push(
      flag(
        `lineItems[${row}].lineTotal`,
        'row_math_mismatch',
        `${quantity} x ${fmt(unitPrice)} = ${fmt(computed)}, but the row total ` +
          `reads ${fmt(lineTotal)}`,
      ),
    );
  }
  return flags;
};

// ── presence and legibility ───────────────────────────────────────────

export const checkMissingRequired = (invoice: Invoice, derived: DerivedTotal[]): FieldFlag[] => {
  const flags: FieldFlag[] = [];

  for (const field of REQUIRED_INVOICE_FIELDS) {
    if (invoice[field] === null) {
      flags.push(flag(field, 'missing'));
    }
  }

  if (invoice.lineItems.length === 0) {
    flags.push(flag('lineItems', 'missing', 'no line items were found on the document'));
  }

  const derivedByRow = new Map(derived.map((d) => [d.row, d.value]));
  for (const [row, item] of invoice.lineItems.entries()) {
    if (item.lineTotal !== null) continue;
    const suggestion = derivedByRow.get(row);
    flags.push(
      flag(
        `lineItems[${row}].lineTotal`,
        'missing',
        suggestion !== undefined
          ? `blank on the document — ${item.quantity} x ${fmt(item.unitPrice ?? 0)} would be ` +
            `${fmt(suggestion)}, but confirm it before accepting`
          : 'blank on the document, and there is not enough on the row to work it out',
      ),
    );
  }

  return flags;
};

/**
 * Normalise a field path the MODEL produced into one our own code uses.
 *
 * `meta.illegibleFields` is free-form text from the model, and it does not
 * reliably match the paths every other flag uses. In practice it comes back
 * as `invoice.grandTotal` — correct from the model's point of view, since the
 * envelope it fills in really does nest the record under `invoice`.
 *
 * That one dotted prefix made the flag INVISIBLE. The UI decorates a field by
 * matching `flag.field === 'grandTotal'`, so an `illegible_source` error
 * landing on `invoice.grandTotal` rendered nowhere at all: not on the input,
 * not in the record-level banner. The single most important flag on the
 * scanned sample — "the model could not read this, do not trust it" — was
 * being computed correctly and then silently dropped on the floor.
 *
 * Only found it by reading a real eval output. Worth remembering that any
 * model-authored identifier needs normalising before it is used as a key.
 */
export const normaliseFieldPath = (raw: string): string =>
  raw
    .trim()
    .replace(/^invoice\./, '')
    .replace(/^\$\./, '')
    // "lineItems.2.unitPrice" -> "lineItems[2].unitPrice"
    .replace(/lineItems\.(\d+)\./, 'lineItems[$1].')
    // "lineItems[2].unit_price" -> camelCase, in case the model snake-cases
    .replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

/** Fields the model itself said it could not read. */
export const checkIllegible = (meta: ExtractionMeta): FieldFlag[] =>
  meta.illegibleFields.map((field) =>
    flag(
      normaliseFieldPath(field),
      'illegible_source',
      'the model reported this region as unreadable',
    ),
  );

export const checkDate = (invoice: Invoice, meta: ExtractionMeta): FieldFlag[] => {
  const flags: FieldFlag[] = [];
  const { iso, ambiguous, detail } = normaliseDate(invoice.invoiceDate, meta.invoiceDateAsPrinted);

  if (ambiguous) {
    flags.push(flag('invoiceDate', 'ambiguous_date', detail));
  }
  if (isImplausibleDate(iso)) {
    flags.push(flag('invoiceDate', 'implausible_value', `${iso} is not a plausible invoice date`));
  }
  return flags;
};

/** Cheap sanity net for values that passed the schema but cannot be real. */
export const checkImplausible = (invoice: Invoice): FieldFlag[] => {
  const flags: FieldFlag[] = [];

  for (const field of ['subtotal', 'grandTotal'] as const) {
    const value = invoice[field];
    if (value !== null && value < 0) {
      flags.push(flag(field, 'implausible_value', `${fmt(value)} is negative`));
    }
  }

  for (const [row, item] of invoice.lineItems.entries()) {
    if (item.quantity !== null && (item.quantity < 0 || item.quantity > 100_000)) {
      flags.push(
        flag(`lineItems[${row}].quantity`, 'implausible_value', `quantity of ${item.quantity}`),
      );
    }
  }

  // An order-of-magnitude gap usually means a separator was misread —
  // "1,41,077.85" read as 141077850, say.
  const lineSum = invoice.lineItems.reduce((a, li) => a + (li.lineTotal ?? 0), 0);
  if (lineSum > 0 && invoice.grandTotal !== null && invoice.grandTotal > lineSum * 100) {
    flags.push(
      flag(
        'grandTotal',
        'implausible_value',
        `${fmt(invoice.grandTotal)} is more than 100x the line items (${fmt(lineSum)}) ` +
          `— a decimal or separator was probably misread`,
      ),
    );
  }

  return flags;
};

// ── composition ───────────────────────────────────────────────────────

const LOW_LEGIBILITY = 0.5;

export const runChecks = (ctx: CheckContext): FieldFlag[] => {
  const { invoice, meta, truncated, repaired } = ctx;
  const derived = deriveMissingLineTotals(invoice);

  const flags: FieldFlag[] = [
    ...checkMissingRequired(invoice, derived),
    ...checkIllegible(meta),
    ...checkReconciliationStage1(invoice, derived),
    ...checkReconciliationStage2(invoice),
    ...checkRowArithmetic(invoice),
    ...checkDate(invoice, meta),
    ...checkImplausible(invoice),
  ];

  if (meta.legibility < LOW_LEGIBILITY) {
    flags.push(
      flag(
        '_record',
        'low_legibility',
        `the model rated the source ${Math.round(meta.legibility * 100)}% legible`,
      ),
    );
  }
  if (truncated) {
    flags.push(
      flag('_record', 'truncated', 'the model hit its output limit; some rows may be missing'),
    );
  }
  if (repaired) {
    flags.push(
      flag('_record', 'repair_required', 'the first response failed validation and was repaired'),
    );
  }

  return dedupe(flags);
};

/**
 * Collapse duplicate flags on the same field for the same reason.
 *
 * Several checks can legitimately fire on one field — an illegible grand
 * total is also a mismatched one. Keeping both is right, because they are
 * different facts. Keeping the SAME fact twice is just noise in the UI.
 */
const dedupe = (flags: FieldFlag[]): FieldFlag[] => {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const key = `${f.field}|${f.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
