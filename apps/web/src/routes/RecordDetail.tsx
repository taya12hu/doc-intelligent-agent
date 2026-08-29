import { RECORD_FIELD, countBySeverity, flagsFor } from '@dia/shared';
import { Link, useParams } from 'react-router-dom';
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
import { TextField } from '../components/Field.js';
import { FlagList } from '../components/FlagChip.js';
import { LineItemGrid } from '../components/LineItemGrid.js';
import { SourceViewer } from '../components/SourceViewer.js';
import { StatusPill } from '../components/StatusPill.js';
import { TotalsBand } from '../components/TotalsBand.js';

/**
 * The review screen, and the only one that really matters.
 *
 * Two panes: the source document on the left, the extracted record on the
 * right. Everything flagged is marked where the value is, with the reason in
 * words, so correcting a record is: read the flag, glance left, type, watch
 * the flag clear.
 */
export const RecordDetail = () => {
  const { id = '' } = useParams();
  const { data, isLoading, error } = useRecord(id);

  const extractionId = data?.extraction?.id ?? '';
  const patchExtraction = usePatchExtraction(extractionId);
  const patchLineItem = usePatchLineItem();
  const addLineItem = useAddLineItem(extractionId);
  const deleteLineItem = useDeleteLineItem();
  const markReviewed = useMarkReviewed(extractionId);
  const reextract = useReextract(id);

  if (isLoading) {
    return <div className="p-10 text-sm text-stone-500">Loading…</div>;
  }
  if (error || !data) {
    return <div className="p-10 text-sm text-red-700">Couldn't load this record.</div>;
  }

  const { document, extraction, lineItems } = data;

  if (!extraction) {
    return (
      <div className="p-10 text-sm text-stone-600">
        No extraction for this document yet.
      </div>
    );
  }

  const busy =
    patchExtraction.isPending ||
    patchLineItem.isPending ||
    addLineItem.isPending ||
    deleteLineItem.isPending ||
    markReviewed.isPending ||
    reextract.isPending;

  const flags = extraction.flags;
  const recordFlags = flagsFor(flags, RECORD_FIELD);
  const allFlags = [...flags, ...lineItems.flatMap((li) => li.flags)];
  const { error: errorCount, warn: warnCount } = countBySeverity(allFlags);

  return (
    <div className="flex h-full flex-col">
      {/* ── header ─────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-stone-200 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link to="/records" className="text-xs text-stone-500 hover:text-stone-800">
              ← Records
            </Link>
            <h1 className="truncate text-base font-semibold text-stone-900">
              {document.filename}
            </h1>
          </div>

          <div className="flex items-center gap-3">
            <ConfidenceBar value={extraction.confidence} />
            <StatusPill status={extraction.status} size="lg" />
            <button
              type="button"
              disabled={busy}
              onClick={() => reextract.mutate(undefined)}
              className="rounded-md border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-40"
            >
              {reextract.isPending ? 'Re-extracting…' : 'Re-extract'}
            </button>
            <button
              type="button"
              disabled={busy || extraction.status === 'extracted'}
              onClick={() => markReviewed.mutate(undefined)}
              title="Sign off on this record, including any flags you've checked and accepted"
              className="rounded-md bg-stone-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-40"
            >
              Mark reviewed
            </button>
          </div>
        </div>

        {(errorCount > 0 || warnCount > 0) && (
          <p className="mt-1.5 text-xs text-stone-600">
            {errorCount > 0 && (
              <span className="font-medium text-red-700">
                {errorCount} field{errorCount === 1 ? '' : 's'} not to be trusted
              </span>
            )}
            {errorCount > 0 && warnCount > 0 && <span className="text-stone-400"> · </span>}
            {warnCount > 0 && (
              <span className="font-medium text-amber-700">
                {warnCount} worth checking
              </span>
            )}
            <span className="text-stone-400"> — marked below, with the reason.</span>
          </p>
        )}
      </header>

      {/* ── two panes ──────────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div className="min-h-[50vh] border-r border-stone-200 lg:min-h-0">
          <SourceViewer document={document} />
        </div>

        <div className="min-h-0 overflow-y-auto bg-stone-50 p-5">
          {recordFlags.length > 0 && (
            <div className="mb-4 rounded-md border border-stone-200 bg-white p-3">
              <FlagList flags={recordFlags} />
            </div>
          )}

          <section className="grid grid-cols-2 gap-3">
            <TextField
              label="Vendor"
              value={extraction.vendorName}
              flags={flagsFor(flags, 'vendorName')}
              onCommit={(v) => patchExtraction.mutate({ vendorName: v })}
            />
            <TextField
              label="Invoice number"
              value={extraction.invoiceNumber}
              flags={flagsFor(flags, 'invoiceNumber')}
              onCommit={(v) => patchExtraction.mutate({ invoiceNumber: v })}
            />
            <TextField
              label="Invoice date"
              value={extraction.invoiceDate}
              hint="yyyy-mm-dd"
              flags={flagsFor(flags, 'invoiceDate')}
              onCommit={(v) => patchExtraction.mutate({ invoiceDate: v })}
            />
            <TextField
              label="Currency"
              value={extraction.currency}
              flags={flagsFor(flags, 'currency')}
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
              onPatch={(lineItemId, patch) => patchLineItem.mutate({ id: lineItemId, patch })}
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

          {extraction.status === 'failed' && (
            <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
              This extraction failed. The record below is what little survived — treat all of
              it as unverified, and check every value against the document.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
