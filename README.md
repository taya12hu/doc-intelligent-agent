# Document Intelligence Agent

A web application that turns vendor invoices into structured, reviewable records. It accepts
PDF and Excel invoices, extracts the invoice fields and line items using Gemini, validates the
result against a schema and a set of arithmetic checks, and flags anything it could not confirm.

A reviewer can then open the record next to the original document, correct any field, and save.
Uncertain values are flagged for human review rather than silently accepted.

## Features

- Upload invoices as PDF or Excel
- Handles both text-based and scanned PDFs
- Structured extraction into a validated schema
- Schema validation plus arithmetic and business-rule checks
- Automatic repair and retry when model output is malformed
- Review flags with plain-language reasons on uncertain fields
- Inline editing of header fields and line items
- Original document shown alongside the extracted record
- Live progress while a document is processed, with one document at a time
- Review queue filterable by state, with flag details on hover
- Extraction status, confidence score and provenance stored per record
- Records persisted in Supabase Postgres, original files in Supabase Storage

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Tailwind CSS, Vite, TanStack Query |
| Backend | Node.js, Express, TypeScript |
| LLM | Gemini (`@google/genai`) |
| Validation | Zod |
| Database | Supabase Postgres with Drizzle ORM |
| File storage | Supabase Storage |
| Document parsing | `pdfjs-dist` (PDF classification), SheetJS (Excel) |

## Getting Started

### Prerequisites

