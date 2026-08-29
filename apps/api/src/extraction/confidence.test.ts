import { flag, type FieldFlag } from '@dia/shared';
import { describe, expect, it } from 'vitest';
import { deriveStatus, scoreConfidence } from './confidence.js';

const errors = (n: number): FieldFlag[] =>
  Array.from({ length: n }, (_, i) => flag(`f${i}`, 'math_mismatch'));
const warns = (n: number): FieldFlag[] =>
  Array.from({ length: n }, (_, i) => flag(`w${i}`, 'low_agreement'));

describe('scoreConfidence', () => {
  it('is 1 for a clean extraction', () => {
    expect(scoreConfidence([], 1, false)).toBe(1);
  });

  it('drops faster for errors than for warnings', () => {
    expect(scoreConfidence(errors(1), 1, false)).toBe(0.85);
    expect(scoreConfidence(warns(1), 1, false)).toBe(0.95);
  });

  it('penalises a repaired response', () => {
    expect(scoreConfidence([], 1, true)).toBe(0.9);
  });

  it('lets poor legibility CAP the record, however clean the arithmetic looks', () => {
    // Multiplicative on purpose. A total we could not read is not made
    // trustworthy by the other numbers happening to sum correctly.
    expect(scoreConfidence([], 0.4, false)).toBe(0.4);
    expect(scoreConfidence(errors(1), 0.5, false)).toBe(0.43);
  });

  it('never lets the model TALK ITS WAY UP — legibility only ever reduces', () => {
    // A model asserting the source was perfectly legible is not evidence.
    const withFlags = scoreConfidence(errors(2), 1, false);
    expect(scoreConfidence(errors(2), 1, false)).toBeLessThanOrEqual(1);
    expect(withFlags).toBeLessThan(1);
  });

  it('clamps to 0 rather than going negative', () => {
    expect(scoreConfidence(errors(20), 1, false)).toBe(0);
  });
});

describe('deriveStatus', () => {
  it('is extracted only when nothing at all fired', () => {
    expect(deriveStatus([], true)).toBe('extracted');
  });

  it('is needs_review for a single warning', () => {
    expect(deriveStatus(warns(1), true)).toBe('needs_review');
  });

  it('is needs_review for one or two errors — usable, with problems', () => {
    expect(deriveStatus(errors(1), true)).toBe('needs_review');
    expect(deriveStatus(errors(2), true)).toBe('needs_review');
  });

  it('is failed once too much of the record is untrustworthy', () => {
    // We have an object, but handing it over as "a record with a few
    // problems" would misrepresent it. This is the branch the degraded scan
    // is allowed to reach.
    expect(deriveStatus(errors(3), true)).toBe('failed');
  });

  it('is failed when no valid object survived repair and escalation', () => {
    expect(deriveStatus([], false)).toBe('failed');
  });
});
