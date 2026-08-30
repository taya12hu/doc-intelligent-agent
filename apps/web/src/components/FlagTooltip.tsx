import { flagMessage, type FieldFlag } from '@dia/shared';

/**
 * The flag count in the records list, expanded on hover.
 *
 * A bare "3" tells the reviewer something is wrong but not what, so the only
 * way to find out was to open the record. Since the list already knows the
 * flags, hovering shows them — enough to decide whether a record is worth
 * opening now or later.
 *
 * CSS-only (group-hover) rather than a positioned popover: there is no
 * placement logic to get wrong, and it works on keyboard focus too.
 */
export const FlagTooltip = ({
  flags,
  errorCount,
}: {
  flags: FieldFlag[];
  errorCount: number;
}) => {
  if (flags.length === 0) {
    return <span className="text-xs text-stone-400">none</span>;
  }

  const shown = flags.slice(0, 6);
  const remaining = flags.length - shown.length;

  return (
    <span className="group/flag relative inline-block">
      <button
        type="button"
        aria-label={`${flags.length} flag${flags.length === 1 ? '' : 's'} — hover for details`}
        className={`tnum cursor-help rounded px-1.5 py-0.5 text-xs font-medium transition-colors ${
          errorCount > 0
            ? 'bg-red-50 text-red-800 hover:bg-red-100'
            : 'bg-amber-50 text-amber-900 hover:bg-amber-100'
        }`}
      >
        {flags.length}
      </button>

      <span
        role="tooltip"
        className="pointer-events-none invisible absolute top-full right-0 z-20 mt-1.5 w-80 rounded-lg border border-stone-200 bg-white p-2.5 text-left opacity-0 shadow-lg transition-opacity duration-100 group-hover/flag:visible group-hover/flag:opacity-100 group-focus-within/flag:visible group-focus-within/flag:opacity-100"
      >
        <span className="mb-1.5 block text-[11px] font-semibold tracking-wide text-stone-400 uppercase">
          {flags.length} flag{flags.length === 1 ? '' : 's'}
        </span>

        {shown.map((f, i) => (
          <span key={`${f.field}-${f.reason}-${i}`} className="mb-1.5 block last:mb-0">
            <span className="flex items-start gap-1.5">
              <span
                aria-hidden
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                  f.severity === 'error' ? 'bg-red-500' : 'bg-amber-500'
                }`}
              />
              <span className="min-w-0">
                <span className="block font-mono text-[11px] text-stone-500">
                  {f.field === '_record' ? 'whole record' : f.field}
                </span>
                <span className="block text-xs leading-snug text-stone-700">
                  {flagMessage(f)}
                </span>
              </span>
            </span>
          </span>
        ))}

        {remaining > 0 && (
          <span className="mt-1 block border-t border-stone-100 pt-1.5 text-[11px] text-stone-400">
            and {remaining} more — open the record to see them all
          </span>
        )}
      </span>
    </span>
  );
};
