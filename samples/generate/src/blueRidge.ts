import sharp from 'sharp';
import { BLUE_RIDGE } from './data.js';
import { money } from './lib/pdf.js';

/**
 * Sample #3, stage 1 — render the invoice CLEAN, as a raster.
 *
 * Why SVG -> raster instead of pdfkit -> rasterize? Two reasons:
 *
 * 1. Rasterizing a PDF in Node needs a native canvas or poppler. sharp already
 *    rasterizes SVG with no extra dependency, and it is the one library we
 *    need anyway for the degradation pass.
 * 2. More importantly: the degradation has to be TARGETED. To put a coffee
 *    ring over the middle digits of the grand total, I need to know exactly
 *    where the grand total is. Authoring in SVG means I place every value at
 *    a known coordinate and can hand those rectangles to the degrader.
 *
 * A uniformly mushy page fails uniformly and proves nothing. This file exists
 * so that #3 fails PRECISELY, on three known values, while the rest of the
 * document stays readable — which is what makes the flags demonstrable.
 */

/** A4 at 150 DPI. Degraded down to ~110 and back, so start with real detail. */
export const CANVAS = { width: 1240, height: 1754 };

export type Rect = { x: number; y: number; w: number; h: number };

/** Where the deliberately-hard values sit, in CANVAS coordinates. */
export type Targets = {
  /** Coffee ring goes over the middle digits of this. */
  grandTotal: Rect;
  /** 08/03/2025 — glyph-level ambiguity lives here. */
  invoiceDate: Rect;
  /** Row 3's unit price: darkest band + extra local blur. */
  unitPriceRow3: Rect;
  /** Centre of the vertical darkening gradient. */
  darkBandY: number;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const L = 100;
const R = 1140;
const FONT = 'Helvetica, Arial, Liberation Sans, sans-serif';

const text = (
  x: number,
  y: number,
  content: string,
  o: { size?: number; bold?: boolean; anchor?: 'start' | 'end' | 'middle'; fill?: string } = {},
) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size ?? 17}"` +
  ` font-weight="${o.bold ? 700 : 400}" text-anchor="${o.anchor ?? 'start'}"` +
  ` fill="${o.fill ?? '#111111'}">${esc(content)}</text>`;

