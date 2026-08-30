import {
  ExtractionEnvelopeSchema,
  emptyInvoice,
  flag,
  toGeminiSchema,
  type ExtractionEnvelope,
  type ExtractionMeta,
  type ExtractionStatus,
  type FieldFlag,
  type Invoice,
  type RepairStep,
} from '@dia/shared';
import { env } from '../env.js';
import { normaliseDate } from '../lib/date.js';
import type { ExtractionInput, LLMProvider } from '../llm/provider.js';
import { classify, type Classification } from './classify.js';
import { runChecks } from './checks.js';
import { buildConsensus } from './consensus.js';
import { deriveStatus, scoreConfidence } from './confidence.js';
import { prepare } from './prepare.js';
import { systemPrompt, userPrompt } from './prompt.js';
import { extractWithRepair, type SampleOutcome } from './repair.js';

/**
 * The whole pipeline: bytes in, a validated record plus an honest verdict out.
 *
 *   classify -> prepare -> N samples (repair loop each) -> consensus
 *            -> normalise -> deterministic checks -> confidence + status
 *
 * Everything after `prepare` is provider-agnostic and pure, which is why most
 * of it is unit-tested without a network.
 */

const RESPONSE_SCHEMA = toGeminiSchema(ExtractionEnvelopeSchema);
const MAX_OUTPUT_TOKENS = 8192;

export type RunInput = {
  buffer: Buffer;
  filename: string;
  provider: LLMProvider;
  /** Defaults to EXTRACTION_SAMPLES. */
  samples?: number;
};

export type RunResult = {
  classification: Classification;
  invoice: Invoice;
  meta: ExtractionMeta;
  flags: FieldFlag[];
  confidence: number;
  status: ExtractionStatus;

  provider: string;
  model: string;
  escalatedTo: string | null;
  samples: number;
  attempts: number;
  repairLog: RepairStep[];
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null };

  /** Everything needed to reproduce and debug this run, persisted to `raw`. */
  raw: {
    notes: string;
    legibility: number;
    illegibleFields: string[];
    invoiceDateAsPrinted: string | null;
    agreement: Record<string, string>;
    /** Each sample's invoice, so a disagreement can be inspected after the fact. */
    sampleInvoices: (Invoice | null)[];
    /** Only populated on failure — the model's actual words. */
    failureText?: string;
  };
};

/**
 * Temperature schedule.
 *
 * Sample 0 is always greedy: it is the canonical reading, the tie-break when
 * three passes split, and the source of `meta`. The rest are warm enough to
 * explore genuinely different readings — the point is to find out which
 * fields MOVE, and a schedule of all-zeros would just return the same answer
 * three times at three times the cost.
 */
const temperatureFor = (index: number): number => (index === 0 ? 0 : 0.4);

/**
 * Why nothing usable came back.
 *
 * A request the provider refused and a response the model mangled are
 * different failures and need different wording. Reusing a field-level
 * "couldn't read it as a number" for either was wrong — on a quota failure
 * no value was ever read, so there was nothing to fail to parse.
 */
export const describeTotalFailure = (repairLog: RepairStep[]): string => {
  const transport = repairLog.some((s) => /transport failure/i.test(s.action));
  const lastError = [...repairLog].reverse().find((s) => s.error)?.error ?? '';

  if (transport) {
    return /quota/i.test(lastError)
      ? 'the model API refused the request because its quota is exhausted — the ' +
          'document was never read'
      : 'the model API could not be reached after retries — the document was never read';
  }
  return (
    'the model responded but never produced a valid record, across the repair loop ' +
    'and an escalation — its raw output is kept with this record'
  );
};

