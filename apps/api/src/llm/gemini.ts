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

/**
 * Transport-level retries. NOT counted as repair attempts.
 *
 * `maxDelayMs` is 65s because the free tier's quota window is a minute: when
 * Gemini says "retry in 46s" the only useful thing to do is wait 46 seconds.
 * An 8s ceiling — my first guess — guarantees every retry lands inside the
 * same exhausted window and burns the whole budget in under 20 seconds.
 */
const TRANSPORT = { maxAttempts: 4, baseDelayMs: 700, maxDelayMs: 65_000 } as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gemini tells us exactly how long to wait on a 429. Use it.
 *
 * It arrives two ways depending on the error surface — a `RetryInfo` detail
 * with `retryDelay: "37s"`, and prose in the message ("Please retry in
 * 37.9s"). Both are worth parsing: guessing at an exponential backoff when
 * the server has published the answer is how you turn a 40-second wait into
 * a failed extraction.
 */
/**
 * Is this a DAILY quota exhaustion rather than a per-minute burst limit?
 *
 * The distinction is the difference between "wait 40 seconds" and "come back
 * tomorrow", and Gemini reports both as a 429 with a `retryDelay` of a few
 * seconds — which is actively misleading for the daily one.
 *
 * I lost real time to this: the free tier is 20 requests per DAY per model
 * (not the 5-per-minute limit that shows up first), and the retry logic
 * cheerfully waited out four 60-second windows against a cap that resets at
 * midnight. Retrying a daily quota is pure waste, so we fail immediately with
 * a message that says what actually happened.
 */
const isDailyQuotaExhausted = (err: unknown): boolean => {
  const text =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err);
  return /PerDay/i.test(text) || /RequestsPerDay/i.test(text);
};

const parseRetryDelayMs = (err: unknown): number | null => {
  const text =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err);

  const structured = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  if (structured) return Math.ceil(Number(structured[1]) * 1000);

  const prose = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text);
  if (prose) return Math.ceil(Number(prose[1]) * 1000);

  return null;
};

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

          // A daily cap does not clear by waiting. Say so and stop.
          if (isDailyQuotaExhausted(err)) {
            throw new ProviderTransportError(
              `Gemini daily free-tier quota exhausted for ${opts.model} ` +
                `(20 requests/day/model). This resets at midnight Pacific — it will NOT ` +
                `clear by retrying. Either wait, enable billing, or set ` +
                `EXTRACTION_SAMPLES=1 to spend a quarter as many requests.`,
              429,
              false,
            );
          }

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

          // Prefer the server's own retry hint over our guess. Add a second
          // of slack so we do not land exactly on the boundary of a window
          // that is still closing.
          const hinted = parseRetryDelayMs(err);
          const backoff = TRANSPORT.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
          const delay = Math.min(
            TRANSPORT.maxDelayMs,
            hinted !== null ? hinted + 1_000 : backoff,
          );

          if (hinted !== null) {
            console.warn(
              `  rate limited; waiting ${Math.round(delay / 1000)}s as instructed ` +
                `(attempt ${attempt}/${TRANSPORT.maxAttempts})`,
            );
          }
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
