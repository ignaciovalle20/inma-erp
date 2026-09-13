---
title: 'Story 2.2: Edit & Correct Sales Documents with Audit Trail'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5513e08e20305b15b39dc3a82bf4b1cec70b1575'
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Sales documents can only be created (Story 2.1) — there is no way to correct a mistaken entry, and no UPDATE/DELETE RLS policy exists on `sales_documents`/`sales_lines` at all. Once a document feeds a report, it must never be silently altered or hard-deleted.

**Approach:** Add an `update_sales_document` RPC mirroring `create_sales_document`'s atomic, server-computed pattern (recomputes net/tax/total from replacement lines, same validation), plus a new UPDATE RLS policy. Existing `updated_at`/`updated_by` columns already provide the audit trail (timestamp + user); the UI marks a document as "Edited" whenever `updated_at` differs from `created_at`. Add a `voided` boolean + `voided_at`/`voided_by` for removal-without-deletion, editable only while not voided.

## Boundaries & Constraints

**Always:** `net_amount`/`total_amount` recomputed server-side on edit, same as create — never accepted as raw client input; editing replaces all lines atomically (delete + reinsert) inside the RPC, never partial line patches; a voided document can never be edited further; the existing cross-company `client_id` trigger (already fires on `before insert or update`) continues to guard edits with no migration needed there; `created_at`/`created_by` are immutable on edit.

**Never:** hard-delete a `sales_documents` or `sales_lines` row from any app code path; build a restore-from-voided flow (not requested); change `create_sales_document` (Story 2.1, done); touch the Chile CSV importer (Epic 4); reuse the `active` boolean naming/semantics for voiding (dedicated `voided` column instead — `active` elsewhere means "usable as a picker option", a distinct concept from "historically corrected").

**Decisions:** void is a dedicated `voided boolean not null default false` + `voided_at`/`voided_by`, not a reuse of `active`. Voided documents still appear in the sales list (with a "Voided" badge), same precedent as inactive clients/suppliers still listing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Edit, change lines | Existing doc, submit new line set + tax | Old lines replaced; `net_amount`/`total_amount` recomputed from new lines | N/A |
| Edit, zero lines | Submit with all lines removed | Blocked | Validation error, no update |
| Edit a voided document | Doc has `voided = true` | Blocked before any DB write | App-level error, edit route refuses |
| Void a document | Any non-voided doc | `voided = true`, `voided_at`/`voided_by` set; rows untouched otherwise | N/A |
| Tampered `client_id` on edit | Cross-company id submitted | Rejected at DB level (existing trigger, now fires on UPDATE too) | Trigger raises exception |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912210000_epic2_story1_sales_documents.sql`, `.../20260912220000_..._review_patches.sql` -- current schema: `sales_documents`/`sales_lines` audit columns (`created_at/by`, `updated_at/by` + `set_updated_at()` trigger already firing on UPDATE), `sales_documents_validate_company_refs()` trigger (already covers UPDATE, no change needed), `create_sales_document` RPC to mirror
- `web/src/lib/dal.ts` -- `getClientForEdit` (line ~182) pattern for `getSalesDocumentForEdit(companyId, salesDocumentId)`; needs a companion fetch for the doc's lines
- `web/src/app/companies/[id]/clients/[clientId]/edit/{page,actions,form}.tsx` -- edit-page shape to mirror (server guard + fetch-or-404, `"use server"` action with `useActionState`, client form); note clients update via plain `.update()` — sales documents instead call the new RPC
- `web/src/app/companies/[id]/sales/new/{page,actions,form}.tsx` -- reuse line add/remove UI, client picker, currency default, and the zero/negative-line client-side validation from Story 2.1 in the new edit form
- `web/src/app/companies/[id]/sales/page.tsx` -- add "Edited"/"Voided" badges and an edit/void link per row

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic2_story2_edit_void_sales_documents.sql` -- add `voided boolean not null default false`, `voided_at timestamptz`, `voided_by uuid references auth.users(id)` to `sales_documents`; add UPDATE RLS policy (any company member, same shape as `clients`); add `update_sales_document(p_sales_document_id, p_client_id, p_document_type, p_document_date, p_currency, p_tax_amount, p_lines jsonb)` RPC -- validates not voided, not empty lines, non-negative tax, positive line amounts (same checks as `create_sales_document`), recomputes net/total, deletes+reinserts `sales_lines`, updates header; add `void_sales_document(p_sales_document_id)` RPC -- sets `voided = true`, `voided_at = now()`, `voided_by = auth.uid()`, refuses if already voided
- [x] `web/src/lib/dal.ts` -- `getSalesDocumentForEdit(companyId, salesDocumentId)` (header + lines, `null` if not found/voided-and-blocked check done in the action, not here) following `getClientForEdit`'s shape
- [x] `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/page.tsx` -- auth+membership guard, fetch-or-redirect, block rendering the form if `voided`
- [x] `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/actions.ts` -- `"use server" updateSalesDocument(...)` calling the new RPC; `voidSalesDocument(...)` calling `void_sales_document`
- [x] `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/form.tsx` -- same dynamic line rows as `new/form.tsx`, pre-populated; a "Void this document" action (separate from save, with a confirm step)
- [x] `web/src/app/companies/[id]/sales/page.tsx` -- "Edited" badge when `updated_at !== created_at`; "Voided" badge when `voided`; edit link per row

