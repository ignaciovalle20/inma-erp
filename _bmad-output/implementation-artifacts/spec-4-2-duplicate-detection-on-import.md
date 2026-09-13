---
title: 'Story 4.2: Duplicate Detection on Import'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'c45bc6718d049d8ba7d34c3315a0bdb5714dca8b'
context: ['_bmad-output/implementation-artifacts/epic-4-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 4.1's import commits every valid row unconditionally — re-importing the same file, or importing a row that was already entered manually, silently creates a second `sales_documents` row for the same real-world sale, double-counting revenue.

**Approach:** Extend the existing preview to flag a row as a likely duplicate when an existing non-voided `sales_documents` row (manual or previously imported) already matches on `client_id` + `document_date` + `total_amount`. Flagged rows default to skip; the user can explicitly check "Force import" per row to keep both. The authoritative check happens server-side inside `import_sales_row` (never trust the client-side flag alone) — a skipped duplicate becomes an `import_rows` row with `status='duplicate'` (no `sales_documents` row created); a forced one creates the document with `duplicate_override=true` and `duplicate_of_sales_document_id` set, so both records stay linked for traceability.

## Boundaries & Constraints

**Always:** the match key is `client_id` + `document_date` + `total_amount` (net + tax, matching what the epic calls "key fields: date, client, amount") against **all** non-voided `sales_documents` for the company, regardless of `source` — revenue must never double-count between manual and imported entries, not just between two imports; duplicate detection is re-verified inside `import_sales_row` itself even though the preview shows a client-side heuristic first — a client-side flag is a hint, never the enforcement point; a flagged duplicate is never auto-skipped or auto-forced — it's always the explicit per-row human choice shown in the preview, defaulting to skip (the safer default: nothing is silently duplicated); a forced duplicate always keeps both records — never merges, never deletes the original.

**Decisions (made autonomously, with reasoning):** duplicate skip is recorded as its own `import_rows.status = 'duplicate'` (not `'error'`) — the epic's own row-count language ("imported/error/duplicate") treats these as distinct outcomes, and a skipped duplicate isn't a data problem the way an invalid row is. No "resolve an already-committed duplicate later" workflow — the epic's wording ("flagged... choice to skip or force-import") describes an import-time decision only; adding a post-hoc reconciliation UI would be new unrequested scope with no story asking for it.

**Never:** auto-merge or auto-delete either side of a duplicate pair; change the matching key to use anything beyond client/date/amount (no external-identifier concept exists anywhere in this schema); build Story 4.3's batch-history UI (out of scope, though this story's new `duplicate_rows` count is what it will display); touch Story 4.1's non-duplicate validation logic (missing client, invalid date/amount stay exactly as they are).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Row matches an existing manual sale | Same client/date/total as a `source='manual'` document | Flagged as a likely duplicate in preview; skipped by default at commit | `import_rows` status `duplicate`, no `sales_documents` row |
| Row matches a previously imported sale | Same client/date/total as a `source='import'` document | Same as above — source doesn't matter | Same |
| User forces a flagged duplicate | "Force import" checked for that row | Document created; `duplicate_override=true`, `duplicate_of_sales_document_id` set to the match | N/A |
| Preview says "not a duplicate" but a match appears before commit | Race: another row/session created a match between preview and commit | RPC's own server-side check still catches it — same skip/force behavior applies, not silently bypassed | N/A |
| No match on any key field | Distinct client/date/amount | Imports normally, exactly as Story 4.1 | N/A |

</frozen-after-approval>

## Code Map

