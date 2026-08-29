import { flagHeadline, type ExtractionEnvelope, type Invoice, type LineItem } from '@dia/shared';
import { describe, expect, it } from 'vitest';
import { buildConsensus, similarity } from './consensus.js';

const line = (over: Partial<LineItem> = {}): LineItem => ({
  description: 'Steel Plate 6mm',
  quantity: 8,
  unitPrice: 187.5,
  lineTotal: 1500,
  ...over,
});

const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  vendorName: 'Blue Ridge Fabrication LLC',
  invoiceNumber: 'BR-4471',
  invoiceDate: '2025-08-03',
  currency: 'USD',
  lineItems: [line()],
  subtotal: 3942.5,
  discountTotal: null,
  taxTotal: 236.55,
  grandTotal: 4179.05,
  ...over,
});

const envelope = (over: Partial<Invoice> = {}): ExtractionEnvelope => ({
  invoice: invoice(over),
  meta: { illegibleFields: [], legibility: 0.6, notes: '', invoiceDateAsPrinted: '08/03/2025' },
});

describe('buildConsensus', () => {
  it('reports nothing when all passes agree', () => {
    const r = buildConsensus([envelope(), envelope(), envelope()]);
    expect(r.flags).toEqual([]);
    expect(r.agreement.grandTotal).toBe('unanimous');
    expect(r.invoice.grandTotal).toBe(4179.05);
  });

  it('takes the majority on 2-of-3 and flags it as a warning', () => {
    const r = buildConsensus([
      envelope({ grandTotal: 4179.05 }),
      envelope({ grandTotal: 4779.05 }),
      envelope({ grandTotal: 4179.05 }),
    ]);
    expect(r.invoice.grandTotal).toBe(4179.05);
    const f = r.flags.find((x) => x.field === 'grandTotal');
    expect(f?.reason).toBe('low_agreement');
    expect(f?.severity).toBe('warn');
    // The reviewer needs to see the actual competing values, not the word
    // "disagreement".
    expect(f?.detail).toContain('4179.05');
    expect(f?.detail).toContain('4779.05');
  });

  it('never claims more passes than were actually run', () => {
    // The flag headline used to read "All three extraction passes..." on a
    // two-pass run. A small lie, in the one place the system is supposed to be
    // scrupulous about what it actually observed.
    const r = buildConsensus([envelope({ grandTotal: 1 }), envelope({ grandTotal: 2 })]);
    const f = r.flags.find((x) => x.field === 'grandTotal');
    expect(flagHeadline(f!.reason)).not.toMatch(/three/i);
  });

  it('escalates a three-way split to an error and keeps the deterministic pass', () => {
    // This is the coffee-ring case: the model can almost read the total, and
    // reads it differently every time.
    const r = buildConsensus([
      envelope({ grandTotal: 4179.05 }),
      envelope({ grandTotal: 4779.05 }),
      envelope({ grandTotal: 4176.05 }),
    ]);
    const f = r.flags.find((x) => x.field === 'grandTotal');
    expect(f?.reason).toBe('disagreement');
    expect(f?.severity).toBe('error');
    // Sample 0 is the temperature-0 pass. With no majority, the greedy decode
    // beats picking at random.
    expect(r.invoice.grandTotal).toBe(4179.05);
  });

  it('does not treat cosmetic string differences as disagreement', () => {
    // "Acme Supplies Inc." vs "Acme Supplies Inc" is the same answer. Flagging
    // it would bury the real disagreements in noise.
    const r = buildConsensus([
      envelope({ vendorName: 'Blue Ridge Fabrication LLC' }),
      envelope({ vendorName: 'Blue Ridge Fabrication, LLC' }),
      envelope({ vendorName: 'blue ridge fabrication llc' }),
    ]);
    expect(r.flags.find((f) => f.field === 'vendorName')).toBeUndefined();
  });

  it('distinguishes null from a value — a pass that read nothing disagrees', () => {
    const r = buildConsensus([
      envelope({ taxTotal: 236.55 }),
      envelope({ taxTotal: null }),
      envelope({ taxTotal: null }),
    ]);
    expect(r.invoice.taxTotal).toBeNull();
    expect(r.flags.find((f) => f.field === 'taxTotal')?.reason).toBe('low_agreement');
  });

  it('votes cell by cell inside line items', () => {
    const r = buildConsensus([
      envelope({ lineItems: [line({ unitPrice: 43.75 })] }),
      envelope({ lineItems: [line({ unitPrice: 48.75 })] }),
      envelope({ lineItems: [line({ unitPrice: 43.75 })] }),
    ]);
    expect(r.invoice.lineItems[0]!.unitPrice).toBe(43.75);
    expect(r.flags.find((f) => f.field === 'lineItems[0].unitPrice')?.reason).toBe('low_agreement');
  });

  it('flags a row-COUNT disagreement wholesale rather than aligning mismatched rows', () => {
    // Trying to align a 1-row reading against a 2-row one invents a
    // correspondence that may not exist. The honest signal is "the passes
    // disagree about how many rows there are".
    const r = buildConsensus([
      envelope({ lineItems: [line(), line({ description: 'Laser Cutting' })] }),
      envelope({ lineItems: [line()] }),
      envelope({ lineItems: [line(), line({ description: 'Laser Cutting' })] }),
    ]);
    const f = r.flags.find((x) => x.field === 'lineItems');
    expect(f?.reason).toBe('disagreement');
    expect(f?.detail).toContain('2 / 1 / 2');
    // The modal reading wins.
    expect(r.invoice.lineItems).toHaveLength(2);
  });

  it('flags a row where the passes read different ITEMS at the same position', () => {
    const r = buildConsensus([
      envelope({ lineItems: [line({ description: 'Steel Plate 6mm' })] }),
      envelope({ lineItems: [line({ description: 'Powder Coating, matte black' })] }),
      envelope({ lineItems: [line({ description: 'Steel Plate 6mm' })] }),
    ]);
    expect(r.flags.find((f) => f.field === 'lineItems[0].description')?.reason).toBe(
      'disagreement',
    );
  });

  it('emits no agreement flags at all when only one sample was run', () => {
    // EXTRACTION_SAMPLES=1 disables self-consistency. Reporting unanimity
    // from a single pass would be claiming a signal we did not measure.
    const r = buildConsensus([envelope()]);
    expect(r.flags).toEqual([]);
  });

  it('takes meta from the deterministic pass rather than averaging', () => {
    // meta describes ONE reading. Averaging three reports about three
    // different readings would be meaningless.
    const first = envelope();
    first.meta.illegibleFields = ['grandTotal'];
    const r = buildConsensus([first, envelope(), envelope()]);
    expect(r.meta.illegibleFields).toEqual(['grandTotal']);
  });
});

describe('similarity', () => {
  it('ignores case and punctuation', () => {
    expect(similarity('Hex Bolt M10x50 (box 100)', 'hex bolt m10x50 box 100')).toBe(1);
  });

  it('scores near-misses high and unrelated strings low', () => {
    expect(similarity('Steel Plate 6mm', 'Steel Plate 6 mm')).toBeGreaterThan(0.9);
    expect(similarity('Steel Plate 6mm', 'Powder Coating')).toBeLessThan(0.4);
  });
});
