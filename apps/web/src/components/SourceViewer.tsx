import type { DocumentDTO } from '@dia/shared';
import { api } from '../api/client.js';

/**
 * The source document, beside the extracted record.
 *
 * This is the highest-value decision in the UI. Reviewing extracted data
 * without the original in view is guesswork: the reviewer can see that the
 * numbers do not add up, but not which one is wrong. Side by side, a flagged
 * field is a two-second glance instead of a download, a window switch and a
 * hunt.
 *
 * It also matters most exactly where the system is weakest. On the degraded
 * scan the reviewer needs to look at the coffee stain themselves and decide
 * what the digits are — the whole point of flagging rather than guessing is
 * to hand that judgement to a person, and it only works if the person can
 * actually see the page.
 */
export const SourceViewer = ({ document }: { document: DocumentDTO }) => {
  const url = api.fileUrl(document.id);

  // Spreadsheets have nothing to render in a frame — the browser would just
  // download them. An honest affordance beats an empty grey box.
  if (document.fileKind === 'xlsx') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-stone-100 p-8 text-center">
        <p className="text-sm text-stone-600">
          <span className="font-medium">{document.filename}</span>
          <br />
          Spreadsheets can't be previewed in the browser.
        </p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-md bg-stone-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
        >
          Open the workbook
        </a>
        <p className="max-w-xs text-xs text-stone-500">
          The extraction read every sheet, including rows below the visible table.
        </p>
      </div>
    );
  }

  return (
    <iframe
      /*
       * view=FitH fits the page to the pane width; navpanes=0 drops the
       * thumbnail sidebar, which is pure waste for a one-page invoice and
       * costs about a fifth of the pane.
       *
       * This is not cosmetic. Left to itself Chrome opened the scan at 42%
       * with a sidebar, and at that size the whole point of the pane —
       * letting the reviewer decide for themselves what the digits under the
       * coffee stain say — does not work.
       */
      src={`${url}#view=FitH&navpanes=0&toolbar=1`}
      title={document.filename}
      className="h-full w-full border-0 bg-stone-200"
    />
  );
};
