# Document Intelligence Agent — Architecture

> Messy vendor invoices → validated structured records a human can review and correct.
> Task for Kautilya PE (Full‑Stack + AI Engineer). Target effort: 4–6 focused hours.

**Stack locked:** Gemini (LLM, primary) · Drizzle (ORM) · Supabase Postgres + Storage · Express + TS · React + Vite + TS + Tailwind.

---

## 1. What we're actually being graded on

The brief says it outright, so optimize for it:

1. **Ship end‑to‑end** — upload → extract → review → correct, working.
2. **Handling LLM unreliability** — validation, retries, repair, confidence signaling. Not trusting raw output.
3. **Data modeling + API design.**
4. **Frontend usability on messy data**, not the happy path.
5. **Written judgment** — README trade‑offs matter as much as code.

**What we deliberately do NOT build:** auth, deployment, multi‑user, job queues, websockets/SSE, visual polish, exotic formats. Each is one honest sentence in the README instead of an hour of code.

The one thing that must be right: **the system knows when it's wrong and says so.** A confidently wrong extraction is a failure. A flagged uncertain extraction is a success.

---

## 2. Why Gemini, and what that buys us

The crux of this task is the deliberately degraded scan. Document understanding is Gemini's strongest capability, and three of its properties shape the whole design:

| Capability | Consequence |
|---|---|
| **Native PDF input** — send raw PDF bytes, 50 MB / 1000 pages, ~258 tokens/page | **No rasterization stage at all.** No pdfjs→PNG render, no DPI tuning, no per‑request image cap. Text PDFs and scanned PDFs go down the *same* code path. |
| **Structured output (`responseSchema`) works alongside multimodal input** | One call: PDF in, schema‑shaped JSON out. No two‑stage transcribe‑then‑structure workaround. |
| Strong OCR on low‑quality scans | The hard sample gets the best available reader, which is the honest choice when the hard sample *is* the task. |

Google's own guidance for document input is *"rotate pages to the correct orientation"* and *"avoid blurry pages."* Sample #3 deliberately violates both — worth naming in the README, because it frames the scan as an adversarial case rather than an accident.

> ⚠️ **Verify in step 0.** Gemini model IDs move fast. Call `ListModels` and confirm the IDs below exist, and confirm `responseSchema` + PDF input compose in one call before building on it. Keep IDs in env (`GEMINI_MODEL`, `GEMINI_ESCALATION_MODEL`) so a swap is config, not code.

### Model roles

| Role | Model | Why |
|---|---|---|
| **Primary extraction** | `gemini-3.7-flash` (alt: `gemini-3.6-flash`) | Fast, cheap, strong multimodal. Handles all four documents. |
| **Escalation** | `gemini-2.5-pro` / `gemini-3.1-pro-preview` | Retried **once** when the primary comes back low‑confidence or the repair loop fired. ~20 lines of code, real production pattern. |

SDK: `@google/genai`. Inline base64 for our sample‑sized files; the Files API is the path for anything larger or reused across calls (noted, not built).

### Provider interface — cheap insurance

Put a thin seam between the pipeline and the SDK:

```ts
interface LLMProvider {
  name: string;
  extract(input: ExtractionInput, opts: { temperature: number; model: string })
    : Promise<{ raw: string; parsed: unknown; usage: Usage; latencyMs: number }>;
}
```

15 minutes. Two payoffs: it's the escape hatch if the Gemini free tier rate‑limits us mid‑build, and if the core finishes early we implement a second provider (Groq), run both across the 4 samples, and put the comparison in the README. **That comparison is an eval** — and the job description explicitly asks for evals. Stretch goal only; never before the core works.

---

## 3. High‑level flow

```
┌────────────┐   POST /api/documents   ┌──────────────────────────────────────────┐
│  React UI  │ ──────────────────────▶ │  Express API (TypeScript)                │
│            │                         │                                          │
│  · upload  │                         │  1. validate + store file → Supabase     │
│  · list    │                         │     Storage; insert documents row        │
│  · review  │ ◀────────────────────── │  2. run extraction pipeline (SYNC)       │
│  · correct │      full record        │                                          │
└────────────┘                         │   ┌──────────────────────────────────┐   │
                                       │   │ classify → pdf_text | pdf_scanned│   │
                                       │   │            | xlsx                │   │
                                       │   ├──────────────────────────────────┤   │
                                       │   │ prepare input                    │   │
                                       │   │  pdf  → raw bytes (passthrough)  │   │
                                       │   │  xlsx → SheetJS → markdown       │   │
                                       │   ├──────────────────────────────────┤   │
                                       │   │ EXTRACT: Gemini + responseSchema │   │
                                       │   │  ×3 samples (self-consistency)   │   │
                                       │   ├──────────────────────────────────┤   │
                                       │   │ zod validate → repair loop       │   │
                                       │   │ → escalate to Pro if shaky       │   │
                                       │   ├──────────────────────────────────┤   │
                                       │   │ deterministic checks → flags     │   │
                                       │   │ confidence + status              │   │
                                       │   └──────────────────────────────────┘   │
                                       │  3. persist extraction + line_items      │
                                       └────────────────────┬─────────────────────┘
                                                            │  Drizzle
                                                     ┌──────▼───────┐
                                                     │   Postgres   │
                                                     │  (Supabase)  │
                                                     └──────────────┘
```

