import { countBySeverity, type ExtractionStatus, type FieldFlag } from '@dia/shared';

/**
 * Turn flags into a score and a verdict.
 *
 * Confidence is COMPUTED, never taken from the model. `meta.legibility` is
 * the model's opinion of the source and it appears here only as a multiplier
 * on an already-derived number — it can pull a score down, it can never
 * prop one up. A model asserting it is 95% confident is not evidence.
 *
 * The weights below are reasoned, not fitted. With four documents there is
 * nothing to fit against, and pretending otherwise would be the kind of
 * false precision this project is supposed to avoid. That belongs in the
 * README's limitations, and calibrating against a labelled set is the first
 * thing I would do with more time.
 */

export const WEIGHTS = {
  perError: 0.15,
  perWarn: 0.05,
  repairPenalty: 0.1,
} as const;

/** Error flags on required fields beyond this, and the record is not worth trusting. */
const FAILED_ERROR_THRESHOLD = 3;

export const scoreConfidence = (
  flags: readonly FieldFlag[],
  legibility: number,
  repaired: boolean,
): number => {
  const { error, warn } = countBySeverity(flags);

  let score = 1;
  score -= error * WEIGHTS.perError;
  score -= warn * WEIGHTS.perWarn;
  if (repaired) score -= WEIGHTS.repairPenalty;

  // Multiplicative, so a bad scan caps the whole record no matter how clean
  // the arithmetic happens to look. Values we could not read cannot be
  // contradicted by a sum that balances.
  score *= Math.min(1, Math.max(0, legibility));

  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
};

export const deriveStatus = (
  flags: readonly FieldFlag[],
  hasValidObject: boolean,
): ExtractionStatus => {
  // No parseable object after repair and escalation. The API still returns
  // this as a 201 with the raw model output attached — a failed extraction is
  // a legitimate outcome, not a server error.
  if (!hasValidObject) return 'failed';

  const { error, warn } = countBySeverity(flags);

  // We have an object, but too much of it is untrustworthy to hand a reviewer
  // as if it were a record with a few problems. Saying so is the point: this
  // is the branch the degraded scan is meant to be able to reach.
  if (error >= FAILED_ERROR_THRESHOLD) return 'failed';

  if (error > 0 || warn > 0) return 'needs_review';

  return 'extracted';
};
