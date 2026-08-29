import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { classify } from '../extraction/classify.js';
import { prepare } from '../extraction/prepare.js';
import { resolveInputPath } from '../lib/paths.js';

/**
 * `npm run prepare:doc -- <file>`
 *
 * Shows exactly what the model will be given, before any model is involved.
 * Worth having as its own command: when an extraction goes wrong the first
 * question is always "did it misread the document, or did we hand it
 * something unreadable?" — and that is much cheaper to answer here than by
 * squinting at a failed run.
 */
const main = async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npm run prepare:doc -- <file>');
    process.exit(1);
  }

  const path = resolveInputPath(arg);
  const buf = await readFile(path);
  const classification = await classify(buf, basename(path));

  console.log(`file          ${basename(path)}  (${(buf.length / 1024).toFixed(0)} KB)`);
  console.log(`kind          ${classification.kind}`);
  console.log(`pages         ${classification.pageCount}`);
  console.log(`chars/page    ${classification.charsPerPage}  (scanned below 50)`);

  const prepared = prepare(buf, classification.kind, classification);

  if (prepared.kind === 'pdf') {
    console.log(`\nSent to the model as: raw PDF bytes, ${prepared.base64.length} base64 chars`);
    console.log(
      classification.kind === 'pdf_scanned'
        ? '\nNo usable text layer — the prompt will warn the model to expect a bad scan.'
        : '\nText layer present. Shown below for DIAGNOSTICS ONLY; the model gets the\n' +
            'PDF itself, which preserves the table structure this flattens away.\n',
    );
    if (classification.textLayer) {
      console.log('─'.repeat(72));
      console.log(classification.textLayer.slice(0, 3000));
      console.log('─'.repeat(72));
    }
  } else {
    console.log('\nSent to the model as text:\n');
    console.log(prepared.text);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
