import * as XLSX from 'xlsx';
import { ZENITH } from './data.js';

/**
 * Sample #4 — the awkward spreadsheet.
 *
 * Spreadsheets are messy in a completely different way to PDFs: the layout
 * carries meaning that the cell values alone do not. Everything here is a
 * thing real accounting exports actually do:
 *
 *  - Three merged title rows, so the data does not start at A1.
 *  - Line items split across two LABELLED blocks with a header row each.
 *  - Columns ordered Description | Unit Price | Qty | Amount. Every other
 *    sample puts Qty before Unit Price. A model that has settled into a
 *    position-based habit will silently swap 31.25 and 8.
 *  - A block sub-total (3,793.00) sitting mid-table, which is NOT the
 *    invoice subtotal (4,974.00) four rows further down. Grabbing the first
 *    thing labelled "Sub-total" is wrong, and wrong in a way that still looks
 *    plausible.
 *  - One Amount cell left genuinely blank.
 *  - EUR rather than USD, stated only in a metadata cell.
 */

const E = ZENITH.expected;
type Row = (string | number | null)[];

export const buildZenith = (): Buffer => {
  const li = E.lineItems;
  const blockATotal = (li[0]!.lineTotal ?? 0) + (li[1]!.lineTotal ?? 0) + (li[2]!.lineTotal ?? 0);

  const rows: Row[] = [
    ['ZENITH PARTS & COMPONENTS', null, null, null],
    ["Rue de l'Industrie 44, 1070 Anderlecht, Brussels", null, null, null],
    ['VAT BE0123.456.789   ·   accounts@zenithparts.example', null, null, null],
    [null, null, null, null],

    [null, 'Invoice No.', null, E.invoiceNumber],
    [null, 'Date', null, '27/02/2025'],
    [null, 'Customer', null, 'Meridian Drivetrain NV'],
    [null, 'Currency', null, E.currency],
    [null, null, null, null],

    ['MACHINED COMPONENTS', null, null, null],
    // Swapped column order. This header row is the only thing telling the
    // model that 18.40 is a price and 120 is a count.
    ['Description', 'Unit Price', 'Qty', 'Amount'],
    [li[0]!.description, li[0]!.unitPrice, li[0]!.quantity, li[0]!.lineTotal],
    [li[1]!.description, li[1]!.unitPrice, li[1]!.quantity, li[1]!.lineTotal],
    [li[2]!.description, li[2]!.unitPrice, li[2]!.quantity, li[2]!.lineTotal],
    [null, null, 'Sub-total', blockATotal],
    [null, null, null, null],

    ['FASTENERS', null, null, null],
    ['Description', 'Unit Price', 'Qty', 'Amount'],
    [li[3]!.description, li[3]!.unitPrice, li[3]!.quantity, li[3]!.lineTotal],
    // The blank Amount. `null` here writes an genuinely empty cell, not a zero
    // and not an empty string — the reviewer sees a hole, and so does the model.
    [li[4]!.description, li[4]!.unitPrice, li[4]!.quantity, null],
    [li[5]!.description, li[5]!.unitPrice, li[5]!.quantity, li[5]!.lineTotal],

    [null, null, null, null],
    [null, null, null, null],
    [null, null, null, null],

    [null, null, 'Sub-total (all items)', E.subtotal],
    [null, null, 'VAT 21%', E.taxTotal],
    [null, null, null, null],
    [null, null, 'TOTAL DUE', E.grandTotal],
    [null, null, null, null],
    ['Payment within 30 days. Late payment interest 8% p.a. per Belgian law.', null, null, null],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: false });

  // Merged title rows — the thing that stops a naive "header is row 1" read.
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 3 } },
    { s: { r: 9, c: 0 }, e: { r: 9, c: 3 } },
    { s: { r: 16, c: 0 }, e: { r: 16, c: 3 } },
    { s: { r: 29, c: 0 }, e: { r: 29, c: 3 } },
  ];

  ws['!cols'] = [{ wch: 42 }, { wch: 13 }, { wch: 22 }, { wch: 14 }];

  // Currency formatting on the money columns. The stored value stays a number;
  // only the display string carries the symbol. A model reading the rendered
  // sheet sees "EUR 18.40"; one reading raw values sees 18.4. Both should work.
  for (const ref of Object.keys(ws)) {
    if (ref.startsWith('!')) continue;
    const cell = ws[ref] as XLSX.CellObject;
    const col = ref.replace(/\d+/g, '');
    if (cell.t === 'n' && (col === 'B' || col === 'D')) {
      cell.z = '"EUR" #,##0.00';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Invoice');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};
