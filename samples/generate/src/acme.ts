import { ACME } from './data.js';
import { createDoc, hr, money, row, type Column } from './lib/pdf.js';

/**
 * Sample #1 — the clean baseline.
 *
 * Everything a well-behaved invoice does: conventional labels, a headed
 * table, right-aligned totals, ISO-ish date spelled out. If the pipeline
 * cannot get this one to `extracted` with high confidence, nothing else in
 * the build matters. It is the control, not the interesting case.
 */
export const buildAcme = async (): Promise<Buffer> => {
  const { doc, done } = createDoc();
  const e = ACME.expected;
  const L = 50;
  const R = 545;

  doc.font('Helvetica-Bold').fontSize(22).fillColor('#1a1a1a').text('ACME SUPPLIES INC.', L, 55);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#555')
    .text('1420 Kingsway Avenue, Suite 300', L, 84)
    .text('Portland, OR 97205', L, 96)
    .text('accounts@acmesupplies.example  ·  (503) 555-0142', L, 108);

  doc.font('Helvetica-Bold').fontSize(26).fillColor('#1a1a1a').text('INVOICE', 360, 55, {
    width: R - 360,
    align: 'right',
  });

  const metaTop = 92;
  doc.font('Helvetica').fontSize(9.5).fillColor('#555');
  doc.text('Invoice #', 360, metaTop, { width: 90, align: 'right' });
  doc.text('Invoice Date', 360, metaTop + 15, { width: 90, align: 'right' });
  doc.text('Payment Terms', 360, metaTop + 30, { width: 90, align: 'right' });

  doc.font('Helvetica-Bold').fillColor('#1a1a1a');
  doc.text(e.invoiceNumber!, 455, metaTop, { width: R - 455, align: 'right' });
  doc.text('March 12, 2025', 455, metaTop + 15, { width: R - 455, align: 'right' });
  doc.font('Helvetica').fillColor('#555');
  doc.text('Net 30', 455, metaTop + 30, { width: R - 455, align: 'right' });

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#777').text('BILL TO', L, 155);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#1a1a1a')
    .text('Harborline Logistics', L, 170)
    .text('88 Wharf Road', L, 184)
    .text('Seattle, WA 98104', L, 198);

  // ── line item table ────────────────────────────────────────────────
  const cols: Column[] = [
    { x: L, width: 250 },
    { x: 310, width: 50, align: 'right' },
    { x: 375, width: 75, align: 'right' },
    { x: 465, width: R - 465, align: 'right' },
  ];

  let y = 240;
  doc.save().rect(L, y - 6, R - L, 22).fill('#f0f0ee').restore();
  y = row(doc, y, cols, ['Description', 'Qty', 'Unit Price', 'Amount'], {
    bold: true,
    size: 9,
    gap: 10,
  });
  doc.fillColor('#1a1a1a');

  for (const li of e.lineItems) {
    y = row(doc, y, cols, [
      li.description,
      String(li.quantity),
      money(li.unitPrice!),
      money(li.lineTotal!),
    ]);
    hr(doc, y - 3, L, R, 0.4, '#e0e0dd');
  }

  // ── totals ─────────────────────────────────────────────────────────
  y += 12;
  const labelCol: Column = { x: 340, width: 110, align: 'right' };
  const valueCol: Column = { x: 460, width: R - 460, align: 'right' };

  y = row(doc, y, [labelCol, valueCol], ['Subtotal', `$${money(e.subtotal!)}`], { size: 10 });
  y = row(doc, y, [labelCol, valueCol], ['Sales Tax (8.25%)', `$${money(e.taxTotal!)}`], {
    size: 10,
  });
  hr(doc, y + 2, 340, R, 0.8, '#999');
  y += 8;
  y = row(doc, y, [labelCol, valueCol], ['Total Due', `$${money(e.grandTotal!)}`], {
    bold: true,
    size: 12,
  });

  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#777')
    .text(
      'Payment due within 30 days. Remit to Acme Supplies Inc., account 4471-88201, ' +
        'Cascadia Bank. Please quote the invoice number with payment.',
      L,
      y + 40,
      { width: R - L },
    );

  doc.end();
  return done;
};
