import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../api/client.js';
import { useExtractionState } from '../api/extractionState.js';
import { useRunSample, useSamples, useUpload } from '../api/hooks.js';
import { ExtractionProgress } from '../components/ExtractionProgress.js';

const ACCEPTED = '.pdf,.xlsx,.xls';
const MAX_BYTES = 10 * 1024 * 1024;

export const Upload = () => {
  const navigate = useNavigate();
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const { job } = useExtractionState();
  const upload = useUpload();
  const runSample = useRunSample();
  const { data: samples } = useSamples();

  const busy = job !== null;

  /**
   * Reject obviously-wrong files before spending an upload and an extraction
   * on them. The server validates properly by magic bytes; this is just to
   * fail fast with a clear message instead of after a round trip.
   */
  const validate = (file: File): string | null => {
    if (file.size > MAX_BYTES) {
      return `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`;
    }
    if (!/\.(pdf|xlsx|xls)$/i.test(file.name)) {
      return `${file.name} is not a PDF or Excel file.`;
    }
    return null;
  };

  const handleFile = (file: File) => {
    setLocalError(null);
    const problem = validate(file);
    if (problem) {
      setLocalError(problem);
      return;
    }
    upload.mutate(file, { onSuccess: (r) => navigate(`/records/${r.document.id}`) });
  };

  const handleSample = (key: string, label: string) => {
    setLocalError(null);
    runSample.mutate(
      { key, label },
      { onSuccess: (r) => navigate(`/records/${r.document.id}`) },
    );
  };

  const requestError = upload.error ?? runSample.error;
  const errorMessage =
    localError ??
    (requestError instanceof ApiRequestError
      ? requestError.message
      : requestError
        ? 'The extraction could not be completed. Check that the API is running.'
        : null);

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-stone-900">Extract an invoice</h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">
        Upload a PDF or Excel invoice. The fields are extracted with a language model, checked
        against the document's own arithmetic, and anything that can't be confirmed is flagged
        for you to review.
      </p>

      {/* While a job runs, the drop zone is replaced entirely rather than
          dimmed. A greyed-out target still invites a drop; removing it makes
          the one-at-a-time rule obvious without needing to explain it. */}
      {busy ? (
        <div className="mt-8">
          <ExtractionProgress />
          <p className="mt-3 text-center text-xs text-stone-500">
            One document is processed at a time. You'll be taken to the record when it's done.
          </p>
        </div>
      ) : (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
          }}
          className={`mt-8 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 transition-colors ${
            dragging
              ? 'border-sky-400 bg-sky-50'
              : 'border-stone-300 bg-white hover:border-stone-400 hover:bg-stone-50'
          }`}
        >
          <input
            type="file"
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = ''; // allow re-selecting the same file
            }}
          />
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="mb-3 h-8 w-8 text-stone-400"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 16.5V6m0 0L8.25 9.75M12 6l3.75 3.75M4.5 16.5v1.875A2.625 2.625 0 007.125 21h9.75a2.625 2.625 0 002.625-2.625V16.5"
            />
          </svg>
          <span className="text-sm font-medium text-stone-700">
            Drop a file here, or click to choose
          </span>
          <span className="mt-1 text-xs text-stone-500">PDF or Excel, up to 10 MB</span>
        </label>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="animate-fade-in mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"
        >
          <span aria-hidden className="mt-px font-bold">
            !
          </span>
          <span>{errorMessage}</span>
        </div>
      )}

      {samples && samples.length > 0 && (
        <section className="mt-12">
          <h2 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Sample invoices
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            Four invoices with different layouts and quality. The scanned one is intentionally
            difficult.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {samples.map((s) => {
              const disabled = busy || !s.available;
              return (
                <button
                  key={s.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleSample(s.key, s.label)}
                  title={
                    busy
                      ? 'Wait for the current extraction to finish'
                      : !s.available
                        ? 'Run `npm run samples:generate` to create this file'
                        : undefined
                  }
                  className="rounded-lg border border-stone-200 bg-white px-3.5 py-3 text-left transition-all hover:border-stone-400 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-stone-200 disabled:hover:shadow-none"
                >
                  <span className="block text-sm font-medium text-stone-800">{s.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">
                    {s.available ? s.blurb : 'Not generated yet'}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
