# Document Intelligence Agent

Turns messy vendor invoices — clean PDFs, awkward layouts, a deliberately degraded scan, an
awkward spreadsheet — into structured records a human can review and correct.

The interesting part isn't the extraction. It's what happens when the model is wrong.

---

## The one idea

**A confidently wrong number is the only real failure mode.**

A field we couldn't read and *said so* costs a reviewer five seconds. A field we got wrong and
asserted confidently is never questioned again — it flows into a spreadsheet, a model, a
decision. Those two outcomes look identical under "accuracy" and could not be more different in
practice.

So every design decision here optimises for the same thing: **the system knows when it doesn't
know, and says so.** Three mechanisms, in increasing order of how much I trust them:

| Signal | Catches | Why trust it |
|---|---|---|
| The model reports what it couldn't read | Illegible source | Cheap, but it's still the model's opinion |
| Cross-sample disagreement | Uncertainty | An empirical measurement, not a self-report |
| Arithmetic reconciliation | **Actual error** | Doesn't involve the model at all |

That ordering matters. Three passes can *agree* on a hallucinated total; they cannot make it
add up.

---

## Setup

Needs Node 20+, a Gemini API key (free tier is enough), and a Supabase project.

```bash
npm install
cp .env.example .env
```

Fill in `.env` — every variable is documented in `.env.example`. Then:

```bash
npm run check:models
```

**Run this first.** It makes a real call to each configured model. It does *not* just check
the model list, because being listed doesn't mean being callable — on a free-tier key
`gemini-2.5-pro` returns 404 ("no longer available to new users") and `gemini-3.7-flash` is
frequently 503, yet both appear in `listModels()`. If it fails, it prints what you *can* use.

```bash
npm run samples:generate   # writes the 4 sample invoices to samples/input/
npm run db:migrate         # applies the schema and creates the storage bucket
npm run dev                # API on :4000, web on :5173
```

Open http://localhost:5173 and use a **Try a sample** button. Start with **Blue Ridge
(scanned)** — that's the one designed to fail informatively.

### Without a database

The extraction pipeline is the interesting part and it doesn't need Postgres. With only
`GEMINI_API_KEY` set:

```bash
npm run extract -- samples/input/blue-ridge-scan.pdf
npm run prepare:doc -- samples/input/zenith-parts.xlsx   # what the model actually sees
npm run test                                             # 109 tests, no network
```

---

## How it works

```
upload ─▶ classify ─▶ prepare ─▶ N passes ─▶ consensus ─▶ checks ─▶ confidence ─▶ persist
          (bytes)     (per kind)  (repair     (vote)      (pure)     + status
                                   ladder)
```

**Classify** from magic bytes, never the declared MIME type or extension — both are trivially
wrong and one is attacker-controlled. A PDF text-layer probe under 50 chars/page means it's a
scan. The four samples land at 677 / 874 / 0, so the threshold sits in genuinely empty space.

**Prepare** is deliberately trivial for PDFs: hand Gemini the raw bytes. Extracting text first
flattens the table structure that makes an invoice readable — pdfjs turns Acme's line items
into `Description Qty Unit Price Amount A4 Copier Paper, 80gsm (ream) 40 4.25 170.00`, strictly
worse than the page itself. Spreadsheets get the opposite treatment (Gemini can't open a zip of
XML), rendered as markdown with **column letters and row numbers preserved** so "the total four
rows below the table" stays true, and merged ranges listed explicitly.

**Passes** run sequentially at temperature 0, 0.4, 0.4. Each goes through a repair ladder,
cheapest rung first:

```
0. local repair    no API call — fences, trailing commas, truncation
1. type coercion   no API call — "Rs. 1,41,077.85" → 141077.85
2. repair call     show the model its own output and the exact zod error
3. escalation      retry once on a different model, double the token ceiling
4. give up         status 'failed', raw output kept, every field flagged
```

Spending a round trip to fix a trailing comma is two wasted seconds and a wasted request, so
rungs 0–1 exist to make that never happen. Hard cap of 4 calls per pass.

**Consensus** votes field by field. Unanimous is clean; 2-of-3 is a warning and takes the
majority; a three-way split is an error and keeps the temperature-0 reading.

**Checks** are pure functions that never touch a model — two-stage reconciliation, row
arithmetic, missing fields, ambiguous dates, and an order-of-magnitude sanity net.

**Confidence** is computed. `meta.legibility` appears only as a *multiplier*, so the model can
pull a score down and never prop one up.

---

## Decisions worth defending

### Gemini, and why that simplified everything

Document understanding is Gemini's strongest capability, and native PDF input means text PDFs
and scanned PDFs go down the **same code path** — no rasterising, no DPI tuning, no
per-request image cap. `responseSchema` composes with document input, so it's one call in, JSON
out.

I'd sketched this against Groq first. There, structured outputs don't compose with image input
at all, which forces a two-stage transcribe-then-structure pipeline. That's more machinery
existing purely to work around a platform limitation. Choosing the tool that doesn't have the
limitation was worth roughly 40 minutes of build time and a whole dependency.

