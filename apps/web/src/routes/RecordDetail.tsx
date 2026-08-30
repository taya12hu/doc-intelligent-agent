import { RECORD_FIELD, countBySeverity, flagsFor } from '@dia/shared';
import { Link, useParams } from 'react-router-dom';
import { useExtractionState } from '../api/extractionState.js';
import {
  useAddLineItem,
  useDeleteLineItem,
  useMarkReviewed,
  usePatchExtraction,
  usePatchLineItem,
  useRecord,
  useReextract,
} from '../api/hooks.js';
import { ConfidenceBar } from '../components/ConfidenceBar.js';
import { ExtractionLog } from '../components/ExtractionLog.js';
import { ExtractionProgress } from '../components/ExtractionProgress.js';
import { FailureNotice } from '../components/FailureNotice.js';
import { TextField } from '../components/Field.js';
import { FlagList } from '../components/FlagChip.js';
import { LineItemGrid } from '../components/LineItemGrid.js';
import { SourceViewer } from '../components/SourceViewer.js';
import { StatusPill, pillState } from '../components/StatusPill.js';
import { TotalsBand } from '../components/TotalsBand.js';

/**
 * The review screen: source document on the left, extracted record on the
 * right. Flagged values are marked where they appear, with the reason in
 * plain language, so a correction is read the flag, check the document, type,
 * and watch the flag clear.
 */
