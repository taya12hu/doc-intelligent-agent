# Document Intelligence Agent — Architecture

## 1. Overview

The Document Intelligence Agent extracts structured invoice data from PDF and Excel documents
using a large language model, validates the result, and presents it for human review.

Invoices vary widely in layout, labelling and quality, and language models do not reliably read
them correctly. The system is therefore built on the assumption that any extraction may be wrong:
output is validated against a schema, checked against independent arithmetic, and anything that
cannot be confirmed is flagged rather than silently accepted.

## 2. Architecture

```
                  ┌──────────────────────────────────────────────┐
   React UI  ───► │  Express API                                 │
                  │                                              │
                  │  1. validate upload, detect file type        │
                  │  2. store original file  ──► Supabase Storage│
                  │  3. insert document row                      │
                  │  4. run extraction pipeline:                 │
                  │       prepare input                          │
                  │       Gemini structured extraction (N passes)│
                  │       Zod validation + repair                │
                  │       consensus across passes                │
                  │       deterministic checks                   │
                  │       review score + status                    │
                  │  5. persist extraction + line items          │
                  └───────────────────┬──────────────────────────┘
                                      │ Drizzle
                              ┌───────▼────────┐
                              │   Supabase     │
                              │   Postgres     │
                              └────────────────┘
```

| Component | Responsibility |
|---|---|
| `apps/api` | Express API, extraction pipeline, database access |
| `apps/web` | React review interface |
| `packages/shared` | Invoice schema, flag types, API DTOs, money parsing |
| `samples/generate` | Scripts that produce the sample invoices from a fixture |

`packages/shared` holds one Zod definition of the invoice, producing the TypeScript types both
apps use, the runtime validator, and the response schema sent to the model.

## 3. Backend

Express 5 with TypeScript. Route handlers delegate to a repository layer for database access and
to the extraction pipeline for processing; they contain no SQL.

### Upload flow

1. Bytes are checked against a size limit and their magic bytes. The declared MIME type and
   extension are not trusted; the extension only distinguishes an `.xlsx` workbook from other ZIP
   archives.
2. The file is classified `pdf_text`, `pdf_scanned` or `xlsx`. For PDFs the embedded text layer is
   measured with `pdfjs-dist` — under roughly 50 characters per page indicates a scan.
3. Classification runs before storage, so an unreadable file leaves no orphaned object.
4. The file goes to a private Supabase Storage bucket and a `documents` row is created.
5. The extraction pipeline runs and the result is persisted.

Extraction runs synchronously within the upload request. The `pending` and `processing` statuses
and the document timestamps are modelled so that moving to a background worker later would not
require a schema change.

### Persistence

Drizzle ORM over `postgres.js`. Monetary columns use Postgres `numeric`, read back as JavaScript
numbers so the API, the checks and the frontend all hold the same type. The client detects
Supabase's transaction pooler (port 6543) and disables prepared statements, which it does not
support.

## 4. LLM Extraction

### Provider

Gemini sits behind an `LLMProvider` interface exposing a single `extract` method; everything above
it — repair, consensus, validation, scoring — is provider-agnostic.

Gemini accepts native PDF input and structured output in the same request, so text and scanned
PDFs share one code path with no rasterisation step.

### Input preparation

| File type | Handling |
|---|---|
| `pdf_text`, `pdf_scanned` | Raw PDF bytes sent inline, unmodified |
| `xlsx` | Parsed with SheetJS into Markdown tables preserving column letters, row numbers and merged ranges |

PDFs pass through untouched because the model reads the page as laid out; extracting text first
flattens the table structure that gives an invoice its meaning. Spreadsheets cannot be read
directly, and the rendering keeps cell addresses because position carries meaning — data may not
start at A1, and a total may sit several rows below the table it summarises.

### Structured output

The request carries a `responseSchema` derived from the Zod definition. Gemini takes an OpenAPI
3.0 subset rather than JSON Schema, so a small purpose-built converter handles it; a generic one
emits something the API rejects.

Every field is nullable and none optional, forcing an explicit `null` for a value the model did
not find rather than a missing key. Per-field descriptions live on the schema, not the prompt.

The response is an envelope: `invoice` holds the record, and `meta` holds the model's own report —
which fields it could not read, a legibility rating, the invoice date exactly as printed, and
notes. `meta` drives the flagging logic but is never written into the record.

