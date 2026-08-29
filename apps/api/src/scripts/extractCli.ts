import { flagMessage, type FieldFlag } from '@dia/shared';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { runExtraction } from '../extraction/index.js';
import { createGeminiProvider } from '../llm/gemini.js';
import { resolveInputPath } from '../lib/paths.js';

/**
 * `npm run extract -- <file> [--json <out>] [--samples N]`
 *
 * The pipeline end to end without a database, a server or a browser. This is
 * how the extraction was actually developed, and it is the fastest way for a
 * reviewer to see what the system does — including, deliberately, what it
 * does when it is not sure.
 */

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const money = (n: number | null, currency: string | null): string =>
  n === null ? c.dim('—') : `${currency ? `${currency} ` : ''}${n.toFixed(2)}`;

const statusColour = (status: string) =>
  status === 'extracted' ? c.green : status === 'needs_review' ? c.amber : c.red;

const bar = (value: number, width = 20): string => {
  const filled = Math.round(value * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
};

const flagsFor = (flags: FieldFlag[], field: string) => flags.filter((f) => f.field === field);

const marker = (flags: FieldFlag[], field: string): string => {
  const own = flagsFor(flags, field);
  if (!own.length) return '  ';
  return own.some((f) => f.severity === 'error') ? c.red('!!') : c.amber(' ?');
};

const main = async () => {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: npm run extract -- <file> [--json <out>] [--samples N]');
    process.exit(1);
  }

  const jsonIndex = args.indexOf('--json');
  const jsonOut = jsonIndex !== -1 ? args[jsonIndex + 1] : undefined;
  const samplesIndex = args.indexOf('--samples');
  const samples = samplesIndex !== -1 ? Number(args[samplesIndex + 1]) : undefined;

  const resolved = resolveInputPath(path);
  const buffer = await readFile(resolved);

  console.log(`\n${c.bold(basename(resolved))}`);
  console.log(c.dim('extracting...'));

  const started = Date.now();
  const result = await runExtraction({
    buffer,
    filename: basename(resolved),
    provider: createGeminiProvider(),
    ...(samples ? { samples } : {}),
  });
  const wall = Date.now() - started;

  const { invoice, flags, classification } = result;
  const paint = statusColour(result.status);

  // ── verdict ────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(74)}`);
  console.log(
    `${paint(c.bold(result.status.toUpperCase().replace('_', ' ')))}   ` +
      `confidence ${bar(result.confidence)} ${(result.confidence * 100).toFixed(0)}%`,
  );
  console.log(
    c.dim(
      `${classification.kind} · ${result.samples} passes · ${result.attempts} model calls · ` +
        `${(wall / 1000).toFixed(1)}s wall` +
        (result.escalatedTo ? ` · escalated to ${result.escalatedTo}` : ''),
    ),
  );
  console.log('─'.repeat(74));

  // ── the record ─────────────────────────────────────────────────────
  const field = (label: string, value: string, path: string) =>
    console.log(`${marker(flags, path)} ${label.padEnd(16)} ${value}`);

  console.log();
  field('Vendor', invoice.vendorName ?? c.dim('—'), 'vendorName');
  field('Invoice no.', invoice.invoiceNumber ?? c.dim('—'), 'invoiceNumber');
  field('Date', invoice.invoiceDate ?? c.dim('—'), 'invoiceDate');
  field('Currency', invoice.currency ?? c.dim('—'), 'currency');

  console.log(`\n   ${c.dim('DESCRIPTION'.padEnd(40))}${c.dim('QTY'.padStart(8))}` +
    `${c.dim('UNIT'.padStart(12))}${c.dim('TOTAL'.padStart(12))}`);
  for (const [i, li] of invoice.lineItems.entries()) {
    const rowFlags = flags.filter((f) => f.field.startsWith(`lineItems[${i}]`));
    const mark = rowFlags.length
      ? rowFlags.some((f) => f.severity === 'error')
        ? c.red('!!')
        : c.amber(' ?')
      : '  ';
    console.log(
      `${mark} ${li.description.slice(0, 39).padEnd(40)}` +
        `${(li.quantity ?? '—').toString().padStart(8)}` +
        `${(li.unitPrice?.toFixed(2) ?? '—').padStart(12)}` +
        `${(li.lineTotal?.toFixed(2) ?? '—').padStart(12)}`,
    );
  }

  console.log();
  field('Subtotal', money(invoice.subtotal, invoice.currency), 'subtotal');
  if (invoice.discountTotal !== null)
    field('Discount', `-${money(invoice.discountTotal, invoice.currency)}`, 'discountTotal');
  if (invoice.taxTotal !== null)
    field('Tax', money(invoice.taxTotal, invoice.currency), 'taxTotal');
  field('Grand total', c.bold(money(invoice.grandTotal, invoice.currency)), 'grandTotal');

  // ── flags ──────────────────────────────────────────────────────────
  if (flags.length) {
    console.log(`\n${c.bold(`${flags.length} flag${flags.length === 1 ? '' : 's'}`)}`);
    for (const f of flags) {
      const sev = f.severity === 'error' ? c.red('error') : c.amber(' warn');
      console.log(`  ${sev}  ${c.bold(f.field)}`);
      console.log(`         ${flagMessage(f)}`);
    }
  } else {
    console.log(`\n${c.green('No flags — every check passed.')}`);
  }

  // ── the receipts ───────────────────────────────────────────────────
  console.log(`\n${c.dim('extraction log')}`);
  for (const step of result.repairLog) {
    console.log(
      c.dim(
        `  #${step.attempt} ${step.stage.padEnd(13)} ${step.model.padEnd(18)} ` +
          `${step.action}${step.latencyMs ? ` (${step.latencyMs}ms)` : ''}`,
      ),
    );
    if (step.error) console.log(c.dim(`     ${step.error.split('\n')[0]}`));
  }
  if (result.raw.notes) console.log(c.dim(`  model notes: ${result.raw.notes}`));

  if (result.raw.failureText) {
    console.log(`\n${c.red('raw model output (failed run)')}`);
    console.log(c.dim(result.raw.failureText.slice(0, 1500)));
  }

  console.log();

  if (jsonOut) {
    const out = resolveInputPath(jsonOut);
    await writeFile(out, JSON.stringify(result, null, 2));
    console.log(c.dim(`wrote ${out}\n`));
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