export const runExtraction = async (input: RunInput): Promise<RunResult> => {
  const sampleCount = input.samples ?? env.EXTRACTION_SAMPLES;

  const classification = await classify(input.buffer, input.filename);
  const prepared = prepare(input.buffer, classification.kind, classification);

  const callInput: ExtractionInput = {
    prepared,
    systemPrompt: systemPrompt(),
    userPrompt: userPrompt(classification.kind),
    schema: RESPONSE_SCHEMA,
  };

  /**
   * Passes run SEQUENTIALLY, not concurrently.
   *
   * I wrote this as `Promise.all` first, which was wrong. Gemini's free tier
   * allows 5 requests per minute per model, and three simultaneous passes
   * trip it immediately — all three fail together and the document produces
   * nothing at all.
   *
   * Sequential is better than "concurrent with backoff" for a reason beyond
   * politeness: pass 0 is the canonical temperature-0 reading. Running it
   * first means that if the quota runs out partway, we still have a usable
   * record from fewer passes (with the reduced consensus flagged) rather than
   * losing everything at once. Degrading is worth more than parallelism when
   * the whole run takes a handful of seconds anyway.
   */
  const outcomes: SampleOutcome[] = [];
  for (let i = 0; i < sampleCount; i++) {
    outcomes.push(
      await extractWithRepair(input.provider, callInput, {
        model: env.GEMINI_MODEL,
        escalationModel: env.GEMINI_ESCALATION_MODEL,
        temperature: temperatureFor(i),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }),
    );
  }

  const repairLog = outcomes.flatMap((o) => o.repairLog);
  const attempts = outcomes.reduce((a, o) => a + o.attempts, 0);
  // Summed, not maxed: the passes run one after another, so total model time
  // is the sum. (It was `Math.max` while they ran concurrently.)
  const latencyMs = outcomes.reduce((a, o) => a + o.latencyMs, 0);
  const escalatedTo = outcomes.find((o) => o.escalatedTo)?.escalatedTo ?? null;
  const truncated = outcomes.some((o) => o.truncated);
  const repaired = outcomes.some((o) => o.attempts > 1);
  const usage = {
    inputTokens: outcomes.reduce((a, o) => a + (o.usage.inputTokens ?? 0), 0) || null,
    outputTokens: outcomes.reduce((a, o) => a + (o.usage.outputTokens ?? 0), 0) || null,
  };

  const base = {
    classification,
    provider: input.provider.name,
    model: env.GEMINI_MODEL,
    escalatedTo,
    samples: sampleCount,
    attempts,
    repairLog,
    latencyMs,
    usage,
  };

  const successful = outcomes.filter(
    (o): o is SampleOutcome & { envelope: ExtractionEnvelope } => o.envelope !== null,
  );

  // ── nothing survived ──────────────────────────────────────────────
  if (successful.length === 0) {
    const meta: ExtractionMeta = {
      illegibleFields: [],
      legibility: 0,
      notes: 'extraction failed',
      invoiceDateAsPrinted: null,
    };
    return {
      ...base,
      invoice: emptyInvoice(),
      meta,
      flags: [flag('_record', 'extraction_failed', describeTotalFailure(repairLog))],
      confidence: 0,
      status: 'failed',
      raw: {
        notes: 'extraction failed',
        legibility: 0,
        illegibleFields: [],
        invoiceDateAsPrinted: null,
        agreement: {},
        sampleInvoices: outcomes.map(() => null),
        failureText: outcomes.find((o) => o.rawText)?.rawText ?? '',
      },
    };
  }

  // ── consensus over whatever survived ──────────────────────────────
  const consensus = buildConsensus(successful.map((o) => o.envelope));

  const flags: FieldFlag[] = [...consensus.flags];

  // A pass that died is not a pass that disagreed, but it does mean the
  // consensus rests on fewer readings than we asked for. Say so.
  if (successful.length < sampleCount) {
    flags.push(
      flag(
        '_record',
        'repair_required',
        `${sampleCount - successful.length} of ${sampleCount} extraction passes failed; ` +
          `consensus is based on ${successful.length}`,
      ),
    );
  }

  // Normalise the date into the record. The ambiguity FLAG comes from
  // `runChecks`, which sees the printed form — normalising here would
  // otherwise erase the evidence that there was ever a choice to make.
  const normalisedDate = normaliseDate(
    consensus.invoice.invoiceDate,
    consensus.meta.invoiceDateAsPrinted,
  );
  const invoice: Invoice = { ...consensus.invoice, invoiceDate: normalisedDate.iso };

  flags.push(
    ...runChecks({ invoice, meta: consensus.meta, truncated, repaired }),
  );

  const confidence = scoreConfidence(flags, consensus.meta.legibility, repaired);
  const status = deriveStatus(flags, true);

  return {
    ...base,
    invoice,
    meta: consensus.meta,
    flags,
    confidence,
    status,
    raw: {
      notes: consensus.meta.notes,
      legibility: consensus.meta.legibility,
      illegibleFields: consensus.meta.illegibleFields,
      invoiceDateAsPrinted: consensus.meta.invoiceDateAsPrinted,
      agreement: consensus.agreement,
      sampleInvoices: outcomes.map((o) => o.envelope?.invoice ?? null),
    },
  };
};