export const RecordDetail = () => {
  const { id = '' } = useParams();
  const { data, isLoading, error } = useRecord(id);

  const extractionId = data?.extraction?.id ?? '';
  const filename = data?.document.filename ?? '';

  const { job } = useExtractionState();
  const patchExtraction = usePatchExtraction(extractionId);
  const patchLineItem = usePatchLineItem();
  const addLineItem = useAddLineItem(extractionId);
  const deleteLineItem = useDeleteLineItem();
  const markReviewed = useMarkReviewed(extractionId);
  const reextract = useReextract(id, filename);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="h-8 w-64 animate-pulse rounded bg-stone-200" />
        <div className="mt-6 h-96 animate-pulse rounded-lg bg-stone-200" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-sm text-red-700">Couldn't load this record.</p>
        <Link to="/records" className="mt-3 inline-block text-sm text-stone-600 underline">
          Back to records
        </Link>
      </div>
    );
  }

  const { document, extraction, lineItems } = data;

  if (!extraction) {
    return <div className="p-10 text-sm text-stone-600">No extraction for this document yet.</div>;
  }

  /** An extraction anywhere in the app blocks edits here, not just one on this record. */
  const extracting = job !== null;
  const saving =
    patchExtraction.isPending ||
    patchLineItem.isPending ||
    addLineItem.isPending ||
    deleteLineItem.isPending ||
    markReviewed.isPending;
  const busy = extracting || saving;

  const flags = extraction.flags;
  const recordFlags = flagsFor(flags, RECORD_FIELD);
  // Record-level flags are shown in their own banner; counting them here made
  // a failed extraction report "1 field to verify" when no field was involved.
  const fieldFlags = [
    ...flags.filter((f) => f.field !== RECORD_FIELD),
    ...lineItems.flatMap((li) => li.flags),
  ];
  const { error: errorCount, warn: warnCount } = countBySeverity(fieldFlags);

  const reextractTitle = extracting
    ? job?.kind === 'reextract'
      ? 'Re-extraction in progress'
      : 'Another document is being extracted'
    : 'Run the extraction again on this document';

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-stone-200 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link to="/records" className="text-xs text-stone-500 hover:text-stone-800">
              ← Records
            </Link>
            <h1 className="truncate text-base font-semibold tracking-tight text-stone-900">
              {document.filename}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {saving && <span className="text-xs text-stone-400">Saving…</span>}
            <ConfidenceBar value={extraction.confidence} />
            <StatusPill status={pillState(extraction.status, extraction.reviewedAt)} size="lg" />
            <button
              type="button"
              disabled={busy}
              onClick={() => reextract.mutate(undefined)}
              title={reextractTitle}
              className="rounded-md border border-stone-300 px-2.5 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Re-extract
            </button>
            <button
              type="button"
              disabled={busy || extraction.reviewedAt !== null || extraction.status === 'extracted'}
              onClick={() => markReviewed.mutate(undefined)}
              title={
                extraction.reviewedAt
                  ? 'Already reviewed'
                  : extraction.status === 'extracted'
                    ? 'This record has no outstanding flags'
                  : 'Accept this record, including any flags you have checked'
              }
              className="rounded-md bg-stone-800 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Mark reviewed
            </button>
          </div>
        </div>

        {(errorCount > 0 || warnCount > 0) && (
          <p className="mt-1.5 text-xs text-stone-600">
            {errorCount > 0 && (
              <span className="font-medium text-red-700">
                {errorCount} field{errorCount === 1 ? '' : 's'} to verify
              </span>
            )}
            {errorCount > 0 && warnCount > 0 && <span className="text-stone-400"> · </span>}
            {warnCount > 0 && (
              <span className="font-medium text-amber-700">{warnCount} worth checking</span>
            )}
            <span className="text-stone-400"> — marked below, with the reason.</span>
          </p>
        )}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div className="min-h-[50vh] border-r border-stone-200 lg:min-h-0">
          <SourceViewer document={document} />
        </div>

        <div className="min-h-0 overflow-y-auto bg-stone-50 p-5">
          {/* A re-extraction replaces everything below it, so the form is
              hidden while one runs rather than left editable against values
              that are about to be overwritten. */}
          {extracting && job?.kind === 'reextract' ? (
            <ExtractionProgress />
          ) : (
            <>
              {extracting && (
                <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                  Another document is being extracted. Editing is paused until it finishes.
                </div>
              )}

              {extraction.status === 'failed' && (
                <div className="mb-4">
                  <FailureNotice extraction={extraction} />
                </div>
              )}

              {/* On a failed extraction the notice above already explains what
                  happened, in more detail and more accurately. Showing the
                  record-level flags too repeated it, and the generic
                  "couldn't read it as a number" wording is wrong when nothing
                  was read at all. */}
              {extraction.status !== 'failed' && recordFlags.length > 0 && (
                <div className="mb-4 rounded-lg border border-stone-200 bg-white p-3">
                  <FlagList flags={recordFlags} />
                </div>
              )}

              <section className="grid grid-cols-2 gap-3">
                <TextField
                  label="Vendor"
                  value={extraction.vendorName}
                  flags={flagsFor(flags, 'vendorName')}
                  disabled={busy}
                  onCommit={(v) => patchExtraction.mutate({ vendorName: v })}
                />
                <TextField
                  label="Invoice number"
                  value={extraction.invoiceNumber}
                  flags={flagsFor(flags, 'invoiceNumber')}
                  disabled={busy}
                  onCommit={(v) => patchExtraction.mutate({ invoiceNumber: v })}
                />
                <TextField
                  label="Invoice date"
                  value={extraction.invoiceDate}
                  hint="yyyy-mm-dd"
                  flags={flagsFor(flags, 'invoiceDate')}
                  disabled={busy}
                  onCommit={(v) => patchExtraction.mutate({ invoiceDate: v })}
                />
                <TextField
                  label="Currency"
                  value={extraction.currency}
                  flags={flagsFor(flags, 'currency')}
                  disabled={busy}
                  onCommit={(v) => patchExtraction.mutate({ currency: v })}
                />
              </section>

              <section className="mt-6">
                <h2 className="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
                  Line items
                </h2>
                <LineItemGrid
                  lineItems={lineItems}
                  busy={busy}
                  onPatch={(lineItemId, patch) =>
                    patchLineItem.mutate({ id: lineItemId, patch })
                  }
                  onDelete={(lineItemId) => deleteLineItem.mutate(lineItemId)}
                  onAdd={() => addLineItem.mutate(undefined)}
                />
              </section>

              <section className="mt-6">
                <h2 className="mb-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">
                  Totals
                </h2>
                <TotalsBand
                  extraction={extraction}
                  lineItems={lineItems}
                  flags={flags}
                  onPatch={(patch) => patchExtraction.mutate(patch)}
                />
              </section>

              <section className="mt-6">
                <ExtractionLog extraction={extraction} />
              </section>

            </>
          )}
        </div>
      </div>
    </div>
  );
};
