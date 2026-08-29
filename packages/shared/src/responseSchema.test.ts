import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExtractionEnvelopeSchema } from './invoice.js';
import { toGeminiSchema } from './responseSchema.js';

/**
 * These tests exist because every bug this converter can have is a RUNTIME
 * bug — the API rejects the request or, worse, quietly ignores a malformed
 * constraint and returns unconstrained output. TypeScript cannot catch a
 * lowercase `"string"` where the wire format wants `"STRING"`.
 */

describe('toGeminiSchema', () => {
  it('emits UPPERCASE OpenAPI types, not JSON Schema lowercase', () => {
    expect(toGeminiSchema(z.string()).type).toBe('STRING');
    expect(toGeminiSchema(z.number()).type).toBe('NUMBER');
    expect(toGeminiSchema(z.number().int()).type).toBe('INTEGER');
    expect(toGeminiSchema(z.boolean()).type).toBe('BOOLEAN');
    expect(toGeminiSchema(z.array(z.string())).type).toBe('ARRAY');
    expect(toGeminiSchema(z.object({})).type).toBe('OBJECT');
  });

  it('expresses nullability as `nullable: true`, never as a type union', () => {
    const s = toGeminiSchema(z.string().nullable());
    expect(s).toEqual({ type: 'STRING', nullable: true });
    // The JSON Schema spelling must NOT appear — Gemini ignores it.
    expect(Array.isArray(s.type)).toBe(false);
  });

  it('treats optional as nullable, so the key is always present', () => {
    expect(toGeminiSchema(z.string().optional())).toEqual({ type: 'STRING', nullable: true });
  });

  it('marks every object key required and pins property order', () => {
    const s = toGeminiSchema(z.object({ b: z.string(), a: z.number().nullable() }));
    expect(s.required).toEqual(['b', 'a']);
    expect(s.propertyOrdering).toEqual(['b', 'a']);
    // Required + nullable together are what force an explicit `null` rather
    // than a dropped key. That distinction is the whole flagging story.
    expect(s.properties?.a).toEqual({ type: 'NUMBER', nullable: true });
  });

  it('carries descriptions through, including on nullable wrappers', () => {
    expect(toGeminiSchema(z.string().describe('the vendor')).description).toBe('the vendor');
    expect(toGeminiSchema(z.string().nullable().describe('outer')).description).toBe('outer');
    expect(toGeminiSchema(z.string().describe('inner').nullable()).description).toBe('inner');
  });

  it('recurses into arrays of objects', () => {
    const s = toGeminiSchema(z.array(z.object({ q: z.number().nullable() })));
    expect(s.items?.type).toBe('OBJECT');
    expect(s.items?.properties?.q).toEqual({ type: 'NUMBER', nullable: true });
  });

  it('emits enums as STRING + enum values', () => {
    expect(toGeminiSchema(z.enum(['a', 'b']))).toEqual({ type: 'STRING', enum: ['a', 'b'] });
  });

  it('throws loudly on an unsupported construct rather than emitting junk', () => {
    // A silent partial conversion would produce an unconstrained field and we
    // would never know why extraction quality dropped.
    expect(() => toGeminiSchema(z.union([z.string(), z.number()]))).toThrow(/unsupported zod type/);
  });

  describe('the real ExtractionEnvelope', () => {
    const schema = toGeminiSchema(ExtractionEnvelopeSchema);

    it('has both branches with every field required', () => {
      expect(schema.type).toBe('OBJECT');
      expect(schema.required).toEqual(['invoice', 'meta']);

      const invoice = schema.properties?.invoice;
      expect(invoice?.required).toEqual([
        'vendorName',
        'invoiceNumber',
        'invoiceDate',
        'currency',
        'lineItems',
        'subtotal',
        'discountTotal',
        'taxTotal',
        'grandTotal',
      ]);
    });

    it('makes every scalar invoice field nullable', () => {
      const props = schema.properties?.invoice?.properties ?? {};
      for (const key of Object.keys(props)) {
        if (key === 'lineItems') continue; // an array, never null — empty instead
        expect(props[key]?.nullable, `${key} must be nullable`).toBe(true);
      }
      // lineItems is an ARRAY and stays non-nullable: "no line items" is `[]`,
      // which is a fact, whereas `null` would be indistinguishable from
      // "I didn't look".
      expect(props.lineItems?.nullable).toBeUndefined();
    });

    it('tells the model not to put tax/discount rows in lineItems', () => {
      // This description is load-bearing: if discount rows leak into
      // lineItems, reconciliation stage 1 breaks on a correct extraction.
      expect(schema.properties?.invoice?.properties?.lineItems?.description).toMatch(
        /do NOT put/i,
      );
    });

    it('describes every field it sends', () => {
      const props = schema.properties?.invoice?.properties ?? {};
      for (const [key, value] of Object.entries(props)) {
        expect(value.description, `${key} needs a description`).toBeTruthy();
      }
    });

    it('contains no JSON-Schema-only keys the API would reject', () => {
      const json = JSON.stringify(schema);
      for (const banned of ['$ref', '$defs', '$schema', 'additionalProperties', 'anyOf']) {
        expect(json).not.toContain(banned);
      }
    });
  });
});
