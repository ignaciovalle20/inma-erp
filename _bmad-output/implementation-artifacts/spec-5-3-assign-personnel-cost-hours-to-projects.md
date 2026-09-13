---
title: 'Story 5.3: Assign Personnel Cost/Hours to Projects'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'cd623fe9535d26ff85240a29158583df69a96fa9'
context: ['_bmad-output/implementation-artifacts/epic-5-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A recorded monthly `personnel_costs` figure (Story 5.2) has no way to attribute itself to the projects a person actually worked on — project cost structure and, later, profitability (Epic 6) can't include labor cost without a linking mechanism.

**AC**: "Given allocations to projects don't consume the full monthly cost... it is tracked as general/unassigned labor cost, never silently dropped."

**Approach:** A `work_allocations` table linking one `personnel_costs` record to one or more projects, each row carrying the **monetary amount** allocated to that project (this is what makes "each project's cost includes its allocated share" concrete) plus an **optional `hours`** value recorded alongside it for traceability. The unallocated remainder (`personnel_costs.amount` minus the sum of its allocations) is always computed and shown, never hidden, satisfying the "never silently dropped" requirement.

## Boundaries & Constraints

**Always:** every allocation's `project_id` is validated to belong to the same company as the personnel cost's person (new cross-company trigger, same pattern used throughout this app); the sum of a personnel cost's allocations can never exceed its total `amount` (over-allocation is rejected, not silently capped); the unallocated remainder is always computed and displayed wherever allocations are shown — never omitted or treated as zero.

**Decisions (made autonomously, with reasoning — this AC's "cost or hours" wording doesn't specify a conversion mechanism, and none exists anywhere in the schema):** allocation is **amount-based**, with `hours` captured as **optional informational metadata** alongside the required amount — not a second, independent allocation currency. Building a real hours→money conversion would require an hourly rate that doesn't exist anywhere in this data model (`personnel_costs` stores a flat monthly figure, not a rate), and inventing one now would be speculative product design with no PRD backing — the same category of gap that blocked Story 3.4, except here a scoped, defensible, testable design (amount as the actual allocation unit, hours as a recorded reference figure) fully satisfies both ACs without fabricating an unspecified formula. A later story can add a rate-based hours-only allocation mode if the business actually needs it.

**Never:** allow allocations to sum past the personnel cost's total `amount`; silently drop or hide the unallocated remainder; build Epic 6's profitability computation (this story only produces the allocable records); invent an hours-to-currency conversion rate anywhere in the schema or RPC.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Allocate part of a cost to one project | Personnel cost with amount, allocate a smaller amount to a project | Row saved; project's allocated share = that amount; remainder shown | N/A |
| Allocate to multiple projects | Two allocations summing to less than the total | Both saved; remainder = total minus sum | N/A |
| Allocation would exceed the total | Sum of existing + new allocation > `amount` | Blocked | Validation error, no insert |
| Allocation with hours recorded | Amount + optional hours | Both stored; hours shown as reference, not converted to money | N/A |
| Full allocation, no remainder | Allocations sum exactly to `amount` | Remainder shows as 0, explicitly (not blank) | N/A |
| Cross-company project | Tampered `project_id` from a different company | Rejected at the DB level | Trigger raises exception |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260913060000_epic4_story2_duplicate_detection.sql`, `.../20260913030000_epic3_story2_cost_allocations.sql` -- `cost_allocations`' replace-pattern and running-total-validation style to mirror (though this story adds allocations incrementally, not as a replace-all set, since multiple separate allocation actions over time are expected)
- `supabase/migrations/20260913080000_epic5_story2_personnel_costs.sql` -- `personnel_costs` shape (`id, personnel_id, period, amount, currency`) to reference; `personnel` table for the cross-company join (`personnel.company_id`)
- `supabase/migrations/20260912190000_epic1_story6_manage_projects.sql` -- `projects` shape (`id, company_id`) to FK against and cross-company-validate
- `web/src/app/companies/[id]/personnel/[personnelId]/costs/page.tsx` -- the list page this story adds an "Allocate" link to, per cost record
- `web/src/lib/dal.ts` -- `getPersonnelCosts`/`getProjects` patterns to mirror for `getWorkAllocations(personnelCostId)`

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260913090000_epic5_story3_work_allocations.sql` -- `work_allocations` (`id`, `personnel_cost_id` not null fk personnel_costs, `project_id` not null fk projects, `amount numeric not null`, `hours numeric` nullable, audit cols + `set_updated_at` trigger); RLS any-member SELECT/INSERT/DELETE scoped through `personnel_costs` → `personnel.company_id` (DELETE needed so a user can remove/redo an allocation, unlike the append-only entities elsewhere); a `BEFORE INSERT` trigger validating `project_id`'s `company_id` matches the personnel cost's person's `company_id`; `allocate_work(p_personnel_cost_id uuid, p_project_id uuid, p_amount numeric, p_hours numeric default null) returns work_allocations` RPC -- validates `p_amount > 0`, sums existing allocations for that personnel cost and rejects if `existing_sum + p_amount > personnel_costs.amount`, inserts the row
- [x] `web/src/lib/dal.ts` -- `getWorkAllocations(personnelCostId)` (joined with `projects.name`), `getWorkAllocationRemainder(totalAmount, allocations)`, and `getPersonnelCostForEdit(companyId, personnelId, personnelCostId)` to expose the cost's `amount` for the remainder calculation
- [x] `web/src/app/companies/[id]/personnel/[personnelId]/costs/[costId]/allocate/page.tsx` -- shows the cost's total, existing allocations, and computed remainder (always shown, including when zero, via `data-testid="remainder"`); a form to add a new allocation (project picker, amount, optional hours)
- [x] `web/src/app/companies/[id]/personnel/[personnelId]/costs/[costId]/allocate/actions.ts` -- `"use server" allocateWork(...)` calling the RPC; `removeWorkAllocation(...)` (plain DELETE via RLS)
- [x] `web/src/app/companies/[id]/personnel/[personnelId]/costs/page.tsx` -- added an "Allocate" link per cost record

**Acceptance Criteria:**
- Given a personnel cost record, when I allocate part of it (amount, optional hours) to a project, then that allocation is saved and the remainder updates correctly
- Given allocations don't consume the full amount, then the unallocated remainder is always visibly shown, never hidden or shown as if it were zero when it isn't
- Given an allocation would exceed the total, then it's blocked with a clear error
- Given a tampered cross-company `project_id`, then the DB trigger rejects it

## Implementation Notes

- **Verified against the linked Supabase project**: migration applied live (`supabase db push --linked`). Direct RPC tests confirmed: a partial allocation (300 of 1000, with hours) saves and the remainder computes to 700; a follow-up allocation that would push the total to 1100 is rejected by `allocate_work` with a clear `P0001` error (`Allocation total (1100) would exceed the personnel cost amount (1000)`); a cross-company `project_id` is rejected by the `work_allocations_validate_company_refs` trigger. All test rows (personnel, personnel_costs, projects, clients, work_allocations) were cleaned up afterward.
- **Browser-verified end to end** against a dev server on the linked project: created a person, recorded a cost, created a project, opened the allocate page (remainder correctly shown as the full amount when unallocated), added a 400/20hrs allocation (remainder updated to 600, hours shown as "400 CLP · 20 hrs" reference text, not converted), and removed the allocation (remainder returned to 1,000, explicitly shown, not blank). Test data cleaned up afterward.
- `tsc --noEmit` and `npm run build` both pass; the new `/companies/[id]/personnel/[personnelId]/costs/[costId]/allocate` route registers in the build output.
- Not covered by browser testing: forcing an over-allocation or a cross-company project through the UI form itself (the amount input's `max` attribute and the project `<select>`'s options naturally prevent constructing those cases from the UI) -- the RPC/trigger rejection for both was instead verified directly via SQL against the RPC, which is the actual guarantee (the UI is just a friendly constraint on top).

## Spec Change Log

## Review Triage Log

## Design Notes

`allocate_work` is a plain function (not `security definer`), same reasoning as every other creation RPC in this codebase.

Allocations are added incrementally (one action per allocation), not replace-all like `cost_allocations` — a personnel cost's allocations naturally accumulate over time as different projects are decided, rather than being fully known and submitted together upfront.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new routes register

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Allocate part of a personnel cost to a project, confirm the remainder computes correctly
- Attempt to over-allocate past the total — confirm rejected
- Attempt a cross-company project id — confirm the trigger rejects it
- Browser-verify the allocate page end to end, including the always-visible remainder
