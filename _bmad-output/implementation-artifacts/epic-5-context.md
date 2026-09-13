# Epic 5 Context: Recurring Services & Personnel Costs

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Users need to model two recurring cost/revenue sources without re-entering them every month: recurring services sold to clients (Microsoft 365, hosting, Starlink, etc.) and personnel/labor cost. Recurring services must generate their expected income/cost entry each period automatically (respecting validity dates) instead of manual re-entry from scratch. Personnel costs must be trackable per period and assignable — by hours or cost amount — to specific projects, with any unallocated remainder tracked explicitly rather than dropped, so that project profitability (Epic 6) can include labor cost where relevant.

## Stories

- Story 5.1: Manage Recurring Services
- Story 5.2: Track Personnel/Labor Costs
- Story 5.3: Assign Personnel Cost/Hours to Projects

## Requirements & Constraints

- Recurring services need: client, price, expected cost, periodicity (monthly/annual), and a validity period (start/end). They must stop generating new entries automatically once validity ends.
- Personnel/labor cost is recorded per person (employee or partner), per company, per period, and serves as the basis for later project cost allocation.
- Owner/partner labor cost is explicitly in scope here — it is modeled as an internal monthly/hourly assignable cost like any other personnel cost, not as a separate mechanism.
- Allocating a person's cost/hours to projects must never silently drop unallocated remainder — it must be tracked as general/unassigned labor cost.
- General multi-company/multi-currency rules apply: every record belongs explicitly to one company; original currency and amount must be preserved (no overwriting) if any consolidated view is derived later.
- Standard audit trail applies: creating/modifying user and timestamps on these records; no silent deletion of records that may already be referenced by reports.
- Values must use explicit states rather than treating an absent value as zero (e.g., an unallocated remainder is tracked, not just omitted).

## Technical Decisions

- Data model: `recurring_services` (service, client, price, expected cost, periodicity, validity) and `personnel_costs` (monthly cost per person/company/period) are dedicated tables, distinct from `work_allocations` (hours or cost assigned to a project) — allocation is a separate linking entity, not a field on the cost record.
- All schema changes ship as versioned SQL migrations committed to the repo.
- Every financial entity is scoped to one company (RLS enforced at the database level, per Epic 1 foundation).
- Recurring-service period generation and personnel cost/hour allocation are the inputs Epic 6's profitability engine consumes for project margin — this epic only needs to produce correctly structured, allocable records, not compute profitability itself.

## Cross-Story Dependencies

- Depends on Epic 1 foundational data: `clients`, `companies`, and `projects` must exist before recurring services or work allocations can reference them.
- Feeds Epic 6 (Profitability Engine & Reporting): personnel cost allocations and recurring-service generated entries become part of project/client/area cost figures in the monthly result and profitability reports.