**Extraction is synchronous** on the upload request. Rationale: 4 files, single user, no deploy, responses land in a few seconds. A queue is the correct production answer and it's #1 on the "more time" list — but at n=4 it's ceremony that costs an hour and adds zero grading signal. We still model `status` and timestamps *as if* async, so the design story holds.

---

## 4. Repo layout

npm workspaces monorepo:

```
/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── index.ts               # express bootstrap
│   │   │   ├── routes/                # documents, extractions, line-items
│   │   │   ├── db/
│   │   │   │   ├── schema.ts          # drizzle schema (source of truth)
│   │   │   │   ├── client.ts          # postgres.js + drizzle
│   │   │   │   └── repo.ts            # query helpers
│   │   │   ├── storage/               # supabase storage wrapper
│   │   │   ├── llm/
│   │   │   │   ├── provider.ts        # LLMProvider interface
│   │   │   │   ├── gemini.ts          # primary impl
│   │   │   │   └── groq.ts            # optional 2nd impl (stretch)
│   │   │   ├── extraction/
│   │   │   │   ├── index.ts           # runExtraction() orchestrator
│   │   │   │   ├── classify.ts
│   │   │   │   ├── prepare.ts         # pdf passthrough / xlsx → markdown
│   │   │   │   ├── prompt.ts
│   │   │   │   ├── repair.ts          # local repair + repair loop
│   │   │   │   ├── consensus.ts       # self-consistency across samples
│   │   │   │   ├── checks.ts          # arithmetic, date, missing → flags
│   │   │   │   └── confidence.ts
│   │   │   └── lib/                   # money/date coercion, errors
│   │   └── drizzle.config.ts
│   └── web/
│       └── src/
│           ├── routes/                # Upload, List, RecordDetail
│           ├── components/            # FlagChip, StatusPill, LineItemGrid,
│           │                          # SourceViewer, ConfidenceBar, ExtractionLog
│           └── api/                   # typed fetch + TanStack Query hooks
├── packages/
│   └── shared/src/
│       ├── invoice.ts                 # zod schema  ← single source of truth
│       ├── flags.ts                   # FieldFlag types
│       └── responseSchema.ts          # zod → Gemini responseSchema
├── samples/
│   ├── generate/                      # scripts that produce the 4 files
│   ├── input/                         # the 4 invoices (committed)
│   └── output/                        # extraction JSON per file (committed)
├── ARCHITECTURE.md
└── README.md
```

`packages/shared` is load‑bearing: the invoice schema is written **once** in zod and produces (a) the TS types both apps use, (b) the runtime validator, (c) the `responseSchema` handed to Gemini.

---

## 5. The extraction pipeline

### 5.1 Canonical schema — `packages/shared/src/invoice.ts`

```ts
export const LineItem = z.object({
  description: z.string(),
  quantity:    z.number().nullable(),
  unitPrice:   z.number().nullable(),
  lineTotal:   z.number().nullable(),
});

export const Invoice = z.object({
  vendorName:    z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate:   z.string().nullable(),   // model emits ISO; we re-normalize
  currency:      z.string().nullable(),   // ISO-4217; beyond brief, cheap, useful
  lineItems:     z.array(LineItem),

  // the adjustment band between line items and the total
  subtotal:      z.number().nullable(),
  discountTotal: z.number().nullable(),   // positive magnitude, subtracted
  taxTotal:      z.number().nullable(),

  grandTotal:    z.number().nullable(),
});
```

**Choices:**

- **Every field nullable, nothing optional.** Removes the ambiguity between "didn't find it" and "forgot to emit it". Explicit `null` is a signal we can flag; a missing key is noise.
- **Numbers are numbers.** Prompt says strip `$ , ₹ Rs.`. When the model returns `"1,234.50"` anyway, a coercion preprocessor repairs it before zod. If coercion fails → `unparseable` flag, not a crash.
- **Date as string, normalized separately.** Invoices say `03/04/2025`, `14‑Mar‑2025`, `2025‑03‑04`. Ask for ISO, then normalize with dayjs + custom parsers. If `MM/DD` vs `DD/MM` is genuinely ambiguous, pick one **and flag it**, keeping the raw string in `raw.observed`.
- **`currency` added beyond the brief** — one extra field, lets the arithmetic check avoid mixing units and tells the reviewer "this one's in INR".
- **`subtotal` / `discountTotal` / `taxTotal` added beyond the brief.** Without them, any invoice with a tax or discount row makes `Σ lineTotal ≠ grandTotal`, and our single strongest check fires a false positive on a perfectly correct extraction — which would train the reviewer to ignore the flag. Three nullable numbers turn one brittle check into a **two-stage reconciliation** (§5.8) that is both stricter and quieter. The alternative — letting tax and discount masquerade as line items with negative totals — makes the sum work but corrupts the line‑item table the human has to review. Modeling the adjustment band explicitly is the honest choice.

