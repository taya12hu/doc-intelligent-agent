# Document Intelligence Agent

Turns vendor invoices — PDF or Excel — into structured records a person can review and correct.

**An LLM will sometimes read an invoice wrong, and it will do so confidently.** A wrong value that
nothing questions is worse than a missing one: it flows into whatever comes next unchallenged. So
extraction here is only the first step. Every response is validated against a schema, reconciled
against the document's own arithmetic, and compared across repeated passes. Anything that cannot
be confirmed is flagged for review rather than silently accepted.

The reviewer sees the original document beside the extracted record, with each flagged field
marked and the reason stated in plain language.

## Features

- PDF and Excel upload, handling both text-based and scanned PDFs
- Structured extraction into a schema-validated record
- Automatic repair and retry when model output is malformed
- Arithmetic reconciliation performed independently of the model
- Uncertain fields flagged with a plain-language reason
- Two-pane review: source document beside inline editing of fields and line items
- Filterable review queue with per-record status and provenance
- Records in Supabase Postgres, original files in Supabase Storage

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Tailwind CSS, Vite, TanStack Query |
| Backend | Node.js, Express, TypeScript |
| LLM | Gemini (`@google/genai`) |
| Validation | Zod |
| Database | Supabase Postgres with Drizzle ORM |
| File storage | Supabase Storage |
| Document parsing | `pdfjs-dist`, SheetJS |

## Getting Started

### Prerequisites

