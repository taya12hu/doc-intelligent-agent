import type { ExtractionDTO } from '@dia/shared';

/**
 * Explains why an extraction failed, in terms the user can act on.
 *
 * "This extraction failed" on its own sends people to the logs. Worse, the
 * previous copy told them to check every value against the document — which
 * is wrong when the model was never successfully called, because there are no
 * values to check. Those are different situations and need different advice:
 *
 *   quota    the API refused the request; waiting or billing fixes it
 *   service  a transient upstream problem; retrying fixes it
 *   model    the model responded but never produced a usable record
 *
 * The reason already exists on the record — the repair log stores the error
 * from every attempt. It was just hidden behind a collapsed disclosure.
 */

type Failure = {
  kind: 'quota' | 'service' | 'model' | 'unknown';
  title: string;
  detail: string;
  action: string;
};

export const describeFailure = (extraction: ExtractionDTO): Failure => {
  const steps = extraction.repairLog;
  const lastError = [...steps].reverse().find((s) => s.error)?.error ?? '';

  // Transport failures are recorded distinctly from bad output, precisely so
  // this distinction survives to the UI.
  const isTransport = steps.some((s) => /transport failure/i.test(s.action));

  if (isTransport && /quota/i.test(lastError)) {
    return {
      kind: 'quota',
      title: 'The daily model quota has run out',
      detail:
        'Gemini’s free tier allows a limited number of requests per day, and this project ' +
        'uses one per extraction pass. The request was refused before the document was read.',
      action:
        'The quota resets daily. You can also set EXTRACTION_SAMPLES=1 in .env to use fewer ' +
        'requests per document, or enable billing on the API key.',
    };
  }

  if (isTransport) {
    return {
      kind: 'service',
      title: 'The model service could not be reached',
      detail:
        'The request was retried automatically and still did not get through. The document ' +
        'itself was never read, so nothing here reflects its contents.',
      action: 'This is usually temporary — try Re-extract in a moment.',
    };
  }

  if (lastError) {
    return {
      kind: 'model',
      title: 'The model did not return a usable record',
      detail:
        'The document was read, but the response failed validation on every attempt, ' +
        'including a retry on a second model. Any values shown below are incomplete.',
      action: 'Try Re-extract, or enter the values manually against the document.',
    };
  }

  return {
    kind: 'unknown',
    title: 'This extraction failed',
    detail: 'No usable record was produced.',
    action: 'Try Re-extract.',
  };
};

export const FailureNotice = ({ extraction }: { extraction: ExtractionDTO }) => {
  const failure = describeFailure(extraction);
  // A failure that never reached the model has no partial data to salvage.
  const reachedModel = failure.kind === 'model' || failure.kind === 'unknown';

  return (
    <div className="animate-fade-in rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-900">{failure.title}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-red-800">{failure.detail}</p>
      <p className="mt-2 text-xs leading-relaxed text-red-700">{failure.action}</p>

      {!reachedModel && (
        <p className="mt-3 border-t border-red-200 pt-3 text-xs text-red-700">
          The fields below are empty because the document was never read — not because it
          could not be understood.
        </p>
      )}
    </div>
  );
};
