import type { FileKind } from '@dia/shared';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * pdfjs needs the base-14 font metrics to map glyphs back to Unicode. In a
 * browser it fetches them from a CDN; in Node it has no idea where they are,
 * silently returns an EMPTY text layer, and logs a warning that looks
 * cosmetic.
 *
 * That failure mode is genuinely dangerous here: a clean text PDF comes back
 * with zero characters, gets classified `pdf_scanned`, and the whole document
 * is treated as a bad scan. Extraction would still mostly work — Gemini reads
 * the PDF either way — but the UI would show a wrong badge and the prompt
 * would warn about illegibility that does not exist. Resolve the path off the
 * installed package so it cannot drift.
 *
 * Despite the name ending in `Url`, this must be a FILESYSTEM PATH with a
 * trailing separator, not a `file://` URL. pdfjs concatenates it with the
 * font filename and hands the result to `fs.readFile`, which rejects a
 * `file:///D:/...` string. Passing a real URL fails with "Unable to load font
 * data", which reads like a missing file rather than a wrong path format.
 */
const require = createRequire(import.meta.url);
const STANDARD_FONT_DATA_URL =
  join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/';

/**
 * Decide how to read an uploaded file.
 *
 * Classification is done from the BYTES, never from the client-supplied MIME
 * type or the file extension. Both are trivially wrong (browsers guess, users
 * rename) and one of them is attacker-controlled. The extension is used only
 * to disambiguate a generic ZIP container, and only after the magic bytes have
 * already said "this is a ZIP".
 */

const MAGIC = {
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04 — xlsx is a zip
} as const;

export type Classification = {
  kind: FileKind;
  /** Characters of embedded text per page. Drives the scanned/text decision. */
  charsPerPage: number;
  pageCount: number;
  /** Extracted text layer, if any. Kept for diagnostics, NOT fed to the model. */
  textLayer: string;
};

/**
 * Below this many characters per page, we call it a scan.
 *
 * A genuine text PDF carries hundreds of characters per page. A scanned one
 * carries zero, or a handful from a stray annotation or an OCR layer someone
 * half-applied. 50 sits in the empty middle of that distribution, so the
 * exact value does not matter much — which is the property you want from a
 * threshold you cannot tune against real data.
 */
export const SCANNED_THRESHOLD_CHARS_PER_PAGE = 50;

export const looksLikePdf = (buf: Buffer): boolean => buf.subarray(0, 4).equals(MAGIC.pdf);
export const looksLikeZip = (buf: Buffer): boolean => buf.subarray(0, 4).equals(MAGIC.zip);

/**
 * Pull the embedded text layer out of a PDF.
 *
 * NOTE: this text is NOT what we send to the model. Gemini takes the PDF
 * bytes directly and reads the page as laid out, which preserves table
 * structure that `getTextContent()` flattens away. We extract text purely to
 * answer one question — "is there a text layer at all?" — because that
 * decides whether the prompt should warn the model to expect a bad scan, and
 * it gives the UI an honest "Scanned" badge the system derived itself.
 */
export const extractTextLayer = async (
  buf: Buffer,
): Promise<{ text: string; pageCount: number }> => {
  // Hold the LOADING TASK, not just the document: `destroy()` lives on the
  // task in pdfjs v6, and calling it on the document proxy throws.
  const task = getDocument({
    data: new Uint8Array(buf),
    // No worker fetch in a server process.
    useWorkerFetch: false,
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });

  const doc = await task.promise;

  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push(text);
      page.cleanup();
    }
    return { text: pages.join('\n\n'), pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
};

export const classify = async (
  buf: Buffer,
  filename: string,
): Promise<Classification> => {
  if (looksLikePdf(buf)) {
    let text = '';
    let pageCount = 1;
    try {
      const result = await extractTextLayer(buf);
      text = result.text;
      pageCount = result.pageCount;
    } catch {
      // A PDF we cannot parse is still a PDF. Treat it as scanned and let the
      // model look at it — refusing here would throw away a document Gemini
      // may well read fine.
      return { kind: 'pdf_scanned', charsPerPage: 0, pageCount: 1, textLayer: '' };
    }

    const charsPerPage = pageCount > 0 ? text.length / pageCount : 0;
    return {
      kind: charsPerPage < SCANNED_THRESHOLD_CHARS_PER_PAGE ? 'pdf_scanned' : 'pdf_text',
      charsPerPage: Math.round(charsPerPage),
      pageCount,
      textLayer: text,
    };
  }

  if (looksLikeZip(buf) && /\.xlsx?$/i.test(filename)) {
    return { kind: 'xlsx', charsPerPage: 0, pageCount: 1, textLayer: '' };
  }

  throw new Error(
    `Unsupported file "${filename}". Expected a PDF or an .xlsx workbook; ` +
      `the first bytes match neither.`,
  );
};
