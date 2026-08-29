import { Link } from 'react-router-dom';
import { useDocuments } from '../api/hooks.js';
import { ConfidenceBar } from '../components/ConfidenceBar.js';
import { StatusPill } from '../components/StatusPill.js';

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

export const List = () => {
  const { data, isLoading, error } = useDocuments();

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
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          Couldn't load records. Is the API running?
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

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-stone-900">Records</h1>
        <span className="text-xs text-stone-500">
          {/* The queue's job is surfacing what needs a person, so it leads
              with those rather than burying them under clean records. */}
          Anything needing attention is listed first
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-xs text-stone-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Document</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Vendor</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 text-left font-medium">Confidence</th>
              <th className="px-3 py-2 text-right font-medium">Flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {data.map((row) => (
              <tr key={row.id} className="hover:bg-stone-50">
                <td className="px-3 py-2.5">
                  <Link to={`/records/${row.id}`} className="block">
                    <span className="font-medium text-stone-800">{row.filename}</span>
                    <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600">
                      {KIND_LABEL[row.fileKind] ?? row.fileKind}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-3 py-2.5 text-stone-700">{row.vendorName ?? '—'}</td>
                <td className="tnum px-3 py-2.5 text-right text-stone-700">
                  {money(row.grandTotal, row.currency)}
                </td>
                <td className="px-3 py-2.5">
                  <ConfidenceBar value={row.confidence} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  {row.flagCount === 0 ? (
                    <span className="text-xs text-stone-400">none</span>
                  ) : (
                    <span
                      className={`tnum rounded px-1.5 py-0.5 text-xs ${
                        row.errorFlagCount > 0
                          ? 'bg-red-50 text-red-800'
                          : 'bg-amber-50 text-amber-900'
                      }`}
                    >
                      {row.flagCount}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
