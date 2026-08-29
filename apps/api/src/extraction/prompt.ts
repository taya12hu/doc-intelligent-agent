import type { FileKind } from '@dia/shared';

/**
 * Prompts.
 *
 * Per-field semantics deliberately do NOT live here — they are `.describe()`
 * calls on the zod schema, which become `description` fields in Gemini's
 * `responseSchema`. The SDK's own docs say that is where they belong ("best
 * practice to provide a clear and descriptive explanation for the schema and
 * its properties here, rather than in the prompt"), and it keeps one
 * definition of what `discountTotal` means instead of two that can drift.
 *
 * What is left here is the stuff that has no schema home: the standing
 * instruction about when to return null, and the per-file-kind context.
 */

const SYSTEM = `You extract structured data from vendor invoices. You are the first
stage of a pipeline whose job is to hand a human a record they can check quickly.

THE ONE RULE THAT MATTERS

If a value is not printed on the document, or you cannot read it clearly, or you are
not certain — return null for that field and add its path to meta.illegibleFields.

Do not infer. Do not compute. Do not guess. A null costs a reviewer five seconds to
fill in. A confident wrong number can be missed entirely, and that is the failure
this whole system is built to prevent. You are never penalised for returning null.

WHAT THAT MEANS IN PRACTICE

- If the document shows line items but no subtotal, subtotal is null. Do NOT add the
  line items up yourself — a computed subtotal is indistinguishable from a printed
  one downstream, and it destroys the cross-check that would otherwise catch a
  misread line item.
- If a line item's amount cell is blank, that lineTotal is null. Do not multiply
  quantity by unit price to fill it in.
- If a total is smudged, partly covered, or otherwise unreadable, it is null — even
  if you can guess most of the digits. "Probably $4,179.05" is a guess.
- If the document has no tax or no discount, those fields are null. Null means "not
  on the document", which is different from zero.

OTHER STANDING RULES

- Numbers must be plain: no currency symbols, no thousands separators, no unit words.
  Watch for grouping conventions that are not US-style — "1,41,077.85" is one hundred
  forty-one thousand, and "1.234,56" is one thousand two hundred thirty-four.
- Take values, not labels. Invoices name the same field many ways: "Invoice #",
  "Bill No.", "Ref", "Document No.". Tax registration numbers, VAT IDs, PAN and GSTIN
  are NOT the invoice number, even when they look more like identifiers.
- The vendor is whoever ISSUED the invoice, not the customer being billed. On many
  layouts the vendor appears only in a letterhead or logo, while the customer sits
  under a clear "Bill To" label. Do not take the labelled one by default.
- lineItems holds only real item rows. Subtotal, discount, tax, shipping and total
  rows belong in their own fields, never in the array.`;

const USER_BASE = `Extract this invoice.

Work through the document as laid out: identify the vendor, the invoice identifier and
date, then the line-item table, then the totals band beneath it.

Fill meta.illegibleFields with the path of every field you could not read with
confidence, and set meta.legibility to reflect the source quality. Put the invoice
date in meta.invoiceDateAsPrinted exactly as it appears on the page, before you
convert it to ISO.`;

const SCANNED_NOTE = `

IMPORTANT — this document is a SCAN with no text layer, and it is a poor one. Expect
skew, blur, noise and low contrast. Parts of it may be stained or obscured.

Partial illegibility is expected here and reporting it is the CORRECT outcome, not a
failure on your part. Read what is genuinely readable and return null for the rest.
Do not reconstruct a number from a partial reading, and do not let a total you can
compute from the other figures talk you into reporting digits you cannot actually
see — if the printed total is obscured, it is null even when the arithmetic is
obvious.`;

const XLSX_NOTE = `

This document is a spreadsheet, rendered below as markdown with the original column
letters and row numbers preserved. Positions are meaningful:

- The data may not start at row 1. Merged title blocks are listed above the table.
- There may be MORE THAN ONE header row, and more than one block of line items.
  Collect items from every block.
- Column order is not standard. Read the header row of each block rather than
  assuming quantity comes before unit price.
- A sub-total inside the table is not necessarily the invoice subtotal — there may be
  a per-block sub-total as well as an overall one further down. Take the one that
  covers all the items.
- Empty cells are shown as the character shown in the header note. An empty cell is a
  null value, not a zero.`;

export const systemPrompt = (): string => SYSTEM;

export const userPrompt = (kind: FileKind): string => {
  if (kind === 'pdf_scanned') return USER_BASE + SCANNED_NOTE;
  if (kind === 'xlsx') return USER_BASE + XLSX_NOTE;
  return USER_BASE;
};

/**
 * The follow-up when the model's output failed schema validation.
 *
 * Kept surgical on purpose: it shows the model its own output and the exact
 * validation error, and asks for nothing else. Re-sending the full extraction
 * instructions here invites it to redo the reading and change values that were
 * already right, turning a formatting fix into a fresh roll of the dice.
 */
export const repairPrompt = (previousOutput: string, validationError: string): string =>
  `Your previous response failed schema validation.

Validation errors:
${validationError}

Your previous response:
${previousOutput}

Return the corrected JSON. Fix ONLY what the validation errors describe — do not
re-read the document, and do not change any value that was not part of an error.`;
