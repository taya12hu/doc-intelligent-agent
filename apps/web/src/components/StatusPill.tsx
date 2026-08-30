import type { DocumentStatus, ExtractionStatus } from '@dia/shared';

/**
 * Record state at a glance.
 *
 * `reviewed` is a display-only state, not a stored status. Marking a record
 * reviewed sets its status to `extracted` while leaving the flags in place, so
 * without a separate pill the list showed "Extracted" beside 0% confidence and
 * an outstanding flag — indistinguishable from a clean extraction. A record a
 * person accepted and a record that needed no attention are different things.
 */
export type PillState = DocumentStatus | ExtractionStatus | 'reviewed';

const STYLES: Record<string, { label: string; className: string; title?: string }> = {
  extracted: {
    label: 'Extracted',
    className: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
    title: 'Every check passed',
  },
  reviewed: {
    label: 'Reviewed',
    className: 'bg-sky-50 text-sky-800 ring-sky-600/20',
    title: 'Accepted by a person, with any remaining flags acknowledged',
  },
  needs_review: {
    label: 'Needs review',
    className: 'bg-amber-50 text-amber-900 ring-amber-600/30',
    title: 'One or more fields could not be confirmed',
  },
  failed: {
    label: 'Failed',
    className: 'bg-red-50 text-red-800 ring-red-600/20',
    title: 'Extraction did not produce a usable record',
  },
  processing: {
    label: 'Extracting',
    className: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  },
  pending: {
    label: 'Pending',
    className: 'bg-stone-100 text-stone-600 ring-stone-500/20',
  },
};

/** Pick the display state, promoting a signed-off record to `reviewed`. */
export const pillState = (
  status: DocumentStatus | ExtractionStatus,
  reviewedAt: string | null | undefined,
): PillState => (reviewedAt ? 'reviewed' : status);

export const StatusPill = ({
  status,
  size = 'sm',
}: {
  status: PillState;
  size?: 'sm' | 'lg';
}) => {
  const style = STYLES[status] ?? STYLES.pending!;
  return (
    <span
      title={style.title}
      className={`inline-flex items-center rounded-full font-medium ring-1 ring-inset ${style.className} ${
        size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-xs'
      }`}
    >
      {style.label}
    </span>
  );
};