Two parts of `meta` earn their place. `illegibleFields` lets the model decline a value rather than
guess at it, and `invoiceDateAsPrinted` preserves the original string, which is what keeps `MM/DD`
versus `DD/MM` ambiguity detectable after normalisation. Field paths from the model are normalised
before use, since it may prefix them with the envelope key.

### Validation and repair

Structured output constrains shape, not correctness — and not always shape. Each pass escalates,
cheapest rung first:

1. **Local repair** (no API call) — fences, unbalanced braces, trailing commas, and JSON
   truncated at the token limit. Truncation discards the incomplete trailing element rather than
   reconstructing it; inventing the tail of a value is the failure this system exists to catch.
2. **Type coercion** (no API call) — money-like strings become numbers, covering thousands
   separators including Indian grouping, European decimal commas, symbols, accounting parentheses
   and unit suffixes. Anything ambiguous becomes `null`.
3. **Repair request** — the model receives its own output and the validation errors, without the
   extraction instructions, so it corrects the error rather than re-reading the document and
   changing values that were already right.
4. **Escalation** — one retry on a second model with a higher token limit.
5. **Failure** — persist the raw output and mark the record `failed`.

The first two rungs mean a trailing comma never costs a round trip. Each pass makes at most three
model calls, all recorded in a repair log.

Transport failures — rate limits, service errors, safety blocks — are handled separately from
invalid output. They retry with backoff inside the provider, honouring the retry delay returned
by the API, and do not consume repair attempts.

### Self-consistency

Extraction runs `EXTRACTION_SAMPLES` times (default 2) at different temperatures, the first at
temperature 0. Results are compared field by field:

| Agreement | Result |
|---|---|
| All passes agree | Value accepted, no flag |
| Majority agrees | Majority value, warning flag |
| All passes differ | Temperature-0 value, error flag |

**This measures stability, not correctness.** Passes can agree and still all be wrong — agreement
is necessary, not sufficient. It identifies fields the model is unsure about, which is a different
question from whether a value is right; the deterministic checks below are what address that.

Comparison ignores cosmetic string differences. Line items are matched by position among the
passes producing the most common row count; a disagreement about how many rows exist flags the
line-item list as a whole rather than aligning rows that may not correspond. Passes run
sequentially, so a partially exhausted quota still yields a usable record from fewer passes, with
the reduced count recorded on the extraction.

### Deterministic checks

These run after consensus and involve no model. They are the only layer that detects a value being
wrong rather than merely unstable.

| Check | Description |
|---|---|
| Reconciliation, stage 1 | Sum of line totals against the stated subtotal |
| Reconciliation, stage 2 | Subtotal minus discount plus tax against the grand total |
| Row arithmetic | Quantity times unit price against the row total |
| Missing fields | Nulls in vendor, invoice number, date or grand total |
| Illegible source | Fields the model reported as unreadable |
| Ambiguous date | Printed dates where both components could be the month |
| Implausible values | Negative totals, unreasonable quantities, out-of-range dates, order-of-magnitude mismatches |

Subtotal, discount and tax are modelled as explicit fields rather than inferred. A single check
comparing line items directly against the grand total reports a mismatch on any invoice carrying
tax — a false positive on a correct extraction, and a flag that fires when nothing is wrong
teaches reviewers to ignore flags.

Where a line total is blank but quantity and unit price are present, the value is derived for
reconciliation only. The record keeps the null and the flag carries the derived figure as a
suggestion to confirm.

### Review score and status

Each record carries a **heuristic review score** — a number for ordering a queue, not a
calibrated probability. It starts at 1.0, is reduced per flag (more for errors than warnings, plus
a penalty if the repair loop ran), then multiplied by the model's reported legibility, so a poor
scan caps the score however clean the arithmetic looks. Legibility can only lower it, never raise
it: a model's assessment of its own output is not evidence.

The weights are hand-chosen, not fitted to labelled data. A score of 0.85 does not mean an 85%
chance of being correct; it means fewer and less severe flags than one scoring 0.5.

Status is derived from the flags themselves, not the score:

| Status | Condition |
|---|---|
| `extracted` | No flags |
| `needs_review` | One or more flags, record usable |
| `failed` | No valid object after repair and escalation, or three or more error-severity flags |

