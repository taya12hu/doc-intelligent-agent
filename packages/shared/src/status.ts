/**
 * Status and kind unions shared by the API, the DB layer and the web app.
 *
 * These are plain const-arrays rather than TS enums so they can be used at
 * runtime (Drizzle column enums, zod, UI maps) without a separate declaration.
 */

/** How we decided to read the file. Detected, never trusted from the client. */
export const FILE_KINDS = ['pdf_text', 'pdf_scanned', 'xlsx'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * Lifecycle of a document.
 *
 * `pending` / `processing` exist even though extraction is currently
 * synchronous — they are the seam an async queue would slot into without a
 * schema change. See ARCHITECTURE.md §3.
 */
export const DOCUMENT_STATUSES = [
  'pending',
  'processing',
  'extracted',
  'needs_review',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * The verdict on one extraction attempt-set.
 *
 *  - `extracted`    zero flags, every arithmetic check balanced
 *  - `needs_review` at least one warn, or an error we could still work around
 *  - `failed`       no valid object after repair + escalation, OR too many
 *                   error flags on required fields to trust what we do have
 *
 * `failed` is a legitimate outcome, not a server error: the API returns it
 * with a 201. See ARCHITECTURE.md §7.
 */
export const EXTRACTION_STATUSES = ['extracted', 'needs_review', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const isTerminal = (s: DocumentStatus): boolean =>
  s === 'extracted' || s === 'needs_review' || s === 'failed';
