import { coerceMoney, type FieldFlag } from '@dia/shared';
import { useEffect, useState } from 'react';
import { FlagList, flagRing } from './FlagChip.js';

/**
 * An editable field that knows why it is suspect.
 *
 * Commits on BLUR, not on every keystroke. Each commit is a PATCH that
 * re-runs the server's checks and rewrites flags, confidence and status —
 * firing that per character would hammer the API and make flags strobe while
 * someone is halfway through typing a number.
 *
 * Local state is seeded from the prop and re-seeded when the prop changes, so
 * a server-side correction (or a re-extraction) shows up in a field the user
 * is not currently editing.
 */

type BaseProps = {
  label: string;
  flags: FieldFlag[];
  disabled?: boolean;
  hint?: string;
};

export const TextField = ({
  label,
  value,
  onCommit,
  flags,
  disabled,
  hint,
}: BaseProps & { value: string | null; onCommit: (next: string | null) => void }) => {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);

  const commit = () => {
    const next = draft.trim() === '' ? null : draft.trim();
    if (next !== value) onCommit(next);
  };

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-500">{label}</span>
      <input
        className={`w-full rounded-md px-2.5 py-1.5 text-sm ring-1 ring-inset outline-none focus:ring-2 disabled:bg-stone-100 ${flagRing(flags)}`}
        value={draft}
        disabled={disabled}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {hint && <span className="mt-0.5 block text-xs text-stone-400">{hint}</span>}
      <FlagList flags={flags} />
    </label>
  );
};

export const NumberField = ({
  label,
  value,
  onCommit,
  flags,
  disabled,
  align = 'right',
}: BaseProps & {
  value: number | null;
  onCommit: (next: number | null) => void;
  align?: 'left' | 'right';
}) => {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      if (value !== null) onCommit(null);
      return;
    }
    // The SAME parser the extraction pipeline uses, imported from @dia/shared
    // rather than re-implemented here. A reviewer copying "1,41,077.85" or
    // "€1.234,56" straight off the document should get the same number the
    // model would have — a second, naive parser in the UI is exactly the kind
    // of quiet divergence that produces a wrong total nobody can explain.
    const parsed = coerceMoney(trimmed);
    if (parsed === null) {
      setDraft(value === null ? '' : String(value)); // reject, don't guess
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-stone-500">{label}</span>
      <input
        inputMode="decimal"
        className={`tnum w-full rounded-md px-2.5 py-1.5 text-sm ring-1 ring-inset outline-none focus:ring-2 disabled:bg-stone-100 ${
          align === 'right' ? 'text-right' : ''
        } ${flagRing(flags)}`}
        value={draft}
        disabled={disabled}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <FlagList flags={flags} />
    </label>
  );
};

/** Bare cell for the line-item grid, where labels live in the column header. */
export const CellInput = ({
  value,
  onCommit,
  flags,
  numeric,
  className = '',
}: {
  value: string | number | null;
  onCommit: (next: string | number | null) => void;
  flags: FieldFlag[];
  numeric?: boolean;
  className?: string;
}) => {
  const asText = value === null ? '' : String(value);
  const [draft, setDraft] = useState(asText);
  useEffect(() => setDraft(asText), [asText]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!numeric) {
      const next = trimmed === '' ? null : trimmed;
      if (next !== value) onCommit(next);
      return;
    }
    if (trimmed === '') {
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = Number(trimmed.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(parsed)) {
      setDraft(asText);
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <input
      inputMode={numeric ? 'decimal' : 'text'}
      className={`w-full rounded px-2 py-1 text-sm ring-1 ring-inset outline-none focus:ring-2 ${
        numeric ? 'tnum text-right' : ''
      } ${flagRing(flags)} ${className}`}
      value={draft}
      placeholder="—"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
};
