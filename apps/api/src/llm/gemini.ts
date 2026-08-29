import { GoogleGenAI } from '@google/genai';
import { env } from '../env.js';
import {
  ProviderTransportError,
  type ExtractionInput,
  type LLMProvider,
  type ProviderCallOptions,
  type ProviderResult,
} from './provider.js';

/**
 * Gemini implementation.
 *
 * The whole reason this project uses Gemini: a PDF goes in as raw bytes and
 * schema-shaped JSON comes out, in ONE call. Native document input means no
 * rasterising, no DPI tuning, no per-request image cap — and `responseSchema`
 * composes with that document input, so there is no transcribe-then-structure
 * two-stage workaround.
 *
 * What `responseSchema` does NOT give us is correctness. It constrains SHAPE.
 * A schema-valid response with a hallucinated grand total looks exactly like
 * a correct one from here, which is why everything downstream of this file
 * exists.
 */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Transport-level retries. NOT counted as repair attempts. */
const TRANSPORT = { maxAttempts: 4, baseDelayMs: 700, maxDelayMs: 8_000 } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const statusOf = (err: unknown): number | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.code === 'number') return e.code;
  // The SDK often surfaces the status only inside the message text.
  const m = typeof e.message === 'string' ? /\b(4\d{2}|5\d{2})\b/.exec(e.message) : null;
  return m ? Number(m[1]) : undefined;
};

export const createGeminiProvider = (apiKey = env.GEMINI_API_KEY): LLMProvider => {
  const ai = new GoogleGenAI({ apiKey });

  const call = async (
    input: ExtractionInput,
    opts: ProviderCallOptions,
  ): Promise<ProviderResult> => {
    const parts =
      input.prepared.kind === 'pdf'
        ? [
            { inlineData: { mimeType: input.prepared.mimeType, data: input.prepared.base64 } },
            { text: input.userPrompt },
          ]
        : [{ text: `${input.userPrompt}\n\n---\n\n${input.prepared.text}` }];

    const startedAt = Date.now();

    const response = await ai.models.generateContent({
      model: opts.model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: input.systemPrompt,
        temperature: opts.temperature,
        responseMimeType: 'application/json',
        responseSchema: input.schema,
        ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      },
    });

    const candidate = response.candidates?.[0];
    const finishReason =
      typeof candidate?.finishReason === 'string' ? candidate.finishReason : undefined;

    // An empty candidate list means a safety or recitation block, not a model
    // mistake. Treat it as transport so it retries rather than burning repair
    // attempts asking the model to fix output it never produced.
    if (!response.candidates?.length) {
      throw new ProviderTransportError(
        `Gemini returned no candidates (${response.promptFeedback?.blockReason ?? 'unknown reason'})`,
        undefined,
        false,
      );
    }

    return {
      rawText: response.text ?? '',
      finishReason,
      usage: {
        inputTokens: response.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      },
      latencyMs: Date.now() - startedAt,
      model: opts.model,
    };
  };

  return {
    name: 'gemini',

    async extract(input, opts) {
      let lastError: unknown;

      for (let attempt = 1; attempt <= TRANSPORT.maxAttempts; attempt++) {
        try {
          return await call(input, opts);
        } catch (err) {
          lastError = err;

          if (err instanceof ProviderTransportError && !err.retryable) throw err;

          const status = statusOf(err);
          const retryable = status === undefined || RETRYABLE_STATUS.has(status);
          if (!retryable || attempt === TRANSPORT.maxAttempts) {
            throw new ProviderTransportError(
              `Gemini call failed${status ? ` (HTTP ${status})` : ''}: ${
                err instanceof Error ? err.message : String(err)
              }`,
              status,
              retryable,
            );
          }

          // Exponential backoff with jitter. The free tier's per-minute limit
          // is the expected reason to land here, and it clears on its own.
          const delay = Math.min(
            TRANSPORT.maxDelayMs,
            TRANSPORT.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()),
          );
          await sleep(delay);
        }
      }

      throw lastError;
    },

    async listModels() {
      const names: string[] = [];
      const pager = await ai.models.list();
      for await (const model of pager) {
        if (model.name) names.push(model.name.replace(/^models\//, ''));
      }
      return names.sort();
    },
  };
};