### 5.2 The response envelope

The model returns more than the canonical record. Wrap it:

```ts
const ExtractionEnvelope = z.object({
  invoice: Invoice,
  meta: z.object({
    illegibleFields: z.array(z.string()),  // ["grandTotal", "lineItems[2].unitPrice"]
    legibility:      z.number(),           // 0–1, model's read on source quality
    notes:           z.string(),           // free text, e.g. "discount row present"
  }),
});
```

`invoice` becomes the persisted record. `meta` goes into `extractions.raw` and feeds the flagging logic — **it never contaminates the canonical data.**

`illegibleFields` is the key idea, and it replaces the `[?]`‑marker machinery a two‑stage pipeline would have needed. Instead of the model silently guessing at a smudged number, it tells us *which fields it couldn't read*, we emit `null` for them, and that becomes a flag. **Uncertainty survives the pipeline instead of getting laundered into a hallucination.**

### 5.3 Classify

MIME + extension + magic bytes → `pdf_text | pdf_scanned | xlsx`.

For PDFs we still run `pdfjs-dist` text extraction — **not to feed the model**, but to classify: < ~50 chars/page → `pdf_scanned`. Stored on the document row and shown in the UI as a badge, which proves the system detected the scan itself rather than being told. Cheap, and it lets the prompt adapt (§5.5).

### 5.4 Prepare input

| Kind | Handling |
|---|---|
| `pdf_text`, `pdf_scanned` | **Raw PDF bytes, inline base64, straight to Gemini.** No preprocessing. This is the whole payoff of the Gemini choice. |
| `xlsx` | SheetJS → for each sheet, a **markdown table with cell addresses preserved** (`A1`, `B7`), empty cells as `∅`. Addresses let the model reason about "the total sits four rows below the table" — exactly sample #4's trick. |

### 5.5 Extraction call

- **System prompt**: role, exact field definitions, normalization rules, and the hard rule:
  > *"If a value is not present, or you cannot read it clearly, output `null` for it and add its field path to `meta.illegibleFields`. Do not infer, do not compute, do not guess. A `null` is correct; a wrong number is a failure."*
- **`responseSchema`** derived from the zod envelope, with `responseMimeType: 'application/json'`.
- `temperature: 0` for the primary sample. Generous `maxOutputTokens` (long line‑item lists — see §5.7 for what happens when we hit the ceiling anyway).
- **Prompt adapts on `pdf_scanned`**: adds an explicit line that the source is a low‑quality scan, that partial illegibility is expected, and that reporting it is the correct behaviour. One conditional string, meaningful accuracy difference.

### 5.6 Self‑consistency

Run the extraction **3 times**: one at `temperature 0`, two at `temperature 0.4`. Then compare **field by field**:

| Agreement across 3 runs | Action |
|---|---|
| All 3 identical | high confidence, no flag |
| 2 of 3 agree | take the majority value, flag `low_agreement` (warn) |
| All 3 differ | take the temp‑0 value, flag `disagreement` (error) — this field is a coin flip |

Line items are matched by position + fuzzy description, then compared exactly on numbers.

Why it's worth 3× the calls: **it's an empirical uncertainty measure, not the model's opinion of itself.** Self‑reported confidence is weakly calibrated at best; disagreement across independent samples genuinely tracks the model being unsure — and on the degraded scan it will light up precisely on the fields we deliberately made hard. That is a demonstrable result, not a claim.

Behind `EXTRACTION_SAMPLES=3` so it can be dialled to 1 if free‑tier rate limits bite. Note the RPM ceiling in the README as a scaling consideration.

### 5.7 Validate + repair loop

`responseSchema` gives us a **shape** guarantee, not a **correctness** one — and not even shape, reliably. Handle failure in escalating order, **cheapest fix first**:

```
0. Local repair (no API call):
     strip markdown fences, extract first balanced {...},
     close truncated JSON, fix trailing commas,
     coerce "1,23,456.00" → 123456, "3 Nos" → 3, "$1,200" → 1200
   → re-parse

1. zod.safeParse
     ok   → continue
     fail → attempt 2

2. Repair call: send the model its own output + the zod error
     "Your output failed validation: <zod error path + message>.
      Return corrected JSON matching the schema. Change nothing else."

3. Fail again, OR finishReason === 'MAX_TOKENS'
   → escalate: retry once on the Pro model with a trimmed prompt
     and a higher token ceiling

4. Fail again → status = 'failed'. Persist the raw model text in
   extractions.raw, flag every field, return 201 with the failure.
   The UI shows "extraction failed — here's the raw output" rather
   than a blank record or a lie.
```