**Acceptance Criteria:**
- Given I edit a document's lines and tax, when I submit, then `net_amount`/`total_amount` are recomputed server-side from the new lines and old lines are gone
- Given I submit an edit with zero lines, then it's blocked with a validation error, not a DB error
- Given a document is voided, when I try to edit it, then the app refuses before any write
- Given I void a document, when I view the list, then it shows a "Voided" badge and `voided_at`/`voided_by` are set
- Given a tampered cross-company `client_id` is submitted on edit, then the existing DB trigger rejects it (same mechanism as create, now exercised via UPDATE)

## Implementation Notes

- Migration also adds DELETE and UPDATE RLS policies on `sales_lines` (any company member, scoped via the parent document's `company_id`) — not explicitly listed in the task, but required because `update_sales_document` deletes+reinserts lines and the original Story 2.1 migration only ever granted `sales_lines` INSERT.
- Verified via `npx tsc --noEmit` (clean), `npm run lint` (0 errors, 2 pre-existing-style warnings), `npm run build` (compiles; new edit route registers as a dynamic server route).
- **Live-verified against the linked Supabase project** (`gpxeikzpqldpxdijbsfs`) via `supabase db push` + `supabase db query --linked`, impersonating a real authenticated Chile-company user:
  - Edit with new lines/tax: net/tax/total recomputed correctly (1500/190/1690 → 2000/300/2300), old lines fully replaced (verified only the new line remained, not accumulated).
  - Edit with zero lines: rejected with `P0001: A sales document needs at least one line`, no partial write.
  - Void: sets `voided=true`, `voided_at`/`voided_by`, rows otherwise untouched.
  - Edit a voided document: rejected with `P0001: A voided sales document cannot be edited`.
  - Void an already-voided document: rejected with `P0001: This sales document is already voided`.
  - Cross-company `client_id` tamper via the edit RPC: rejected by the existing trigger (`sales_documents_validate_company_refs`, now exercised on UPDATE), and the failed call's line delete+reinsert rolled back atomically (confirmed line count and client_id unchanged afterward) — no migration was needed for this, as predicted in Design Notes.
  - All temporary test data (2 clients, 2 sales documents, their lines) deleted afterward; confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

`update_sales_document` is a plain function (not `security definer`), same reasoning as `create_sales_document` in Story 2.1 — caller already has RLS-authorized UPDATE rights once the new policy exists.

No edit history/versioning table — "audit trail" per this epic's Requirements & Constraints means modifying user + timestamp + a visible change marker, which the existing `updated_by`/`updated_at` plus a derived "Edited" badge already satisfy without new storage.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run dev` -- expected: starts clean

**Manual checks (if no CLI):**
- As a company member: edit an existing document's lines/tax, confirm net/total recomputed and old lines replaced
- Try submitting an edit with zero lines — confirm a validation error, not a crash
- Void a document, then attempt to edit it — confirm the app blocks it
- Attempt the cross-company `client_id` bypass technique from Story 2.1's review, this time via the edit RPC — confirm the trigger still rejects it
