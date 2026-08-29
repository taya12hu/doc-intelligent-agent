import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

/**
 * Normalise an invoice date to ISO, and say whether it was a guess.
 *
 * The model is asked for ISO and usually obliges, so most of the work here is
 * the OTHER question: was the source ambiguous? `08/03/2025` is either 8 March
 * or 3 August, and NOTHING in the document can settle it. Once it has been
 * normalised to `2025-08-03` that uncertainty is invisible — the ISO string
 * looks exactly as confident as one parsed from "March 12, 2025".
 *
 * So we take the printed form (`meta.invoiceDateAsPrinted`) alongside the
 * normalised one, and flag when the printed form admits two readings. We do
 * NOT try to resolve it: guessing from the vendor's country would be a
 * plausible-sounding heuristic that is wrong maybe a third of the time, and a
 * confident wrong date is worse than a flagged uncertain one.
 */

export type NormalisedDate = {
  /** ISO yyyy-mm-dd, or null if nothing parseable. */
  iso: string | null;
  /** True when the printed form admits both a DD/MM and an MM/DD reading. */
  ambiguous: boolean;
  /** Human-readable specifics for the flag chip. */
  detail?: string;
};

/**
 * Formats we accept, most-specific first. Order matters: `DD/MM/YYYY` before
 * `MM/DD/YYYY` only decides the fallback reading for genuinely ambiguous
 * input, and either way we flag it — so the order is a tie-break, not a
 * claim about correctness.
 */
const FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'D MMMM YYYY',
  'MMMM D, YYYY',
  'MMM D, YYYY',
  'D MMM YYYY',
  'DD-MMM-YYYY',
  'D-MMM-YYYY',
  'DD.MM.YYYY',
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'DD-MM-YYYY',
] as const;

/** `08/03/2025` and `12-03-2025`: two numeric components that could swap. */
const SLASH_OR_DASH = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/;

export const isAmbiguousDateText = (printed: string | null | undefined): boolean => {
  if (!printed) return false;
  const m = SLASH_OR_DASH.exec(printed.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  // Both components are valid months, so either could be the month.
  return a >= 1 && a <= 12 && b >= 1 && b <= 12;
};

export const normaliseDate = (
  isoOrRaw: string | null | undefined,
  printed?: string | null,
): NormalisedDate => {
  const ambiguous = isAmbiguousDateText(printed);

  const detailFor = (iso: string | null): string | undefined => {
    if (!ambiguous || !printed) return undefined;
    const m = SLASH_OR_DASH.exec(printed.trim())!;
    const [, a, b, y] = m;
    const yy = y!.length === 2 ? `20${y}` : y;
    const readingA = dayjs(`${yy}-${b!.padStart(2, '0')}-${a!.padStart(2, '0')}`);
    const readingB = dayjs(`${yy}-${a!.padStart(2, '0')}-${b!.padStart(2, '0')}`);
    return (
      `"${printed}" could be ${readingA.format('D MMM YYYY')} or ` +
      `${readingB.format('D MMM YYYY')}` +
      (iso ? `; read as ${dayjs(iso).format('D MMM YYYY')}` : '')
    );
  };

  const parse = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    for (const format of FORMATS) {
      const d = dayjs(trimmed, format, true);
      if (d.isValid()) return d.format('YYYY-MM-DD');
    }
    // Last resort: let dayjs guess. Only reached when the model returned
    // something none of the formats above cover.
    const loose = dayjs(trimmed);
    return loose.isValid() ? loose.format('YYYY-MM-DD') : null;
  };

  const iso = parse(isoOrRaw) ?? parse(printed);
  const detail = detailFor(iso);

  return { iso, ambiguous, ...(detail ? { detail } : {}) };
};

/** Dates outside this window are almost certainly a misread, not a real invoice. */
export const isImplausibleDate = (iso: string | null): boolean => {
  if (!iso) return false;
  const d = dayjs(iso);
  if (!d.isValid()) return true;
  const year = d.year();
  // One year of slack ahead: post-dated invoices exist, invoices from 2087 do not.
  return year < 2000 || year > new Date().getFullYear() + 1;
};
