export const ConfidenceBar = ({
  value,
  showLabel = true,
}: {
  value: number | null;
  showLabel?: boolean;
}) => {
  if (value === null) {
    return <span className="text-xs text-stone-400">—</span>;
  }

  // Thresholds match the status boundaries so the bar and the pill never
  // disagree — a green bar next to an amber pill would undermine both.
  const tone =
    value >= 0.85 ? 'bg-emerald-500' : value >= 0.5 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-stone-200">
        <span
          className={`block h-full rounded-full ${tone}`}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </span>
      {showLabel && (
        <span className="tnum text-xs text-stone-500">{Math.round(value * 100)}%</span>
      )}
    </span>
  );
};
