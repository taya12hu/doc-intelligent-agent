import { describe, expect, it } from 'vitest';
import type { ExtractionRow, LineItemRow } from '../db/schema.js';
import { recheck } from './recheck.js';

/**
 * A flag that can never be cleared is decoration. A flag that disappears the
 * moment the reviewer fixes the number underneath it is feedback. These tests
 * pin that difference.
 */

const extraction = (over: Partial<ExtractionRow> = {}): ExtractionRow =>
  ({
    id: 'e1',
    documentId: 'd1',
    provider: 'gemini',
    model: 'flash',
    escalatedTo: null,
    samples: 3,
    attempts: 3,
    latencyMs: 1000,
    tokensIn: 100,
    tokensOut: 200,
    repairLog: [],
    raw: { illegibleFields: [], legibility: 1, notes: '', invoiceDateAsPrinted: null },
    status: 'needs_review',
    confidence: 0.5,
    flags: [],
    vendorName: 'Acme Supplies Inc.',
    invoiceNumber: 'INV-2025-0417',
    invoiceDate: '2025-03-12',
    currency: 'USD',
    subtotal: 429.8,
    discountTotal: null,
    taxTotal: 35.46,
    grandTotal: 465.26,
    isCurrent: true,
    reviewedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as ExtractionRow;

const row = (position: number, over: Partial<LineItemRow> = {}): LineItemRow =>
  ({
    id: `li${position}`,
    extractionId: 'e1',
    position,
    description: 'Item',
    quantity: 2,
    unitPrice: 10,
    lineTotal: 20,
    flags: [],
    isEdited: false,
    ...over,
  }) as LineItemRow;

const acmeRows = (): LineItemRow[] => [
  row(0, { description: 'A4 Copier Paper', quantity: 40, unitPrice: 4.25, lineTotal: 170 }),
  row(1, { description: 'Ballpoint Pens', quantity: 12, unitPrice: 8.9, lineTotal: 106.8 }),
  row(2, { description: 'Manila Folders', quantity: 6, unitPrice: 14.5, lineTotal: 87 }),
  row(3, { description: 'Desk Organiser', quantity: 3, unitPrice: 22, lineTotal: 66 }),
];

describe('recheck', () => {
  it('clears to `extracted` once a correction makes the record balance', () => {
    const rows = acmeRows();
    rows[0]!.lineTotal = 999; // the reviewer is about to fix this

    const before = recheck(extraction(), rows);
    expect(before.status).toBe('needs_review');
    expect(before.flags.some((f) => f.reason === 'math_mismatch')).toBe(true);

    rows[0]!.lineTotal = 170;
    rows[0]!.isEdited = true;

    const after = recheck(extraction(), rows);
    expect(after.flags).toEqual([]);
    expect(after.status).toBe('extracted');
    expect(after.confidence).toBe(1);
  });

  it('drops "the model could not read this" once a HUMAN has typed a value', () => {
    // Otherwise the reviewer can never clear the record: they read the smudged
    // number off the source pane, typed it in, and the system still insists it
    // is unreadable. The illegibility was a fact about the model, not the field.
    const raw = { illegibleFields: ['lineItems[2].unitPrice'], legibility: 0.6, notes: '' };

    const untouched = recheck(extraction({ raw }), acmeRows());
    expect(untouched.flags.some((f) => f.reason === 'illegible_source')).toBe(true);

    const edited = acmeRows();
    edited[2]!.isEdited = true;
    const corrected = recheck(extraction({ raw }), edited);
    expect(corrected.flags.some((f) => f.reason === 'illegible_source')).toBe(false);
  });

  it('does not re-assert truncation or repair after a human has fixed the record', () => {
    // Both describe the original model call. Holding the reviewer responsible
    // for a model failure they have already corrected is just noise.
    const v = recheck(extraction(), acmeRows());
    expect(v.flags.some((f) => f.reason === 'truncated')).toBe(false);
    expect(v.flags.some((f) => f.reason === 'repair_required')).toBe(false);
  });

  it('raises NEW flags when an edit breaks the arithmetic', () => {
    // The reviewer is not trusted either. Editing a total to something that
    // does not reconcile is caught exactly like a bad extraction would be.
    const rows = acmeRows();
    rows[1]!.lineTotal = 500;
    rows[1]!.isEdited = true;

    const v = recheck(extraction(), rows);
    expect(v.flags.some((f) => f.reason === 'row_math_mismatch')).toBe(true);
    expect(v.status).toBe('needs_review');
  });

  it('keeps a low-legibility cap on confidence even when everything balances', () => {
    const v = recheck(extraction({ raw: { illegibleFields: [], legibility: 0.4, notes: '' } }), acmeRows());
    expect(v.confidence).toBeLessThanOrEqual(0.4);
  });

  it('maps per-row flags back to the right line item ids', () => {
    const rows = acmeRows();
    rows[2]!.lineTotal = 90; // 6 x 14.50 != 90

    const v = recheck(extraction(), rows);
    expect(v.lineItemFlags.get('li2')?.length).toBeGreaterThan(0);
    expect(v.lineItemFlags.get('li0')).toEqual([]);
  });
});