## 5. Data Model

### `documents`

One row per uploaded file.

| Column | Notes |
|---|---|
| `id` | UUID primary key |
| `filename`, `mime_type`, `byte_size` | Upload metadata |
| `file_kind` | `pdf_text`, `pdf_scanned` or `xlsx`, detected from the file |
| `storage_path` | Object key in the Supabase Storage bucket |
| `status` | `pending`, `processing`, `extracted`, `needs_review`, `failed` |
| `created_at`, `updated_at` | Timestamps |

### `extractions`

One row per extraction attempt, referencing a document. Columns fall into three groups:

- **Provenance** — provider, models used, pass and attempt counts, latency, token usage, the
  repair log, and a JSON column holding the `meta` envelope, each pass's invoice, the agreement
  map, and any raw output from a failed run.
- **Verdict** — status, review score and flags.
- **The record** — vendor, invoice number, date, currency, subtotal, discount, tax and grand
  total, all directly editable by a reviewer.

There is no separate table for the reviewed record: the extraction *is* the record, and
corrections update it in place with an edit trail appended to the provenance column. Re-running
extraction inserts a new row and sets `is_current = false` on the previous one, preserving earlier
results including any corrections to them.

### `line_items`

One row per invoice line, referencing an extraction.

| Column | Notes |
|---|---|
| `id` | UUID primary key |
| `extraction_id` | Foreign key, cascade delete |
| `position` | Document order |
| `description`, `quantity`, `unit_price`, `line_total` | Row values |
| `flags` | Flags scoped to this row |
| `is_edited` | Set when a human has changed the row |

Line items are stored separately rather than as JSON so individual rows can be updated, added or
deleted, and so the server can re-run arithmetic checks on the result. Monetary columns use
`numeric`, never floating point. Flag lists are JSONB — display metadata, never queried
relationally.

## 6. API

