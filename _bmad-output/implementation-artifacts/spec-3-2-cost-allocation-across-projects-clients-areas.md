---
title: 'Story 3.2: Cost Allocation Across Projects, Clients & Areas'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '7b468009f8fcf0b132e891998f51b1671f10150b'
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A `general` (company-overhead) cost document today has no way to be split across the projects/clients/areas that actually consumed it — it just sits at company level, which is fine as a default but blocks the optional per-target proration the epic requires, and reports would otherwise show a shared cost as fully belonging to whichever single record happens to reference it (which doesn't exist for `general` costs today).

**Approach:** Add a `cost_allocations` table (one row per target: project, client, or business area, exactly one of the three FKs set) and a `set_cost_allocations` RPC using the same replace-all pattern as `update_sales_document` (delete existing rows for the document, insert the new set, atomically). Each row is either `percentage` or `fixed_amount`; the RPC validates the resulting shares sum to exactly the document's `total_amount` (rounded to 2 decimals) before committing, and requires at least 2 rows (an allocation of exactly one target isn't allocation, it's just re-tagging the cost).

## Boundaries & Constraints

**Always:** allocation is only permitted on `classification = 'general'` cost documents (a `direct` cost already has its single target via `project_id` — allocating it too would create two competing sources of truth); each `cost_allocations` row has exactly one of `project_id`/`client_id`/`business_area_id` set (DB check constraint); every target FK is validated to belong to the same `company_id` as the cost document (new trigger, same cross-company pattern as `cost_documents_validate_company_refs`); allocation shares (percentage rows converted to `total_amount * percentage / 100`, fixed rows used as-is) must sum to the document's `total_amount` within a 0.01 rounding tolerance, checked server-side before any row is committed; setting allocations replaces the full set atomically (delete + reinsert), never a partial patch.

**Decisions (made autonomously — none would surprise the user in the result):** allocation is scoped to `general` costs only, not `direct` — the epic's own wording ties this to "per-client/project proration of general/overhead expenses" and a `direct` cost's target is already unambiguous; the basis for allocation shares is `total_amount` (the epic's "100% ... or the full cost amount" language points at the document's full total, not a tax-excluded figure — no existing precedent yet excludes tax from cost figures the way it does for sales/income); a minimum of 2 allocation rows is required (validates the epic's "distribution across two or more targets" literally).

**Never:** allow allocation on `direct` cost documents; build the pending-vs-confirmed-zero states (Story 3.3); build duplicate-cost detection (Story 3.4); change how reports compute figures (no reporting/aggregation exists yet — that's Epic 6, which will read `cost_allocations` when it's built); edit `cost_documents`' own header/lines (still out of scope, same as 3.1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Allocate, two projects by percentage | General cost, 60%/40% across 2 projects | Both rows saved; shares (60%/40% of `total_amount`) sum exactly | N/A |
| Allocate, mixed methods | One row `fixed_amount`, one row `percentage`, summing to `total_amount` | Both rows saved | N/A |
| Allocate, shares don't sum to total | Percentages/amounts sum to something other than `total_amount` | Blocked | Validation error, no insert |
| Allocate, only one target | A single allocation row submitted | Blocked | Validation error ("at least 2 targets") |
| Allocate a `direct` cost | Cost document has `classification = 'direct'` | Blocked | Validation error, no insert |
| Tampered cross-company target | `project_id`/`client_id`/`business_area_id` from a different company | Rejected at the DB level | Trigger raises exception |
| Row with more than one target set | `project_id` and `client_id` both non-null on one row | Blocked | DB check constraint violation |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260913020000_epic3_story1_cost_documents.sql` -- current `cost_documents`/`cost_lines` schema, `cost_documents_validate_company_refs` trigger pattern, `create_cost_document` RPC to mirror the replace-all style of
- `supabase/migrations/20260913000000_epic2_story2_edit_void_sales_documents.sql` -- `update_sales_document`'s delete+reinsert replace-all pattern to mirror for `set_cost_allocations`
- `supabase/migrations/20260912190000_epic1_story6_manage_projects.sql`, `.../20260912150000_epic1_story3_manage_clients.sql`, `.../20260912170000_epic1_story5_manage_business_areas.sql` -- the three target tables' shapes (`id`, `company_id`) to FK against; no shared base table, so `cost_allocations` needs 3 separate nullable FK columns
- `web/src/lib/dal.ts` -- `getCostDocuments` (line ~804, extend with an `is_allocated` or allocation-count indicator for the list badge), `getProjects`/`getClients`/`getBusinessAreas` for the three pickers; add `getCostAllocations(costDocumentId)` for the allocate page
- `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/{page,actions,form}.tsx` -- structural template for the new `costs/[costDocumentId]/allocate/{page,actions,form}.tsx` (guard + fetch-or-block, `"use server"` action calling a replace-all RPC, dynamic row UI) — a new route segment, not a reuse of any header/lines editing (there is none for costs yet)
- `web/src/app/companies/[id]/costs/page.tsx` -- add an "Allocate" link per `general` cost document row, and an "Allocated" badge when rows exist

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic3_story2_cost_allocations.sql` -- `cost_allocations` (`id`, `cost_document_id` not null fk cost_documents, `project_id`/`client_id`/`business_area_id` all nullable fks with a check constraint requiring exactly one non-null, `method text not null check in ('percentage','fixed_amount')`, `percentage numeric`, `amount numeric`, a check constraint that `method='percentage'` requires non-null `percentage` and `method='fixed_amount'` requires non-null `amount`, audit cols); RLS any-member SELECT/INSERT/DELETE scoped through the parent `cost_documents.company_id` (DELETE needed for the RPC's own replace-all step, same reasoning as `sales_lines`' DELETE policy in Story 2.2); a `BEFORE INSERT` trigger validating each non-null target FK belongs to the same company as the parent cost document; `set_cost_allocations(p_cost_document_id uuid, p_allocations jsonb)` RPC -- looks up the cost document, rejects if `classification != 'general'`, rejects if fewer than 2 allocation rows submitted, computes each row's share (`total_amount * percentage / 100` or the fixed `amount`), rejects if the sum doesn't equal `total_amount` within 0.01, then deletes existing allocations for the document and inserts the new set atomically
- [x] `web/src/lib/dal.ts` -- `getCostAllocations(costDocumentId)` (rows + joined target names); extend `getCostDocuments`/its type with an allocation-count or boolean so the list can show an "Allocated" badge without an extra round trip per row (a single query with a count subselect or a follow-up batched query, whichever fits the existing query style)
- [x] `web/src/app/companies/[id]/costs/[costDocumentId]/allocate/page.tsx` -- auth+membership guard; fetch the cost document, redirect/block with a message if `classification != 'general'`; fetch active projects/clients/areas and existing allocations; render `<CostAllocationForm>`
- [x] `web/src/app/companies/[id]/costs/[costDocumentId]/allocate/actions.ts` -- `"use server" setCostAllocations(companyId, costDocumentId, prevState, formData)` parsing dynamic rows (target type + target id + method + value), calling the RPC, returning a fresh state on success (stay on page, matching the RPC's own atomicity) rather than redirecting
- [x] `web/src/app/companies/[id]/costs/[costDocumentId]/allocate/form.tsx` -- dynamic add/remove rows, each with a target-type select (project/client/area) that swaps the picker, a method select (percentage/fixed amount), and a value input; a running total vs. `total_amount` shown live; client-side validation blocking submit when the sum doesn't match or fewer than 2 rows exist
- [x] `web/src/app/companies/[id]/costs/page.tsx` -- "Allocate" link on `general` rows only; "Allocated" badge when the document has allocation rows

**Acceptance Criteria:**
- Given a general cost and two projects with percentages summing to 100%, when I save allocations, then both rows are stored and their computed shares sum to the document's `total_amount`
- Given allocation shares that don't sum to the document's total, then saving is blocked with a validation error, not a DB error
- Given only one allocation row submitted, then saving is blocked ("at least 2 targets")
- Given a `direct` cost document, then its list row has no "Allocate" link, and a direct RPC call against it is rejected
- Given a tampered cross-company target id, then the DB trigger rejects it

## Implementation Notes

Implemented as specified: `cost_allocations` table + `set_cost_allocations` RPC in
`supabase/migrations/20260913030000_epic3_story2_cost_allocations.sql`, DAL additions
(`getCostAllocations`, `getCostDocumentForEdit`, `is_allocated` on `getCostDocuments`)
in `web/src/lib/dal.ts`, and the new
`web/src/app/companies/[id]/costs/[costDocumentId]/allocate/{page,actions,form}.tsx`
route, plus an "Allocate"/"Edit allocation" link and "Allocated" badge on
`web/src/app/companies/[id]/costs/page.tsx`.

Verified: `tsc --noEmit` and `npm run build` both clean, new route registers.
Manually verified against the linked Supabase project (`supabase db query --linked`,
test data cleaned up afterward): 60/40 percentage split across two projects saves
and sums correctly; a wrong-sum submission, a single-row submission, and a `direct`
cost document are all rejected server-side with a clear error, not a raw DB error
surfaced past validation; a cross-company target id is rejected by the
`cost_allocations_validate_company_refs` trigger; a row with two target FKs set is
rejected by the `cost_allocations_single_target_check` check constraint.

**Browser-verified end to end** (follow-up pass): created a real `general` cost document (Total 1000 CLP) via the UI, opened its "Allocate" link, switched both rows' target type to "Business area" (confirmed the target picker swaps options live), set Development 60% / Hosting 40%, watched the running total update live to "1000.00 / 1000.00" in green, submitted and got "Allocations saved." Returned to the cost list and confirmed the badge changed to "Allocated" with the link now reading "Edit allocation". Test document + allocations deleted afterward via `supabase db query --linked`, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

`set_cost_allocations` is a plain function (not `security definer`), same reasoning as `create_cost_document`/`update_sales_document` — the caller already has RLS-authorized INSERT/DELETE rights on `cost_allocations` once its policies exist.

No percentage/amount reconciliation UI beyond a live running-total display — this is a small internal tool, not a full allocation-audit workflow. Rounding tolerance of 0.01 absorbs floating-point/display rounding without allowing a materially wrong split through.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new `/costs/[costDocumentId]/allocate` route registers

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- As a company member: allocate a general cost across 2 projects by percentage, confirm shares sum correctly
- Attempt allocation summing to the wrong total — confirm rejected
- Attempt allocation with only 1 row — confirm rejected
- Attempt allocation on a `direct` cost — confirm rejected
- Attempt a cross-company target id — confirm the trigger rejects it
- Browser-verify the allocate page: target-type toggle swaps pickers correctly, running total updates live
