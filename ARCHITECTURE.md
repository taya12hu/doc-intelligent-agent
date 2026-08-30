# Document Intelligence Agent — Architecture

## 1. Overview

The Document Intelligence Agent extracts structured invoice data from PDF and Excel documents
using a large language model, validates the result, and presents it for human review.

Documents vary widely in layout, labelling and quality, and language models do not reliably
produce correct output from them. The system is therefore built on the assumption that any
extraction may be wrong: model output is validated against a schema, checked against independent
arithmetic rules, and any field that cannot be confirmed is flagged rather than silently
accepted. A reviewer sees the original document alongside the extracted record and can correct
it.

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
                  │       confidence + status                    │
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

`packages/shared` holds a single Zod definition of the invoice record, which produces the
TypeScript types used by both applications, the runtime validator, and the response schema sent
to the model.

## 3. Backend

Express 5 with TypeScript. Route handlers delegate to a repository layer for database access and
to the extraction pipeline for processing; they contain no SQL.

### Upload flow

1. Uploaded bytes are checked against a size limit and their magic bytes. The declared MIME type
   and file extension are not trusted; the extension is used only to distinguish an `.xlsx`
   workbook from other ZIP archives.
2. The file is classified as `pdf_text`, `pdf_scanned` or `xlsx`. For PDFs the embedded text
   layer is extracted with `pdfjs-dist` and measured — fewer than roughly 50 characters per page
   indicates a scan.
3. Classification runs before storage, so an unreadable file does not leave an orphaned object in
   the bucket.
4. The original file is uploaded to a private Supabase Storage bucket and a `documents` row is
   created.
5. The extraction pipeline runs and the result is persisted.

Extraction runs synchronously within the upload request. The `pending` and `processing` statuses
and the document timestamps are modelled so that moving to a background worker later would not
require a schema change.

### Persistence

Drizzle ORM over `postgres.js`. Monetary columns use Postgres `numeric` and are read back as
JavaScript numbers, so the API, the validation checks and the frontend all handle the same type.
The database client detects Supabase's transaction pooler (port 6543) and disables prepared
statements, which that pooler does not support.

## 4. LLM Extraction

### Provider

Gemini is the primary provider, accessed through an `LLMProvider` interface exposing a single
`extract` method. Everything above that interface — repair, consensus, validation, confidence —
is provider-agnostic.

Gemini supports native PDF input and structured output in the same request, so text PDFs and
scanned PDFs use the same code path with no rasterisation step.

### Input preparation

| File type | Handling |
|---|---|
| `pdf_text`, `pdf_scanned` | Raw PDF bytes sent inline, unmodified |
| `xlsx` | Parsed with SheetJS into Markdown tables preserving column letters, row numbers and merged ranges |

PDFs are passed through untouched because the model reads the page as laid out; extracting text
first flattens the table structure that gives an invoice its meaning. Spreadsheets cannot be read
directly, and the Markdown rendering keeps cell addresses because position carries meaning —
data may not start at A1, and a total may sit several rows below the table it summarises.

### Structured output

The request sets `responseMimeType: application/json` and a `responseSchema` derived from the Zod
schema. Gemini accepts an OpenAPI 3.0 subset rather than JSON Schema — uppercase type names,
`nullable: true` instead of type unions, no `$ref`, and a Gemini-specific `propertyOrdering`
field — so the conversion is handled by a small purpose-built function.

Every field is nullable and none are optional, which forces the model to emit an explicit `null`
for a value it did not find rather than omitting the key. Per-field descriptions live on the
schema rather than in the prompt.

The model returns an envelope with two parts:

- `invoice` — vendor, invoice number, date, currency, line items, subtotal, discount, tax and
  grand total.
- `meta` — field paths the model could not read, an overall legibility score, the invoice date
  exactly as printed, and free-text notes.

`meta` is stored with the extraction and drives the flagging logic, but is never written into the
record. `illegibleFields` lets the model state that it could not read a value instead of guessing
at it, and `invoiceDateAsPrinted` preserves the original date string, which is what keeps
`MM/DD` versus `DD/MM` ambiguity detectable after normalisation. Field paths returned by the
model are normalised before use, as the model may prefix them with the envelope key.

### Validation and repair

Structured output constrains the shape of a response, not its correctness, and does not always
constrain the shape reliably. Each pass runs through an escalating sequence:

1. **Local repair** — strip Markdown fences, extract the first balanced object, remove trailing
   commas, close JSON truncated at the token limit. Truncation discards the incomplete trailing
   element rather than reconstructing it.
2. **Type coercion** — convert money-like strings to numbers, handling thousands separators
   (including Indian grouping), European decimal commas, currency symbols, accounting parentheses
   and unit suffixes. Values that cannot be coerced become `null`.
3. **Repair request** — send the model its own output plus the validation errors and ask for a
   correction, without repeating the extraction instructions.
4. **Escalation** — retry once on a second model with a higher token limit.
5. **Failure** — persist the raw output, mark the record `failed`, flag every field.

Each pass is capped at four model calls, and every step is recorded in a repair log stored with
the extraction.

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

Comparison ignores cosmetic string differences. Line items are matched by position among the
passes producing the most common row count; a disagreement about the number of rows flags the
line-item list as a whole rather than aligning rows that may not correspond. Passes run
sequentially, so a partially exhausted API quota still yields a usable record from fewer passes,
with the reduced count recorded on the extraction.

### Deterministic checks

These run after consensus and do not involve the model.

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
comparing line items directly against the grand total would report a mismatch on any invoice
carrying tax, which is a false positive on a correct extraction.