All routes are under `/api`. There is no authentication.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/documents` | Upload a file, run extraction, return the full record |
| `GET` | `/api/documents` | List records for the review queue |
| `GET` | `/api/documents/:id` | Full record: document, current extraction, line items |
| `GET` | `/api/documents/:id/file` | Redirect to a short-lived signed URL for the original file |
| `POST` | `/api/documents/:id/reextract` | Re-run extraction, superseding the previous result |
| `PATCH` | `/api/extractions/:id` | Correct header or total fields |
| `POST` | `/api/extractions/:id/line-items` | Add a line item |
| `POST` | `/api/extractions/:id/review` | Mark the record reviewed |
| `PATCH` | `/api/line-items/:id` | Correct a line item |
| `DELETE` | `/api/line-items/:id` | Remove a line item |
| `GET` | `/api/samples` | List the bundled sample documents |
| `POST` | `/api/samples/:key` | Ingest a bundled sample |
| `GET` | `/api/health` | Service status and active model |

Request bodies are validated with Zod schemas from the shared package. Patch schemas accept only
human-correctable fields; flags, score, status and provenance are server-derived and cannot be set
by a client.

A failed extraction returns `201` with `status: "failed"` and the raw output attached — a recorded
outcome, not a server error, and a `5xx` would be indistinguishable from a service fault.

Every mutation re-runs the deterministic checks against the whole extraction and returns the
updated record. Editing one line item re-checks the entire invoice, since a single row affects
whether the totals reconcile.

The original file is served through a short-lived signed URL, keeping the service-role key
server-side.

## 7. Frontend

React, TypeScript, Vite and Tailwind. TanStack Query manages server state; each mutation returns
the complete record and writes it straight into the cache, so flags and status update immediately
after an edit.

**Upload** — a drop zone plus buttons that ingest each of the four bundled samples.

**Records list** — filename, file kind, status, vendor, grand total, review score, flag count and
time added. Records needing attention come first, and the list filters by Needs attention /
Reviewed / All. Hovering a flag count expands it into the individual flags with their field paths
and reasons, so a record can be triaged without opening it.

**Record detail** — two panes. The left shows the source document (PDFs inline; spreadsheets as a
download, since browsers cannot preview them); the right shows the record as editable header
fields, a line-item grid supporting edit, add and delete, and a totals section. Flagged fields are
outlined and state their reason in plain language beneath them, with the relevant figures.

Showing the source beside the record is the point of the screen: without it a reviewer can see
that the numbers do not reconcile, but not which one is wrong.

A live arithmetic summary below the totals mirrors the server's two-stage reconciliation as values
are edited — a convenience only; the server recomputes and stays authoritative. Fields commit on
blur, since each commit re-evaluates the record. An expandable log shows the models used, pass and
attempt counts, tokens, latency and every repair step. A failed record shows why it failed in
place of the flag list.

### Extraction state

Extraction is synchronous and takes tens of seconds, so a single in-flight job is tracked
application-wide rather than inside the page that started it. Every pipeline mutation registers
with that state, which gives:

- One extraction at a time. The drop zone is replaced by a progress panel rather than disabled,
  since a greyed-out drop target still invites a drop.
- A navigation-bar indicator, so a running extraction stays visible after navigating away.
- Editing and re-extraction disabled on the record screen while any extraction runs.

The panel reports file name, elapsed time and likely stage, but no percentage: a single
synchronous request has no progress to report, and an estimated stage is honest where a fabricated
percentage is not. The state clears on failure as well as success, so a failed job cannot leave the
application locked.

### Reviewed as a display state

Marking a record reviewed sets its status to `extracted` while leaving its flags in place. The
list therefore derives a separate `Reviewed` state from `reviewedAt`, so a record a person
accepted with known problems is not shown identically to one that had nothing flagged.

## 8. Sample Documents

Four invoices are generated by scripts in `samples/generate` from a single fixture that also
defines their expected results, so documents and expectations cannot drift apart. The generator
refuses to emit anything whose own arithmetic does not balance.

They cover a conventional layout; one with unusual labels, tax identifiers resembling invoice
numbers and a discount/tax band; a deliberately degraded scan with no text layer; and a
spreadsheet with an offset origin, two item blocks and reordered columns. `README.md` describes
each in detail.

The scan is expected to require human review, and results for all four are committed under
`samples/output`.

## 9. Error Handling and Review

Section 4 covers repairing malformed output and the checks that produce flags. What follows is how
those outcomes reach a reviewer.

A value that is absent, unreadable, unstable across passes, arithmetically inconsistent or
ambiguously dated is set to `null` or kept with a flag — never silently accepted. Two cases are
handled separately from the rest:

| Situation | Handling |
|---|---|
| No valid output after all attempts | Saved as `failed` with the raw output retained, flagged `extraction_failed` with a reason distinguishing a refused request from output the model mangled |
| Rate limit or service error | Retried with backoff inside the provider; not treated as an extraction failure |

Flags carry a field path, reason, severity and a human-readable explanation with the relevant
values, attached to either the extraction or the specific line item.

Each save re-runs the checks, so flags clear when the problem is fixed and new ones appear if an
edit introduces an inconsistency. Flags saying the model could not read a field are dropped once a
human has entered a value. A record can be marked reviewed with flags outstanding, since some — an
ambiguous date — cannot be resolved from the document alone.

## 10. Known Limitations

- Extraction is synchronous, so a slow document holds the request open.
- The review score is heuristic. Its weights are hand-chosen rather than fitted to labelled
  data, and it should be read as a queue ordering rather than a probability.
- Agreement between passes indicates stability, not correctness; passes can agree and still be
  wrong.
- A response that validates against the schema is not evidence that its values are right. Only the
  deterministic checks catch semantically incorrect output.
- Scanned document quality depends entirely on the vision model. There is no separate OCR stage
  and no per-character confidence available.
- `MM/DD` and `DD/MM` dates are normalised to one reading and flagged; they cannot be resolved
  from a single document.
- Arithmetic checks assume one currency per invoice.
- Long invoices can exceed the output token limit. Truncation is detected and recovered as far as
  possible, but very long documents remain a limit.
- The Gemini free tier is capped per day per model, which constrains how many extractions can be
  run.
- There is no authentication. Anyone with access to the API can read and modify all records.

## 11. Future Improvements

- Move extraction to a background worker with status polling.
- Add a dedicated OCR stage for scanned documents to obtain word-level confidence scores.
- Record field edits in a dedicated audit table rather than appending to a JSON column.
- Calibrate the review score against a labelled set of real invoices.
- Return the source region for each field and highlight it in the document viewer.
