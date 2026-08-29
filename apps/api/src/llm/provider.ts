import type { GeminiSchema } from '@dia/shared';
import type { PreparedInput } from '../extraction/prepare.js';

/**
 * The seam between the extraction pipeline and whichever model is behind it.
 *
 * Worth the fifteen minutes it cost for two reasons. It is the escape hatch
 * if the Gemini free tier rate-limits mid-build — swapping providers becomes
 * a config change rather than a refactor. And it makes the interesting
 * version of the eval possible: run both providers over the same four
 * documents and put the comparison in the README, which is a real eval rather
 * than an assertion that I thought about evals.
 *
 * The interface is deliberately narrow. Everything above it — repair,
 * consensus, checks, confidence — is provider-agnostic, so a second
 * implementation only has to turn a prompt plus a document into text.
 */

export type ExtractionInput = {
  prepared: PreparedInput;
  systemPrompt: string;
  userPrompt: string;
  /** Provider-native output schema. Gemini takes an OpenAPI subset. */
  schema: GeminiSchema;
};

export type ProviderCallOptions = {
  model: string;
  temperature: number;
  maxOutputTokens?: number;
};

export type ProviderResult = {
  /** Raw response text. Parsing and repair are the caller's job. */
  rawText: string;
  /**
   * Why generation stopped. `MAX_TOKENS` is the one that matters: it means the
   * JSON is cut off mid-structure and needs the truncation path, not a
   * "the model got it wrong" path.
   */
  finishReason: string | undefined;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
  model: string;
};

export interface LLMProvider {
  readonly name: string;
  extract(input: ExtractionInput, opts: ProviderCallOptions): Promise<ProviderResult>;
  /** Used by `npm run check:models` to verify configured IDs actually exist. */
  listModels(): Promise<string[]>;
}

/**
 * Thrown when the call itself failed — network, rate limit, 5xx, safety block.
 *
 * Deliberately distinct from "the model returned something we could not
 * parse". They need different responses (backoff vs. a repair prompt) and
 * they mean different things in the log. Conflating them produces a repair
 * loop that burns its attempts asking a model to fix output it never sent.
 */
export class ProviderTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderTransportError';
  }
}
