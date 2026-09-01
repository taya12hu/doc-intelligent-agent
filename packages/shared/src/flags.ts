import { z } from 'zod';

/**
 * Why a field is not trustworthy.
 *
 * Every flag is produced by a DETERMINISTIC check (`checks.ts`) or by
 * cross-sample disagreement (`consensus.ts`). None of them is the model's
 * opinion of its own accuracy — that number is weakly calibrated and we do
 * not use it as a signal, only as a multiplier on an already-computed score.
 * See ARCHITECTURE.md §5.8–5.9.
 */
export const FLAG_REASONS = [
  /** The field came back null and it is one we require. */
  'missing',
  /** A value was present but could not be coerced into a number or date. */
  'unparseable',
  /**
   * Extraction produced no usable record at all. Distinct from `unparseable`,
   * which is about one field's value: this says the run never got far enough
   * to have field values to judge.
   */
  'extraction_failed',
  /** The model listed this field in `meta.illegibleFields` — it could not read it. */
  'illegible_source',
  /** Reconciliation stage 1 or 2 did not balance. */
  'math_mismatch',
  /** quantity x unitPrice does not equal lineTotal for this row. */
  'row_math_mismatch',
  /** MM/DD vs DD/MM cannot be resolved from this document alone. */
  'ambiguous_date',
  /** 2 of 3 extraction passes agreed; we took the majority. */
  'low_agreement',
  /** All 3 extraction passes returned different values. This field is a coin flip. */
  'disagreement',
  /** Output failed schema validation at least once and had to be repaired. */
  'repair_required',
  /** The model hit its token ceiling and the JSON was cut off mid-structure. */
  'truncated',
  /** The source scan was poor enough that the whole record is suspect. */
  'low_legibility',
  /** Passed validation but fails a sanity check (negative total, date in 2087, ...). */
  'implausible_value',
] as const;

export type FlagReason = (typeof FLAG_REASONS)[number];
export type FlagSeverity = 'warn' | 'error';

export const FieldFlagSchema = z.object({
  /** Field path: `"grandTotal"`, `"lineItems[2].unitPrice"`, or `"_record"` for whole-record flags. */
  field: z.string(),
  reason: z.enum(FLAG_REASONS),
  severity: z.enum(['warn', 'error']),
  /** Human-readable specifics, pre-computed server-side so the UI stays dumb. */
  detail: z.string().optional(),
});
export type FieldFlag = z.infer<typeof FieldFlagSchema>;

/**
 * Default severity per reason.
 *
 * `error` means "do not trust this value at all". `warn` means "a human
 * should look, but the value is probably usable". The split matters: it is
 * what separates `needs_review` from `failed`, and it is what decides whether
 * the field gets an amber ring or a red one.
 */
export const SEVERITY_BY_REASON: Record<FlagReason, FlagSeverity> = {
  // Default only. A missing REQUIRED field is raised as an error at the call
  // site in checks.ts — this default covers the milder uses: a blank
  // line-item cell, and a tax or discount row inferred from an unexplained
  // delta rather than observed as absent.
  missing: 'warn',
  unparseable: 'error',
  extraction_failed: 'error',
  illegible_source: 'error',
  math_mismatch: 'error',
  row_math_mismatch: 'warn',
  ambiguous_date: 'warn',
  low_agreement: 'warn',
  disagreement: 'error',
  repair_required: 'warn',
  truncated: 'warn',
  low_legibility: 'warn',
  implausible_value: 'error',
};

/** Whole-record flags use this sentinel rather than a real field path. */
export const RECORD_FIELD = '_record';

export const flag = (
  field: string,
  reason: FlagReason,
  detail?: string,
  severity?: FlagSeverity,
): FieldFlag => ({
  field,
  reason,
  severity: severity ?? SEVERITY_BY_REASON[reason],
  ...(detail ? { detail } : {}),
});

/**
 * Plain-language headline for a flag chip.
 *
 * The reviewer needs to know WHY in the two seconds before they look at the
 * source pane. "math_mismatch" is not that; "Doesn't add up" plus the actual
 * numbers is. The specifics come from `detail`, computed server-side.
 */
const HEADLINES: Record<FlagReason, string> = {
  missing: "Couldn't find this in the document",
  unparseable: "Found something here, but couldn't read it as a number",
  extraction_failed: 'The extraction did not complete',
  illegible_source: 'The model reported this as unreadable rather than guessing',
  math_mismatch: "Doesn't add up",
  row_math_mismatch: "This row's quantity x price doesn't match its total",
  ambiguous_date: 'Ambiguous date format',
  low_agreement: 'The extraction passes disagreed here',
  // Deliberately not "all three": EXTRACTION_SAMPLES is configurable and
  // defaults to 2. Hard-coding the count produced "All three extraction
  // passes..." on a two-pass run, which is a small lie in the one place the
  // system is supposed to be scrupulous about what it actually observed.
  disagreement: 'Every extraction pass returned a different value',
  repair_required: 'The model output had to be repaired before it validated',
  truncated: 'The model ran out of room and the output was cut off',
  low_legibility: 'The source scan is poor quality overall',
  implausible_value: "This value doesn't look plausible",
};

export const flagHeadline = (reason: FlagReason): string => HEADLINES[reason];

export const flagMessage = (f: FieldFlag): string =>
  f.detail ? `${HEADLINES[f.reason]}: ${f.detail}` : HEADLINES[f.reason];

export const hasError = (flags: readonly FieldFlag[]): boolean =>
  flags.some((f) => f.severity === 'error');

export const countBySeverity = (flags: readonly FieldFlag[]) => ({
  error: flags.filter((f) => f.severity === 'error').length,
  warn: flags.filter((f) => f.severity === 'warn').length,
});

/** All flags attached to one field path. Used to decorate inputs in the UI. */
export const flagsFor = (flags: readonly FieldFlag[], field: string): FieldFlag[] =>
  flags.filter((f) => f.field === field);