- Node.js 20 or later
- A Gemini API key — [Google AI Studio](https://aistudio.google.com/apikey)
- A Supabase project — [supabase.com](https://supabase.com)

### Setup

```bash
git clone https://github.com/taya12hu/doc-intelligent-agent.git
cd doc-intelligent-agent
npm install
cp .env.example .env
```

| Variable | Notes |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio |
| `GEMINI_MODEL` | Primary extraction model (default `gemini-3.6-flash`) |
| `GEMINI_ESCALATION_MODEL` | Fallback used when the first attempt fails validation |
| `EXTRACTION_SAMPLES` | Extraction passes to compare (default `2`) |
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API (server-side only) |
| `DATABASE_URL` | Supabase → Settings → Database → Connection string |

Then verify the models, apply the schema, and run:

```bash
npm run check:models   # calls each configured model; availability varies by key and tier
npm run db:migrate     # applies the schema and creates the storage bucket
npm run dev            # API on :4000, frontend on :5173
```

Open http://localhost:5173 and drop in a PDF or `.xlsx`, or use one of the four bundled samples.

Extraction runs synchronously and takes roughly 10–40 seconds, so **one document is processed at
a time**. While it runs, a progress panel replaces the drop zone and an indicator stays in the
navigation bar from any page.

The pipeline also runs from the command line with only a Gemini API key — no database needed:

```bash
npm run extract -- samples/input/blue-ridge-scan.pdf
npm run prepare:doc -- samples/input/zenith-parts.xlsx   # shows what the model receives
```

## How It Works

```
upload → classify → prepare → extraction (N passes) → schema validation
       → deterministic checks → review flags → save
```

**Classify.** The file type is detected from its contents, not the declared MIME type. PDFs
without a usable text layer are treated as scans.

**Prepare.** PDFs go to Gemini as raw bytes, so text and scanned PDFs follow the same path.
Spreadsheets are converted to Markdown tables that preserve column letters, row numbers and
merged ranges, because in a spreadsheet position carries meaning — data may not start at A1, and
a total can sit several rows below the table it summarises.

**Extract.** Gemini is called with a response schema derived from the Zod definition. Alongside
the invoice fields it reports which fields it could not read, a legibility rating, and the
invoice date exactly as printed — the last of these is what keeps `MM/DD` versus `DD/MM`
ambiguity detectable after normalisation.

**Validate.** Responses are parsed with Zod. Malformed output is repaired locally where possible,
then re-sent to the model with the specific validation errors, then retried once on a fallback
model. If nothing valid survives, the record is saved as `failed` with the raw output retained.

**Check.** Independent of the model, values are reconciled arithmetically and checked for missing
required fields, ambiguous dates and implausible magnitudes.

**Flag and save.** Fields that fail a check, that the model reported as unreadable, or that
differed between passes are flagged with a reason. A status and a heuristic review score are
derived from the flags, and the record is written to Postgres.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the pipeline, data model and API in detail.

## Validation and Reliability

Valid JSON is not evidence of correct values. Four independent layers, each catching something
the others do not:

| Layer | Catches |
|---|---|
| **Schema validation** | Structurally wrong output. Every field is nullable and none optional, so a value the model did not find is an explicit `null`, not an absent key. |
| **Repair and retry** | Malformed responses — fences, truncation, number formats — fixed locally first, then by the model, then by a fallback model. |
| **Deterministic checks** | Genuinely wrong values. Line totals reconcile against the subtotal, and subtotal less discount plus tax against the grand total. No model involved. |
| **Repeated passes** | Fields the model is unstable about, surfaced by comparing passes field by field. |

**Agreement between passes indicates stability, not correctness.** Passes can agree and all be
wrong; that is what the arithmetic checks are for. Neither replaces the reviewer.

Each record carries a status — `extracted`, `needs_review` or `failed` — and a **heuristic review
score** derived from its flags and the model's legibility rating. The score orders a queue; it is
not a calibrated probability, and 0.85 does not mean an 85% chance of being right. The weights
are hand-chosen and have not been fitted to labelled data.

## Human Review

Each record opens with the source document on the left and the editable record on the right, so
values can be checked without leaving the page. Header fields, line items and totals are all
editable, and flagged fields show their reason inline:

- *Couldn't find this in the document*
- *The model reported this as unreadable rather than guessing*
- *Doesn't add up: line items total 1,240.00 but the document states 1,245.00 — off by 5.00*
- *Ambiguous date format: "08/03/2025" could be 8 Mar 2025 or 3 Aug 2025*

Saving re-runs the checks server-side, so flags clear when the underlying problem is fixed and new
ones appear if an edit introduces an inconsistency.

A record can be marked reviewed with flags outstanding — an ambiguous date cannot be resolved from
the document alone. Reviewed records carry their own status, so accepting a record with known
problems is never confused with a clean extraction.

The queue lists anything needing attention first and filters by **Needs attention / Reviewed /
All**. Hovering a record's flag count expands it into the individual flags, so records can be
triaged without opening them.

When extraction fails, the record says why — quota exhausted, service unreachable, or no usable
output — because the causes call for different responses. The raw model output is kept either way.

## Sample Documents

Four invoices, generated from a single fixture that also defines their expected results:

| File | Format | What it exercises |
|---|---|---|
| `acme-supplies.pdf` | Text PDF | Conventional layout — the baseline |
| `northwind-trading.pdf` | Text PDF | Unusual field labels, vendor only in the letterhead, non-Western digit grouping, and a discount and tax band above the total |
| `blue-ridge-scan.pdf` | Scanned PDF | Degraded scan, no text layer, several values obscured |
| `zenith-parts.xlsx` | Excel | Data not starting at A1, line items across two blocks, reordered columns, a blank amount cell |

The scanned sample is deliberately difficult and is expected to need human review. Results for all
four are committed in `samples/output`; `npm run samples:generate` rebuilds the documents.

## Testing

Unit and integration tests cover the extraction pipeline, validation, repair, consensus and the
deterministic checks, using a scripted fake provider with no network calls.

```bash
npm test        # test suite
npm run eval    # runs all four samples and scores them against samples/truth.json
```

The evaluation marks every field **correct**, **flagged**, or **wrong and unflagged**, and exits
non-zero if anything is wrong without a flag. A recent run:

| Sample | Status | Correct | Flagged | Wrong, unflagged |
|---|---|---|---|---|
| acme | `extracted` | 24 / 24 | 0 | 0 |
| northwind | `extracted` | 24 / 24 | 0 | 0 |
| blueridge | `needs_review` | 23 / 24 | 1 | 0 |
| zenith | `needs_review` | 32 / 32 | 0 | 0 |
| **Total** | | **103 / 104** | **1** | **0** |

The single non-matching field is the scanned sample's grand total, obscured on the page — returned
as `null` and flagged rather than guessed.

**These four documents are synthetic and were written alongside the system, so these numbers do
not establish real-world accuracy.** They show the pipeline behaving as designed on known inputs,
including deliberately hard ones. Results on the scanned sample vary between runs.

## Known Limitations

- Extraction is synchronous, so a slow document holds the request open.
- The review score is heuristic. Its weights are hand-chosen, not calibrated against labelled data.
- Agreement between passes indicates stability, not correctness.
- Scanned quality depends entirely on the vision model — no separate OCR stage, no per-character
  confidence.
- Ambiguous `MM/DD` and `DD/MM` dates are normalised to one reading and flagged; they cannot be
  resolved from a single document.
- Arithmetic checks assume one currency per invoice.
- Long invoices can exceed the model's output token limit. Truncation is detected and partially
  recovered, but remains a limit.
- Gemini's free tier is capped per day per model, which restricts throughput.
- No authentication. Anyone with API access can read and modify all records.

## Future Improvements

- Move extraction to a background worker with status polling.
- Add a dedicated OCR stage for scans, for word-level confidence.
- Record field edits in a dedicated audit table.
- Calibrate the review score against a labelled dataset.
- Return source regions per field and highlight them in the viewer.
- Add a second LLM provider behind the existing interface.

## Project Structure

```
apps/
  api/         Express API, extraction pipeline, database access
  web/         React review interface
packages/
  shared/      Invoice schema, flag types, API types
samples/
  generate/    Scripts that produce the sample invoices
  input/       The four sample documents
  output/      Committed extraction results
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the system design, extraction pipeline, data model, API
and the reasoning behind the main technical decisions.
