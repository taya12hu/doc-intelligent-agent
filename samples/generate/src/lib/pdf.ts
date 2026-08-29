import PDFDocument from 'pdfkit';

/**
 * Thin pdfkit helpers. Deliberately thin: the four invoices are supposed to
 * look like they came from four different accounting systems, so most layout
 * lives in each generator rather than in a shared "invoice template" that
 * would quietly make them all the same shape.
 */

export type Doc = InstanceType<typeof PDFDocument>;

/** Create a document and a promise that resolves to its bytes. */
export const createDoc = (options?: ConstructorParameters<typeof PDFDocument>[0]) => {
  const doc = new PDFDocument({ size: 'A4', margin: 50, ...options });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { doc, done };
};

/** 1234.5 -> "1,234.50" (western grouping). */
export const money = (n: number): string =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/**
 * 141077.85 -> "1,41,077.85" (Indian grouping: last three digits, then twos).
 *
 * This is sample #2's job: a thousands separator pattern that a naive
 * `parseFloat(s.replace(/,/g, ''))` handles fine but a naive regex for
 * `\d{1,3}(,\d{3})*` does not match at all.
 */
export const inr = (n: number): string =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

export type Column = {
  x: number;
  width: number;
  align?: 'left' | 'right' | 'center';
};

/** Draw one table row at `y`, returning the y of the next row. */
export const row = (
  doc: Doc,
  y: number,
  columns: Column[],
  values: string[],
  opts: { bold?: boolean; size?: number; gap?: number } = {},
): number => {
  const size = opts.size ?? 9.5;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  let maxHeight = 0;
  for (const [i, col] of columns.entries()) {
    const text = values[i] ?? '';
    doc.text(text, col.x, y, { width: col.width, align: col.align ?? 'left' });
    maxHeight = Math.max(maxHeight, doc.heightOfString(text, { width: col.width }));
  }
  return y + maxHeight + (opts.gap ?? 6);
};

export const hr = (doc: Doc, y: number, x1: number, x2: number, weight = 0.5, color = '#999') => {
  doc.save().lineWidth(weight).strokeColor(color).moveTo(x1, y).lineTo(x2, y).stroke().restore();
};
