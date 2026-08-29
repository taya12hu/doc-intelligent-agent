import type { FileKind } from '@dia/shared';
import * as XLSX from 'xlsx';
import type { Classification } from './classify.js';

/**
 * Turn an uploaded file into something the model can read.
 *
 * There are only two paths, and the PDF one is deliberately trivial:
 *
 *   pdf_text / pdf_scanned -> the raw bytes, untouched
 *   xlsx                   -> a markdown rendering of every sheet
 *
 * Handing Gemini the PDF directly is the single biggest simplification in
 * this project. It reads the page as laid out — table columns stay columns,
 * a total that sits under a rule still sits under a rule. Extracting text
 * first with pdfjs would flatten exactly the spatial structure that makes an
 * invoice readable, and rasterising to images would mean a canvas dependency,
 * DPI tuning, and a per-request image cap. None of that is needed.
 *
 * Spreadsheets get the opposite treatment, because a .xlsx is a zip of XML
 * that Gemini cannot open. The rendering below is designed so the LAYOUT
 * survives, since in a spreadsheet the layout is most of the meaning.
 */

export type PreparedInput =
  | { kind: 'pdf'; mimeType: string; base64: string; pageCount: number }
  | { kind: 'text'; text: string };

const EMPTY = '∅'; // ∅

/** Markdown tables are pipe-delimited, so a pipe in a cell has to be escaped. */
const cellText = (cell: XLSX.CellObject | undefined): string => {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return EMPTY;
  // Numbers go through as raw values, not as their display strings. The model
  // then never has to strip a currency symbol or a thousands separator from a
  // spreadsheet — the only place those appear is in genuine text cells.
  const raw = cell.t === 'n' ? String(cell.v) : String(cell.w ?? cell.v);
  return raw.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};

/**
 * Render a worksheet as markdown, preserving the two things that carry
 * meaning beyond the cell values themselves:
 *
 *  - COLUMN LETTERS and ROW NUMBERS, so the model can reason about position
 *    ("the total four rows below the table", "the header row is row 11").
 *    Without addresses it sees a table that begins at an arbitrary offset and
 *    has no way to say where anything is.
 *  - MERGED RANGES, listed explicitly. A merged title block is what stops the
 *    data starting at A1, and it is invisible once you flatten to values.
 */
export const sheetToMarkdown = (ws: XLSX.WorkSheet, name: string): string => {
  const ref = ws['!ref'];
  if (!ref) return `### Sheet "${name}"\n\n(empty)\n`;

  const range = XLSX.utils.decode_range(ref);
  const colLetters: string[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) colLetters.push(XLSX.utils.encode_col(c));

  const lines: string[] = [];
  lines.push(`### Sheet "${name}"  (used range ${ref})`);

  const merges = ws['!merges'];
  if (merges?.length) {
    const described = merges.map((m) => XLSX.utils.encode_range(m)).join(', ');
    lines.push(`Merged ranges: ${described}`);
  }
  lines.push(`Empty cells are shown as ${EMPTY}. Numeric cells show their raw value.`);
  lines.push('');

  lines.push(`| row | ${colLetters.join(' | ')} |`);
  lines.push(`| --- | ${colLetters.map(() => '---').join(' | ')} |`);

  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells = colLetters.map((col) => cellText(ws[`${col}${r + 1}`] as XLSX.CellObject));
    // Skip fully-empty rows but keep the row NUMBERS honest, so "four rows
    // below" stays true. A collapsed sheet would silently move things.
    if (cells.every((c) => c === EMPTY)) continue;
    lines.push(`| ${r + 1} | ${cells.join(' | ')} |`);
  }

  return lines.join('\n');
};

export const workbookToMarkdown = (buf: Buffer): string => {
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
  return wb.SheetNames.map((name) => sheetToMarkdown(wb.Sheets[name]!, name)).join('\n\n');
};

export const prepare = (
  buf: Buffer,
  kind: FileKind,
  classification?: Classification,
): PreparedInput => {
  if (kind === 'xlsx') {
    return { kind: 'text', text: workbookToMarkdown(buf) };
  }
  return {
    kind: 'pdf',
    mimeType: 'application/pdf',
    base64: buf.toString('base64'),
    pageCount: classification?.pageCount ?? 1,
  };
};
