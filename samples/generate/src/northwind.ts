import { NORTHWIND } from './data.js';
import { createDoc, hr, inr, row, type Column } from './lib/pdf.js';

/**
 * Sample #2 — label variance and number formatting.
 *
 * Everything here is a realistic Indian B2B tax invoice, and every one of its
 * quirks is a specific thing that breaks naive extraction:
 *
 *  - The vendor name appears ONLY in the letterhead. There is no "Vendor:"
 *    label anywhere on the page.
 *  - "Bill No." instead of "Invoice Number".
 *  - A GSTIN and a PAN sit right next to the Bill No. Both look far more like
 *    a machine-readable identifier than "NW/2025/1183" does. Picking the right
 *    one is the test.
 *  - Indian digit grouping: "1,41,077.85". A `\d{1,3}(,\d{3})*` regex does not
 *    match it at all.
 *  - The totals band uses accounting language: "Gross Amount", "Less: Trade
 *    Discount", "Add: GST", "Net Payable" — not subtotal/discount/tax/total.
 *  - Consequently sum(lineItems) != grandTotal, LEGITIMATELY. A single-stage
 *    sum check flags this perfectly correct invoice. Two-stage does not.
 *    That is the entire reason this sample exists.
 */
export const buildNorthwind = async (): Promise<Buffer> => {
  const { doc, done } = createDoc();
  const e = NORTHWIND.expected;
  const L = 50;
  const R = 545;

  // Letterhead — the only place the vendor name occurs.
  doc.save().rect(0, 0, 595, 6).fill('#1f4e79').restore();
  doc.font('Helvetica-Bold').fontSize(19).fillColor('#1f4e79').text('NORTHWIND TRADING CO.', L, 34);
  doc
    .font('Helvetica-Oblique')
    .fontSize(8.5)
    .fillColor('#666')
    .text('Industrial Bearings · Seals · Power Transmission', L, 58);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#555')
    .text('Plot 47, MIDC Industrial Area, Bhosari, Pune 411026, Maharashtra', L, 74)
    .text('Tel +91 20 2712 4480  ·  sales@northwindtrading.example', L, 85);

  hr(doc, 102, L, R, 0.8, '#1f4e79');

  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor('#1a1a1a')
    .text('TAX INVOICE', L, 112, { width: R - L, align: 'center' });

  // Identifier block: the real invoice number is surrounded by two decoys
  // that look far more "official" than it does.
  const my = 138;
  doc.font('Helvetica').fontSize(8.5).fillColor('#555');
  doc.text('GSTIN', L, my).text('PAN', L, my + 13).text('Bill No.', L, my + 26).text('Dated', L, my + 39);
  doc.font('Helvetica-Bold').fillColor('#1a1a1a');
  doc
    .text('27AABCN4471P1ZK', L + 60, my)
    .text('AABCN4471P', L + 60, my + 13)
    .text(e.invoiceNumber!, L + 60, my + 26)
    .text('14-Mar-2025', L + 60, my + 39);

  doc.font('Helvetica').fontSize(8.5).fillColor('#555').text('Buyer', 330, my);
  doc
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .fillColor('#1a1a1a')
    .text('Deccan Engineering Works Pvt. Ltd.', 330, my + 13, { width: R - 330 });
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#555')
    .text('Gat No. 212, Chakan, Pune 410501', 330, my + 27, { width: R - 330 })
    .text('GSTIN 27AACCD8812M1Z4', 330, my + 39, { width: R - 330 });

  // ── particulars ────────────────────────────────────────────────────
  const cols: Column[] = [
    { x: L, width: 28, align: 'center' },
    { x: 82, width: 218 },
    { x: 306, width: 46, align: 'right' },
    { x: 362, width: 80, align: 'right' },
    { x: 452, width: R - 452, align: 'right' },
  ];

  let y = 200;
  doc.save().rect(L, y - 6, R - L, 20).fill('#eaf0f6').restore();
  y = row(doc, y, cols, ['Sr.', 'Particulars', 'Qty', 'Rate', 'Amount (Rs.)'], {
    bold: true,
    size: 8.5,
    gap: 9,
  });
  hr(doc, y - 4, L, R, 0.6, '#1f4e79');
  doc.fillColor('#1a1a1a');

  for (const [i, li] of e.lineItems.entries()) {
    y = row(doc, y, cols, [
      String(i + 1),
      li.description,
      `${li.quantity} Nos`,
      inr(li.unitPrice!),
      inr(li.lineTotal!),
    ]);
    hr(doc, y - 3, L, R, 0.3, '#dde4ea');
  }

  // ── the adjustment band ────────────────────────────────────────────
  // Accounting labels, not schema labels. This is what the model has to map.
  y += 10;
  const labelCol: Column = { x: 300, width: 145, align: 'right' };
  const valueCol: Column = { x: 452, width: R - 452, align: 'right' };

  y = row(doc, y, [labelCol, valueCol], ['Gross Amount', inr(e.subtotal!)], { size: 9.5 });
  y = row(doc, y, [labelCol, valueCol], ['Less: Trade Discount @ 5%', `(${inr(e.discountTotal!)})`], {
    size: 9.5,
  });
  y = row(doc, y, [labelCol, valueCol], ['Add: GST @ 18%', inr(e.taxTotal!)], { size: 9.5 });
  hr(doc, y + 2, 300, R, 0.8, '#1f4e79');
  y += 8;
  y = row(doc, y, [labelCol, valueCol], ['Net Payable', `Rs. ${inr(e.grandTotal!)}`], {
    bold: true,
    size: 11.5,
  });

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor('#1a1a1a')
    .text('Amount in words:', L, y + 24);
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor('#555')
    .text(
      'Rupees One Lakh Forty One Thousand Seventy Seven and Eighty Five Paise Only',
      L,
      y + 36,
      { width: 300 },
    );

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#777')
    .text('For NORTHWIND TRADING CO.', 360, y + 30, { width: R - 360, align: 'right' })
    .text('Authorised Signatory', 360, y + 72, { width: R - 360, align: 'right' });

  doc.end();
  return done;
};
