import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FullRecord } from '@dia/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError, api } from '../api/client.js';
import { keys, useUpload } from '../api/hooks.js';

type Sample = { key: string; label: string; blurb: string; available: boolean };

export const Upload = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState(false);

  const upload = useUpload();

  const { data: samples } = useQuery({
    queryKey: ['samples'],
    queryFn: () => fetch('/api/samples').then((r) => r.json() as Promise<Sample[]>),
  });

  const runSample = useMutation({
    mutationFn: async (key: string) => {
      const response = await fetch(`/api/samples/${key}`, { method: 'POST' });
      if (!response.ok) throw new Error('Sample extraction failed');
      return response.json() as Promise<FullRecord>;
    },
    onSuccess: (record) => {
      queryClient.setQueryData(keys.record(record.document.id), record);
      void queryClient.invalidateQueries({ queryKey: keys.documents });
      navigate(`/records/${record.document.id}`);
    },
  });

  const busy = upload.isPending || runSample.isPending;

  const handleFile = (file: File) =>
    upload.mutate(file, { onSuccess: (r) => navigate(`/records/${r.document.id}`) });

  const error = upload.error ?? runSample.error;

  return (
    <div className="mx-auto max-w-2xl px-6 py-14">
      <h1 className="text-2xl font-semibold text-stone-900">Extract an invoice</h1>
      <p className="mt-1.5 text-sm text-stone-600">
        Upload a PDF or spreadsheet. It's read by an LLM, cross-checked against its own
        arithmetic, and anything uncertain is flagged for you rather than guessed at.
      </p>

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
        className={`mt-6 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 transition-colors ${
          dragging ? 'border-stone-500 bg-stone-100' : 'border-stone-300 bg-white hover:bg-stone-50'
        } ${busy ? 'pointer-events-none opacity-60' : ''}`}
      >
        <input
          type="file"
          accept=".pdf,.xlsx,.xls"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        {busy ? (
          <>
            <span className="text-sm font-medium text-stone-700">
              {upload.isPending ? 'Uploading and extracting…' : 'Extracting sample…'}
            </span>
            <span className="mt-1 text-xs text-stone-500">
              Three independent passes, then the checks. Usually 5–15 seconds.
            </span>
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-stone-700">
              Drop a file here, or click to choose
            </span>
            <span className="mt-1 text-xs text-stone-500">PDF or .xlsx, up to 10 MB</span>
          </>
        )}
      </label>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {error instanceof ApiRequestError ? error.message : 'Something went wrong.'}
        </div>
      )}

      {/*
        These exist so the interesting case is one click away. The scanned
        sample is the one worth trying first: it is meant to flag rather than
        guess, and seeing that happen is the fastest way to understand what
        the whole system is for.
      */}
      {samples && samples.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
            Or try a bundled sample
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            Four deliberately inconsistent invoices. The scanned one is degraded on purpose.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {samples.map((s) => (
              <button
                key={s.key}
                type="button"
                disabled={busy || !s.available}
                onClick={() => runSample.mutate(s.key)}
                className="rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-stone-400 hover:bg-stone-50 disabled:opacity-50"
              >
                <span className="block text-sm font-medium text-stone-800">{s.label}</span>
                <span className="mt-0.5 block text-xs text-stone-500">
                  {s.available ? s.blurb : 'Run `npm run samples:generate` first'}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
