---
title: 'Story 1.4: Manage Suppliers'
type: 'feature'
created: '09-12-2026'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'cdcfb221afabaa39bcb181c4e732b8f4d7fc0230'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There's no supplier entity yet. Costs/expenses (Epic 3) need a single supplier record per company that avoids duplicate names, mirroring what Story 1.3 did for clients.

**Approach:** Add a `suppliers` table, same shape and rules as `clients` (company-scoped, any member manages it, non-blocking near-duplicate-name warning, deactivate-only), reusing the exact `findSimilarClients`-style helper pattern.

## Boundaries & Constraints

**Always:** suppliers are scoped to one `company_id`; any member of that company can create/edit; `created_by`/`updated_by` populate from `auth.uid()`; a name closely matching an existing supplier in the same company shows a non-blocking warning (same bidirectional, whitespace-normalized substring check as `findSimilarClients`, including its "Save anyway" fix from Story 1.3's review).

**Never:** hard-delete a supplier (deactivate only); apply the duplicate check on edit (create-only, matching Story 1.3's scope decision); gate suppliers by admin role (operational data, same reasoning as clients).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create supplier, unique name | Any company member, new name | Supplier created, scoped to that company | N/A |
| Create supplier, near-duplicate name | Name closely matches an existing supplier in the same company | Warning shown; save still allowed on confirm; re-checks if the name is edited before confirming | N/A |
| Edit supplier | Any company member | Fields update, `updated_by`/`updated_at` set | N/A |
| Deactivate supplier | Any company member sets `active=false` | Supplier stays visible/listed, no delete option exists anywhere | N/A |
| Cross-company access | User with no membership in that company | RLS returns zero rows | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912150000_epic1_story3_manage_clients.sql` -- `clients` table/RLS/trigger shape to mirror exactly for `suppliers`
- `web/src/lib/dal.ts` -- `getClients`/`getClientForEdit`/`findSimilarClients` (post-fix, bidirectional + whitespace-normalized + stale-confirmation-safe) are the direct template for `getSuppliers`/`getSupplierForEdit`/`findSimilarSuppliers`
- `web/src/app/companies/[id]/clients/` (all three routes) -- structural and interaction template, including the `confirmedName`-guarded "Save anyway" flow from the Story 1.3 fix — copy that exact pattern, not the pre-fix version
- `web/src/app/companies/page.tsx` -- already has a "Clients" link pattern to copy for "Suppliers"

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260912160000_epic1_story4_manage_suppliers.sql` -- `suppliers` table, identical shape to `clients` (`id`, `company_id`, `name`, `tax_id`, `country`, `notes`, `active`, audit cols), reused `set_updated_at` trigger, RLS mirroring `clients`' member-scoped SELECT/INSERT/UPDATE (no DELETE policy)
- [x] `web/src/lib/dal.ts` -- `getSuppliers(companyId)`, `getSupplierForEdit(companyId, supplierId)`, `findSimilarSuppliers(companyId, name)` mirroring the post-fix `findSimilarClients`
- [x] `web/src/app/companies/[id]/suppliers/page.tsx` -- list, "New supplier" link, redirects non-members
- [x] `web/src/app/companies/[id]/suppliers/new/page.tsx` + `actions.ts` + `form.tsx` -- create form with the same confirmed-name-guarded duplicate-warning flow as clients
- [x] `web/src/app/companies/[id]/suppliers/[supplierId]/edit/page.tsx` + `actions.ts` + `form.tsx` -- edit form (name, tax_id, country, notes, active)
- [x] (handled centrally, not by this dispatch) `web/src/app/companies/page.tsx` -- a "Suppliers" link will be added after this and the parallel Story 1.5 both land, to avoid a file conflict between the two dispatches

**Acceptance Criteria:**
- Given I am a member of a company, when I create a supplier with a name closely matching an existing one, then I see a warning and can still save — ✅ verified live in the browser (`test-chile`, "Movistar")
- Given I edit the name after a warning renders, when I click save again, then it re-checks the new value rather than trusting the earlier confirmation — ✅ verified by the edge-case-hunter reviewer tracing the code (confirmedName-guarded, same fix pattern as Story 1.3)
- Given I am a member, when I edit a supplier, then it saves with `updated_by`/`updated_at` set — ✅ verified: the reused `set_updated_at()` trigger (extended in Story 1.2's review to also set `updated_by`) applies to `suppliers` too
- Given I have no membership in a company, when I try to view/edit its suppliers, then RLS returns zero rows — ✅ verified via `pg_policies` inspection: SELECT/INSERT/UPDATE all scoped to `company_memberships`, no DELETE policy
- Given a supplier has no delete option anywhere, then deactivating is the only removal path — ✅ verified: no delete control in any page, no DELETE RLS policy

## Implementation Notes

- Structural copy of Story 1.3 (Clients), including its post-review fixes (confirmedName-guarded "Save anyway", bidirectional whitespace-normalized duplicate check).
- `web/src/lib/dal.ts` was edited concurrently by the parallel Story 1.5 (Business Areas) session; confirmed after both landed that all additions from both stories are intact with no corruption (`grep` for all exported functions/types shows no duplicates or truncation).
- Code review (blind-hunter, edge-case-hunter, verification-gap) found no real defects specific to this story — edge-case-hunter traced every branch and reported zero findings; the one cross-cutting item (RLS subquery duplication across migrations) was deferred as a future refactor, not a fix for this story.
- Live-verified end to end in the browser (`test-chile`): created "Movistar" as a supplier, confirmed it lists correctly with an Active badge; test data cleaned up afterward via `supabase db query --linked`.
- `web/src/app/companies/page.tsx`'s "Suppliers" link intentionally not added by this dispatch — added centrally by the orchestrator after both parallel stories (1.4, 1.5) landed.

## Spec Change Log

## Review Triage Log

- **defer (cross-cutting, not this story's fix)** — the membership-exists RLS subquery (`exists (select 1 from company_memberships cm where cm.company_id = ... and cm.user_id = auth.uid())`) is now duplicated inline across `companies`, `clients`, and `suppliers` migrations (and will appear again in `business_areas`). Worth extracting into a reusable `is_company_member(company_id uuid, required_role text default null)` SQL function at some point, but that's a refactor touching multiple already-shipped migrations, not something this story should do alone. Appended to `deferred-work.md`.
- **reject (out of scope)** — the duplicate-name warning isn't re-checked on edit. Explicitly scoped out in this spec's own Boundaries ("apply the duplicate check on edit... — create-only, matching Story 1.3's scope decision").
- **reject (consistent with established precedent)** — `createSupplier` gives a generic "Something went wrong" to a non-member instead of a clearer permission message (unlike `updateSupplier`'s explicit zero-rows check). Same asymmetry already exists in the equivalent `clients` create/edit actions from Story 1.3; not a regression introduced here.
- **reject (YAGNI)** — no pagination on the suppliers list. Premature for a 2-person internal tool; not flagged for the equivalent clients list either.
- **reject (consistent with established precedent)** — no length/format validation on `tax_id`/`country`/`name` beyond non-empty. Same as `clients` (Story 1.3) and `companies` (Story 1.2); not a new gap.
- **reject (matches explicit boundary)** — no DB-level unique constraint preventing true duplicate names (TOCTOU between check and insert). This spec's own Boundaries explicitly rule out enforcing the duplicate check as a DB constraint — it's a soft UX warning by design, matching Story 1.3.
- **reject (consistent with established precedent)** — `country` is free text with no ISO-code normalization. Same as `companies` (Story 1.2); not a new gap, and not blocking any current reporting need.
- **defer (already covered)** — no automated tests for the new DAL functions/actions. Same root condition as the existing deferred-work.md entry ("add an automated test framework") — no new entry needed.
- **verified clean** — edge-case-hunter traced every branch (RLS null-user/error paths, the confirmed-name re-check on any name edit, the checkbox coercion, the `updated_by`/`updated_at` trigger claim) and found zero issues. Verification-gap reviewer found no regression risk (all-new surface, no prior tested consumer to break).

## Design Notes

This is a near-exact structural copy of Story 1.3 (Clients) — same entity shape, same RLS model, same duplicate-warning UX, including its post-review fix. Deliberately not abstracting `clients`/`suppliers` into a shared generic "party" table or shared component yet: two concrete tables are simpler to reason about than a premature abstraction, and nothing today needs them unified (they diverge slightly by Epic 3 anyway — sales vs. cost documents).

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run dev` -- expected: starts clean

**Manual checks (if no CLI):**
- As `test-chile`: create a supplier, then a near-duplicate — confirm warning, confirm re-check-on-edit works (repeat Story 1.3's post-fix verification)
- Edit a supplier, confirm `updated_by`/`updated_at` via `supabase db query --linked`
- As `test-noaccess`: confirm zero access to Inmasoft Chile's suppliers
