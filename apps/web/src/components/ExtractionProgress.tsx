import {
  PIPELINE_STAGES,
  estimateStage,
  useExtractionState,
} from '../api/extractionState.js';

/**
 * Shown while an extraction is running.
 *
 * Deliberately does NOT render a percentage. The upload is a single
 * synchronous request, so there is no progress to report, and a fake
 * percentage that jumps to 90% and sits there is worse than an honest
 * indeterminate bar. What the user gets instead is the file name, a live
 * elapsed counter, and the stage the request is most likely in.
 */
export const ExtractionProgress = () => {
  const { job, elapsed } = useExtractionState();
  if (!job) return null;

  const current = estimateStage(elapsed);
  const slow = elapsed > 60;

  return (
    <div className="animate-fade-in rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-500"
            />
            <span className="truncate">{job.label}</span>
          </p>
          <p className="mt-0.5 text-xs text-stone-500">
            {job.kind === 'reextract' ? 'Re-extracting' : 'Extracting'} — this usually takes
            10–40 seconds
          </p>
        </div>
        <span className="tnum shrink-0 text-sm font-medium text-stone-400">{elapsed}s</span>
      </div>

      {/* Indeterminate: activity, not completion. */}
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-stone-200">
        <div className="animate-indeterminate h-full w-1/3 rounded-full bg-sky-500" />
      </div>

      <ol className="mt-4 space-y-1.5">
        {PIPELINE_STAGES.map((stage, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li
              key={stage.label}
              className={`flex items-center gap-2.5 text-xs ${
                active ? 'text-stone-900' : done ? 'text-stone-400' : 'text-stone-300'
              }`}
            >
              <span
                aria-hidden
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  done
                    ? 'bg-stone-200 text-stone-500'
                    : active
                      ? 'bg-sky-100 text-sky-700'
                      : 'bg-stone-100 text-stone-300'
                }`}
              >
                {done ? '✓' : active ? '•' : ''}
              </span>
              <span className={active ? 'font-medium' : ''}>{stage.label}</span>
            </li>
          );
        })}
      </ol>

      {slow && (
        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This is taking longer than usual. The model API may be rate-limiting the request — it
          retries automatically, so give it another moment before reloading.
        </p>
      )}
    </div>
  );
};

/** Compact variant for the navigation bar, visible from any page. */
export const ExtractionIndicator = () => {
  const { job, elapsed } = useExtractionState();
  if (!job) return null;

  return (
    <span className="ml-auto flex items-center gap-2 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800 ring-1 ring-sky-600/20 ring-inset">
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
      <span className="max-w-[16rem] truncate">Extracting {job.label}</span>
      <span className="tnum text-sky-600">{elapsed}s</span>
    </span>
  );
};
