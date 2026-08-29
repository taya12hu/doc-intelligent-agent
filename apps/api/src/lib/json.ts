/**
 * Salvage JSON from model output, without an API call.
 *
 * This is step 0 of the repair loop, and it exists because most "malformed
 * output" is trivially malformed: a markdown fence, a trailing comma, or a
 * response cut off mid-array because it hit the token ceiling. Spending a
 * round trip asking the model to fix its own trailing comma is two wasted
 * seconds and a wasted request.
 *
 * Everything here is conservative. If a repair would require GUESSING at
 * content — inventing a closing value, filling in a truncated number — we
 * don't do it. Truncation is handled by cutting BACK to the last complete
 * value and closing the structure, so what survives is data the model
 * actually produced. The dropped tail becomes a `truncated` flag, which is
 * the honest outcome.
 */

export type RepairAction =
  | 'stripped_code_fence'
  | 'extracted_object'
  | 'removed_trailing_commas'
  | 'closed_truncated_json';

export type LocalRepairResult = {
  value: unknown;
  actions: RepairAction[];
  /** True when we had to drop a partial tail — the caller raises a flag. */
  truncated: boolean;
};

/** ```json ... ``` — by far the most common wrapper. */
export const stripCodeFences = (s: string): string => {
  const fenced = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(s);
  return fenced?.[1] ?? s;
};

/**
 * Find the first balanced `{...}`, respecting string literals.
 *
 * A naive `indexOf('{')` / `lastIndexOf('}')` breaks on any invoice whose
 * description contains a brace, and on prose before or after the JSON.
 */
export const extractFirstBalancedObject = (s: string): string | null => {
  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unbalanced — closeTruncatedJson gets a go at it
};

export const removeTrailingCommas = (s: string): string => {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      // Look ahead past whitespace: a comma before } or ] is trailing.
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === '}' || s[j] === ']') continue; // drop it
    }
    out += c;
  }
  return out;
};

type SafePoint = { index: number; stack: string[] };

/**
 * Close a response that was cut off mid-structure.
 *
 * Strategy: scan forward recording every point at which a COMPLETE value has
 * just ended and the parser sits between elements. On truncation, rewind to
 * the last such point, drop any dangling comma, and emit the closers the
 * stack demands.
 *
 * Rewinding rather than patching is the important part. Given
 * `..., {"description": "Powder Coat` we do not try to close the string and
 * keep a half-read description — we drop that whole element. Inventing the
 * tail of a value is exactly the hallucination this project exists to catch,
 * and it would be perverse to do it in our own repair code.
 */
export const closeTruncatedJson = (s: string): string | null => {
  const safePoints: SafePoint[] = [];
  const stack: string[] = [];

  let inString = false;
  let escaped = false;
  /** Index where the current bare token (number / true / false / null) began. */
  let tokenStart = -1;

  const isBetweenElements = (i: number): boolean => {
    let j = i;
    while (j < s.length && /\s/.test(s[j]!)) j++;
    const next = s[j];
    return next === ',' || next === '}' || next === ']';
  };

  const record = (index: number) => safePoints.push({ index, stack: [...stack] });

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        inString = false;
        // Only a VALUE completes here; a key is followed by ':'.
        if (isBetweenElements(i + 1)) record(i + 1);
      }
      continue;
    }

    if (tokenStart !== -1 && /[\s,}\]]/.test(c)) {
      tokenStart = -1;
      // The bare token ended just before this character.
      if (c === ',' || c === '}' || c === ']' || isBetweenElements(i)) record(i);
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c);
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      record(i + 1);
      continue;
    }
    if (tokenStart === -1 && /[-\d tfn]/.test(c) && !/\s/.test(c)) {
      tokenStart = i;
    }
  }

  // Already balanced and outside a string: nothing to close.
  if (stack.length === 0 && !inString) return null;

  const safe = safePoints.at(-1);
  if (!safe || safe.stack.length === 0) return null;

  let head = s.slice(0, safe.index).replace(/,\s*$/, '');
  for (const open of [...safe.stack].reverse()) {
    head += open === '{' ? '}' : ']';
  }
  return head;
};

/** Run the whole cheap pipeline and try to parse. */
export const localRepair = (raw: string): LocalRepairResult => {
  const actions: RepairAction[] = [];
  let truncated = false;

  const attempt = (text: string): unknown | undefined => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  // Fast path: it is already valid.
  const direct = attempt(raw);
  if (direct !== undefined) return { value: direct, actions, truncated };

  let text = raw;

  const unfenced = stripCodeFences(text);
  if (unfenced !== text) {
    actions.push('stripped_code_fence');
    text = unfenced;
    const parsed = attempt(text);
    if (parsed !== undefined) return { value: parsed, actions, truncated };
  }

  const extracted = extractFirstBalancedObject(text);
  if (extracted) {
    actions.push('extracted_object');
    text = extracted;
    const parsed = attempt(text);
    if (parsed !== undefined) return { value: parsed, actions, truncated };
  }

  const decommaed = removeTrailingCommas(text);
  if (decommaed !== text) {
    actions.push('removed_trailing_commas');
    text = decommaed;
    const parsed = attempt(text);
    if (parsed !== undefined) return { value: parsed, actions, truncated };
  }

  const closed = closeTruncatedJson(text);
  if (closed) {
    actions.push('closed_truncated_json');
    truncated = true;
    const cleaned = removeTrailingCommas(closed);
    const parsed = attempt(cleaned);
    if (parsed !== undefined) return { value: parsed, actions, truncated };
  }

  return { value: undefined, actions, truncated };
};
