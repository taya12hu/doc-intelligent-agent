import { describe, expect, it } from 'vitest';
import {
  closeTruncatedJson,
  extractFirstBalancedObject,
  localRepair,
  removeTrailingCommas,
  stripCodeFences,
} from './json.js';

describe('stripCodeFences', () => {
  it('unwraps a fenced block', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced text alone', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('extractFirstBalancedObject', () => {
  it('ignores prose either side', () => {
    expect(extractFirstBalancedObject('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it('does not get confused by braces inside strings', () => {
    // A naive lastIndexOf('}') truncates this at the wrong place.
    const s = '{"description":"Bracket {A} fitting","qty":2}';
    expect(extractFirstBalancedObject(s)).toBe(s);
  });

  it('handles escaped quotes inside strings', () => {
    const s = '{"description":"6\\" flange","qty":2}';
    expect(extractFirstBalancedObject(s)).toBe(s);
  });

  it('returns null when nothing balances', () => {
    expect(extractFirstBalancedObject('{"a":1')).toBeNull();
  });
});

describe('removeTrailingCommas', () => {
  it('drops commas before a closer', () => {
    expect(removeTrailingCommas('{"a":1,}')).toBe('{"a":1}');
    expect(removeTrailingCommas('[1,2,]')).toBe('[1,2]');
  });

  it('never touches a comma inside a string', () => {
    expect(removeTrailingCommas('{"d":"Bolts, hex, M10"}')).toBe('{"d":"Bolts, hex, M10"}');
  });
});

describe('closeTruncatedJson', () => {
  it('closes a response cut off between elements', () => {
    const out = closeTruncatedJson('{"lineItems":[{"qty":1},{"qty":2},');
    expect(out).toBe('{"lineItems":[{"qty":1},{"qty":2}]}');
    expect(() => JSON.parse(out!)).not.toThrow();
  });

  it('DROPS a half-written value rather than inventing its tail', () => {
    // This is the MAX_TOKENS case. The temptation is to close the string and
    // keep "Powder Coat" as a description. That would be us hallucinating in
    // our own repair code, which is exactly what this project exists to catch.
    const out = closeTruncatedJson(
      '{"lineItems":[{"description":"Steel Plate","lineTotal":1500},{"description":"Powder Coat',
    );
    const parsed = JSON.parse(out!) as { lineItems: { description: string }[] };
    expect(parsed.lineItems).toHaveLength(1);
    expect(parsed.lineItems[0]!.description).toBe('Steel Plate');
    expect(JSON.stringify(parsed)).not.toContain('Powder Coat');
  });

  it('drops a truncated number rather than reading a prefix of it', () => {
    // "43.7" is a plausible-looking wrong answer for 43.75. Dropping the whole
    // row is correct; keeping a prefix would be silently wrong data.
    const out = closeTruncatedJson('{"items":[{"unitPrice":187.5},{"unitPrice":43.7');
    const parsed = JSON.parse(out!) as { items: { unitPrice: number }[] };
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.unitPrice).toBe(187.5);
  });

  it('returns null when the input is already balanced', () => {
    expect(closeTruncatedJson('{"a":1}')).toBeNull();
  });
});

describe('localRepair', () => {
  it('parses valid JSON with no actions taken', () => {
    const r = localRepair('{"a":1}');
    expect(r.value).toEqual({ a: 1 });
    expect(r.actions).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('handles the everyday case: a fence plus a trailing comma', () => {
    const r = localRepair('```json\n{"a":1,"b":[1,2,],}\n```');
    expect(r.value).toEqual({ a: 1, b: [1, 2] });
    expect(r.actions).toContain('stripped_code_fence');
    expect(r.actions).toContain('removed_trailing_commas');
  });

  it('reports truncation so the caller can flag it', () => {
    const r = localRepair('{"lineItems":[{"qty":1},{"qty":2},{"qt');
    expect(r.truncated).toBe(true);
    expect(r.actions).toContain('closed_truncated_json');
    expect((r.value as { lineItems: unknown[] }).lineItems).toHaveLength(2);
  });

  it('gives up rather than returning junk', () => {
    // No object at all. The repair loop escalates to the model from here.
    expect(localRepair('I was unable to read this document.').value).toBeUndefined();
  });
});
