---
title: 'Story 4.3: Import Batch History & Traceability'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'a377ec5ab3ef523cf9420248f1c8652f473e734e'
context: ['_bmad-output/implementation-artifacts/epic-4-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 4.1/4.2 record every import batch and row outcome (`import_batches`/`import_rows`), and tag each resulting document with `source`/`import_row_id`, but none of it is visible anywhere in the UI — a user can't see past imports or trace a document back to the file/row that created it.

**Approach:** Read-only additions only: an "Import history" list page (file name, date, imported-by, row counts), a per-batch detail page (every row's outcome), and a provenance line on the sales document edit page when `source='import'`, linking back to its batch/row. No new writes, no new RLS — both tables already have member-scoped SELECT policies.

## Boundaries & Constraints

**Always:** the batch list and detail views are read-only — no edit/delete/re-run actions; the provenance line only appears when `document.source === 'import'`; batch/row data displayed is scoped by the existing RLS (any company member can view), no new access rules needed.

**Decisions (made autonomously, with reasoning):** "imported by" shows "You" when `imported_by` matches the current session's user id, otherwise a generic "Another team member" — no existing infrastructure anywhere in this codebase resolves `created_by`/`updated_by`/`imported_by` to a friendly name or email (confirmed: zero joins to `auth.users` exist in `dal.ts`), so adding one just for this story would be new infrastructure inconsistent with how every other audit field in the app is already (not) displayed. The "Import history" link is shown whenever the company has `country = 'CL'` (same gate as the "Import" link itself, for consistent visibility) rather than only when batches exist — an empty history list is a normal, harmless state.

**Never:** add a `profiles`/user-display-name table or any `auth.users` join (out of scope, inconsistent with existing precedent); build any re-run/retry-failed-rows action (not requested, read-only story); change `import_batches`/`import_rows`/`sales_documents` schema (nothing new to store — this story only reads).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| View batch list, no imports yet | Company with zero `import_batches` rows | Empty-state message, no crash | N/A |
| View batch list, several imports | Multiple `import_batches` rows | Listed newest-first with file name, date, "You"/"Another team member", counts | N/A |
| View batch detail | A batch with a mix of imported/error/duplicate rows | Every row shown with its status and message; imported rows link to their `sales_documents` | N/A |
| View an imported sales document's edit page | `source='import'` | Shows a provenance line linking to its batch and row number | N/A |
| View a manually-created sales document's edit page | `source='manual'` | No provenance line shown | N/A |

</frozen-after-approval>

## Code Map

- `web/src/lib/dal.ts` -- `getSalesDocuments`/`getCostDocuments` list-fetch pattern (createClient → auth check → `.eq("company_id", companyId).order(...)`, `[]`/`null` on no-session) to mirror for `getImportBatches(companyId)` and `getImportBatchDetail(companyId, batchId)`; `getSalesDocumentForEdit` (currently selects `id, company_id, client_id, document_type, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, voided, voided_at` + lines) needs `source`, `import_row_id` added to its select, plus the `SalesDocument`/`SalesDocumentWithLines` types extended
- `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/page.tsx` -- insertion point for the provenance line, between the company-name line and the voided/form conditional
- `web/src/app/companies/[id]/sales/page.tsx` -- action-links row (Quick entry/Import/New sales document) to add an "Import history" link next to "Import"
- `supabase/migrations/20260913050000_epic4_story1_import_sales.sql`, `.../20260913060000_epic4_story2_duplicate_detection.sql` -- confirmed RLS already permits member SELECT on both `import_batches`/`import_rows` — no migration needed for this story

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/dal.ts` -- `getImportBatches(companyId)` (id, file_name, total_rows, imported_rows, error_rows, duplicate_rows, imported_by, imported_at, ordered newest-first); `getImportBatchDetail(companyId, batchId)` (batch header + its `import_rows`, ordered by row_number); extend `getSalesDocumentForEdit`'s select and type with `source`/`import_row_id`; add `getImportRowBatchInfo(importRowId)` (returns `{import_batch_id, row_number}`) for the provenance link on the edit page
- [x] `web/src/app/companies/[id]/sales/import-history/page.tsx` -- list page: file name, date, "You"/"Another team member" (compare `imported_by` to the session user id), imported/error/duplicate counts, link to each batch's detail
- [x] `web/src/app/companies/[id]/sales/import-history/[batchId]/page.tsx` -- detail page: batch summary header, table of every row (row number, status badge, error/duplicate message, link to the resulting sales document when one exists)
- [x] `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/page.tsx` -- provenance line when `document.source === 'import'`: "Imported from {file_name}, row {row_number}" linking to `/companies/[id]/sales/import-history/[batchId]`
- [x] `web/src/app/companies/[id]/sales/page.tsx` -- "Import history" link next to "Import", same `country === 'CL'` gate

**Acceptance Criteria:**
- Given a company with past imports, when I open Import history, then I see every batch with correct file name/date/counts, newest first
- Given I open a batch's detail, then every row's outcome (imported/error/duplicate) and message is shown, and imported rows link to their sales document
- Given I open an imported sales document's edit page, then I see a line identifying its source batch/row, linking back to the batch detail
- Given I open a manually-created sales document's edit page, then no provenance line appears

## Implementation Notes

- `getImportRowBatchInfo` returns `{import_batch_id, row_number, file_name}` — the extra `file_name` (joined from `import_batches`) beyond the Code Map's literal signature was needed to satisfy the exact provenance-line wording ("Imported from {file_name}, row {row_number}") without a second round trip.
- **Browser-verified end to end**: created a client, imported a 2-row CSV (1 valid, 1 unmatched-client), confirmed "1 of 2 rows imported... 1 row had errors". Opened Import history: batch listed with correct file name, timestamp, "You", and exact counts (1 imported/1 error/0 duplicates). Opened the batch detail: row 1 showed "Imported" with a working link to its sales document, row 2 showed "Error / Client not found". Followed the link to the sales document's edit page and confirmed the provenance line "Imported from history_test.csv, row 1 · View batch" renders and links back correctly. Confirmed the "Import history" link appears on the sales list next to "Import". All test data (client, sales document, import batch/rows) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

No new RPC or migration — every table this story reads already has member-scoped SELECT RLS from Stories 4.1/4.2. This is the first purely read-only, additive-UI story in the epic.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new routes register

**Manual checks:**
- Browser-verify: import a small CSV, open Import history, open its detail, confirm row outcomes match what the import actually did; open the resulting sales document's edit page and confirm the provenance line links back correctly
