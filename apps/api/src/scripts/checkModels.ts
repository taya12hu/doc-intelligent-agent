import { GoogleGenAI } from '@google/genai';
import { env } from '../env.js';
import { createGeminiProvider } from '../llm/gemini.js';

/**
 * `npm run check:models`
 *
 * Step 0 of the build: confirm the configured models actually WORK on this
 * key.
 *
 * The first version of this script only checked membership of `listModels()`,
 * and that was worse than useless — it gave confident green ticks for two
 * models, one of which returned 404 "no longer available to new users" on the
 * first real call, and the other 503. Being listed means the model exists
 * somewhere, not that this key can call it on this tier.
 *
 * So this makes a real (tiny) request per configured model. Slower, costs
 * three tokens, and is the only version that answers the question actually
 * being asked.
 */

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Probe = { ok: true } | { ok: false; code: string; reason: string };

const probe = async (model: string): Promise<Probe> => {
  try {
    await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with: ok' }] }],
      config: { maxOutputTokens: 2000 },
    });
    return { ok: true };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ');
    const code = /\b(4\d{2}|5\d{2})\b/.exec(message)?.[1] ?? '???';
    const reason =
      code === '404'
        ? 'not available to this key'
        : code === '429'
          ? 'quota exhausted (free tier may not include this model)'
          : code === '503'
            ? 'model overloaded right now — try again, or pick another'
            : message.slice(0, 110);
    return { ok: false, code, reason };
  }
};

const main = async () => {
  const configured = [
    ['GEMINI_MODEL', env.GEMINI_MODEL],
    ['GEMINI_ESCALATION_MODEL', env.GEMINI_ESCALATION_MODEL],
  ] as const;

  console.log('Calling each configured model...\n');

  let allGood = true;
  for (const [name, id] of configured) {
    const result = await probe(id);
    if (result.ok) {
      console.log(`  OK        ${name.padEnd(24)} ${id}`);
    } else {
      allGood = false;
      console.log(`  FAIL ${result.code}  ${name.padEnd(24)} ${id}`);
      console.log(`            ${result.reason}`);
    }
    await sleep(3_000); // free tier is 5 req/min; do not trip it while checking
  }

  if (!allGood) {
    console.log('\nModels visible on this key (not all are callable on the free tier):\n');
    const available = await createGeminiProvider().listModels();
    for (const m of available.filter(
      (m) => /^gemini/.test(m) && !/embedding|image|tts|audio|live|robotics|transcribe/.test(m),
    )) {
      console.log(`  ${m}`);
    }
    console.log(
      '\nFlash models are the reliable free-tier choice; pro-class models are\n' +
        'generally quota-blocked without billing enabled. Set working IDs in .env\n' +
        'and re-run.',
    );
    process.exit(1);
  }

  console.log(`\nBoth configured models responded. Samples per document: ${env.EXTRACTION_SAMPLES}.`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
