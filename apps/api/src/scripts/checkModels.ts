import { env } from '../env.js';
import { createGeminiProvider } from '../llm/gemini.js';

/**
 * `npm run check:models`
 *
 * Step 0 of the build: confirm the configured model IDs actually exist on
 * this key. Gemini's roster moves, and a stale ID fails as a 404 in the
 * middle of an extraction where it looks like a pipeline bug rather than a
 * config problem. Thirty seconds here saves that.
 */
const main = async () => {
  const provider = createGeminiProvider();

  console.log('Fetching available models...\n');
  const available = await provider.listModels();

  const configured = [
    ['GEMINI_MODEL', env.GEMINI_MODEL],
    ['GEMINI_ESCALATION_MODEL', env.GEMINI_ESCALATION_MODEL],
  ] as const;

  let allGood = true;
  for (const [name, id] of configured) {
    const ok = available.includes(id);
    if (!ok) allGood = false;
    console.log(`${ok ? 'OK  ' : 'MISSING'}  ${name.padEnd(24)} ${id}`);
  }

  if (!allGood) {
    console.log('\nModels visible on this key that look usable for extraction:\n');
    for (const m of available.filter((m) => /gemini/.test(m) && !/embedding|image|tts/.test(m))) {
      console.log(`  ${m}`);
    }
    console.log('\nSet the working ones in .env and re-run.');
    process.exit(1);
  }

  console.log(`\nBoth configured models are available. ${available.length} models visible total.`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
