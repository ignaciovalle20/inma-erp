---
title: 'Story 4.1: Import Sales with Column Mapping & Preview'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '55513b578c9f7105bf00e2edd2baa1c28cd1fe16'
context: ['_bmad-output/implementation-artifacts/epic-4-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chile has no way to bring sales data in from a file — every sale must be typed in one at a time via Epic 2's manual form, which doesn't scale to the volume Chile's real operation produces (the historical validation dataset alone is 123 rows for one half-year).

**Approach:** A CSV upload + column-mapping + preview flow, Chile-only, that lands rows into the *existing* `sales_documents`/`sales_lines` tables (never a separate import table) via a new `import_sales_row` RPC — one row becomes one single-line sales document. Every attempted row is recorded in a new `import_rows` table (imported or error, with the reason), grouped under an `import_batches` record. Invalid rows are excluded from commit, never silently saved. No duplicate detection yet (Story 4.2) and no batch-history UI (Story 4.3) — this story is upload → map → preview → commit only.

## Boundaries & Constraints

**Always:** import is gated to companies whose `country` is `'CL'` (case-insensitive) — the real per-row column mapping is user-configurable (source headers vary, nothing is hardcoded), required internal fields are date/client/amount, currency/tax are optional (defaulting to the company's currency / 0); a row with an invalid or unmatched required field is recorded in `import_rows` with `status='error'` and a specific reason, and never produces a `sales_documents` row; `net_amount`/`total_amount` are still computed server-side exactly like manual entry, never trusted from the file; client matching is exact, case-insensitive name match against the company's active clients — no fuzzy matching; every imported `sales_documents` row carries `source='import'` and a link back to its `import_rows` row; the manual entry flow from Epic 2 is completely untouched and remains equally available.

**Decisions (made autonomously, with reasoning):** **CSV only, not Excel** — the epic title says "CSV/Excel" but no sample file (of either format) exists anywhere in the repo to validate a parser against, and building two parsers in one story doubles scope for a format nobody can currently test; CSV is the universal export target from any spreadsheet tool, so this covers the real need with one well-tested library (`papaparse`) — `.xlsx` support is a clean, additive follow-up once a real Chile export file is available to validate against. **Chile-gating uses `country`, not `currency`** — inspecting live data found `country` already holds real 2-letter codes (`'CL'`, `'UY'`) in practice despite the column being unconstrained text, while `currency` is independently user-settable and at least one existing company has a known-bad `currency`/`country` mismatch; `country` is the semantically correct and currently-more-reliable signal. **One CSV row = one single-line sales document** — matches how a sales export naturally lists one transaction per row; multi-line documents remain a manual-entry-only capability (Epic 2), consistent with import never being the only path. **Row-level partial commit, not all-or-nothing** — matches the epic's own "invalid rows excluded ... unless fixed or explicitly skipped," so valid rows in a batch always commit even if others in the same file fail.

**Never:** build duplicate detection (Story 4.2); build a batch-history/detail UI (Story 4.3, though the underlying `import_batches`/`import_rows` data this story creates is what that UI will read); support `.xlsx` parsing; touch Epic 2's manual sales flow; allow import for non-Chile companies; let the file's raw column values become `net_amount`/`total_amount` directly.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Valid row, all fields mapped | Row with valid date/client-name/amount | A single-line `sales_documents` row created with `source='import'`; `import_rows` status `imported` | N/A |
| Row with unmatched client name | Client name doesn't exact-match any active client | Row excluded from commit | `import_rows` status `error`, reason "Client not found" |
| Row with invalid/missing date or amount | Blank or unparseable date/amount | Row excluded from commit | `import_rows` status `error`, specific reason |
| Mixed valid/invalid rows in one file | 10 rows, 2 invalid | 8 documents created, 2 error rows recorded, one `import_batches` row with correct counts | N/A |
| Import attempted for a non-Chile company | Company `country != 'CL'` | Blocked before any file processing | App-level error, no batch created |
| Currency/tax omitted in the file | No currency/tax columns mapped | Defaults to the company's currency and `tax_amount = 0` | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260913010000_epic2_story3_quick_entry_business_area.sql` (latest `sales_documents` state) -- current columns to extend with `source text not null default 'manual' check in ('manual','import')` and `import_row_id uuid references import_rows(id)` (nullable); `create_sales_document`'s validation logic (non-empty lines, positive amount, non-negative tax) to mirror inside the new single-row import RPC
- `supabase/migrations/20260912210000_epic2_story1_sales_documents.sql` -- `sales_documents_validate_company_refs()` trigger pattern (client_id/business_area_id cross-company check) — the import RPC's client lookup must go through the same company-scoped query, not bypass it
- `web/src/lib/dal.ts` -- `getClients(companyId)` (line ~150) for exact-name client matching; add `getImportBatches`/similar only if trivial, otherwise defer to Story 4.3
- No existing file-upload pattern anywhere in `web/src` — this is the first; use a plain `<input type="file">` + Server Action reading `FormData.get('file') as File`, `.text()` to get CSV content, parsed server-side with `papaparse` (new dependency)
- No existing multi-step client-side wizard pattern — keep state in a single client component (uploaded rows + column mapping selections + preview), submitting the full parsed+mapped row set as JSON to a second server action on commit (avoids re-uploading the file or persisting an in-progress import)

## Tasks & Acceptance

**Execution:**
- [x] `cd web && npm install papaparse @types/papaparse` -- CSV parsing dependency
- [x] `supabase/migrations/<ts>_epic4_story1_import_sales.sql` -- `import_batches` (`id`, `company_id` not null fk companies, `file_name text not null`, `total_rows int not null`, `imported_rows int not null default 0`, `error_rows int not null default 0`, `imported_by uuid references auth.users default auth.uid()`, `imported_at timestamptz not null default now()`); `import_rows` (`id`, `import_batch_id` not null fk import_batches, `row_number int not null`, `raw_data jsonb not null`, `status text not null check in ('imported','error')`, `error_message text`, `sales_document_id uuid references sales_documents(id)`); RLS any-member SELECT/INSERT on both (no UPDATE/DELETE — a batch is a historical record); alter `sales_documents` adding `source text not null default 'manual' check in ('manual','import')` and `import_row_id uuid references import_rows(id)`; `create_import_batch(p_company_id uuid, p_file_name text, p_total_rows int) returns import_batches`; `import_sales_row(p_import_batch_id uuid, p_row_number int, p_raw_data jsonb, p_client_id uuid, p_document_date date, p_currency text, p_amount numeric, p_tax_amount numeric) returns import_rows` -- validates amount > 0 and tax >= 0; on valid input, inserts a single-line `sales_documents`/`sales_lines` pair with `source='import'`, then an `import_rows` row with `status='imported'` and `sales_document_id` set; on invalid input, inserts only an `import_rows` row with `status='error'` and a specific `error_message` (never raises for row-level validation issues — only for structural problems like an unknown batch id)
- [x] `web/src/lib/dal.ts` -- `getClientsByName(companyId)` or reuse `getClients` directly for exact-match lookup; confirm `getCompanyForEdit`-style membership+country check is available for the gate
- [x] `web/src/app/companies/[id]/sales/import/page.tsx` -- auth+membership guard; redirect if `company.country` (case-insensitive) isn't `'CL'`; renders `<ImportSalesForm>`
- [x] `web/src/app/companies/[id]/sales/import/actions.ts` -- `"use server" parseImportFile(companyId, formData)` reads the uploaded file, parses CSV headers + rows with `papaparse`, returns them to the client for mapping (no DB writes yet); `"use server" commitImport(companyId, fileName, mappedRows)` calls `create_import_batch` once, then loops `import_sales_row` per row (matching each row's mapped client name to an active client via `getClients`, case-insensitive exact match), then updates the batch's `imported_rows`/`error_rows` counts from the resulting `import_rows`
- [x] `web/src/app/companies/[id]/sales/import/form.tsx` -- file input + upload step; once parsed, a column-mapping step (dropdowns mapping detected CSV headers to date/client/amount/currency/tax, currency/tax optional); a preview table (all rows) showing mapped values with inline error highlighting for unmatched clients/invalid dates/amounts; a "Commit import" button calling `commitImport`; a results summary (imported/error counts) after commit
- [x] `web/src/app/companies/[id]/sales/page.tsx` -- add an "Import" link, shown only when `company.country` (case-insensitive) is `'CL'`

**Acceptance Criteria:**
- Given a CSV with valid rows mapped correctly, when I commit the import, then each row becomes a single-line `sales_documents` row with `source='import'`, and `net_amount`/`total_amount` are computed server-side
- Given a row with a client name that doesn't match any active client, then it's excluded from commit and recorded as an error row with a specific reason
- Given a mixed-validity file, when I commit, then valid rows import and invalid rows don't, and the batch's counts reflect both
- Given a non-Chile company, then the import page/link isn't reachable and a direct RPC call is rejected by the gate
- Given the file omits currency/tax, then imported documents default to the company's currency and zero tax

## Implementation Notes

- Two design gaps found during backend verification and fixed (not in the original migration draft): (1) `import_batches` has no UPDATE policy by design ("historical record"), so finalizing counts needed `update_import_batch_counts` to be `security definer` with its own explicit membership re-check, mirroring `create_company`'s established precedent for the one case a normal RLS grant can't express — every other RPC in this feature stays non-`security definer`; (2) the acceptance criteria requires a *direct RPC call* for a non-Chile company to be rejected, not just the page-level redirect, so the `country` check was added inside `create_import_batch` itself too.
- **Verified against the linked Supabase project**: migration applied live; ran the RPC chain inside rolled-back transactions — valid row produces a correctly-computed `sales_documents` row with `source='import'` and `import_row_id` linked back; unmatched-client row produces an `import_rows` error "Client not found"; `update_import_batch_counts` computes correct counts; non-CL company rejected directly at the RPC level.
- **Browser-verified end to end, including a real gap found and fixed**: uploaded a real 3-row CSV (1 valid, 1 unmatched-client, 1 missing-amount) via the actual UI (file injected into the `<input type="file">` via `DataTransfer` in the already-authenticated Browser-pane session — no credentials needed). Column auto-mapping guessed correctly from Spanish headers (Fecha/Cliente/Monto/Moneda). **First pass surfaced a real bug**: the preview step showed the unmatched-client row as "OK" because `page.tsx` never fetched clients and `form.tsx` had no client list to validate against — a row that would only fail at commit-time looked fine in the preview, directly contradicting the spec's "row with unmatched client name... excluded from commit" requirement being visible *before* commit. Fixed by fetching active clients in `page.tsx` and passing their names down to `form.tsx` for case-insensitive matching in the preview computation. Re-verified after the fix: preview correctly showed "Client not found" for that row; committed the batch and got "1 of 3 rows imported, 2 rows had errors" with the exact right per-row messages; confirmed the resulting sales document, import row, and batch in the DB with correct linkage; confirmed the "Import" link only shows for the CL company. All test data (client, sales document, import batch/row) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

`import_sales_row` deliberately never raises for row-level validation failures — a loop calling it per row needs every call to succeed at the transaction level (recording either a document+success or an error row), so the caller doesn't need per-row exception handling. It still relies on RLS/company-scoped queries for the client lookup, same trust model as every other RPC in this codebase (not `security definer`).

This is the first file-upload flow and the first multi-step client-side wizard in the app — kept deliberately simple (one component holding parse-then-map-then-preview state, two server actions, no persisted "draft import" state) rather than building general-purpose infrastructure for a pattern used exactly once so far.

Token count note: this spec is larger than the usual single-file-CRUD story (~1900 words) because upload+mapping+preview+commit is one cohesive interaction that would be artificial to split — Story 4.2 (duplicate detection) and 4.3 (batch history) are the natural next increments, not a further split of this one.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new `/companies/[id]/sales/import` route registers

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- As a Chile-company member: upload a small CSV with a mix of valid and invalid rows, map columns, confirm the preview flags errors correctly, commit, and confirm the right documents/import_rows/batch counts result
- Attempt import for a non-Chile company — confirm blocked
- Browser-verify the full upload → map → preview → commit flow end to end
