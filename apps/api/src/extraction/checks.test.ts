import type { ExtractionMeta, Invoice } from '@dia/shared';
import { describe, expect, it } from 'vitest';
import { ACME, NORTHWIND, ZENITH } from '../../../../samples/generate/src/data.js';
import {
  checkImplausible,
  checkReconciliationStage1,
  checkReconciliationStage2,
  checkRowArithmetic,
  deriveMissingLineTotals,
  runChecks,
} from './checks.js';

/**
 * The checks are tested against the ACTUAL sample fixtures, imported from the
 * generator. If I change a price in a sample document, these tests follow —
 * there is no second copy of the numbers to drift.
 */

const meta = (over: Partial<ExtractionMeta> = {}): ExtractionMeta => ({
  illegibleFields: [],
  legibility: 1,
  notes: '',
  invoiceDateAsPrinted: null,
  ...over,
});

const invoiceOf = (spec: typeof ACME): Invoice => structuredClone(spec.expected) as Invoice;

const ctx = (invoice: Invoice, over: Partial<ExtractionMeta> = {}) => ({
  invoice,
  meta: meta(over),
  truncated: false,
  repaired: false,
});

describe('the false-positive test — a correct invoice must produce NO flags', () => {
  it('passes a clean invoice with sales tax (#1 Acme)', () => {
    expect(runChecks(ctx(invoiceOf(ACME)))).toEqual([]);
  });

  it('passes an invoice with a DISCOUNT and GST (#2 Northwind)', () => {
    // This is the single most important test in the file.
    //
    // sum(lineItems) is 125,850 and grandTotal is 141,077.85. A one-stage
    // "do the lines add up to the total" check flags this perfectly correct
    // extraction. Two-stage reconciliation does not, and that difference is
    // why subtotal/discountTotal/taxTotal are modelled at all.
    //
    // A flag that fires when nothing is wrong is worse than no flag: it
    // teaches the reviewer to ignore the amber rings.
    const invoice = invoiceOf(NORTHWIND);
    const lineSum = invoice.lineItems.reduce((a, li) => a + (li.lineTotal ?? 0), 0);
    expect(lineSum).not.toBeCloseTo(invoice.grandTotal!, 2); // the trap is real
    expect(runChecks(ctx(invoice))).toEqual([]);
  });
});

describe('recovering blank cells (#4 Zenith)', () => {
  const invoice = invoiceOf(ZENITH);

  it('derives the blank line total from quantity x unit price', () => {
    const derived = deriveMissingLineTotals(invoice);
    expect(derived).toEqual([{ row: 4, value: 250 }]);
  });

  it('does NOT report a subtotal mismatch once the blank is accounted for', () => {
    // The printed lines sum to 4,724 against a printed subtotal of 4,974.
    // Without recovery that is a 250.00 "mismatch" on a correct reading.
    const derived = deriveMissingLineTotals(invoice);
    expect(checkReconciliationStage1(invoice, derived)).toEqual([]);
  });

  it('still flags the blank, with the derived value as a SUGGESTION not a fact', () => {
    const flags = runChecks(ctx(invoice));
    const blank = flags.find((f) => f.field === 'lineItems[4].lineTotal');
    expect(blank?.reason).toBe('missing');
    expect(blank?.detail).toContain('250.00');
    // The record itself keeps null. We do not quietly write a number the
    // document does not contain.
    expect(invoice.lineItems[4]!.lineTotal).toBeNull();
    expect(blank?.detail).toMatch(/confirm/i);
  });
});

describe('reconciliation stage 1', () => {
  it('flags a genuine subtotal mismatch with both numbers', () => {
    const invoice = invoiceOf(ACME);
    invoice.lineItems[0]!.lineTotal = 999;
    const flags = checkReconciliationStage1(invoice, []);
    expect(flags[0]?.reason).toBe('math_mismatch');
    expect(flags[0]?.field).toBe('subtotal');
    expect(flags[0]?.detail).toContain('429.80');
  });

  it('falls back to the grand total only when there are no adjustments', () => {
    const invoice: Invoice = {
      ...invoiceOf(ACME),
      subtotal: null,
      taxTotal: null,
      grandTotal: 429.8,
    };
    expect(checkReconciliationStage1(invoice, [])).toEqual([]);

    // With tax present but no subtotal, comparing lines to the grand total
    // would be wrong, so we decline to check rather than flag a guess.
    const withTax: Invoice = { ...invoice, taxTotal: 35.46, grandTotal: 465.26 };
    expect(checkReconciliationStage1(withTax, [])).toEqual([]);
  });

  it('declines to check when a row is neither readable nor derivable', () => {
    const invoice = invoiceOf(ACME);
    invoice.lineItems[1] = { description: 'x', quantity: null, unitPrice: null, lineTotal: null };
    // The blank is already flagged as missing; a mismatch on top would be two
    // flags for one problem.
    expect(checkReconciliationStage1(invoice, [])).toEqual([]);
  });
});