### An explicit subtotal / discount / tax band

Beyond the brief's required fields, and the single most important schema decision here.

Without them, *any* invoice carrying tax makes `sum(lineItems) ≠ grandTotal`, and the strongest
check in the system fires a false positive on a **perfectly correct extraction**. Sample #2
(Northwind) exists specifically to prove this: its lines sum to ₹125,850 against a total of
₹141,077.85, entirely legitimately.

Three nullable numbers turn one brittle check into two:

```
stage 1   Σ line items              → subtotal
stage 2   subtotal − discount + tax → grand total
```

Stricter *and* quieter. **A flag that fires when nothing is wrong is worse than no flag** — it
teaches the reviewer to ignore the amber rings, which breaks the one feature everything else
here serves.

The alternative — letting tax and discount masquerade as line items with negative totals —
makes the sum balance but corrupts the line-item table the human has to review.

### Self-consistency instead of self-reported confidence

An LLM's stated confidence is weakly calibrated and correlates with fluency more than accuracy.
What *does* correlate is instability: run the same document three times and the fields the model
is unsure about are the ones whose answers move.

On the degraded scan this lights up exactly where intended — the row-3 unit price came back
`43.75 / null` across passes, and the tax value `236.55 / 315.40`.

It costs 3× the calls, which is affordable because Flash is cheap. On a frontier model the
arithmetic would be different, and I'd probably drop to 2 passes.

**The honest caveat: agreement is necessary, not sufficient.** Three passes can agree and all be
wrong. This catches uncertainty; the arithmetic catches error.

### Recovering blank cells without inventing data

Sample #4 leaves an Amount cell blank. The correct extraction returns `null` — the document
doesn't contain that number. But then the lines legitimately fail to sum to the printed
subtotal, and stage 1 would flag a correct reading.

So we derive the value from qty × price **for checking only**, reconcile with it, keep `null` in
the record, and flag it with the derived number as a suggestion:

> *blank on the document — 8 × 31.25 would be 250.00, but confirm it before accepting*

The reviewer gets the help. The record doesn't get a number the document never had.

### A failed extraction returns 201, not 500

It's a legitimate outcome we successfully recorded: the record exists, carries flags, and keeps
the raw model output. A 500 would make "this document was unreadable" indistinguishable from
"the server is broken" — and those need very different things from the person looking at the
screen.

### The source document sits beside the record

The highest-value UI decision. Reviewing extracted data without the original in view is
guesswork — you can see the numbers don't add up, but not which one is wrong.

It matters most exactly where the system is weakest. On the scan, the reviewer has to look at
the coffee stain and decide for themselves what the digits are. Flagging instead of guessing
only works if the person can see the page.

### Synchronous extraction

A queue is the right production answer and it's first on the list below. At four documents, one
user and no deployment, it costs an hour and adds a worker plus a polling endpoint that improve
nothing a reviewer can see. The `pending`/`processing` statuses and timestamps are modelled *as
if* async, so moving to a queue is a change to one route file rather than a schema migration.

---

## The samples

All four are generated by committed scripts from a **single ground-truth fixture**
(`samples/generate/src/data.ts`), which is also the eval's expectations — so the documents and
what we expect from them cannot drift apart. The generator refuses to emit anything if a
fixture's own arithmetic doesn't balance.