export const buildBlueRidgeClean = async (): Promise<{ png: Buffer; targets: Targets }> => {
  const e = BLUE_RIDGE.expected;

  // Row baselines, declared once so the targets below cannot drift from the art.
  const ROW_Y = [510, 556, 602, 648];
  const DATE_Y = 312;
  const TOTAL_Y = 836;

  const parts: string[] = [];
  parts.push(`<rect width="${CANVAS.width}" height="${CANVAS.height}" fill="#ffffff"/>`);

  // Letterhead
  parts.push(text(L, 120, 'BLUE RIDGE FABRICATION LLC', { size: 38, bold: true }));
  parts.push(
    text(L, 155, 'Structural Steel  ·  Laser Cutting  ·  Powder Coating', {
      size: 17,
      fill: '#444444',
    }),
  );
  parts.push(text(L, 186, '2210 Foundry Road, Roanoke, VA 24012', { size: 16, fill: '#444444' }));
  parts.push(
    text(L, 210, '(540) 555-0188   ·   billing@blueridgefab.example', {
      size: 16,
      fill: '#444444',
    }),
  );
  parts.push(text(R, 126, 'INVOICE', { size: 40, bold: true, anchor: 'end' }));
  parts.push(`<line x1="${L}" y1="238" x2="${R}" y2="238" stroke="#222222" stroke-width="2"/>`);

  // Bill-to
  parts.push(text(L, 288, 'BILL TO', { size: 14, bold: true, fill: '#666666' }));
  parts.push(text(L, 316, 'Tidewater Marine Services', { size: 19 }));
  parts.push(text(L, 344, '4400 Terminal Boulevard', { size: 17, fill: '#444444' }));
  parts.push(text(L, 370, 'Norfolk, VA 23505', { size: 17, fill: '#444444' }));

  // Meta — vendor name and invoice number stay legible on purpose, so the
  // contrast between "confident here / uncertain there" is visible on screen.
  parts.push(text(830, 288, 'Invoice No.', { size: 16, anchor: 'end', fill: '#666666' }));
  parts.push(text(R, 288, e.invoiceNumber!, { size: 18, bold: true, anchor: 'end' }));
  parts.push(text(830, DATE_Y, 'Date', { size: 16, anchor: 'end', fill: '#666666' }));
  parts.push(text(R, DATE_Y, '08/03/2025', { size: 18, bold: true, anchor: 'end' }));
  parts.push(text(830, 336, 'Terms', { size: 16, anchor: 'end', fill: '#666666' }));
  parts.push(text(R, 336, 'Net 15', { size: 18, anchor: 'end' }));

  // Table
  parts.push(`<rect x="${L}" y="444" width="${R - L}" height="34" fill="#e8e8e6"/>`);
  parts.push(text(L + 12, 468, 'DESCRIPTION', { size: 15, bold: true }));
  parts.push(text(770, 468, 'QTY', { size: 15, bold: true, anchor: 'end' }));
  parts.push(text(940, 468, 'UNIT PRICE', { size: 15, bold: true, anchor: 'end' }));
  parts.push(text(R - 12, 468, 'AMOUNT', { size: 15, bold: true, anchor: 'end' }));

  for (const [i, li] of e.lineItems.entries()) {
    const y = ROW_Y[i]!;
    parts.push(text(L + 12, y, li.description, { size: 17 }));
    parts.push(text(770, y, String(li.quantity), { size: 17, anchor: 'end' }));
    parts.push(text(940, y, money(li.unitPrice!), { size: 17, anchor: 'end' }));
    parts.push(text(R - 12, y, money(li.lineTotal!), { size: 17, anchor: 'end' }));
    parts.push(
      `<line x1="${L}" y1="${y + 16}" x2="${R}" y2="${y + 16}" stroke="#d5d5d2" stroke-width="1"/>`,
    );
  }

  // Totals
  parts.push(text(940, 740, 'Subtotal', { size: 18, anchor: 'end', fill: '#333333' }));
  parts.push(text(R, 740, `$${money(e.subtotal!)}`, { size: 18, anchor: 'end' }));
  parts.push(text(940, 782, 'Sales Tax (6%)', { size: 18, anchor: 'end', fill: '#333333' }));
  parts.push(text(R, 782, `$${money(e.taxTotal!)}`, { size: 18, anchor: 'end' }));
  parts.push(`<line x1="820" y1="804" x2="${R}" y2="804" stroke="#222222" stroke-width="2"/>`);
  parts.push(text(940, TOTAL_Y, 'TOTAL DUE', { size: 22, bold: true, anchor: 'end' }));
  parts.push(text(R, TOTAL_Y, `$${money(e.grandTotal!)}`, { size: 24, bold: true, anchor: 'end' }));

  parts.push(
    text(L, 960, 'Thank you for your business. Payment due within 15 days of invoice date.', {
      size: 15,
      fill: '#555555',
    }),
  );
  parts.push(
    text(L, 986, 'Remit to Blue Ridge Fabrication LLC, acct 88-4471023, Appalachian Trust.', {
      size: 15,
      fill: '#555555',
    }),
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">${parts.join('')}</svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  const targets: Targets = {
    // "$4,179.05" right-anchored at x=1140, ~24px font => roughly 175px wide.
    grandTotal: { x: 960, y: TOTAL_Y - 26, w: 185, h: 40 },
    invoiceDate: { x: 985, y: DATE_Y - 20, w: 160, h: 28 },
    unitPriceRow3: { x: 845, y: ROW_Y[2]! - 20, w: 100, h: 28 },
    darkBandY: ROW_Y[2]!,
  };

  return { png, targets };
};
