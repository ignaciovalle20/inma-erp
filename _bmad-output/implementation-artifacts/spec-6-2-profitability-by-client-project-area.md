---
title: 'Story 6.2: Profitability by Client, Project & Area'
type: 'feature'
created: '2026-09-13'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '33a8dbb419c3680c95e1768ab9e249de48835289'
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 6.1 only computes a company-wide result — nothing shows which clients, projects, or business areas are actually profitable. Blocking gap found during investigation: `sales_documents` had no link to a project at all (only `client_id`, and `business_area_id` since Story 2.3), so project revenue had no source. **Resolved by user decision**: add an optional `project_id` to `sales_documents` going forward — a sale not tagged to a project counts only at its client's level, never fabricated or apportioned.

**Approach:** Extend `reporting.ts` with `computeClientProfitability`/`computeProjectProfitability`/`computeAreaProfitability`, all reusing Story 6.1's exact net-of-tax, classification-based cost logic. A report page lists all three breakdowns for a period; a project's detail additionally shows accumulated (life-to-date) figures alongside the period figures, per AC2.

## Boundaries & Constraints

**Always:** revenue for any entity is the sum of non-voided `sales_documents.net_amount` directly tagged to it (`client_id` for client, new `project_id` for project, `business_area_id` for area) — never apportioned, inferred, or backfilled onto historical untagged sales; a sale's `project_id`, when set, is validated to belong to the same client as the sale itself (a project always has its own `client_id`) and the same company (new trigger check, same pattern used everywhere else); every figure reuses Story 6.1's exact rules (net_amount only, non-voided only, tax never counted as cost or profit).

**Decisions (made autonomously — cost-attribution formula per entity, since the AC only says "allocated costs" without specifying the rollup):** **Client costs** = `cost_allocations` rows targeting that client directly + the full `total_amount` of every `direct` `cost_documents` row belonging to a project whose `client_id` is that client (a project has exactly one client, so this is an unambiguous rollup, not an apportionment). **Area costs** = `cost_allocations` rows targeting that area directly + the full cost of every `direct` cost document belonging to a project whose `business_area_id` is that area (symmetric to client, since a project has exactly one area too). **Project costs** = its own `direct` `cost_documents` (via `project_id`) + `cost_allocations` rows targeting it (computed share: `percentage * cost_document.total_amount / 100` or the fixed `amount`) + `work_allocations` rows targeting it (`amount` field — the real personnel cost share, `hours` stays informational per Story 5.3). This is a normal hierarchical rollup (a client's number naturally includes its projects' costs), not double-counting — each entity answers a different question ("what did this client cost us" vs. "what did this specific project cost us").

**Never:** apportion or estimate revenue for an entity that has no directly-tagged sales (a client/project/area with zero tagged sales shows zero revenue, not a guessed share); retroactively backfill `project_id` on historical sales documents; build Story 6.3 (budgeted vs. actual — this story shows actuals only, `projects.budget` is not compared here); build Story 6.4 (drill-down links); build Story 6.5/6.6 (currency consolidation, period-recognition rules beyond what 6.1 already established).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Client with sales and project costs | Client has direct sales + a project with direct costs | Revenue = client's tagged sales; costs = allocations to client + that project's direct costs | N/A |
| Project spanning multiple months | Sales/costs across several months | Both accumulated (all-time) and this-period figures shown | N/A |
| Sale not tagged to any project | `sales_documents.project_id` is null | Counts at client level only; no project's revenue includes it | N/A |
| Entity with no tagged revenue | A project with only costs, no sales tagged to it | Revenue shows as 0, not blank; margin is negative | N/A |
| Cross-company/cross-client project tampering | A sale's `project_id` belongs to a different client or company | Rejected at the DB level | Trigger raises exception |

</frozen-after-approval>

## Code Map

- `web/src/lib/reporting.ts` (Story 6.1) -- `computeMonthlyResult`'s exact net_amount/voided/classification logic to reuse identically, not reimplement
- `supabase/migrations/20260913010000_epic2_story3_quick_entry_business_area.sql` -- the exact pattern of adding a nullable FK column + extending `sales_documents_validate_company_refs` to also validate it, to mirror for `project_id`
- `supabase/migrations/20260913030000_epic3_story2_cost_allocations.sql` -- `cost_allocations` shape (`project_id`/`client_id`/`business_area_id`, `method`, `percentage`/`amount`) to sum per target
- `supabase/migrations/20260913090000_epic5_story3_work_allocations.sql` -- `work_allocations` shape (`personnel_cost_id`, `project_id`, `amount`) to sum per project
- `web/src/app/companies/[id]/sales/new/{page,actions,form}.tsx`, `.../[salesDocumentId]/edit/` -- add an optional project picker (filtered to the selected client's own projects) to both create and edit flows

## Tasks & Acceptance

**Execution:**
- [ ] `supabase/migrations/<ts>_epic6_story2_sales_project_link.sql` -- add `sales_documents.project_id uuid references projects(id)` (nullable); extend `sales_documents_validate_company_refs` to validate, when `project_id` is non-null: the project's `company_id` matches, and the project's `client_id` matches the sale's own `client_id`; extend `create_sales_document`/`update_sales_document` RPCs with `p_project_id uuid default null`
- [ ] `web/src/lib/reporting.ts` -- `computeClientProfitability(companyId, clientId, period)`, `computeProjectProfitability(companyId, projectId, period)` (returns both accumulated and period figures), `computeAreaProfitability(companyId, areaId, period)`, each returning `{revenue, costs, margin}` (plus accumulated variants for project); a `getProfitabilityBreakdown(companyId, period)` that lists all clients/projects/areas with their period figures for the report page
- [ ] `web/src/app/companies/[id]/sales/new/form.tsx` + `actions.ts`, `.../[salesDocumentId]/edit/form.tsx` + `actions.ts` -- add an optional project `<select>` (options filtered to the chosen client's own active projects), passed through to the RPC
- [ ] `web/src/app/companies/[id]/reports/profitability/page.tsx` -- period selector (mirroring 6.1's month input); three sections (clients, projects, areas), each row showing revenue/costs/margin; project rows also show accumulated figures
- [ ] `web/src/app/companies/[id]/reports/monthly-result/page.tsx` -- add a link to the new profitability report (and vice versa) for navigation between the two reports

**Acceptance Criteria:**
- Given a period, when I view the profitability report, then revenue, allocated costs, and margin are shown per client, project, and area, using the same calculation rules as the monthly result
- Given a project spans multiple months, when I view its profitability, then both accumulated and this-period figures are shown
- Given a sale not tagged to any project, then it counts only at its client's level, never fabricated into a project figure
- Given a tampered `project_id` from a different client or company, then the DB trigger rejects it

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

The cost-rollup formulas (client/area including their projects' direct costs) are a hierarchical sum, not a separate allocation mechanism — no new `cost_allocations`-style table needed, just a broader query per entity type.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new route registers

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Create a client with a project; tag one sale to the project, leave another untagged; add a direct cost to the project and a cost_allocation to the client directly; confirm client/project figures match a hand-calculation
- Confirm a multi-month project shows correct accumulated vs. period figures
- Attempt a cross-client/cross-company `project_id` on a sale — confirm rejected
- Browser-verify the profitability report end to end