Hard cap: **4 model calls per sample.** Every attempt appended to `repair_log` (attempt no, finishReason, error, action taken) and surfaced in the UI behind a "Show extraction log" disclosure. That's grading criterion #2 made *visible* rather than asserted.

**Known Gemini failure modes this specifically catches:**
- `finishReason: MAX_TOKENS` → JSON truncated mid‑array on a long invoice. Local repair closes the structure, we flag the truncation, and escalation retries with more headroom.
- Schema‑valid but semantically wrong — caught downstream by §5.8, not here.
- Safety/recitation blocks returning empty candidates → treated as a transport failure, retried with backoff.

Separately, a transport layer with exponential backoff on 429/5xx. **Don't conflate "network flaked" with "model was wrong"** — they need different responses and they mean different things in the log.

**Escalation trigger** (the Flash→Pro path, ~20 lines): fire when the repair loop ran, or `meta.legibility < 0.5`, or ≥2 error‑severity flags after §5.8. One retry, recorded in `repair_log`. Real production pattern, cheap, and a good interview talking point.

### 5.8 Deterministic checks → flags

Nothing here calls a model. Pure functions, unit‑testable, and the strongest hallucination catch we have.

```ts
type FieldFlag = {
  field: string;      // "grandTotal" | "lineItems[2].unitPrice"
  reason: 'missing' | 'unparseable' | 'illegible_source' | 'math_mismatch'
        | 'row_math_mismatch' | 'ambiguous_date' | 'low_agreement'
        | 'disagreement' | 'repair_required' | 'truncated'
        | 'low_legibility' | 'implausible_value';
  severity: 'warn' | 'error';
  detail?: string;    // human-readable: "Σ lines = 1,240.00, stated = 1,245.00"
};
```

| Check | Rule |
|---|---|
| **Reconciliation, stage 1** | `Σ lineTotal` vs `subtotal` (falling back to `grandTotal` when `subtotal` is null), tolerance ±0.02 → `math_mismatch` on `subtotal`. |
| **Reconciliation, stage 2** | `subtotal − discountTotal + taxTotal` vs `grandTotal`, same tolerance → `math_mismatch` on `grandTotal`. Nulls in the adjustment band are treated as 0, but *only* if stage 2 then balances; if it doesn't, the null adjustment is itself flagged `missing` — an unexplained delta means we failed to read a row that exists. |
| **Row arithmetic** | `quantity × unitPrice ≈ lineTotal` per row → `row_math_mismatch` on that row. |
| **Missing required** | any `null` in the required set → `missing`. |
| **Illegible source** | field listed in `meta.illegibleFields` → `illegible_source`. |
| **Ambiguous date** | `MM/DD` vs `DD/MM` where both ≤ 12 → `ambiguous_date`. |
| **Implausible** | negative total, qty > 100k, date in the future or before 2000, grand total 100× the line sum → `implausible_value`. Cheap sanity net. |
| **Agreement** | from §5.6. |
| **Repair / truncation** | repair loop fired, or `MAX_TOKENS` hit → global `warn`. |

### 5.9 Confidence + status

Confidence is **computed, never taken from the model**:

```
start at 1.0
  − 0.15 per error flag
  − 0.05 per warn flag
  × meta.legibility        (scanned path only)
  − 0.10 if repair loop fired
clamp 0…1
```

Status:

```
extracted     → 0 flags and all arithmetic checks pass
needs_review  → any warn flag, or an error flag where we still got a usable object
failed        → no valid object after the repair loop and escalation,
                OR ≥3 error flags on required fields (we have an object
                but shouldn't trust it)
```

