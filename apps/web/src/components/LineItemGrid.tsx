import { flagsFor, type FieldFlag, type LineItemDTO } from '@dia/shared';
import { CellInput } from './Field.js';
import { FlagList } from './FlagChip.js';

/**
 * The line-item table, editable in place.
 *
 * Per-row flags are rendered on their own line UNDER the row rather than as a
 * tooltip. A reviewer working through a flagged invoice needs to see every
 * reason at once to decide where to start; hover-to-discover would make them
 * hunt for the problems they are here to fix.
 */
export const LineItemGrid = ({
  lineItems,
  onPatch,
  onDelete,
  onAdd,
  busy,
}: {
  lineItems: LineItemDTO[];
  onPatch: (id: string, patch: Record<string, string | number | null>) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  busy: boolean;
}) => (
  <div>
    <table className="w-full border-separate border-spacing-0">
      <thead>
        <tr className="text-left text-xs font-medium text-stone-500">
          <th className="pb-2 pl-1 font-medium">Description</th>
          <th className="w-24 pb-2 text-right font-medium">Qty</th>
          <th className="w-32 pb-2 text-right font-medium">Unit price</th>
          <th className="w-32 pb-2 text-right font-medium">Amount</th>
          <th className="w-8 pb-2" />
        </tr>
      </thead>
      <tbody>
        {lineItems.map((item, index) => {
          const cell = (field: string): FieldFlag[] =>
            flagsFor(item.flags, `lineItems[${index}].${field}`);
          const rowFlags = item.flags;

          return (
            <tr key={item.id} className="align-top">
              <td colSpan={5} className="pb-1.5">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <CellInput
                      value={item.description}
                      flags={cell('description')}
                      onCommit={(v) => onPatch(item.id, { description: v as string | null })}
                    />
                  </div>
                  <div className="w-24">
                    <CellInput
                      value={item.quantity}
                      numeric
                      flags={cell('quantity')}
                      onCommit={(v) => onPatch(item.id, { quantity: v as number | null })}
                    />
                  </div>
                  <div className="w-32">
                    <CellInput
                      value={item.unitPrice}
                      numeric
                      flags={cell('unitPrice')}
                      onCommit={(v) => onPatch(item.id, { unitPrice: v as number | null })}
                    />
                  </div>
                  <div className="w-32">
                    <CellInput
                      value={item.lineTotal}
                      numeric
                      flags={cell('lineTotal')}
                      onCommit={(v) => onPatch(item.id, { lineTotal: v as number | null })}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => onDelete(item.id)}
                    disabled={busy}
                    title="Remove this row"
                    className="mt-1 h-6 w-6 shrink-0 rounded text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>

                {item.isEdited && (
                  <span className="mt-0.5 ml-1 inline-block text-[11px] text-sky-700">
                    edited by you
                  </span>
                )}
                <FlagList flags={rowFlags} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>

    {lineItems.length === 0 && (
      <p className="rounded-md bg-stone-100 px-3 py-4 text-center text-sm text-stone-500">
        No line items were extracted from this document.
      </p>
    )}

    <button
      type="button"
      onClick={onAdd}
      disabled={busy}
      className="mt-2 rounded-md px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40"
    >
      + Add row
    </button>
  </div>
);
