/**
 * Ground truth for the four sample invoices.
 *
 * This file is the input to the generators AND the fixture for `npm run eval`.
 * One definition, so the documents and the expectations cannot drift apart —
 * if I change a price here, the PDF and the eval both follow.
 *
 * `expected` is what a PERFECT extraction returns: the values as PRINTED on
 * the document, not the semantically-correct values. Where sample #4 leaves a
 * line total blank, `expected` is `null` — returning 250.00 there would mean
 * the model computed a number the document does not contain, which is exactly
 * the behaviour we are trying to detect, not reward.
 */

export type ExpectedFlag = {
  /** Field path, e.g. `grandTotal` or `lineItems[2].unitPrice`. */
  field: string;
  /** Why we expect it. Documentation for the eval report, not asserted exactly. */
  why: string;
};

export type SampleSpec = {
  key: string;
  filename: string;
  fileKind: 'pdf_text' | 'pdf_scanned' | 'xlsx';
  /** One line for the README table and the eval output. */
  difficulty: string;
  expected: {
    vendorName: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    currency: string | null;
    lineItems: {
      description: string;
      quantity: number | null;
      unitPrice: number | null;
      lineTotal: number | null;
    }[];
    subtotal: number | null;
    discountTotal: number | null;
    taxTotal: number | null;
    grandTotal: number | null;
  };
  /**
   * Fields the system MUST flag. Not "fields it may get wrong" — fields where
   * silently returning a confident value is a failure even if that value
   * happens to be right.
   */
  mustFlag: ExpectedFlag[];
  expectedStatus: 'extracted' | 'needs_review' | 'failed';
};

// ── #1 Acme — the clean baseline ──────────────────────────────────────
export const ACME: SampleSpec = {
  key: 'acme',
  filename: 'acme-supplies.pdf',
  fileKind: 'pdf_text',
  difficulty: 'Clean digital PDF. Conventional labels, headed table, sales tax.',
  expected: {
    vendorName: 'Acme Supplies Inc.',
    invoiceNumber: 'INV-2025-0417',
    invoiceDate: '2025-03-12',
    currency: 'USD',
    lineItems: [
      { description: 'A4 Copier Paper, 80gsm (ream)', quantity: 40, unitPrice: 4.25, lineTotal: 170.0 },
      { description: 'Ballpoint Pens, blue (box of 50)', quantity: 12, unitPrice: 8.9, lineTotal: 106.8 },
      { description: 'Manila Folders, foolscap (pack of 100)', quantity: 6, unitPrice: 14.5, lineTotal: 87.0 },
      { description: 'Desk Organiser, mesh black', quantity: 3, unitPrice: 22.0, lineTotal: 66.0 },
    ],
    subtotal: 429.8,
    discountTotal: null,
    taxTotal: 35.46,
    grandTotal: 465.26,
  },
  mustFlag: [],
  expectedStatus: 'extracted',
};

// ── #2 Northwind — label variance, Indian grouping, discount + GST ────
export const NORTHWIND: SampleSpec = {
  key: 'northwind',
  filename: 'northwind-trading.pdf',
  fileKind: 'pdf_text',
  difficulty:
    'Vendor only in the letterhead. "Bill No." not "Invoice Number". Date as ' +
    '14-Mar-2025. Indian digit grouping (Rs. 1,41,077.85). A discount row and ' +
    'a GST row sit between the line items and the total.',
  expected: {
    vendorName: 'Northwind Trading Co.',
    invoiceNumber: 'NW/2025/1183',
    invoiceDate: '2025-03-14',
    currency: 'INR',
    lineItems: [
      { description: 'Industrial Bearing 6204-2RS', quantity: 250, unitPrice: 148.0, lineTotal: 37000.0 },
      { description: 'Hydraulic Seal Kit HS-88', quantity: 40, unitPrice: 1250.0, lineTotal: 50000.0 },
      { description: 'V-Belt A-52 (pack of 10)', quantity: 15, unitPrice: 890.0, lineTotal: 13350.0 },
      { description: 'Coupling Sleeve CS-32', quantity: 60, unitPrice: 425.0, lineTotal: 25500.0 },
    ],
    subtotal: 125850.0,
    discountTotal: 6292.5,
    taxTotal: 21520.35,
    grandTotal: 141077.85,
  },
  // Nothing. This sample exists to prove the two-stage reconciliation does NOT
  // cry wolf: sum(lines) != grandTotal here, legitimately, and a naive check
  // would flag a perfectly correct extraction.
  mustFlag: [],
  expectedStatus: 'extracted',
};

