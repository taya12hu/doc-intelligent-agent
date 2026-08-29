import { flagMessage, type FieldFlag } from '@dia/shared';

/**
 * Why a field is suspect, in words the reviewer can act on.
 *
 * The message text lives in `@dia/shared` and the SPECIFICS are computed
 * server-side — "line items total 1,240.00 but the document states 1,245.00
 * — off by 5.00", not "math_mismatch". A reviewer has two seconds before
 * they look at the source pane, and a reason code spends all of it.
 */
export const FlagChip = ({ flag }: { flag: FieldFlag }) => {
  const error = flag.severity === 'error';
  return (
    <span
      className={`inline-flex items-start gap-1.5 rounded px-1.5 py-1 text-xs leading-snug ${
        error ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'
      }`}
    >
      <span aria-hidden className="mt-px font-bold">
        {error ? '!' : '?'}
      </span>
      <span>{flagMessage(flag)}</span>
    </span>
  );
};

export const FlagList = ({ flags }: { flags: FieldFlag[] }) => {
  if (!flags.length) return null;
  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      {flags.map((f, i) => (
        <FlagChip key={`${f.field}-${f.reason}-${i}`} flag={f} />
      ))}
    </div>
  );
};

/** Ring colour for an input carrying flags. */
export const flagRing = (flags: FieldFlag[]): string => {
  if (!flags.length) return 'ring-stone-300 focus:ring-stone-500';
  return flags.some((f) => f.severity === 'error')
    ? 'ring-red-400 bg-red-50/40 focus:ring-red-500'
    : 'ring-amber-400 bg-amber-50/40 focus:ring-amber-500';
};
