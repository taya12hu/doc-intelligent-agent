import { flagsFor, type ExtractionDTO, type FieldFlag, type LineItemDTO } from '@dia/shared';
import { NumberField } from './Field.js';

/**
 * The totals band, plus a live read-out of whether the invoice reconciles.
 *
 * The arithmetic strip mirrors the SERVER's two-stage check exactly:
 *
 *   stage 1   sum(line items)              -> subtotal
 *   stage 2   subtotal - discount + tax    -> grand total
 *
 * Running it client-side as you type is a convenience, not a source of truth
 * — the server recomputes on every PATCH and its answer is what gets stored.
 * But waiting on a round trip to find out whether your correction balanced is
 * a miserable way to work through fifty invoices, and seeing the ✗ flip to ✓
 * as you fix the number is most of what makes this screen feel usable.
 *
 * Showing BOTH stages separately is the point. "It doesn't add up" is not
 * actionable; "the lines are fine, it's the tax line that's wrong" is.
 */

const EPSILON = 0.02;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const fmt = (n: number | null) =>
  n === null
    ? '—'
    : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        n,
      );

const Stage = ({
  label,
  left,
  right,
  ok,
  indeterminate,
}: {
  label: string;
  left: string;
  right: string;
  ok: boolean;
  indeterminate: boolean;
}) => (
  <div className="flex items-baseline justify-between gap-3 py-0.5">
    <span className="text-xs text-stone-500">{label}</span>
    <span className="tnum flex items-baseline gap-2 text-xs">
      <span className="text-stone-600">{left}</span>
      <span className="text-stone-400">vs</span>
      <span className="text-stone-600">{right}</span>
      {indeterminate ? (
        <span className="text-stone-400" title="Not enough values to check">
          –
        </span>
      ) : ok ? (
        <span className="font-bold text-emerald-600">✓</span>
      ) : (
        <span className="font-bold text-red-600">✗</span>
      )}
    </span>
  </div>
);

export const TotalsBand = ({
  extraction,
  lineItems,
  flags,
  onPatch,
}: {
  extraction: ExtractionDTO;
  lineItems: LineItemDTO[];
  flags: FieldFlag[];
  onPatch: (patch: Record<string, number | null>) => void;
}) => {
  const { subtotal, discountTotal, taxTotal, grandTotal } = extraction;

  const anyLineMissing = lineItems.some((li) => li.lineTotal === null);
  const lineSum = round2(lineItems.reduce((a, li) => a + (li.lineTotal ?? 0), 0));

  const stage1Target = subtotal ?? (discountTotal === null && taxTotal === null ? grandTotal : null);
  const stage1Indeterminate = stage1Target === null || anyLineMissing || lineItems.length === 0;
  const stage1Ok = !stage1Indeterminate && Math.abs(lineSum - stage1Target!) <= EPSILON;

  const stage2Computed =
    subtotal === null ? null : round2(subtotal - (discountTotal ?? 0) + (taxTotal ?? 0));
  const stage2Indeterminate = stage2Computed === null || grandTotal === null;
  const stage2Ok = !stage2Indeterminate && Math.abs(stage2Computed! - grandTotal!) <= EPSILON;

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Subtotal"
          value={subtotal}
          flags={flagsFor(flags, 'subtotal')}
          onCommit={(v) => onPatch({ subtotal: v })}
        />
        <NumberField
          label="Discount"
          value={discountTotal}
          flags={flagsFor(flags, 'discountTotal')}
          onCommit={(v) => onPatch({ discountTotal: v })}
        />
        <NumberField
          label="Tax"
          value={taxTotal}
          flags={flagsFor(flags, 'taxTotal')}
          onCommit={(v) => onPatch({ taxTotal: v })}
        />
        <NumberField
          label="Grand total"
          value={grandTotal}
          flags={flagsFor(flags, 'grandTotal')}
          onCommit={(v) => onPatch({ grandTotal: v })}
        />
      </div>

      <div className="mt-3 rounded-md border border-stone-200 bg-white px-3 py-2">
        <Stage
          label="Line items → subtotal"
          left={`Σ ${fmt(lineSum)}${anyLineMissing ? ' (incomplete)' : ''}`}
          right={fmt(stage1Target)}
          ok={stage1Ok}
          indeterminate={stage1Indeterminate}
        />
        <Stage
          label="Subtotal − discount + tax → total"
          left={fmt(stage2Computed)}
          right={fmt(grandTotal)}
          ok={stage2Ok}
          indeterminate={stage2Indeterminate}
        />
      </div>
    </div>
  );
};
