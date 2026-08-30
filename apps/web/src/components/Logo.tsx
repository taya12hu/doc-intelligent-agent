/**
 * The mark, matching the favicon: a document with extracted lines and a
 * verification check. The check is the point of the product — a record that
 * has been examined, not merely read.
 */
export const Logo = ({ className = 'h-6 w-6' }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
    <rect width="32" height="32" rx="7" className="fill-stone-900" />
    <path
      d="M10 7.5h8.2L23 12.2V24a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 9 24V9a1.5 1.5 0 0 1 1-1.5Z"
      className="fill-stone-50"
    />
    <path d="M18 7.5V12a.8.8 0 0 0 .8.8H23" className="fill-stone-300" />
    <rect x="11.8" y="14" width="6" height="1.4" rx=".7" className="fill-stone-400" />
    <rect x="11.8" y="17" width="8.4" height="1.4" rx=".7" className="fill-stone-400" />
    <circle cx="21.5" cy="21.5" r="5.2" className="fill-emerald-600" />
    <path
      d="m19.3 21.6 1.6 1.6 3-3.2"
      stroke="#fff"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);
