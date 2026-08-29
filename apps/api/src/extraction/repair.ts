import {
  ExtractionEnvelopeSchema,
  type ExtractionEnvelope,
  type RepairStep,
} from '@dia/shared';
import type { z } from 'zod';
import { localRepair } from '../lib/json.js';
import { ProviderTransportError, type ExtractionInput, type LLMProvider } from '../llm/provider.js';
import { coerceEnvelope } from './coerce.js';
import { repairPrompt } from './prompt.js';

/**
 * Run ONE extraction sample, repairing malformed output as cheaply as possible.
 *
 * `responseSchema` constrains shape, not correctness, and it does not always
 * constrain shape either. This is the ladder, cheapest rung first:
 *
 *   0. local repair       no API call — fences, trailing commas, truncation
 *   1. type coercion      no API call — "1,234.50" -> 1234.5
 *   2. repair call        show the model its own output and the zod error
 *   3. escalation         retry once on the stronger model
 *   4. give up honestly   status 'failed', raw text kept, every field flagged
 *
 * Hard cap of 4 provider calls. Every rung appends to `repairLog`, which the
 * UI surfaces behind a disclosure — the point is that "we handle unreliable
 * model output" is something a reviewer can watch happen, not a claim.
 */

export type SampleOutcome = {
  ok: boolean;
  envelope: ExtractionEnvelope | null;
  /** Kept whether we succeeded or not: it is the evidence for a failed run. */
  rawText: string;
  attempts: number;
  repairLog: RepairStep[];
  /** Output was cut off and we dropped a partial tail. */
  truncated: boolean;
  escalatedTo: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
};

export type RepairOptions = {
  model: string;
  escalationModel: string;
  temperature: number;
  maxOutputTokens: number;
};

/** Compact zod errors into something a model can act on. */
const formatZodError = (error: z.ZodError): string =>
  error.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');

export const extractWithRepair = async (
  provider: LLMProvider,
  input: ExtractionInput,
  opts: RepairOptions,
): Promise<SampleOutcome> => {
  const repairLog: RepairStep[] = [];
  let attempts = 0;
  let truncated = false;
  let escalatedTo: string | null = null;
  let lastRawText = '';
  let totalLatency = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };

  const finish = (envelope: ExtractionEnvelope | null): SampleOutcome => ({
    ok: envelope !== null,
    envelope,
    rawText: lastRawText,
    attempts,
    repairLog,
    truncated,
    escalatedTo,
    usage: {
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
    },
    latencyMs: totalLatency,
  });

  /** One provider call plus the free local repairs. Returns a parsed envelope or a reason. */
  const tryOnce = async (
    stage: RepairStep['stage'],
    callInput: ExtractionInput,
    model: string,
    maxOutputTokens: number,
  ): Promise<{ envelope: ExtractionEnvelope } | { error: string; rawText: string }> => {
    attempts++;
    const result = await provider.extract(callInput, {
      model,
      temperature: opts.temperature,
      maxOutputTokens,
    });

    lastRawText = result.rawText;
    totalLatency += result.latencyMs;
    usage.inputTokens += result.usage.inputTokens ?? 0;
    usage.outputTokens += result.usage.outputTokens ?? 0;

    const hitCeiling = result.finishReason === 'MAX_TOKENS';

    const repaired = localRepair(result.rawText);
    if (repaired.truncated) truncated = true;
    if (hitCeiling) truncated = true;

    if (repaired.value === undefined) {
      const error = 'response was not parseable as JSON';
      repairLog.push({
        attempt: attempts,
        stage,
        model,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        error,
        action: 'local repair could not recover an object; escalating',
        latencyMs: result.latencyMs,
      });
      return { error, rawText: result.rawText };
    }

    const parsed = ExtractionEnvelopeSchema.safeParse(coerceEnvelope(repaired.value));

    if (parsed.success) {
      const notes: string[] = [];
      if (repaired.actions.length) notes.push(`local repair: ${repaired.actions.join(', ')}`);
      if (hitCeiling) notes.push('hit the token ceiling — output was truncated');
      repairLog.push({
        attempt: attempts,
        stage,
        model,
        ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        action: notes.length ? notes.join('; ') : 'validated on the first pass',
        latencyMs: result.latencyMs,
      });
      return { envelope: parsed.data };
    }

    const error = formatZodError(parsed.error);
    repairLog.push({
      attempt: attempts,
      stage,
      model,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      error,
      action:
        repaired.actions.length > 0
          ? `local repair (${repaired.actions.join(', ')}) was not enough; schema still failed`
          : 'schema validation failed',
      latencyMs: result.latencyMs,
    });
    return { error, rawText: result.rawText };
  };

  try {
    // ── rung 0-1: the initial call ────────────────────────────────────
    const first = await tryOnce('initial', input, opts.model, opts.maxOutputTokens);
    if ('envelope' in first) return finish(first.envelope);

    // ── rung 2: show the model its own output and the exact error ─────
    const repairInput: ExtractionInput = {
      ...input,
      userPrompt: repairPrompt(first.rawText.slice(0, 12_000), first.error),
    };
    const second = await tryOnce('repair_call', repairInput, opts.model, opts.maxOutputTokens);
    if ('envelope' in second) return finish(second.envelope);

    // ── rung 3: escalate ──────────────────────────────────────────────
    // Double the ceiling: if the first two attempts were truncated, a stronger
    // model with the same budget would truncate too, and we would have spent
    // an escalation learning nothing.
    escalatedTo = opts.escalationModel;
    const third = await tryOnce(
      'escalation',
      input,
      opts.escalationModel,
      opts.maxOutputTokens * 2,
    );
    if ('envelope' in third) return finish(third.envelope);

    // ── rung 4: give up honestly ──────────────────────────────────────
    return finish(null);
  } catch (err) {
    // Transport failures already exhausted their own backoff inside the
    // provider. Record and surface — the caller turns this into a `failed`
    // record with the reason attached, not a 500.
    const message = err instanceof Error ? err.message : String(err);
    repairLog.push({
      attempt: attempts,
      stage: 'initial',
      model: opts.model,
      error: message,
      action:
        err instanceof ProviderTransportError
          ? 'provider call failed after retries — this is a transport failure, not a bad extraction'
          : 'unexpected error during extraction',
    });
    return finish(null);
  }
};