describe('reconciliation stage 2', () => {
  it('flags an unbalanced totals band', () => {
    const invoice = { ...invoiceOf(ACME), grandTotal: 500 };
    const flags = checkReconciliationStage2(invoice);
    expect(flags[0]?.field).toBe('grandTotal');
    expect(flags[0]?.detail).toContain('465.26');
  });

  it('points at the missing tax row when the total is higher than it should be', () => {
    // An unexplained positive delta usually means a row we failed to read,
    // not that the arithmetic on the page is wrong.
    const invoice = { ...invoiceOf(ACME), taxTotal: null };
    const flags = checkReconciliationStage2(invoice);
    expect(flags.find((f) => f.field === 'taxTotal')?.reason).toBe('missing');
    expect(flags.find((f) => f.field === 'taxTotal')?.detail).toMatch(/tax or charge row/);
  });

  it('points at the missing discount row when the total is lower', () => {
    const invoice = { ...invoiceOf(NORTHWIND), discountTotal: null };
    const flags = checkReconciliationStage2(invoice);
    expect(flags.find((f) => f.field === 'discountTotal')?.reason).toBe('missing');
  });
});

describe('row arithmetic', () => {
  it('flags a row whose quantity x price does not match its total', () => {
    const invoice = invoiceOf(ACME);
    invoice.lineItems[2]!.lineTotal = 90;
    const flags = checkRowArithmetic(invoice);
    expect(flags[0]?.field).toBe('lineItems[2].lineTotal');
    expect(flags[0]?.detail).toContain('87.00');
  });

  it('skips rows with a null anywhere — nothing to compare', () => {
    const invoice = invoiceOf(ZENITH);
    expect(checkRowArithmetic(invoice)).toEqual([]);
  });
});

describe('implausible values', () => {
  it('catches an order-of-magnitude separator misread', () => {
    // "1,41,077.85" read as 141077850.
    const invoice = { ...invoiceOf(NORTHWIND), grandTotal: 141_077_850 };
    const flags = checkImplausible(invoice);
    expect(flags.some((f) => f.reason === 'implausible_value')).toBe(true);
  });

  it('catches negative totals and absurd quantities', () => {
    const invoice = invoiceOf(ACME);
    invoice.grandTotal = -100;
    invoice.lineItems[0]!.quantity = 5_000_000;
    const flags = checkImplausible(invoice);
    expect(flags).toHaveLength(2);
  });
});

describe('legibility and repair signals', () => {
  it('flags fields the model reported as unreadable', () => {
    const flags = runChecks(
      ctx(invoiceOf(ACME), { illegibleFields: ['grandTotal', 'lineItems[2].unitPrice'] }),
    );
    expect(flags.filter((f) => f.reason === 'illegible_source')).toHaveLength(2);
  });

  it('normalises model-authored field paths so the flag is not orphaned', () => {
    // Gemini actually returns "invoice.grandTotal" — correct from its point of
    // view, since the envelope really does nest the record under `invoice`.
    // Left alone, the UI matches on `flag.field === 'grandTotal'` and the flag
    // renders NOWHERE: not on the input, not in the record banner. The most
    // important flag on the scanned sample was being computed and then
    // silently dropped. Caught by reading a real eval output, not a unit test.
    const flags = runChecks(
      ctx(invoiceOf(ACME), {
        illegibleFields: ['invoice.grandTotal', 'invoice.lineItems.2.unitPrice', '$.subtotal'],
      }),
    );
    const paths = flags.filter((f) => f.reason === 'illegible_source').map((f) => f.field);
    expect(paths).toEqual(['grandTotal', 'lineItems[2].unitPrice', 'subtotal']);
  });

  it('normalises snake_case paths too', () => {
    const flags = runChecks(
      ctx(invoiceOf(ACME), { illegibleFields: ['invoice.lineItems[1].unit_price'] }),
    );
    expect(flags.find((f) => f.reason === 'illegible_source')?.field).toBe(
      'lineItems[1].unitPrice',
    );
  });

  it('flags an ambiguous printed date and explains both readings', () => {
    const invoice = { ...invoiceOf(ACME), invoiceDate: '2025-08-03' };
    const flags = runChecks(ctx(invoice, { invoiceDateAsPrinted: '08/03/2025' }));
    const dateFlag = flags.find((f) => f.reason === 'ambiguous_date');
    expect(dateFlag?.detail).toContain('3 Aug 2025');
    expect(dateFlag?.detail).toContain('8 Mar 2025');
  });

  it('raises record-level flags for a bad scan, truncation and repair', () => {
    const flags = runChecks({
      invoice: invoiceOf(ACME),
      meta: meta({ legibility: 0.3 }),
      truncated: true,
      repaired: true,
    });
    const reasons = flags.filter((f) => f.field === '_record').map((f) => f.reason);
    expect(reasons).toContain('low_legibility');
    expect(reasons).toContain('truncated');
    expect(reasons).toContain('repair_required');
  });

  it('keeps distinct facts about one field but not duplicates of the same fact', () => {
    // An illegible grand total is also a mismatched one — both are worth
    // saying. The same reason twice is just noise.
    const invoice = { ...invoiceOf(ACME), grandTotal: 999 };
    const flags = runChecks(ctx(invoice, { illegibleFields: ['grandTotal'] }));
    const onGrandTotal = flags.filter((f) => f.field === 'grandTotal');
    expect(onGrandTotal.length).toBeGreaterThan(1);
    expect(new Set(onGrandTotal.map((f) => f.reason)).size).toBe(onGrandTotal.length);
  });
});
