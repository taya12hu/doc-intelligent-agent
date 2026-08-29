import { toGeminiSchema, ExtractionEnvelopeSchema } from '@dia/shared';
import { describe, expect, it } from 'vitest';
import {
  ProviderTransportError,
  type ExtractionInput,
  type LLMProvider,
  type ProviderResult,
} from '../llm/provider.js';
import { extractWithRepair } from './repair.js';

/**
 * The repair loop is the answer to "how do you handle unreliable model
 * output", so it is tested against a provider that is unreliable ON PURPOSE.
 * No network, no API key — the scripted failures below are the ones actually
 * seen from Gemini: markdown fences, trailing commas, wrong types, truncation
 * at the token ceiling, and outright transport failure.
 */

const VALID = JSON.stringify({
  invoice: {
    vendorName: 'Acme Supplies Inc.',
    invoiceNumber: 'INV-2025-0417',
    invoiceDate: '2025-03-12',
    currency: 'USD',
    lineItems: [{ description: 'Paper', quantity: 40, unitPrice: 4.25, lineTotal: 170 }],
    subtotal: 429.8,
    discountTotal: null,
    taxTotal: 35.46,
    grandTotal: 465.26,
  },
  meta: { illegibleFields: [], legibility: 1, notes: '', invoiceDateAsPrinted: 'March 12, 2025' },
});

/** A provider that replays a scripted list of responses, one per call. */
const scripted = (
  responses: (Partial<ProviderResult> | Error)[],
): LLMProvider & { calls: { model: string; prompt: string }[] } => {
  const calls: { model: string; prompt: string }[] = [];
  let i = 0;
  return {
    name: 'scripted',
    calls,
    async extract(input: ExtractionInput, opts) {
      calls.push({ model: opts.model, prompt: input.userPrompt });
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return {
        rawText: '',
        finishReason: 'STOP',
        usage: { inputTokens: 100, outputTokens: 200 },
        latencyMs: 10,
        model: opts.model,
        ...next,
      };
    },
    async listModels() {
      return [];
    },
  };
};

const input: ExtractionInput = {
  prepared: { kind: 'text', text: 'an invoice' },
  systemPrompt: 'sys',
  userPrompt: 'extract',
  schema: toGeminiSchema(ExtractionEnvelopeSchema),
};

const opts = {
  model: 'flash',
  escalationModel: 'pro',
  temperature: 0,
  maxOutputTokens: 4096,
};

describe('extractWithRepair', () => {
  it('accepts clean output in one call', async () => {
    const provider = scripted([{ rawText: VALID }]);
    const r = await extractWithRepair(provider, input, opts);

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.escalatedTo).toBeNull();
    expect(r.envelope?.invoice.grandTotal).toBe(465.26);
    expect(r.repairLog[0]?.action).toContain('validated on the first pass');
  });

  it('fixes fences and trailing commas locally, with NO extra API call', async () => {
    // The point of the cheapest-fix-first ordering: a round trip to fix a
    // comma is two wasted seconds and a wasted request.
    const messy = '```json\n' + VALID.replace('}}', '},}') + '\n```';
    const provider = scripted([{ rawText: messy }]);
    const r = await extractWithRepair(provider, input, opts);

    expect(r.ok).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(r.repairLog[0]?.action).toContain('local repair');
  });

  it('coerces "1,23,456.00" style numbers without a repair call', async () => {
    const withStrings = JSON.parse(VALID) as Record<string, Record<string, unknown>>;
    withStrings.invoice!.grandTotal = 'Rs. 1,41,077.85';
    withStrings.invoice!.subtotal = '1,25,850.00';
    const provider = scripted([{ rawText: JSON.stringify(withStrings) }]);
    const r = await extractWithRepair(provider, input, opts);

    expect(provider.calls).toHaveLength(1);
    expect(r.envelope?.invoice.grandTotal).toBe(141077.85);
    expect(r.envelope?.invoice.subtotal).toBe(125850);
  });

  it('sends a repair call when the schema genuinely fails, and keeps the fix surgical', async () => {
    const broken = JSON.stringify({ invoice: { vendorName: 'Acme' } }); // missing everything
    const provider = scripted([{ rawText: broken }, { rawText: VALID }]);
    const r = await extractWithRepair(provider, input, opts);

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(provider.calls).toHaveLength(2);
    // The repair prompt must show the model its own output and the error, and
    // must NOT re-send the extraction instructions — re-reading the document
    // invites it to change values that were already right.
    expect(provider.calls[1]!.prompt).toContain('failed schema validation');
    expect(provider.calls[1]!.prompt).toMatch(/do not\s+re-read the document/);
    // It must carry the specific failing paths, not just "it was invalid".
    expect(provider.calls[1]!.prompt).toContain('invoice.grandTotal');
    expect(provider.calls[1]!.prompt).toContain('{"invoice":{"vendorName":"Acme"}}');
    expect(r.repairLog[1]?.stage).toBe('repair_call');
  });

  it('escalates to the stronger model after the repair call also fails', async () => {
    const broken = JSON.stringify({ nope: true });
    const provider = scripted([{ rawText: broken }, { rawText: broken }, { rawText: VALID }]);
    const r = await extractWithRepair(provider, input, opts);

    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(r.escalatedTo).toBe('pro');
    expect(provider.calls[2]!.model).toBe('pro');
    expect(r.repairLog.at(-1)?.stage).toBe('escalation');
  });

  it('detects MAX_TOKENS truncation, recovers what it can, and says so', async () => {
    const cut = VALID.slice(0, VALID.indexOf('"subtotal"'));
    const provider = scripted([{ rawText: cut, finishReason: 'MAX_TOKENS' }, { rawText: VALID }]);
    const r = await extractWithRepair(provider, input, opts);

    expect(r.truncated).toBe(true);
    expect(r.repairLog[0]?.finishReason).toBe('MAX_TOKENS');
  });

  it('doubles the token ceiling when it escalates', async () => {
    // A stronger model on the same budget would truncate too, and we would
    // have spent the escalation learning nothing.
    let escalationBudget: number | undefined;
    const provider: LLMProvider = {
      name: 'budget-spy',
      async extract(_i, o) {
        if (o.model === 'pro') escalationBudget = o.maxOutputTokens;
        return {
          rawText: o.model === 'pro' ? VALID : '{"bad":1}',
          finishReason: 'MAX_TOKENS',
          usage: { inputTokens: 1, outputTokens: 1 },
          latencyMs: 1,
          model: o.model,
        };
      },
      async listModels() {
        return [];
      },
    };

    await extractWithRepair(provider, input, opts);
    expect(escalationBudget).toBe(opts.maxOutputTokens * 2);
  });

  it('fails honestly when every rung fails, keeping the raw output as evidence', async () => {
    const junk = 'I could not read this document.';
    const provider = scripted([{ rawText: junk }]);
    const r = await extractWithRepair(provider, input, opts);

    expect(r.ok).toBe(false);
    expect(r.envelope).toBeNull();
    expect(r.attempts).toBe(3); // initial + repair + escalation, then stop
    // The raw text is kept so the UI can show "extraction failed, here is what
    // the model actually said" rather than a blank record or a lie.
    expect(r.rawText).toBe(junk);
  });

  it('distinguishes a transport failure from a bad extraction', async () => {
    const provider = scripted([new ProviderTransportError('rate limited', 429, true)]);
    const r = await extractWithRepair(provider, input, opts);

    expect(r.ok).toBe(false);
    // Conflating the two produces a repair loop that burns its attempts asking
    // a model to fix output it never sent.
    expect(r.repairLog.at(-1)?.action).toContain('transport failure');
  });
});
