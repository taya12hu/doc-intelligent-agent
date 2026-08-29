import { z } from 'zod';

/**
 * zod -> Gemini `Schema` (the `responseSchema` config field).
 *
 * WHY HAND-ROLL THIS instead of pulling in `zod-to-json-schema`?
 *
 * Gemini does not take JSON Schema here. It takes an OpenAPI 3.0 *subset*,
 * and the differences are exactly the ones a generic converter gets wrong:
 *
 *   - `type` is an UPPERCASE enum ("STRING", "OBJECT"), not JSON Schema's
 *     lowercase strings. This one fails at runtime, not compile time.
 *   - nullability is `nullable: true`, NOT `type: ["string", "null"]`
 *   - `$ref` / `$defs` are not supported, so everything must be inlined
 *   - `additionalProperties` is not part of the Schema type at all
 *   - `propertyOrdering` is Gemini-specific and measurably improves output
 *     consistency; no JSON Schema converter will emit it
 *
 * Our schema uses six constructs. Ninety lines that handle those six exactly
 * beats a dependency that handles two hundred approximately and silently
 * emits something the API rejects. `responseSchema.test.ts` pins the shape.
 *
 * NOTE: the SDK also exposes `responseJsonSchema`, which does take real JSON
 * Schema. We deliberately use `responseSchema` instead: `propertyOrdering`
 * has no JSON Schema equivalent, and the OpenAPI subset is the better-trodden
 * path for this model family.
 *
 * On descriptions — the SDK's own docs for `Schema.description` say it is
 * "best practice to provide a clear and descriptive explanation for the
 * schema and its properties here, rather than in the prompt." That is why
 * per-field semantics live in `.describe()` calls on the zod schema and only
 * global rules live in `prompt.ts`.
 */

/** Mirrors the SDK's `Type` enum without importing the SDK into shared code. */
export type GeminiType = 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'OBJECT' | 'ARRAY';

export type GeminiSchema = {
  type: GeminiType;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  propertyOrdering?: string[];
  items?: GeminiSchema;
};

type Unwrapped = { inner: z.ZodTypeAny; nullable: boolean };

/** Peel wrappers that carry no meaning for the wire format. */
const unwrap = (schema: z.ZodTypeAny): Unwrapped => {
  let inner = schema;
  let nullable = false;

  // Loop rather than recurse: `.nullable().describe()` and
  // `.describe().nullable()` both occur, in either order.
  for (;;) {
    if (inner instanceof z.ZodNullable) {
      nullable = true;
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodOptional) {
      // Gemini wants every property present. An optional field is therefore
      // emitted as nullable: "always send the key, null is an acceptable value".
      nullable = true;
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodDefault) {
      inner = inner._def.innerType as z.ZodTypeAny;
    } else if (inner instanceof z.ZodEffects) {
      inner = inner._def.schema as z.ZodTypeAny;
    } else {
      return { inner, nullable };
    }
  }
};

export const toGeminiSchema = (schema: z.ZodTypeAny): GeminiSchema => {
  const outerDescription = schema.description;
  const { inner, nullable } = unwrap(schema);
  // A description on the outer wrapper wins; fall back to the inner type's.
  const description = outerDescription ?? inner.description;

  const decorate = (base: GeminiSchema): GeminiSchema => ({
    ...base,
    ...(description ? { description } : {}),
    ...(nullable ? { nullable: true } : {}),
  });

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    const keys = Object.keys(shape);
    const properties: Record<string, GeminiSchema> = {};
    for (const key of keys) {
      const child = shape[key];
      if (child) properties[key] = toGeminiSchema(child);
    }
    return decorate({
      type: 'OBJECT',
      properties,
      // Every key required. Combined with the nullability above, this is what
      // guarantees the model emits an explicit `null` rather than dropping the
      // key — the whole reason we can tell "not found" apart from "forgot".
      required: keys,
      propertyOrdering: keys,
    });
  }

  if (inner instanceof z.ZodArray) {
    return decorate({ type: 'ARRAY', items: toGeminiSchema(inner.element as z.ZodTypeAny) });
  }

  if (inner instanceof z.ZodEnum) {
    return decorate({ type: 'STRING', enum: [...(inner.options as string[])] });
  }

  if (inner instanceof z.ZodString) return decorate({ type: 'STRING' });
  if (inner instanceof z.ZodBoolean) return decorate({ type: 'BOOLEAN' });
  if (inner instanceof z.ZodNumber) {
    return decorate({ type: inner.isInt ? 'INTEGER' : 'NUMBER' });
  }

  throw new Error(
    `toGeminiSchema: unsupported zod type "${inner.constructor.name}". ` +
      `Add a case here rather than working around it at the call site.`,
  );
};