- `web/src/app/companies/[id]/sales/import/form.tsx` -- `previewRows` useMemo (lines ~99-131) to extend with a duplicate check against a new `existingDocuments` prop; `activeClientNames: string[]` prop needs to become `activeClients: {id, name}[]` so preview rows can resolve `client_id` locally (needed to match against `existingDocuments`, not just for the "client not found" check)
- `web/src/app/companies/[id]/sales/import/actions.ts` -- `commitImport`'s per-row loop and its `import_sales_row` RPC call to extend with a new `p_force` argument, sourced from a new per-row forced-row-numbers input
- `supabase/migrations/20260913050000_epic4_story1_import_sales.sql` -- `import_sales_row`'s exact current body to extend with the server-side duplicate lookup + `p_force` handling; `import_rows.status` check constraint to extend with `'duplicate'`; `import_batches` to gain `duplicate_rows`; `update_import_batch_counts` to count the new status
- `web/src/app/companies/[id]/sales/import/page.tsx` -- currently fetches `getClients`; add a lean non-voided `sales_documents` fetch (`client_id, document_date, total_amount`) for the new `existingDocuments` prop

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic4_story2_duplicate_detection.sql` -- alter `import_rows.status` check to `in ('imported','error','duplicate')`; add `import_batches.duplicate_rows int not null default 0`; add `sales_documents.duplicate_override boolean not null default false` and `sales_documents.duplicate_of_sales_document_id uuid references sales_documents(id)`; extend `import_sales_row` to accept `p_force boolean default false`, look up a non-voided `sales_documents` match on `company_id`+`client_id`+`document_date`+`total_amount` (computed from the same net+tax the function already calculates) before inserting -- if a match exists and `p_force` is false, insert only an `import_rows` row with `status='duplicate'` and a message naming the matched document, and return without creating a `sales_documents` row; if a match exists and `p_force` is true, insert the document as usual but set `duplicate_override=true` and `duplicate_of_sales_document_id`; extend `update_import_batch_counts` to also compute and set `duplicate_rows`
- [x] `web/src/app/companies/[id]/sales/import/page.tsx` -- fetch active clients as `{id, name}` pairs (was names only) and a lean list of the company's non-voided `sales_documents` (`client_id, document_date, total_amount`); pass both down to the form
- [x] `web/src/app/companies/[id]/sales/import/form.tsx` -- resolve each preview row's `client_id` from the client list; if resolved, check for a match in `existingDocuments` on `client_id`+date+total (rounded to 2 decimals); when matched, show a "Possible duplicate" badge and a "Force import" checkbox (default unchecked) instead of blocking the row; track forced row numbers in state
- [x] `web/src/app/companies/[id]/sales/import/actions.ts` -- `commitImport` gains a `forcedRowNumbers: number[]` parameter; passes `p_force: forcedRowNumbers.includes(rowNumber)` to `import_sales_row`; result summary includes `duplicateRows` alongside existing counts

**Acceptance Criteria:**
- Given a row matches an existing manual sale on client/date/total, when I preview it, then it's flagged as a likely duplicate, and when I commit without forcing it, then no new `sales_documents` row is created and the batch's `duplicate_rows` count reflects it
- Given I check "Force import" on a flagged duplicate row, when I commit, then a new document is created with `duplicate_override=true` and `duplicate_of_sales_document_id` pointing at the match
- Given a row matches a previously *imported* sale (not manual), then it's flagged the same way — source doesn't exempt it
- Given no existing row matches, then the row imports exactly as it did before this story

## Implementation Notes

- Migration `20260913060000_epic4_story2_duplicate_detection.sql` adds `import_rows.status = 'duplicate'`, `import_batches.duplicate_rows`, `sales_documents.duplicate_override` / `duplicate_of_sales_document_id`, and replaces `import_sales_row` with a 9-arg version (`p_force boolean default false`) that does the server-side match lookup before insert; the old 8-arg overload is dropped so callers can't accidentally skip the new parameter. `update_import_batch_counts` now also computes `duplicate_rows`.
- Match is `company_id + client_id + document_date + total_amount` against non-voided `sales_documents` (any `source`), using `total_amount` computed the same way the function already computes it (`p_amount + tax`). When multiple matches exist (shouldn't happen in practice), the oldest (`order by created_at`) is used as the linked duplicate.
- Client-side preview (`form.tsx`) mirrors the same key using a local `existingDocuments` list passed from `page.tsx` (lean `client_id, document_date, total_amount` fetch, non-voided, scoped to the company) and resolves each row's `client_id` from the now `{id, name}[]`-shaped `activeClients` prop. Amounts are rounded to 2 decimals before comparing, both client- and server-side comparisons rely on exact numeric equality (`total_amount`), which is fine given amounts are already rounded on parse.
- Verified server-side logic directly against the linked Supabase project via `supabase db query --linked`, simulating `auth.uid()` with `set_config('request.jwt.claims', ...)`, then cleaned up all test rows (client, batches, import_rows, sales_documents/sales_lines).
- **Browser-verified end to end**: created a real manual sale (client, 2026-09-05, Total 800 CLP), then imported a 2-row CSV where row 1 exactly matched it and row 2 didn't. Preview correctly showed row 1 as "Possible duplicate" with a "Force import" checkbox and row 2 as "OK"; committing without forcing produced "1 of 2 rows imported, 1 row skipped as duplicates" and the sales list confirmed only the non-duplicate row was added (no third document). Re-imported the same duplicate row with "Force import" checked: committed successfully, and the DB confirmed the new document has `duplicate_override=true` and `duplicate_of_sales_document_id` pointing exactly at the original manual sale, with both records intact. All test data (client, 3 sales documents, 2 import batches/rows) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

The server-side duplicate check in `import_sales_row` is the actual enforcement; the client-side check in `form.tsx` is only a preview convenience (lets the user decide skip/force before committing). This mirrors the existing defense-in-depth pattern elsewhere in the codebase (e.g. business-area/client cross-company checks done at both the app layer and a DB trigger) — never trust a client-computed flag as the source of truth for something that affects financial data integrity.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Create a manual sale, then import a CSV row matching it on client/date/total — confirm flagged and skipped by default, `import_rows.status='duplicate'`
- Force-import that same row — confirm a second document is created with `duplicate_override=true` and the correct `duplicate_of_sales_document_id`
- Import a row matching a previously *imported* sale (not manual) — confirm flagged the same way
- Browser-verify the preview: duplicate badge appears, "Force import" checkbox works, commit results show the duplicate count
