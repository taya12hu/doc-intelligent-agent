import type { DocumentListItem } from '@dia/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDocuments } from '../api/hooks.js';
import { ConfidenceBar } from '../components/ConfidenceBar.js';
import { FlagTooltip } from '../components/FlagTooltip.js';
import { StatusPill, pillState } from '../components/StatusPill.js';

const KIND_LABEL: Record<string, string> = {
  pdf_text: 'PDF',
  pdf_scanned: 'Scanned',
  xlsx: 'Excel',
};

const money = (n: number | null, currency: string | null) =>
  n === null
    ? '—'
    : `${currency ? `${currency} ` : ''}${new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n)}`;

/** Time for today's records, date for older ones. */
const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/**
 * Filters.
 *
 * Marking a record reviewed changes its status to `extracted`, which moves it
 * from the top of the queue to the bottom. With several documents of the same
 * name that reads as the record disappearing. These make where it went
 * explicit, and give a way back to it.
 */
type Filter = 'attention' | 'reviewed' | 'all';

const MATCHES: Record<Filter, (r: DocumentListItem) => boolean> = {
  attention: (r) => r.status === 'failed' || r.status === 'needs_review',
  reviewed: (r) => r.reviewedAt !== null,
  all: () => true,
};

const TABS: { id: Filter; label: string }[] = [
  { id: 'attention', label: 'Needs attention' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'all', label: 'All' },
];

export const List = () => {
  const { data, isLoading, error } = useDocuments();
  const [filter, setFilter] = useState<Filter>('all');

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-stone-200" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          Couldn't load records. Is the API running on port 4000?
        </div>
      </div>
    );
  }

  if (!data?.length) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-20 text-center">
        <p className="text-sm text-stone-600">Nothing extracted yet.</p>
        <Link
          to="/"
          className="mt-3 inline-block rounded-md bg-stone-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
        >
          Upload an invoice
        </Link>
      </div>
    );
  }

  const counts = {
    attention: data.filter(MATCHES.attention).length,
    reviewed: data.filter(MATCHES.reviewed).length,
    all: data.length,
  };
  const rows = data.filter(MATCHES[filter]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-stone-900">Records</h1>

        <div className="flex items-center gap-1 rounded-lg bg-stone-200/70 p-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === tab.id
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              {tab.label}
              <span className="tnum ml-1.5 text-stone-400">{counts[tab.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-stone-200 bg-white px-4 py-10 text-center text-sm text-stone-500">
          {filter === 'attention'
            ? 'Nothing needs attention. Every record has been extracted cleanly or reviewed.'
            : 'No records have been marked reviewed yet.'}
        </p>
      ) : (
        <div className="rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-xs text-stone-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Document</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Vendor</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-left font-medium">Confidence</th>
                <th className="px-3 py-2 text-right font-medium">Flags</th>
                <th className="px-3 py-2 text-right font-medium">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((row) => (
                <tr key={row.id} className="group hover:bg-stone-50">
                  <td className="px-3 py-2.5">
                    <Link to={`/records/${row.id}`} className="block">
                      <span className="font-medium text-stone-800 group-hover:underline">
                        {row.filename}
                      </span>
                      <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600">
                        {KIND_LABEL[row.fileKind] ?? row.fileKind}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <StatusPill status={pillState(row.status, row.reviewedAt)} />
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-2.5 text-stone-700">
                    {row.vendorName ?? '—'}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right whitespace-nowrap text-stone-700">
                    {money(row.grandTotal, row.currency)}
                  </td>
                  <td className="px-3 py-2.5">
                    <ConfidenceBar value={row.confidence} />
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <FlagTooltip flags={row.flags} errorCount={row.errorFlagCount} />
                  </td>
                  {/* Several documents can share a filename. The timestamp is
                      what tells one upload from another. */}
                  <td className="tnum px-3 py-2.5 text-right text-xs whitespace-nowrap text-stone-400">
                    {when(row.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filter === 'all' && counts.attention > 0 && (
        <p className="mt-3 text-xs text-stone-500">
          Records needing attention are listed first. Reviewed records move to the bottom.
        </p>
      )}
    </div>
  );
};
