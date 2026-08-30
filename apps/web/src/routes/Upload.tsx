import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../api/client.js';
import { useExtractionState } from '../api/extractionState.js';
import { useRunSample, useSamples, useUpload } from '../api/hooks.js';
import { ExtractionProgress } from '../components/ExtractionProgress.js';
import { Logo } from '../components/Logo.js';

const ACCEPTED = '.pdf,.xlsx,.xls';
const MAX_BYTES = 10 * 1024 * 1024;

/** Short tag per sample. The full description stays as a hover title. */
const SAMPLE_TAG: Record<string, string> = {
  acme: 'Clean PDF',
  northwind: 'Awkward layout',
  blueridge: 'Scanned',
  zenith: 'Excel',
};

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
   * on them. The server validates properly by magic bytes; this only fails
   * fast with a clear message instead of after a round trip.
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
    runSample.mutate({ key, label }, { onSuccess: (r) => navigate(`/records/${r.document.id}`) });
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
    <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-6 py-16">
      <header className="text-center">
        <Logo className="mx-auto h-10 w-10" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-stone-900">
          Extract an invoice
        </h1>
        {/* One line. The detail belongs on the record screen, where it is
            attached to the value it describes, rather than as preamble. */}
        <p className="mt-2 text-sm text-stone-500">
          PDF or Excel. Anything uncertain is flagged for review.
        </p>
      </header>

      {/* While a job runs the drop zone is replaced rather than dimmed: a
          greyed-out target still invites a drop. */}
      {busy ? (
        <div className="mt-8">
          <ExtractionProgress />
          <p className="mt-3 text-center text-xs text-stone-500">
            One document at a time. You'll be taken to the record when it's done.
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
          className={`mt-8 flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 transition-all ${
            dragging
              ? 'border-sky-400 bg-sky-50 ring-4 ring-sky-100'
              : 'border-stone-300 bg-white hover:border-stone-400 hover:shadow-sm'
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
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-stone-100">
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              className="h-5 w-5 text-stone-500"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 16.5V6m0 0L8.25 9.75M12 6l3.75 3.75M4.5 16.5v1.875A2.625 2.625 0 007.125 21h9.75a2.625 2.625 0 002.625-2.625V16.5"
              />
            </svg>
          </span>
          <span className="mt-3 text-sm font-medium text-stone-800">Drop a file here</span>
          <span className="mt-0.5 text-xs text-stone-400">or click to choose · up to 10 MB</span>
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
        <section className="mt-10">
          <div className="mb-3 flex items-center gap-3">
            <span className="h-px flex-1 bg-stone-200" />
            <span className="text-xs text-stone-400">or try a sample</span>
            <span className="h-px flex-1 bg-stone-200" />
          </div>

          {/* Name plus a two-word tag. The full description is the hover
              title — enough to choose one without a paragraph each. */}
          <div className="flex flex-wrap justify-center gap-2">
            {samples.map((s) => (
              <button
                key={s.key}
                type="button"
                disabled={busy || !s.available}
                onClick={() => handleSample(s.key, s.label)}
                title={
                  busy
                    ? 'Wait for the current extraction to finish'
                    : s.available
                      ? s.blurb
                      : 'Run `npm run samples:generate` to create this file'
                }
                className="group flex items-center gap-2 rounded-full border border-stone-200 bg-white py-1.5 pr-3 pl-3.5 text-sm transition-all hover:border-stone-400 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-stone-200 disabled:hover:shadow-none"
              >
                <span className="font-medium text-stone-700">{s.label}</span>
                <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">
                  {SAMPLE_TAG[s.key] ?? 'Sample'}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