| # | File | What it's actually testing |
|---|---|---|
| 1 | `acme-supplies.pdf` | Clean baseline. The control, not a test. |
| 2 | `northwind-trading.pdf` | Vendor only in the letterhead. "Bill No." not "Invoice Number", with a GSTIN and PAN beside it as decoys that look *more* like identifiers. Indian digit grouping (`1,41,077.85`, which `\d{1,3}(,\d{3})*` doesn't match). Accounting labels: Gross / Less: Discount / Add: GST / Net Payable. |
| 3 | `blue-ridge-scan.pdf` | Degraded scan, no text layer. See below. |
| 4 | `zenith-parts.xlsx` | Data not at A1, two labelled blocks, **Unit Price before Qty** (swapped vs every other sample), a decoy block sub-total mid-table that isn't the invoice subtotal, one blank Amount cell. |

### On the scanned one

Authored as SVG rather than laid out with pdfkit, so every value has a known coordinate and the
degradation could be **targeted rather than uniform**. A uniformly mushy page fails uniformly and
proves nothing.

Global: rotated −2.4°, blurred, gaussian noise, contrast crushed to a faded-photocopy range,
resampled through 110 DPI, JPEG quality 20. Then three planted difficulties: a coffee ring with
ink bleed over the grand total, glyph-ambiguous date digits, and one unit price in the darkest
band.

Most of the page stays readable — vendor, invoice number, the line items, the subtotal — while
those three values are genuinely ambiguous. That contrast is the point: you can watch the system
draw a line between what it knows and what it doesn't.

Two calibration notes, because neither was obvious:

- **The resample round-trip is the only irreversible step** and decides everything. 0.73 leaves
  everything readable; 0.42 destroys the document; 0.55 makes body text marginal.
- **I tuned the local blurs *down*, from 3.4 to 2.6.** At the higher value the fields were
  *erased*, and an erased field is the easy case — the model reports it illegible and all three
  passes agree. The interesting case is a value it can *almost* read, because that's where it
  guesses.

**Rule I held to: calibrate the generator, never the prompt.** Tuning a prompt to pass a test you
wrote yourself is exactly the self-deception this exercise is screening for.

---

## Results

`npm run eval` runs all four and scores against ground truth. The headline metric is not
accuracy:

```
correct        matched the document
flagged        wrong or missing, but we said so
SILENTLY WRONG wrong, and we claimed otherwise    ← the only number that matters
```

<!-- EVAL_RESULTS -->

---

## Known limitations

- **Extraction is synchronous.** A slow document blocks the request. Fine at this scale, wrong
  in production.
- **Confidence weights are reasoned, not fitted.** With four documents there's nothing to
  calibrate against, and pretending otherwise would be false precision.
- **Self-consistency detects instability, not correctness.** Three passes can agree and all be
  wrong.
- **`responseSchema` guarantees shape, not truth.** Schema-valid and semantically wrong is the
  failure that actually hurts; only the deterministic checks catch it.
- **Scanned quality depends entirely on the vision model.** There's no dedicated OCR fallback and
  no per-character confidence to lean on — a page Gemini can't read is a page we can't read.
- **`MM/DD` vs `DD/MM` is guessed and flagged, not resolved.** It cannot be resolved from a
  single document without vendor context.
- **The Gemini free tier is 20 requests per _day_ per model**, and this is the single biggest
  practical constraint on the project. The 5-per-minute limit is the one you hit first and it is
  *not* the binding one — I lost real time retrying a daily cap that was never going to clear.
  The whole daily budget is 5 eval runs at `EXTRACTION_SAMPLES=1`, 2 at `=2`, or 1 at `=3`,
  before any repair calls or clicking around the UI. The provider now detects a daily
  exhaustion and fails immediately with a clear message rather than waiting out four windows
  against a cap that resets at midnight. **Default is 2** — 3 is the better design and what
  §5.6 describes, but a reviewer who clones this and immediately cannot run it is a worse
  outcome than losing the 2-of-3 nuance.
- **A pass lost to quota legitimately downgrades the record.** If one of the passes fails, the
  consensus is built from the rest and the record carries `1 of 3 extraction passes failed;
  consensus is based on 2` — which flips it to `needs_review`. That is the system being honest
  rather than a bug, but it means status can vary run to run on a constrained key.
- **Single-currency assumption** in the arithmetic checks. Mixed-currency invoices are flagged,
  not handled.
- **Long invoices** can hit `MAX_TOKENS` mid-JSON. We detect it, recover what's complete, flag
  the truncation and escalate — but very long documents remain a real limit.
- **No auth.** Anyone with the URL can read and edit everything. Explicitly out of scope.

---

## What I'd do differently with more time

Roughly in order of what I'd reach for first:

1. **Async extraction** — a queue and status polling. The right answer at any real volume.
2. **A proper audit trail.** Edits currently append to `raw.edits`; a `field_edits` table with a
   diff view is the real answer. **Corrections are training data** and this schema throws most of
   that signal away.
3. **Calibrate confidence against a few hundred labelled invoices** instead of four. The weights
   are currently defensible, not measured.
4. **A dedicated OCR stage** for scans (Document AI / Textract) with **word-level confidence
   scores**. Gemini's OCR is strong but returns no per-character certainty — a real OCR engine
   does, and that's a strictly better uncertainty signal than anything computed here.
5. **The second provider.** There's already an `LLMProvider` seam and a `provider` column;
   implementing Groq behind it and putting a head-to-head over the same four documents in this
   README would turn "I thought about evals" into an actual eval.
6. **Span grounding** — have the model return the source region per field, and highlight it on
   the document when you focus the input. The natural next step for the two-pane view.
7. **Vendor templates.** Once a vendor's layout is corrected, prime the next invoice from that
   vendor with the corrected prior. Cheaper and more accurate at volume than re-reading from
   scratch every time.
8. **Recorded-fixture tests for the pipeline end to end.** The pure functions are well covered;
   the Gemini integration is only covered by a scripted fake.

## What I deliberately skipped

Auth, deployment, multi-user, websocket progress, PDF form fields, table-structure ML, exhaustive
locale handling, and a job queue. Each was one honest sentence here instead of an hour of code
that wouldn't have changed what a reviewer sees.

---

## Layout

```
apps/api            Express + TS. Extraction pipeline, routes, Drizzle schema.
  src/extraction/   classify · prepare · prompt · repair · consensus · checks · confidence
  src/llm/          provider interface + Gemini implementation
apps/web            React + TS + Tailwind. Upload, list, two-pane review.
packages/shared     The zod schema. One definition → TS types, runtime validation,
                    and Gemini's responseSchema.
samples/generate    Scripts that produce the four invoices from one fixture.
samples/input       The four generated documents.
samples/output      Committed extraction results.
```

`ARCHITECTURE.md` has the fuller design write-up, including the parts that were reasoned about
and then not built.
