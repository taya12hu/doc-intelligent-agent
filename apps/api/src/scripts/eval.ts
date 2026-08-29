import type { FieldFlag } from '@dia/shared';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runExtraction, type RunResult } from '../extraction/index.js';
import { createGeminiProvider } from '../llm/gemini.js';
import { REPO_ROOT } from '../lib/paths.js';
import { moneyEquals } from '@dia/shared';

/**
 * `npm run eval`
 *
 * Runs all four samples and scores them against `samples/truth.json`, which
 * is generated from the same fixture the documents are drawn from — so the
 * expectations cannot drift from the documents.
 *
 * THE HEADLINE NUMBER IS "SILENTLY WRONG": fields that came back with the
 * wrong value AND no flag on them.
 *
 * Plain accuracy is the wrong metric for this system. A field we could not
 * read and flagged is a success — the reviewer spends five seconds on it and
 * moves on. A field we got wrong and asserted confidently is the failure
 * mode that costs money, because nothing downstream will ever question it.
 * Those two outcomes score identically under accuracy and could not be more
 * different in practice.
 *
 * So every field lands in one of three buckets:
 *
 *   correct        matched the document
 *   flagged        wrong or missing, but we said so
 *   SILENTLY WRONG wrong, and we claimed otherwise    <- minimise this
 */

type Truth = {
  samples: {
    key: string;
    filename: string;
    difficulty: string;
    expected: Record<string, unknown> & {
      lineItems: { description: string; quantity: number | null; unitPrice: number | null; lineTotal: number | null }[];
    };
    mustFlag: { field: string; why: string }[];
    expectedStatus: string;
  }[];
};

type Bucket = 'correct' | 'flagged' | 'silently_wrong';

type FieldOutcome = { field: string; bucket: Bucket; expected: unknown; actual: unknown };

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const valuesMatch = (expected: unknown, actual: unknown): boolean => {
  if (expected === null || actual === null) return expected === actual;
  if (typeof expected === 'number' && typeof actual === 'number') {
    return moneyEquals(expected, actual, 0.02);
  }
  if (typeof expected === 'string' && typeof actual === 'string') {
    // Casing and punctuation are not extraction errors. "ACME SUPPLIES INC."
    // and "Acme Supplies Inc." are the same answer, and scoring them apart
    // would bury the real failures under cosmetic noise.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return norm(expected) === norm(actual);
  }
  return expected === actual;
};

const scoreSample = (
  truth: Truth['samples'][number],
  result: RunResult,
): { outcomes: FieldOutcome[]; missedFlags: string[] } => {
  const flags = result.flags;
  const outcomes: FieldOutcome[] = [];

  /**
   * A whole-record failure covers every field.
   *
   * When extraction fails outright the record carries a `_record` flag saying
   * so and the status is `failed` — the UI renders "treat all of this as
   * unverified". That is the LOUDEST possible signal, the exact opposite of
   * silently wrong.
   *
   * My first version of this scorer checked flags per exact field path, so a
   * failed run scored 24 "silent" failures — which would have made the
   * headline metric say the system's most honest outcome was its worst one.
   * Anything a reviewer is explicitly told not to trust is `flagged`.
   */
  const wholeRecordFlagged =
    result.status === 'failed' ||
    flags.some((f) => f.field === '_record' && f.severity === 'error');

  const isFlagged = (field: string): boolean =>
    wholeRecordFlagged ||
    flags.some((f) => f.field === field) ||
    // A row flagged anywhere covers its cells: "we could not read this row"
    // is a warning about every value on it.
    (field.startsWith('lineItems[') &&
      flags.some((f) => f.field.startsWith(field.slice(0, field.indexOf(']') + 1))));

  const compare = (field: string, expected: unknown, actual: unknown) => {
    const ok = valuesMatch(expected, actual);
    outcomes.push({
      field,
      bucket: ok ? 'correct' : isFlagged(field) ? 'flagged' : 'silently_wrong',
      expected,
      actual,
    });
  };

  for (const field of [
    'vendorName',
    'invoiceNumber',
    'invoiceDate',
    'currency',
    'subtotal',
    'discountTotal',
    'taxTotal',
    'grandTotal',
  ] as const) {
    compare(field, truth.expected[field], result.invoice[field]);
  }

  const expectedRows = truth.expected.lineItems;
  const actualRows = result.invoice.lineItems;

  if (expectedRows.length !== actualRows.length) {
    outcomes.push({
      field: 'lineItems.length',
      bucket: isFlagged('lineItems') ? 'flagged' : 'silently_wrong',
      expected: expectedRows.length,
      actual: actualRows.length,
    });
  }

  for (const [i, expectedRow] of expectedRows.entries()) {
    const actualRow = actualRows[i];
    for (const key of ['description', 'quantity', 'unitPrice', 'lineTotal'] as const) {
      compare(`lineItems[${i}].${key}`, expectedRow[key], actualRow?.[key] ?? null);
    }
  }

  // Fields the fixture says MUST be flagged: places where a confident value
  // is a failure even if it happens to be right.
  const missedFlags = truth.mustFlag.filter((m) => !isFlagged(m.field)).map((m) => m.field);

  return { outcomes, missedFlags };
};