The degraded scan (#3) is *expected* to land in `needs_review`/`failed` with targeted per‑field flags. **We do not tune the prompt until it goes green** — the brief asks us to flag it rather than silently return wrong data, and doing that honestly is the entire point.

---

## 6. Data model (Drizzle + Supabase Postgres)

Three tables. **Line items normalized, not JSONB** — the brief grades data modeling, and the UI edits rows individually with server‑side arithmetic re‑checks on save.

`apps/api/src/db/schema.ts`:

```ts
export const documents = pgTable('documents', {
  id:          uuid('id').primaryKey().defaultRandom(),
  filename:    text('filename').notNull(),
  mimeType:    text('mime_type').notNull(),
  fileKind:    text('file_kind', { enum: ['pdf_text','pdf_scanned','xlsx'] }).notNull(),
  storagePath: text('storage_path').notNull(),          // Supabase Storage object key
  byteSize:    integer('byte_size').notNull(),
  status:      text('status', { enum: ['pending','processing','extracted','needs_review','failed'] })
                 .notNull().default('pending'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({ statusIdx: index().on(t.status) }));

export const extractions = pgTable('extractions', {
  id:            uuid('id').primaryKey().defaultRandom(),
  documentId:    uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),

  // provenance
  provider:      text('provider').notNull(),            // 'gemini' | 'groq'
  model:         text('model').notNull(),
  escalatedTo:   text('escalated_to'),                  // Pro model, if we escalated
  samples:       integer('samples').notNull().default(1),
  attempts:      integer('attempts').notNull().default(1),
  latencyMs:     integer('latency_ms'),
  tokensIn:      integer('tokens_in'),
  tokensOut:     integer('tokens_out'),
  repairLog:     jsonb('repair_log').$type<RepairStep[]>().notNull().default([]),
  raw:           jsonb('raw'),                          // meta envelope, all samples, failure text

  // verdict
  status:        text('status').notNull(),
  confidence:    numeric('confidence', { precision: 3, scale: 2 }),
  flags:         jsonb('flags').$type<FieldFlag[]>().notNull().default([]),

  // the canonical, human-editable record
  vendorName:    text('vendor_name'),
  invoiceNumber: text('invoice_number'),
  invoiceDate:   date('invoice_date'),
  currency:      char('currency', { length: 3 }),
  subtotal:      numeric('subtotal',       { precision: 14, scale: 2 }),
  discountTotal: numeric('discount_total', { precision: 14, scale: 2 }),
  taxTotal:      numeric('tax_total',      { precision: 14, scale: 2 }),
  grandTotal:    numeric('grand_total',    { precision: 14, scale: 2 }),

  isCurrent:     boolean('is_current').notNull().default(true),
  reviewedAt:    timestamp('reviewed_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const lineItems = pgTable('line_items', {
  id:            uuid('id').primaryKey().defaultRandom(),
  extractionId:  uuid('extraction_id').notNull().references(() => extractions.id, { onDelete: 'cascade' }),
  position:      integer('position').notNull(),
  description:   text('description'),
  quantity:      numeric('quantity',   { precision: 14, scale: 4 }),
  unitPrice:     numeric('unit_price', { precision: 14, scale: 4 }),
  lineTotal:     numeric('line_total', { precision: 14, scale: 2 }),
  flags:         jsonb('flags').$type<FieldFlag[]>().notNull().default([]),
  isEdited:      boolean('is_edited').notNull().default(false),
});
```

**Trade‑offs to write up:**

- **`extractions` holds the editable canonical values** rather than a separate `records` table. One less join, and "the extraction *is* the record, humans just correct it" is the honest mental model. An edit sets `isEdited` and appends to `raw.edits` (field, old, new, timestamp). A dedicated `field_edits` audit table is the more‑time answer.
- **Re‑extraction inserts a new `extractions` row**, sets the previous `isCurrent = false`. Free history, no versioning machinery. Partial index `where is_current` keeps the hot query fast.
- **`provider` column** even though we ship one provider — it costs a column and makes the eval comparison (§2) a query instead of a refactor.
- **`numeric`, never `float`.** It's money.
- **`flags` as JSONB** — display metadata, never queried relationally. Normalizing it would be over‑engineering, and I'd rather say that out loud than build it.
- **`raw` as JSONB** holds the `meta` envelope and all 3 samples. Makes any run reproducible and debuggable after the fact — worth far more than the storage.
- **`isEdited` on line items** so the UI distinguishes human‑corrected from model output. Useful trust signal, one boolean.

**Connection:** postgres.js + `drizzle-orm/postgres-js`, against Supabase's **session pooler / direct connection** (long‑running Express server, not serverless). If using the transaction pooler (`:6543`), set `prepare: false` on postgres.js or prepared statements break. Migrations via `drizzle-kit generate` + `migrate`, SQL committed under `apps/api/drizzle/`.

**Storage:** Supabase Storage bucket `invoices`, private, accessed server‑side with the **service role key** (never shipped to the browser). The UI reaches files through our own `GET /api/documents/:id/file`, which issues a short‑lived signed URL.

---

## 7. API

REST, JSON, under `/api`. No auth (out of scope — stated in README).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/documents` | multipart upload → store → insert → **run pipeline synchronously** → return full record. |
| `GET` | `/api/documents` | list for the table: id, filename, kind, status, vendor, grandTotal, confidence, flagCount, createdAt. |
| `GET` | `/api/documents/:id` | full record: document + current extraction + line items + flags + repair log. |
| `GET` | `/api/documents/:id/file` | 302 to a short‑lived Supabase signed URL (source viewer). |
| `POST` | `/api/documents/:id/reextract` | re‑run pipeline; new `extractions` row, old one `isCurrent=false`. |
| `PATCH` | `/api/extractions/:id` | correct header fields. Re‑runs §5.8 checks server‑side, recomputes flags/status/confidence. |
| `PATCH` | `/api/line-items/:id` | correct a row. Re‑runs checks on the parent extraction. |
| `POST` | `/api/extractions/:id/line-items` | add a row during review. |
| `DELETE` | `/api/line-items/:id` | delete a row. |
| `POST` | `/api/extractions/:id/review` | "Mark reviewed" — human override, sets `reviewedAt`, status → `extracted`. |

**Conventions:**

- Every body/param parsed with a zod schema from `packages/shared`. 400 + the zod error path on failure.
- Errors: `{ error: { code, message, detail? } }`, consistent.
- **Extraction failure is not a 5xx.** It's a `201` with `status: 'failed'` and populated flags — a failed extraction is a legitimate, well‑modeled outcome, not a server error. Only actual bugs and a dead upstream return 5xx. Worth a line in the README.
- **Checks re‑run server‑side on every PATCH.** The client shows live arithmetic for responsiveness, but the server is the authority. Never trust the browser's math on money.
- Upload guard: 10 MB, `application/pdf` + `.xlsx` + `image/png|jpeg` only, magic‑byte check not just extension.

---

## 8. Frontend

Three screens. One job: **make a human fast at fixing bad extractions.**

### 8.1 Upload (`/`)
Drag‑drop or picker. **Plus four "Try a sample" buttons** that upload the committed sample files — makes the reviewer's first 30 seconds work, for ~15 minutes of effort. Inline state: `uploading → extracting… → done`, then navigate to the record.

### 8.2 List (`/records`)
Table: filename · kind badge (`PDF` / `Scanned` / `Excel`) · **status pill** (green `extracted`, amber `needs review`, red `failed`) · vendor · grand total · confidence bar · flag count · date. Amber/red sorted first — the point of a review queue is surfacing what needs a human.

### 8.3 Record detail (`/records/:id`) — the screen that matters

**Two panes.**

- **Left — the source.** PDF in an `<iframe>` (works for both text and scanned PDFs — no separate image path needed); xlsx re‑rendered as an HTML table. The reviewer verifies against ground truth without leaving the app. Highest‑value UI decision in the build.
- **Right — the extracted record, editable.**
  - Status banner: pill + confidence + "3 fields need attention".
  - Header fields (vendor, number, date, currency) as inputs.
  - Line items as an editable grid: edit cells, add row, delete row.
  - Below the grid, the **totals band** — subtotal, discount, tax, grand total — as inputs, laid out the way an invoice lays them out, so the reviewer's eye maps straight from the source pane.
  - **Every flagged field carries an amber/red ring and a chip explaining *why*, in plain language:**
    - *"Doesn't add up: line items total ₹1,240.00 but the invoice states ₹1,245.00"*
    - *"The 3 extraction passes disagreed here (₹450 / ₹480 / ₹450)"*
    - *"The model reported this region of the scan as unreadable rather than guessing"*
    - *"Ambiguous date: 03/04/2025 could be 3 Apr or 4 Mar"*
  - **Live arithmetic strip** under the totals band, mirroring the two‑stage check: `Σ lines 1,240.00 → subtotal 1,240.00 ✓ · −disc 40.00 +tax 223.20 → total 1,423.20 ✓`, recomputed as you type, with the failing stage marked. Server re‑validates on save.
  - **"Show extraction log"** disclosure: provider, model, escalation, sample count, attempts, repair steps, tokens, latency. Small, but it's the receipts for grading criterion #2.
  - Actions: **Save** · **Mark reviewed** (human takes responsibility, clears soft flags) · **Re‑extract**.

### 8.4 States
TanStack Query for cache + invalidation after mutations. Loading skeletons, error toasts, empty state. Tailwind only; headless‑ui if a tooltip/dialog is needed. "Clean and usable," then stop.

---

## 9. The 4 sample files

Generated by committed scripts in `samples/generate/` — reproducible, and the generator code itself demonstrates judgment about *what makes documents hard*. All vendors fictional.

| # | File | Format | Deliberate difficulty | Expected outcome |
|---|---|---|---|---|
| 1 | `acme-supplies.pdf` | PDF, text layer | Clean baseline. `Invoice #`, headed table, total bottom‑right, USD. | `extracted`, confidence > 0.9 |
| 2 | `northwind-trading.pdf` | PDF, text layer | **Label variance + number format**: vendor only in a logo block, `Bill No.` not "Invoice Number", date `14‑Mar‑2025`, Indian grouping `Rs. 1,23,456.00`, and a **discount row + GST row** between line items and total (so naive `Σ lines == total` fails *legitimately* — this sample exists to prove the two‑stage reconciliation works). | `extracted`, both reconciliation stages balancing — **no false‑positive flag** |
| 3 | `blue-ridge-scan.pdf` | **Scanned image PDF** | See §9.1 — targeted degradation. | `needs_review` / `failed`, flags on *specific* fields |
| 4 | `zenith-parts.xlsx` | Excel | Data doesn't start at A1 (3 title rows, merged cells), line items split across **two blocks** with a subtotal between, `TOTAL DUE` four rows below the table, **qty and unit‑price columns swapped** relative to the other invoices, one `lineTotal` cell left blank. | `needs_review` — blank line total flagged `missing`; row arithmetic can actually recover it |

### 9.1 Sample #3 — the degradation spec

Goal: *barely human‑readable, with specific values genuinely hard for the model.* So degradation is **targeted, not uniform** — a uniformly mushy page produces a uniformly useless result, which proves nothing. Most of the document stays readable and **three specific values become genuinely ambiguous**, so the flags land precisely and provably.

Build: render a clean invoice with `pdfkit` → rasterize → degrade with `sharp` → re‑wrap as a single‑page PDF **with no text layer**.

**Global degradation (makes it a hard scan):**
- Rotate **−1.8°** with off‑white fill (skew, like a hand‑fed scanner) — *directly violates Google's "rotate pages to the correct orientation" guidance, on purpose*
- Gaussian blur **σ ≈ 0.9** — violates "avoid blurry pages", also on purpose
- Gaussian noise **σ ≈ 12/255**
- Contrast crush: black→`#3a3a3a`, white→`#dcdcd6` (faded photocopy)
- Vertical gradient darkening down the page (uneven scan lamp)
- Re‑encode at **JPEG quality 35** → ringing artifacts around glyphs
- Downscale to ~110 DPI then upscale to 180 — throws away real detail

**Targeted difficulty (what makes the flags meaningful):**
1. **Coffee‑ring stain** (semi‑transparent brown radial PNG) over the **grand total's** middle digits → genuinely partially occluded. Expect `illegible_source` + `math_mismatch`.
2. **Digit ambiguity in the invoice date** — glyphs chosen to blur into each other: `08/03/2025` where the `8` degrades toward `3`/`6`. Expect `disagreement` across the 3 samples.
3. **One line item's unit price** in the darkest gradient band with extra local blur → expect `null` or 3‑way disagreement, which breaks that row's arithmetic → `row_math_mismatch`.
4. Vendor name and invoice number left **relatively legible** — so the extraction is partially useful and the contrast between "confident here / uncertain there" is visible on screen. A document where everything fails is a far less interesting demo than one where the system draws a precise line.

**Calibration rule while building:** if it extracts perfectly, degrade further. If it returns nothing, back off. Target **~60–70% of fields recovered, the three planted values flagged.** Tune the **generator**, never the prompt — tuning a prompt to pass a test you wrote is exactly the self‑deception this brief is screening for. Gemini's OCR is strong, so expect to push the degradation harder than feels reasonable.

### 9.2 `samples/output/`
Committed extraction JSON for all four — the full API record including flags, confidence, status, repair log. Doubles as the fixture set for the eval script.

---

## 10. Improvements beyond the brief

Ordered by value‑per‑hour. **Bold** items are in the plan; the rest are stretch.

1. **`meta.illegibleFields` envelope** (§5.2) — the model reports what it couldn't read instead of guessing. Core idea. Do it.
2. **Self‑consistency sampling as the confidence signal** (§5.6). Do it.
3. **Two‑stage arithmetic reconciliation** over an explicit subtotal/discount/tax band (§5.1, §5.8) — strongest hallucination catch, zero model cost, and it doesn't cry wolf on invoices that legitimately have tax. Do it.
4. **Side‑by‑side source vs. form review** (§8.3) — biggest usability win. Do it.
5. **Flash→Pro escalation on low confidence** (§5.7) — ~20 lines, real production pattern. Do it.
6. **Repair log surfaced in the UI** — receipts for criterion #2. Do it, it's small.
7. **"Try a sample" buttons** — makes the reviewer's first 30 seconds work. Do it.
8. **`currency` field** — one extra field, real value. Do it.
9. **Minimal eval harness**: `npm run eval` runs all 4 samples, diffs against `samples/output/`, prints field‑level accuracy + flag precision. Even 40 lines signals "I think in evals," which the job description explicitly asks for. Do a small one.
10. **Second provider behind the interface + comparison table in the README** (§2) — strong differentiator, only after everything works. *Stretch.*
11. Span grounding — model returns the source region per field, highlight on hover. *Stretch.*
12. Vendor memory — once a vendor is corrected, few‑shot the next invoice from that vendor with the corrected prior. *Stretch, but great to describe in the README.*

**Explicitly not doing:** job queue, SSE/websocket progress, auth, deployment, multi‑user, PDF form fields, table‑structure ML, exhaustive locale handling, Files API for large documents.

---

## 11. What I'd do with more time (README draft)

- **Async extraction**: BullMQ/Redis or Supabase pg‑cron + worker, status polling in the UI. Right answer at any real volume; skipped deliberately at n=4.
- **Proper audit trail**: `field_edits` table (who/when/before/after) + diff view. Corrections are training data.
- **A dedicated OCR stage** for scans (Document AI / Textract / PaddleOCR) with **word‑level confidence scores**, feeding the LLM higher‑quality text plus a per‑token certainty signal. Gemini's OCR is strong but returns no per‑character confidence — a real OCR engine does, and that's a strictly better uncertainty signal than anything we're computing.
- **Calibrate confidence** against a few hundred labeled invoices instead of 4 — current weights are reasoned, not fitted.
- **Vendor templates**: cluster by vendor, learn field locations, fall back to the LLM only on novel layouts. Cheaper and more accurate at volume.
- **Span grounding + click‑to‑highlight** on the source.
- **Tests**: pipeline units against recorded LLM fixtures (no live calls in CI), API integration tests, 2–3 Playwright flows over the review screen.
- **Observability**: every LLM call logged (prompt, response, tokens, latency, cost) to a table; a small cost/accuracy dashboard.

---

## 12. Known limitations (README draft)

- Extraction is **synchronous**; a slow file blocks the request. Fine at this scale, wrong in production.
- **Confidence is heuristic**, not calibrated — the weights in §5.9 are reasoned, not fitted to data.
- **Self‑consistency detects instability, not correctness.** Three runs can agree and all be wrong. Agreement is necessary, not sufficient.
- **`responseSchema` guarantees shape, not truth.** Schema‑valid and semantically wrong is the failure mode that actually hurts, and only the deterministic checks catch it.
- **Scanned quality depends entirely on the vision model.** No dedicated OCR fallback, and no per‑character confidence to lean on — a page Gemini can't read is a page we can't read.
- **`MM/DD` vs `DD/MM`** is guessed and flagged, not resolved. It *cannot* be resolved from a single document without vendor context.
- **Single‑currency assumption** in the arithmetic check; mixed‑currency invoices flagged, not handled.
- **Long invoices** can hit `MAX_TOKENS` mid‑JSON; we detect, repair, and escalate, but very long documents remain a real limit.
- Free‑tier **rate limits** cap throughput; 3 samples per document multiplies request count 3×.
- **No auth** — anyone with the URL reads and edits everything.

---

## 13. Build order (the 4–6 hours)

| # | Time | Deliverable |
|---|---|---|
| 0 | 25m | Workspaces scaffold · shared zod schema + `responseSchema` conversion · Supabase project + bucket · Drizzle schema + first migration · env wiring · **verify Gemini model IDs, and that `responseSchema` + PDF input compose in one call**. |
| 1 | 50m | Sample generators → 4 files in `samples/input/`. Most of this is #3's degradation calibration. |
| 2 | 20m | Classify + prepare: pdfjs classification, SheetJS→markdown. CLI: `npm run prepare <file>`. |
| 3 | 60m | Provider interface + Gemini impl + prompt + `responseSchema` call + local repair + zod validate + repair loop + escalation. CLI: `npm run extract <file>` prints the record. |
| 4 | 35m | Self‑consistency + deterministic checks + confidence/status. Pure functions, a few unit tests. |
| 5 | 45m | API: upload → storage → pipeline → persist; list; get; file; re‑extract. |
| 6 | 25m | PATCH endpoints + server‑side re‑check on save + mark‑reviewed. |
| 7 | 75m | Frontend: upload (+ sample buttons), list, two‑pane detail with flag chips, editable grid, live arithmetic, extraction log. |
| 8 | 25m | Run all 4, commit `samples/output/`, minimal eval script. |
| 9 | 35m | README (setup, architecture, trade‑offs, limitations). |

*(~6h05 at full scope; the Gemini choice already bought back the ~40 min a rasterization stage would have cost.)*

**If time runs short, cut in this order:** second provider → eval script → re‑extract button → source viewer (fall back to a download link) → escalation → self‑consistency (drop to 1 sample).

**Do not cut, at any cost:** the repair loop, the arithmetic checks, `meta.illegibleFields` propagation, flag chips with plain‑language reasons, and the scan honestly landing in `needs_review`. That list *is* the submission.

---

## 14. Remaining decisions

1. **"Anything you want us to know"** — use it to name the non‑obvious calls: *(a) the model reports which fields it couldn't read rather than guessing, and that propagates all the way to a flag in the UI; (b) confidence is computed from cross‑sample disagreement and arithmetic reconciliation, never taken from the model's self‑report; (c) the scanned sample is deliberately adversarial and is supposed to land in `needs_review` — that's the feature, not a miss.*
2. **Gemini model IDs** — pinned in env, verified in step 0. If `gemini-3.7-flash` isn't available on your key, `gemini-3.6-flash` is the drop‑in; note the swap in the README.
3. **Rate limits** — if the free tier throttles during development, drop `EXTRACTION_SAMPLES` to 1 while building and turn it back to 3 for the final sample run that generates `samples/output/`.
