import type { ExtractionDTO } from '@dia/shared';

/**
 * The receipts.
 *
 * "We handle unreliable model output" is a claim. This is the evidence:
 * which model ran, how many independent passes, how many calls each took,
 * whether the repair loop fired and what it did about it, whether we
 * escalated.
 *
 * Behind a disclosure because a reviewer correcting an invoice does not care
 * — but a reviewer wondering *why the system thinks this field is wrong*
 * cares a lot, and so does anyone assessing whether the thing is honest.
 */
export const ExtractionLog = ({ extraction }: { extraction: ExtractionDTO }) => (
  <details className="rounded-md border border-stone-200 bg-white">
    <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-stone-500 select-none hover:text-stone-700">
      Extraction log — {extraction.samples} pass{extraction.samples === 1 ? '' : 'es'},{' '}
      {extraction.attempts} model call{extraction.attempts === 1 ? '' : 's'}
      {extraction.escalatedTo ? ', escalated' : ''}
    </summary>

    <div className="border-t border-stone-100 px-3 py-2 text-xs text-stone-600">
      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
        <dt className="text-stone-400">Provider</dt>
        <dd>{extraction.provider}</dd>
        <dt className="text-stone-400">Model</dt>
        <dd className="font-mono">{extraction.model}</dd>
        {extraction.escalatedTo && (
          <>
            <dt className="text-stone-400">Escalated to</dt>
            <dd className="font-mono">{extraction.escalatedTo}</dd>
          </>
        )}
        <dt className="text-stone-400">Latency</dt>
        <dd className="tnum">{extraction.latencyMs ? `${extraction.latencyMs} ms` : '—'}</dd>
        <dt className="text-stone-400">Tokens</dt>
        <dd className="tnum">
          {extraction.tokensIn ?? '—'} in / {extraction.tokensOut ?? '—'} out
        </dd>
      </dl>

      {extraction.repairLog.length > 0 && (
        <ol className="space-y-1 border-t border-stone-100 pt-2">
          {extraction.repairLog.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="tnum shrink-0 text-stone-400">#{step.attempt}</span>
              <span className="shrink-0 font-medium text-stone-500">{step.stage}</span>
              <span className="min-w-0">
                {step.action}
                {step.finishReason && step.finishReason !== 'STOP' && (
                  <span className="ml-1 rounded bg-amber-100 px-1 text-amber-900">
                    {step.finishReason}
                  </span>
                )}
                {step.error && (
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-red-700">
                    {step.error.split('\n')[0]}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  </details>
);
