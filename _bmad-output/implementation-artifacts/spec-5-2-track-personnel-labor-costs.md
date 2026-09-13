---
title: 'Story 5.2: Track Personnel/Labor Costs'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '88af88719582a051d75c6777e5a5d84364859215'
context: ['_bmad-output/implementation-artifacts/epic-5-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Labor cost (employees and owner/partners alike) has no record anywhere — it can't feed project cost allocation (Story 5.3) or profitability (Epic 6) because there's no entity for "a person" or "their monthly cost."

**Approach:** A `personnel` roster (name, type employee/partner, active) plus `personnel_costs` (one row per person per period, a plain monthly amount). No hours field — per the story's own single AC ("record their monthly cost for a company and period"), hours is exclusively Story 5.3's concept when allocating to projects, not captured here.

## Boundaries & Constraints

**Always:** a person belongs to exactly one company; a monthly cost record is scoped to one `(personnel_id, period)` pair — only one cost record per person per month (a correction means editing that record, not adding a second); owner/partner labor cost uses the exact same `personnel`/`personnel_costs` mechanism as any employee — no separate "partner cost" table or field, per the epic's explicit instruction.

**Never:** capture hours anywhere in this story (Story 5.3's concern entirely); build project allocation (Story 5.3, out of scope); build Epic 6's cost-structure reporting; add a payroll/tax-calculation feature (not requested — this is a plain recorded monthly figure, not a payroll engine).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Add a person | Name, type (employee/partner) | Saved, listed | N/A |
| Record a monthly cost | Person, period, amount, currency | Saved, available as a later allocation basis | N/A |
| Record a second cost for the same person+period | Duplicate `(personnel_id, period)` | Blocked | Validation error, no duplicate |
| Edit an existing period's cost | Change the amount | Updates that record in place | N/A |
| Deactivate a person | `active = false` | Person stays listed (badge), no longer offered for new cost entry | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912160000_epic1_story4_manage_suppliers.sql` -- simplest CRUD-table template (`id, company_id, name, active`, audit cols, `set_updated_at` trigger, member SELECT/INSERT/UPDATE RLS, no DELETE) to mirror for `personnel`
- `supabase/migrations/20260913070000_epic5_story1_recurring_services.sql` -- child-table-with-period pattern (`recurring_services`/its generated `sales_documents` link) for the `personnel_costs` shape and its `(personnel_id, period)` uniqueness
- `web/src/app/companies/[id]/suppliers/{page,new,[supplierId]/edit}.tsx` -- exact CRUD template to mirror for the `personnel` roster
- `web/src/lib/dal.ts` -- `getSuppliers`/`getSupplierForEdit` pattern for `getPersonnel(companyId)`/`getPersonnelForEdit(companyId, id)`; add `getPersonnelCosts(personnelId)`/`getPersonnelCostForEdit` for the cost sub-resource

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic5_story2_personnel_costs.sql` -- `personnel` (`id`, `company_id` not null fk companies, `name text not null`, `type text not null check in ('employee','partner')`, `active boolean not null default true`, audit cols + `set_updated_at` trigger); RLS any-member SELECT/INSERT/UPDATE (no DELETE, deactivate via `active=false`); `personnel_costs` (`id`, `personnel_id` not null fk personnel, `period date not null` check `period = date_trunc('month', period)::date`, `amount numeric not null`, `currency text not null check in ('CLP','UYU','USD')`, audit cols + `set_updated_at` trigger, unique `(personnel_id, period)`); RLS any-member SELECT/INSERT/UPDATE scoped through `personnel.company_id` (no DELETE, same pattern as `sales_lines`/`cost_lines` join-based RLS)
- [x] `web/src/lib/dal.ts` -- `getPersonnel(companyId)`, `getPersonnelForEdit(companyId, id)` mirroring `getSuppliers`/`getSupplierForEdit`; `getPersonnelCosts(personnelId)` for the cost sub-resource (a `getPersonnelCostForEdit` was initially added too, but removed as dead code -- no cost-edit page exists in this story's task list, and this codebase avoids unused exports)
- [x] `web/src/app/companies/[id]/personnel/page.tsx` -- roster list (name, type, active badge), "New person" link, a "Costs" link per person
- [x] `web/src/app/companies/[id]/personnel/new/{page,actions,form}.tsx` -- create a person (name, type)
- [x] `web/src/app/companies/[id]/personnel/[personnelId]/edit/{page,actions,form}.tsx` -- edit including the `active` toggle
- [x] `web/src/app/companies/[id]/personnel/[personnelId]/costs/page.tsx` -- list of that person's monthly cost records, "Record cost" link
- [x] `web/src/app/companies/[id]/personnel/[personnelId]/costs/new/{page,actions,form}.tsx` -- record a period's cost (period, amount, currency defaulting to company currency); server-side rejects a duplicate `(personnel_id, period)` with a clear message
- [x] `web/src/app/companies/page.tsx` -- add a "Personnel" link

**Acceptance Criteria:**
- Given I add a person and record their monthly cost for a period, then it's saved and listed under that person
- Given I attempt a second cost record for the same person and period, then it's blocked with a clear error, not a raw DB error
- Given I deactivate a person, then they're still visible (with a badge) but not offered when creating a new cost record elsewhere (n/a yet — no cross-entity picker exists until Story 5.3; deactivation here only affects this roster's own display)

## Implementation Notes

- **Verified against the linked Supabase project**: migration applied live; direct-insert tests confirmed a valid cost row saves, a duplicate `(personnel_id, period)` is rejected (`23505`), and a non-month-start period is rejected (`23514`). Test data cleaned up.
- **Browser-verified end to end**: created a real person (TEST-5-2 Juan Pérez, employee), recorded a September 2026 cost of 1,200,000 CLP — confirmed it lists correctly (2026-09-01, 1,200,000 CLP). Attempted a second cost record for the same person/period: correctly blocked with "A cost record for this person and period already exists. Edit that record instead of adding a new one." Removed the unused `getPersonnelCostForEdit` DAL function (no cost-edit page is in this story's scope). All test data (person, cost record) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

No cross-company validation trigger needed on `personnel_costs` — it references only `personnel` (a single entity, whose own `company_id` is authoritative via RLS), unlike `sales_documents`/`cost_documents` which reference two or more entities that could mismatch.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new routes register

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Add a person, record a monthly cost, confirm it's saved and listed
- Attempt a duplicate `(personnel_id, period)` — confirm rejected
- Browser-verify the roster and cost-recording flow end to end