const main = async () => {
  const truth = JSON.parse(
    await readFile(join(REPO_ROOT, 'samples', 'truth.json'), 'utf8'),
  ) as Truth;

  const outDir = join(REPO_ROOT, 'samples', 'output');
  await mkdir(outDir, { recursive: true });

  const provider = createGeminiProvider();
  const rows: {
    key: string;
    status: string;
    expectedStatus: string;
    confidence: number;
    correct: number;
    flagged: number;
    silent: number;
    total: number;
    missedFlags: string[];
    silentFields: FieldOutcome[];
  }[] = [];

  /**
   * Pause between documents.
   *
   * The free tier allows 5 requests/minute/model and each document spends 3.
   * Running them back to back means document 2 starts inside document 1's
   * exhausted window, and by document 3 the retries are consuming the next
   * window as fast as it opens — the first run of this script had blue-ridge
   * fail purely from quota starvation. Waiting is not politeness; without it
   * the eval measures the rate limiter rather than the extraction.
   */
  const pauseMs = Number(process.env.EVAL_PAUSE_MS ?? 45_000);

  for (const [index, sample] of truth.samples.entries()) {
    if (index > 0 && pauseMs > 0) {
      console.log(c.dim(`  (pausing ${pauseMs / 1000}s for the rate-limit window)`));
      await new Promise((r) => setTimeout(r, pauseMs));
    }
    process.stdout.write(`${sample.filename.padEnd(26)} extracting... `);

    const buffer = await readFile(join(REPO_ROOT, 'samples', 'input', sample.filename));
    const result = await runExtraction({ buffer, filename: sample.filename, provider });

    await writeFile(
      join(outDir, `${sample.key}.json`),
      JSON.stringify(result, null, 2),
    );

    const { outcomes, missedFlags } = scoreSample(sample, result);
    const correct = outcomes.filter((o) => o.bucket === 'correct').length;
    const flagged = outcomes.filter((o) => o.bucket === 'flagged').length;
    const silent = outcomes.filter((o) => o.bucket === 'silently_wrong');

    rows.push({
      key: sample.key,
      status: result.status,
      expectedStatus: sample.expectedStatus,
      confidence: result.confidence,
      correct,
      flagged,
      silent: silent.length,
      total: outcomes.length,
      missedFlags,
      silentFields: silent,
    });

    console.log(
      `${result.status.padEnd(13)} ${correct}/${outcomes.length} correct, ` +
        `${flagged} flagged, ${silent.length} silently wrong`,
    );
  }

  // ── report ──────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(78)}`);
  console.log(c.bold('EVAL'));
  console.log('─'.repeat(78));
  console.log(
    `${'sample'.padEnd(12)}${'status'.padEnd(14)}${'expected'.padEnd(14)}` +
      `${'correct'.padStart(9)}${'flagged'.padStart(9)}${'silent'.padStart(9)}`,
  );

  for (const r of rows) {
    const statusOk = r.status === r.expectedStatus;
    console.log(
      `${r.key.padEnd(12)}` +
        `${(statusOk ? c.green : c.amber)(r.status.padEnd(14))}` +
        `${c.dim(r.expectedStatus.padEnd(14))}` +
        `${String(r.correct).padStart(9)}` +
        `${c.amber(String(r.flagged).padStart(9))}` +
        `${(r.silent > 0 ? c.red : c.green)(String(r.silent).padStart(9))}`,
    );
  }

  const totals = rows.reduce(
    (a, r) => ({
      correct: a.correct + r.correct,
      flagged: a.flagged + r.flagged,
      silent: a.silent + r.silent,
      total: a.total + r.total,
    }),
    { correct: 0, flagged: 0, silent: 0, total: 0 },
  );

  console.log('─'.repeat(78));
  const pct = (n: number) => `${((n / totals.total) * 100).toFixed(1)}%`;
  console.log(
    `${'TOTAL'.padEnd(40)}${String(totals.correct).padStart(9)}` +
      `${c.amber(String(totals.flagged).padStart(9))}` +
      `${(totals.silent > 0 ? c.red : c.green)(String(totals.silent).padStart(9))}`,
  );
  console.log(
    c.dim(
      `${''.padEnd(40)}${pct(totals.correct).padStart(9)}` +
        `${pct(totals.flagged).padStart(9)}${pct(totals.silent).padStart(9)}`,
    ),
  );

  console.log(
    `\n${c.bold('Silently wrong')} — wrong value, no flag. The number that matters: ` +
      (totals.silent === 0
        ? c.green('0')
        : c.red(`${totals.silent} (${pct(totals.silent)})`)),
  );

  for (const r of rows) {
    for (const f of r.silentFields) {
      console.log(
        c.red(`  ${r.key}/${f.field}`) +
          c.dim(` expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`),
      );
    }
    if (r.missedFlags.length) {
      console.log(
        c.red(`  ${r.key}: expected flags never raised on `) + r.missedFlags.join(', '),
      );
    }
  }

  console.log(c.dim(`\nWrote ${rows.length} records to samples/output/\n`));

  // Non-zero exit on a silent failure so this is usable as a gate.
  if (totals.silent > 0 || rows.some((r) => r.missedFlags.length > 0)) process.exit(1);
};

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