- Node.js 20 or later
- A Gemini API key — [Google AI Studio](https://aistudio.google.com/apikey)
- A Supabase project — [supabase.com](https://supabase.com)

### Installation

```bash
git clone https://github.com/taya12hu/doc-intelligent-agent.git
cd doc-intelligent-agent
npm install
```

### Configuration

Copy the example environment file and fill it in:

```bash
cp .env.example .env
```

| Variable | Where to find it |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio |
| `GEMINI_MODEL` | Primary extraction model (default `gemini-3.6-flash`) |
| `GEMINI_ESCALATION_MODEL` | Fallback model used when the first attempt fails validation |
| `EXTRACTION_SAMPLES` | Number of extraction passes to compare (default `2`) |
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API (service role, server-side only) |
| `DATABASE_URL` | Supabase → Settings → Database → Connection string (URI) |

Use the session pooler connection string (port 5432). The transaction pooler (port 6543) also
works — the database client detects it and disables prepared statements automatically.

### Verify models

Model availability varies by API key and tier. This command calls each configured model directly
and reports whether it responds:

```bash
npm run check:models
```

If a model is unavailable, the command lists the models the key can see so you can update `.env`.

### Set up the database

Applies the schema and creates the storage bucket:

```bash
npm run db:migrate
```

### Run

```bash
npm run dev
```

## Running the Application

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:4000 |

Open the frontend and drag a PDF or `.xlsx` invoice onto the upload area. The file is stored,
extracted and saved, and the browser opens the resulting record. The upload page also has
buttons for the four bundled sample invoices, which can be ingested with one click.

There are three screens:

| Screen | Purpose |
|---|---|
| **Upload** | Drop zone and the bundled samples |
| **Records** | Review queue, filterable by Needs attention / Reviewed / All |
| **Record** | Two-pane review: source document beside the editable record |

Extraction runs synchronously and takes roughly 10–40 seconds, so **only one document is
processed at a time**. While a document is running, the upload area is replaced by a progress
panel showing the file name, elapsed time and the current pipeline stage, and a compact
indicator stays in the navigation bar from any page. Editing and re-extraction are disabled
until it finishes.

The panel shows no percentage. Extraction is a single synchronous request with no progress to
report, so it reports elapsed time and stage rather than a number it cannot know.

The extraction pipeline can also be run from the command line without a database, using only a
Gemini API key:

```bash
npm run extract -- samples/input/blue-ridge-scan.pdf
npm run prepare:doc -- samples/input/zenith-parts.xlsx   # shows what the model receives
```

## Sample Documents

Four sample invoices are included, generated from a single fixture that also defines their
expected extraction results.

| File | Format | What it exercises |
|---|---|---|
| `acme-supplies.pdf` | Text PDF | A conventional invoice layout — the baseline case |
| `northwind-trading.pdf` | Text PDF | Unusual field labels, vendor name only in the letterhead, non-Western digit grouping, and a discount and tax band above the total |
| `blue-ridge-scan.pdf` | Scanned PDF | A degraded scan with no text layer and several values obscured |
| `zenith-parts.xlsx` | Excel | Data not starting at A1, line items split across two blocks, reordered columns, and a blank amount cell |

The scanned sample is intentionally difficult and is expected to require human review.
Extraction results for all four are committed in `samples/output`.

To regenerate the documents:

```bash
npm run samples:generate
```

## How Extraction Works

```
upload → classify → prepare → Gemini extraction → schema validation
       → deterministic checks → review flags → save
```

**Classify.** The file type is determined from its magic bytes rather than the declared MIME
type or extension. PDFs are additionally checked for an embedded text layer; a PDF without one
is treated as a scan.

**Prepare.** PDFs are sent to Gemini as raw bytes, so text and scanned PDFs follow the same
path. Excel files are parsed with SheetJS and converted into Markdown tables that keep column
letters, row numbers and merged ranges, since position carries meaning in a spreadsheet.

**Extract.** Gemini is called with a response schema derived from the Zod definition, returning
JSON. Alongside the invoice fields, the model reports which fields it could not read, an overall
legibility score, and the invoice date exactly as printed.

**Validate.** The response is parsed with Zod. Malformed output is repaired locally where
possible — stripping code fences, closing truncated JSON, coercing number formats — and only
then re-sent to the model with the specific validation errors. A second model is used as a
fallback if that also fails. If nothing valid survives, the record is saved with status `failed`
and the raw output retained.

**Check.** Independent of the model, the extracted values are checked for arithmetic
consistency, missing required fields, ambiguous dates and implausible values.

**Flag and save.** Fields that fail a check, that the model reported as unreadable, or that
differed between extraction passes are flagged with a reason. A confidence score and status are
derived from the flags, and the record is written to Postgres.

For a fuller description, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Human Review

Each record opens in a two-pane screen. The original document is displayed on the left and the
extracted record on the right, so values can be checked against the source without leaving the
page.

Header fields, line items and totals are all editable. Flagged fields are outlined and show the
reason beneath them, for example:

- *Couldn't find this in the document*
- *The model reported this as unreadable rather than guessing*
- *Doesn't add up: line items total 1,240.00 but the document states 1,245.00 — off by 5.00*
- *Ambiguous date format: "08/03/2025" could be 8 Mar 2025 or 3 Aug 2025*

Saving an edit re-runs the checks on the server, so flags clear when the underlying problem is
resolved and new ones appear if an edit introduces an inconsistency.

A record can be marked reviewed even with flags outstanding, since some — an ambiguous date,
for example — cannot be resolved from the document alone. Reviewed records are shown with their
own status, distinct from records that had nothing flagged in the first place, so accepting a
record with known problems is not confused with a clean extraction.

### The review queue

Records are listed with anything needing attention first. Because marking a record reviewed
moves it down that order, the list can be filtered by **Needs attention**, **Reviewed** or
**All**, and shows the time each document was added — several uploads of the same file are
otherwise indistinguishable.

Hovering a record's flag count expands it into the individual flags, each with its field path
and reason, so a record can be triaged without opening it.

### When extraction fails

A failed record explains why rather than only reporting that it failed, since the causes need
different responses:

| Cause | What it means |
|---|---|
| Quota exhausted | The API refused the request; the document was never read |
| Service unreachable | Retries did not get through; worth trying again shortly |
| No usable output | The model responded but never returned a valid record |

The raw model output is kept with the record in every case.

## Validation and Reliability

A response that parses as valid JSON is not treated as evidence that its values are correct. The
system applies several independent layers:

- **Schema validation.** Every response is parsed with Zod. All fields are nullable and none are
  optional, so a value the model did not find is an explicit `null` rather than an absent key.
- **Repair and retry.** Malformed output is repaired locally first, then sent back to the model
  with its validation errors, then retried on a fallback model.
- **Arithmetic checks.** Line totals are reconciled against the subtotal, and the subtotal less
  discount plus tax against the grand total. Each row's quantity times unit price is checked
  against its own total. These checks do not involve the model.
- **Missing and implausible values.** Required fields that are null, negative totals,
  out-of-range dates and order-of-magnitude mismatches are all flagged.
- **Ambiguity detection.** The date as printed is retained, so `MM/DD` and `DD/MM` ambiguity
  remains detectable after normalisation.
- **Multiple extraction passes.** Extraction runs more than once by default and the results are
  compared field by field. Fields that differ between passes are flagged as unstable.
- **Confidence and status.** A confidence score is computed from the flags and the model's
  reported legibility, and each record is marked `extracted`, `needs_review` or `failed`.

Comparing passes indicates whether a value is stable, not whether it is correct — passes can
agree and still be wrong. The arithmetic checks are what detect inconsistent values.

## Database

Three tables:

| Table | Contents |
|---|---|
| `documents` | One row per uploaded file: filename, detected type, storage path, status |
| `extractions` | One row per extraction attempt: the invoice header and totals, flags, confidence, status, and provenance such as model used, attempt counts and the repair log |
| `line_items` | One row per invoice line, belonging to an extraction |

`documents` has many `extractions`; `extractions` has many `line_items`. Re-running extraction
inserts a new `extractions` row and marks the previous one as no longer current, so earlier
results are preserved.

Line items are stored in their own table rather than as JSON on the extraction so individual
rows can be edited, added or deleted, and so the server can re-run arithmetic checks against the
result. Monetary values use Postgres `numeric` rather than floating point.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/documents` | Upload a file, run extraction, return the record |
| `GET` | `/api/documents` | List records |
| `GET` | `/api/documents/:id` | Full record with extraction and line items |
| `GET` | `/api/documents/:id/file` | Redirect to a signed URL for the original file |
| `POST` | `/api/documents/:id/reextract` | Re-run extraction on a stored document |
| `PATCH` | `/api/extractions/:id` | Update header or total fields |
| `POST` | `/api/extractions/:id/line-items` | Add a line item |
| `POST` | `/api/extractions/:id/review` | Mark the record reviewed |
| `PATCH` | `/api/line-items/:id` | Update a line item |
| `DELETE` | `/api/line-items/:id` | Delete a line item |
| `GET` | `/api/samples` | List bundled sample documents |
| `POST` | `/api/samples/:key` | Ingest a bundled sample |
| `GET` | `/api/health` | Service status and active model |

A failed extraction is returned as `201` with `status: "failed"` and the raw model output
attached, since it is a recorded outcome rather than a server fault.

## Testing

The unit and integration tests cover the extraction pipeline, validation, repair handling,
consensus and the deterministic checks. They use a scripted fake provider and make no network
calls.

```bash
npm test
```

An evaluation script runs all four samples through the pipeline and compares the results against
the expected values in `samples/truth.json`:

```bash
npm run eval
```

It reports each field as correct, flagged, or wrong-and-unflagged, and exits non-zero if any
field is wrong without a flag. A recent run:

| Sample | Status | Correct | Flagged | Wrong, unflagged |
|---|---|---|---|---|
| acme | `extracted` | 24 / 24 | 0 | 0 |
| northwind | `extracted` | 24 / 24 | 0 | 0 |
| blueridge | `needs_review` | 23 / 24 | 1 | 0 |
| zenith | `needs_review` | 32 / 32 | 0 | 0 |
| **Total** | | **103 / 104** | **1** | **0** |

The one non-matching field is the grand total on the scanned sample, which is obscured on the
document; it was returned as null and flagged rather than guessed.

These four documents are synthetic and were written alongside the system, so these numbers do
not establish real-world accuracy. They confirm that the pipeline behaves as intended on known
inputs, including the difficult ones. Results on the scanned sample vary between runs.

## Known Limitations

- Extraction runs synchronously within the upload request, so a slow document holds the
  connection open.
- Confidence weights are set by hand rather than calibrated against labelled data.
- Agreement between extraction passes indicates stability, not correctness.
- Scanned document quality depends entirely on the vision model. There is no separate OCR stage
  and no per-character confidence.
- Ambiguous `MM/DD` and `DD/MM` dates are normalised to one reading and flagged; they cannot be
  resolved from a single document.
- Arithmetic checks assume a single currency per invoice.
- Long invoices can exceed the model's output token limit. Truncation is detected and partially
  recovered, but very long documents remain a limit.
- Gemini's free tier is rate-limited per day per model, which restricts how many extractions can
  be run.
- There is no authentication. Anyone with access to the API can read and modify all records.

## Future Improvements

- Move extraction to a background worker with status polling.
- Add a dedicated OCR stage for scanned documents to obtain word-level confidence scores.
- Store field edits in a dedicated audit table rather than a JSON column.
- Calibrate confidence weights against a larger labelled dataset.
- Return source regions per field and highlight them in the document viewer.
- Add a second LLM provider behind the existing provider interface.

## Project Structure

```
apps/
  api/              Express API, extraction pipeline, database access
  web/              React review interface
packages/
  shared/           Invoice schema, flag types, API types
samples/
  generate/         Scripts that produce the sample invoices
  input/            The four sample documents
  output/           Committed extraction results
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system design, extraction pipeline, data model
and the reasoning behind the main technical decisions.
