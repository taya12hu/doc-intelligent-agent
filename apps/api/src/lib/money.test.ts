import { describe, expect, it } from 'vitest';
import { coerceMoney, moneyEquals, round2 } from './money.js';

describe('coerceMoney', () => {
  it('passes finite numbers through', () => {
    expect(coerceMoney(1234.5)).toBe(1234.5);
    expect(coerceMoney(0)).toBe(0);
    expect(coerceMoney(-45)).toBe(-45);
  });

  it('rejects non-finite numbers rather than propagating NaN', () => {
    expect(coerceMoney(NaN)).toBeNull();
    expect(coerceMoney(Infinity)).toBeNull();
  });

  it('handles US grouping', () => {
    expect(coerceMoney('1,234.50')).toBe(1234.5);
    expect(coerceMoney('429.80')).toBe(429.8);
  });

  it('handles Indian lakh/crore grouping — sample #2 depends on this', () => {
    // A `\d{1,3}(,\d{3})*` regex does not match this at all.
    expect(coerceMoney('1,41,077.85')).toBe(141077.85);
    expect(coerceMoney('1,25,850.00')).toBe(125850);
    expect(coerceMoney('Rs. 1,41,077.85')).toBe(141077.85);
  });

  it('handles European decimal commas', () => {
    expect(coerceMoney('1.234,56')).toBe(1234.56);
    expect(coerceMoney('1234,56')).toBe(1234.56);
    expect(coerceMoney('18,4')).toBe(18.4);
    expect(coerceMoney('1.234.567')).toBe(1234567);
  });

  it('strips currency symbols and codes', () => {
    expect(coerceMoney('$1,200')).toBe(1200);
    expect(coerceMoney('€18.40')).toBe(18.4);
    expect(coerceMoney('₹1,41,077.85')).toBe(141077.85);
    expect(coerceMoney('EUR 6018.54')).toBe(6018.54);
    expect(coerceMoney('USD 465.26')).toBe(465.26);
  });

  it('strips trailing unit words', () => {
    expect(coerceMoney('22 Nos')).toBe(22);
    expect(coerceMoney('250 pcs')).toBe(250);
    expect(coerceMoney('1,200/-')).toBe(1200);
  });

  it('reads accounting parentheses as negative', () => {
    expect(coerceMoney('(45.00)')).toBe(-45);
    expect(coerceMoney('(6,292.50)')).toBe(-6292.5);
    expect(coerceMoney('-45.00')).toBe(-45);
  });

  it('returns null for absence, but NOT for zero', () => {
    for (const empty of ['', '  ', '-', 'N/A', 'nil', 'None', '∅', '?']) {
      expect(coerceMoney(empty), `${JSON.stringify(empty)} should be null`).toBeNull();
    }
    // Zero is a real amount, not a missing one. Conflating them would let a
    // blank cell silently reconcile as if it were 0.00.
    expect(coerceMoney('0')).toBe(0);
    expect(coerceMoney('0.00')).toBe(0);
  });

  it('returns null rather than guessing at junk', () => {
    expect(coerceMoney('see attached')).toBeNull();
    expect(coerceMoney('twelve')).toBeNull();
    expect(coerceMoney({})).toBeNull();
    expect(coerceMoney([])).toBeNull();
    expect(coerceMoney(undefined)).toBeNull();
  });

  it('resolves the ambiguous "1,234" as grouping', () => {
    // Documented tie-break: an invoice writing "1,234" means one thousand two
    // hundred and thirty four. The other reading is off by 1000x, which the
    // reconciliation checks catch loudly rather than silently.
    expect(coerceMoney('1,234')).toBe(1234);
  });
});

describe('round2 / moneyEquals', () => {
  it('rounds away float drift', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1044.5399999)).toBe(1044.54);
  });

  it('tolerates a cent either way, but not more', () => {
    expect(moneyEquals(429.8, 429.81)).toBe(true);
    expect(moneyEquals(429.8, 429.82)).toBe(true);
    expect(moneyEquals(429.8, 429.85)).toBe(false);
  });
});
