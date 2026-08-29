import { describe, expect, it } from 'vitest';
import { isAmbiguousDateText, isImplausibleDate, normaliseDate } from './date.js';

describe('normaliseDate', () => {
  it('passes ISO through', () => {
    expect(normaliseDate('2025-03-12').iso).toBe('2025-03-12');
  });

  it('parses the formats the four samples actually use', () => {
    expect(normaliseDate('March 12, 2025').iso).toBe('2025-03-12'); // #1
    expect(normaliseDate('14-Mar-2025').iso).toBe('2025-03-14'); // #2
    expect(normaliseDate('27/02/2025').iso).toBe('2025-02-27'); // #4
  });

  it('falls back to the printed form when the model returned nothing usable', () => {
    expect(normaliseDate(null, '14-Mar-2025').iso).toBe('2025-03-14');
    expect(normaliseDate('not a date', '2025-03-12').iso).toBe('2025-03-12');
  });

  it('returns null rather than inventing a date', () => {
    expect(normaliseDate(null).iso).toBeNull();
    expect(normaliseDate('').iso).toBeNull();
    expect(normaliseDate('see above').iso).toBeNull();
  });
});

describe('ambiguity detection', () => {
  it('flags a date whose components could swap', () => {
    // Sample #3's planted date. Nothing in the document can settle this.
    expect(isAmbiguousDateText('08/03/2025')).toBe(true);
    expect(isAmbiguousDateText('12-03-2025')).toBe(true);
    expect(isAmbiguousDateText('01.02.2025')).toBe(true);
  });

  it('does NOT flag a date that can only be read one way', () => {
    // 27 is not a month, so this is unambiguously 27 February.
    expect(isAmbiguousDateText('27/02/2025')).toBe(false);
    expect(isAmbiguousDateText('14-Mar-2025')).toBe(false);
    expect(isAmbiguousDateText('2025-03-12')).toBe(false);
    expect(isAmbiguousDateText('March 12, 2025')).toBe(false);
    expect(isAmbiguousDateText(null)).toBe(false);
  });

  it('explains both readings in the detail, for the flag chip', () => {
    const r = normaliseDate('2025-08-03', '08/03/2025');
    expect(r.ambiguous).toBe(true);
    expect(r.iso).toBe('2025-08-03');
    // The reviewer needs to see the fork, not the word "ambiguous".
    expect(r.detail).toContain('3 Aug 2025');
    expect(r.detail).toContain('8 Mar 2025');
  });

  it('still normalises an ambiguous date — flagged, not discarded', () => {
    // A flagged best guess is useful; a null is not. The point is to be
    // honest about the uncertainty, not to refuse to answer.
    const r = normaliseDate(null, '08/03/2025');
    expect(r.iso).not.toBeNull();
    expect(r.ambiguous).toBe(true);
  });
});

describe('isImplausibleDate', () => {
  it('rejects dates outside a sane invoice window', () => {
    expect(isImplausibleDate('1823-01-01')).toBe(true);
    expect(isImplausibleDate('2087-06-01')).toBe(true);
  });

  it('accepts real invoice dates, including slightly post-dated ones', () => {
    expect(isImplausibleDate('2025-03-12')).toBe(false);
    expect(isImplausibleDate(null)).toBe(false);
  });
});