When a line total is blank but quantity and unit price are present, the value is derived for
reconciliation purposes only. The record keeps the null, and the flag includes the derived figure
as a suggestion to confirm.

### Confidence and status

Confidence starts at 1.0, less 0.15 per error flag, 0.05 per warning, and 0.1 if the repair loop
ran. The result is multiplied by the model's reported legibility, so a poor scan caps the score
regardless of the other checks; legibility can only lower it, never raise it.

| Status | Condition |
|---|---|
| `extracted` | No flags |
| `needs_review` | One or more flags, record usable |
| `failed` | No valid object after repair and escalation, or three or more error flags on required fields |

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

- **Provenance** — provider, model, escalation model, pass and attempt counts, latency, token
  usage, the repair log, and a JSON column holding the `meta` envelope, each pass's invoice, the
  agreement map and any raw output from a failed run.
- **Verdict** — status, confidence and the flag list.
- **The record** — vendor name, invoice number, invoice date, currency, subtotal, discount total,
  tax total and grand total, all directly editable by a reviewer.

There is no separate table for the reviewed record. The extraction is the record, and human
corrections update it in place, with an edit trail appended to the JSON provenance column.

Re-running extraction inserts a new row and sets `is_current = false` on the previous one,
preserving earlier results including any corrections made to them. An index on
`(document_id, is_current)` supports the common lookup.

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
`numeric`, never floating point. Flag lists are stored as JSONB, as they are display metadata and
are not queried relationally.

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

Request bodies are validated with Zod schemas from the shared package. The patch schemas accept
only human-correctable fields; flags, confidence, status and provenance are derived by the server
and cannot be set by a client.

A failed extraction returns `201` with `status: "failed"` and the raw model output attached. It is
a recorded outcome rather than a server error, and returning `5xx` would make it
indistinguishable from a service fault.

Every mutation re-runs the deterministic checks against the whole extraction and returns the
updated record. Editing a single line item re-checks the entire invoice, since one row affects
whether the totals reconcile.

The original file is served through a short-lived signed URL rather than a public bucket URL,
keeping the service-role key server-side.

## 7. Frontend

React with TypeScript, Vite and Tailwind CSS. TanStack Query manages server state; each mutation
returns the complete record and writes it directly into the cache, so flags and status update
immediately after an edit.

**Upload** — a drop zone accepting PDF and `.xlsx` files, plus buttons that ingest each of the
four bundled samples.

**Records list** — filename, file kind, status, vendor, grand total, confidence and flag count.
Records needing attention are listed first.

**Record detail** — a two-pane review screen. The left pane shows the source document: PDFs in an
embedded viewer, spreadsheets as a download link, since they cannot be previewed in the browser.
The right pane shows the record as editable fields — header fields, a line-item grid supporting
edit, add and delete, and a totals section. Flagged fields are outlined and display the reason in
plain language beneath them, including the relevant figures.

Below the totals, a live arithmetic summary mirrors the server's two-stage reconciliation and
updates as values are edited. This is a client-side convenience; the server recomputes and remains
authoritative. An expandable extraction log shows the model used, pass and attempt counts, token
usage, latency and each repair step.

Fields commit on blur rather than on each keystroke, since every commit triggers a request that
re-evaluates the record.

## 8. Sample Documents

Four sample invoices are generated by scripts in `samples/generate` from a single fixture that
also defines the expected extraction results, so the documents and their expectations stay
consistent.

| File | Type | Tests |
|---|---|---|
| `acme-supplies.pdf` | Text PDF | Baseline: conventional layout and labels |
| `northwind-trading.pdf` | Text PDF | Vendor name only in the letterhead, non-standard field labels, tax identifiers resembling invoice numbers, Indian digit grouping, and a discount and tax band between the line items and the total |
| `blue-ridge-scan.pdf` | Scanned PDF | Degraded scan with no text layer: rotation, blur, noise, low contrast, and localised obstructions over specific values |
| `zenith-parts.xlsx` | Excel | Data not starting at A1, merged title rows, line items split across two blocks, unit price before quantity, an intermediate subtotal that is not the invoice subtotal, and one blank amount cell |

The scanned sample is intentionally difficult and is expected to require human review. Extraction
results for all four are committed under `samples/output`.

## 9. Error Handling and Review

Section 4 covers how malformed and truncated model output is repaired. The table below covers the
cases where extraction succeeds but a value cannot be trusted.

| Situation | Handling |
|---|---|
| Value not present on the document | Field set to `null`, flagged as missing |
| Value present but unreadable | Field set to `null`, flagged as illegible from the model's own report |
| Passes disagree on a value | Majority or temperature-0 value used, field flagged |
| Totals do not reconcile | Field flagged with both figures and the difference |
| Ambiguous date format | Normalised to one reading, flagged with both interpretations |
| No valid output after all attempts | Record saved as `failed` with the raw model output retained |
| Rate limit or service error | Retried with backoff, not treated as an extraction failure |

Flags carry a field path, a reason, a severity and a human-readable explanation containing the
relevant values. They are attached either to the extraction or to the specific line item they
concern.

A reviewer corrects fields directly in the interface. Each save re-runs the checks, so flags clear
when the underlying problem is resolved and new ones appear if an edit introduces an
inconsistency. Flags reporting that the model could not read a field are dropped once a human has
entered a value for it.

A record can be marked reviewed with flags outstanding, since some flags — an ambiguous date, for
example — cannot be resolved from the document alone.

## 10. Known Limitations

- Extraction is synchronous, so a slow document holds the request open.
- Confidence weights are chosen by hand rather than calibrated against labelled data.
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
- Calibrate confidence weights against a labelled set of real invoices.
- Return the source region for each field and highlight it in the document viewer.