// ── #3 Blue Ridge — the degraded scan ─────────────────────────────────
export const BLUE_RIDGE: SampleSpec = {
  key: 'blueridge',
  filename: 'blue-ridge-scan.pdf',
  fileKind: 'pdf_scanned',
  difficulty:
    'Scanned image PDF, no text layer. Rotated 1.8 degrees, blurred, noisy, ' +
    'contrast-crushed, JPEG q35, resampled through 110 DPI. Three values are ' +
    'deliberately hard: a coffee ring over the grand total, ambiguous date ' +
    'digits, and one unit price in the darkest band.',
  expected: {
    vendorName: 'Blue Ridge Fabrication LLC',
    invoiceNumber: 'BR-4471',
    // Printed as 08/03/2025. US vendor, so MM/DD -> 3 August. Unresolvable
    // from the document alone, which is the point: we expect a flag either way.
    invoiceDate: '2025-08-03',
    currency: 'USD',
    lineItems: [
      { description: 'Steel Plate 6mm, 1200x2400', quantity: 8, unitPrice: 187.5, lineTotal: 1500.0 },
      { description: 'Laser Cutting, per hour', quantity: 14, unitPrice: 95.0, lineTotal: 1330.0 },
      { description: 'Powder Coating, matte black', quantity: 22, unitPrice: 43.75, lineTotal: 962.5 },
      { description: 'Delivery, local', quantity: 1, unitPrice: 150.0, lineTotal: 150.0 },
    ],
    subtotal: 3942.5,
    discountTotal: null,
    taxTotal: 236.55,
    grandTotal: 4179.05,
  },
  mustFlag: [
    { field: 'grandTotal', why: 'coffee ring plus ink bleed over the digits' },
    { field: 'invoiceDate', why: '08/03/2025 — ambiguous, and the 8 degrades toward 3/6' },
    { field: 'lineItems[2].unitPrice', why: 'sits in the darkest gradient band, extra local blur' },
    // Collateral, and deliberately kept: a real stain does not respect field
    // boundaries. It also gives stage-2 reconciliation something to catch —
    // if taxTotal is wrong, subtotal - discount + tax stops matching the
    // grand total, and the mismatch is flagged even where legibility was not.
    { field: 'taxTotal', why: 'clipped by the edge of the same coffee ring' },
  ],
  expectedStatus: 'needs_review',
};

// ── #4 Zenith — the awkward spreadsheet ───────────────────────────────
export const ZENITH: SampleSpec = {
  key: 'zenith',
  filename: 'zenith-parts.xlsx',
  fileKind: 'xlsx',
  difficulty:
    'Data does not start at A1 (three title rows, merged cells). Line items ' +
    'split across two labelled blocks with a subtotal between them. Columns ' +
    'are ordered Description | Unit Price | Qty | Amount — qty and unit price ' +
    'swapped relative to every other sample. One Amount cell is blank. ' +
    'TOTAL DUE sits four rows below the table. Currency is EUR.',
  expected: {
    vendorName: 'Zenith Parts & Components',
    invoiceNumber: 'ZP-88213',
    invoiceDate: '2025-02-27',
    currency: 'EUR',
    lineItems: [
      { description: 'Flange Adapter FA-12', quantity: 120, unitPrice: 18.4, lineTotal: 2208.0 },
      { description: 'Shaft Collar SC-25', quantity: 300, unitPrice: 3.75, lineTotal: 1125.0 },
      { description: 'Retaining Ring RR-40', quantity: 500, unitPrice: 0.92, lineTotal: 460.0 },
      { description: 'Hex Bolt M10x50 (box 100)', quantity: 25, unitPrice: 22.6, lineTotal: 565.0 },
      // The Amount cell is BLANK in the sheet. A perfect extraction returns
      // null here — 250.00 would mean the model did arithmetic the document
      // does not contain. Our row-arithmetic check recovers it afterwards,
      // and that recovery is visible to the reviewer rather than silent.
      { description: 'Lock Washer M10 (box 500)', quantity: 8, unitPrice: 31.25, lineTotal: null },
      { description: 'Threaded Rod M12x1000', quantity: 40, unitPrice: 9.15, lineTotal: 366.0 },
    ],
    subtotal: 4974.0,
    discountTotal: null,
    taxTotal: 1044.54,
    grandTotal: 6018.54,
  },
  mustFlag: [{ field: 'lineItems[4].lineTotal', why: 'the Amount cell is blank in the sheet' }],
  expectedStatus: 'needs_review',
};

export const SAMPLES: SampleSpec[] = [ACME, NORTHWIND, BLUE_RIDGE, ZENITH];

/** Sanity: every spec's arithmetic must actually balance, or the fixture lies. */
export const verifySpec = (s: SampleSpec): string[] => {
  const problems: string[] = [];
  const { expected: e } = s;

  const lineSum = e.lineItems.reduce((acc, li) => acc + (li.lineTotal ?? 0), 0);
  // #4's blank cell means the printed lines cannot sum to the printed subtotal.
  // That gap IS the planted difficulty, so allow it where a lineTotal is null.
  const hasBlank = e.lineItems.some((li) => li.lineTotal === null);
  if (!hasBlank && e.subtotal !== null && Math.abs(lineSum - e.subtotal) > 0.02) {
    problems.push(`${s.key}: line items sum to ${lineSum}, subtotal says ${e.subtotal}`);
  }

  if (e.subtotal !== null && e.grandTotal !== null) {
    const computed = e.subtotal - (e.discountTotal ?? 0) + (e.taxTotal ?? 0);
    if (Math.abs(computed - e.grandTotal) > 0.02) {
      problems.push(
        `${s.key}: subtotal - discount + tax = ${computed.toFixed(2)}, ` +
          `grand total says ${e.grandTotal}`,
      );
    }
  }

  for (const [i, li] of e.lineItems.entries()) {
    if (li.quantity === null || li.unitPrice === null || li.lineTotal === null) continue;
    const computed = li.quantity * li.unitPrice;
    if (Math.abs(computed - li.lineTotal) > 0.02) {
      problems.push(
        `${s.key}: row ${i} ${li.quantity} x ${li.unitPrice} = ${computed.toFixed(2)}, ` +
          `line total says ${li.lineTotal}`,
      );
    }
  }

  return problems;
};
