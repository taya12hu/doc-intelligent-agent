import type { DocumentStatus, ExtractionStatus } from '@dia/shared';

/**
 * Three states a reviewer needs to tell apart at a glance:
 *
 *   green  nothing fired — you can trust this without opening it
 *   amber  a human should look
 *   red    do not trust this record
 *
 * `failed` is red rather than grey on purpose. A failed extraction is not an
 * absence of data — it is a document we could not read, which is a thing
 * somebody has to deal with.
 */

const STYLES: Record<string, { label: string; className: string }> = {
  extracted: { label: 'Extracted', className: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20' },
  needs_review: { label: 'Needs review', className: 'bg-amber-50 text-amber-900 ring-amber-600/30' },
  failed: { label: 'Failed', className: 'bg-red-50 text-red-800 ring-red-600/20' },
  processing: { label: 'Extracting…', className: 'bg-sky-50 text-sky-800 ring-sky-600/20' },
  pending: { label: 'Pending', className: 'bg-stone-100 text-stone-600 ring-stone-500/20' },
};

export const StatusPill = ({
  status,
  size = 'sm',
}: {
  status: DocumentStatus | ExtractionStatus;
  size?: 'sm' | 'lg';
}) => {
  const style = STYLES[status] ?? STYLES.pending!;
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ring-1 ring-inset ${style.className} ${
        size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs'
      }`}
    >
      {style.label}
    </span>
  );
};
