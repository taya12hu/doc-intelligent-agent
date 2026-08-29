/**
 * Coerce whatever the model returned into a number, or null.
 *
 * The schema asks for plain numbers and the field descriptions say so twice.
 * The model still returns `"1,234.50"`, `"$1,200"`, `"22 Nos"` and
 * `"(45.00)"` often enough that treating it as a validation failure would
 * burn a repair call on a problem we can fix locally for free. That is the
 * whole point of the cheapest-fix-first ordering in the repair loop: an API
 * round trip to fix a comma is a waste of two seconds and a request.
 *
 * The one thing this must never do is guess. If a value is ambiguous enough
 * that we would be inventing a number, return null and let it be flagged.
 */

/** Words that mean "no value", not "zero". Zero is a real amount. */
const NULLISH = new Set(['', '-', '--', 'n/a', 'na', 'nil', 'none', 'null', 'tbd', '?', '∅']);

export const coerceMoney = (input: unknown): number | null => {
  if (input === null || input === undefined) return null;

  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }

  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (NULLISH.has(trimmed.toLowerCase())) return null;

  // Accounting negatives: "(45.00)" means -45.00.
  const parenthesised = /^\((.*)\)$/.test(trimmed);
  let s = parenthesised ? trimmed.replace(/^\(|\)$/g, '') : trimmed;

  // Strip currency symbols, codes and unit words from either end. Deliberately
  // anchored: a stray "12" inside a description should never become a price.
  s = s
    .replace(/^[^\d(+-]*/, '') // leading symbols: $, €, ₹, "Rs.", "EUR "
    .replace(/[^\d)]*$/, ''); // trailing units: " Nos", " pcs", " kg", "/-"

  const explicitlyNegative = parenthesised || /^-/.test(s);
  s = s.replace(/^[+-]/, '');

  if (!s || !/\d/.test(s)) return null;

  const normalised = normaliseSeparators(s);
  if (normalised === null) return null;

  const value = Number(normalised);
  if (!Number.isFinite(value)) return null;

  return explicitlyNegative ? -value : value;
};

/**
 * Work out which of `.` and `,` is the decimal point, and drop the other.
 *
 * Cases that actually occur in these documents:
 *   "1,234.50"      US grouping                     -> 1234.50
 *   "1,41,077.85"   Indian grouping (lakh/crore)    -> 141077.85
 *   "1.234,56"      European: comma is the decimal  -> 1234.56
 *   "1234,56"       European, no grouping           -> 1234.56
 *   "1,234"         ambiguous -> treated as grouping (see below)
 */
const normaliseSeparators = (s: string): string | null => {
  if (!/^[\d.,\s]+$/.test(s)) return null;
  const clean = s.replace(/\s/g, '');

  const lastDot = clean.lastIndexOf('.');
  const lastComma = clean.lastIndexOf(',');

  // Both present: whichever comes LAST is the decimal separator. This is
  // reliable regardless of locale, because no convention uses the decimal
  // separator for grouping as well.
  if (lastDot !== -1 && lastComma !== -1) {
    return lastComma > lastDot
      ? clean.replace(/\./g, '').replace(',', '.')
      : clean.replace(/,/g, '');
  }

  if (lastComma !== -1) {
    const after = clean.length - lastComma - 1;
    const onlyOne = clean.indexOf(',') === lastComma;
    // "1234,56" / "18,4" -> European decimal comma.
    // "1,234" / "1,41,077" -> grouping.
    //
    // The tie-break is 3 digits after the separator: that is a valid group but
    // not a valid money fraction. Anything else with a single comma and 1-2
    // trailing digits is a decimal. Genuinely ambiguous inputs like "1,234"
    // resolve to grouping (1234) because that is overwhelmingly what an
    // invoice means by it, and because the alternative reading is off by 1000x
    // -- an error the arithmetic checks catch loudly rather than silently.
    if (onlyOne && after > 0 && after <= 2) return clean.replace(',', '.');
    return clean.replace(/,/g, '');
  }

  if (lastDot !== -1) {
    const onlyOne = clean.indexOf('.') === lastDot;
    // "1.234.567" -> European grouping, no decimal part.
    if (!onlyOne) return clean.replace(/\./g, '');
    return clean;
  }

  return clean;
};

/** Round to cents, avoiding the usual float drift on sums. */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Money comparison tolerance: a cent of rounding either way. */
export const MONEY_EPSILON = 0.02;

export const moneyEquals = (a: number, b: number, epsilon = MONEY_EPSILON): boolean =>
  Math.abs(a - b) <= epsilon;
