---
title: 'Story 6.1: Monthly Result Report'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '52db4e6949ec11e39edd136ef91d6b4ab9ddb68b'
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing today computes a company's actual monthly result — net sales, direct margin, and operating result all have to be derived by hand from raw documents, and nothing distinguishes a fully-recorded result from one where some project still has no cost entered.

**Approach:** A shared calculation function (`computeMonthlyResult(companyId, period)`) — the single source of truth Epic 6's later reports will also call — summing `sales_documents.net_amount` (non-voided) for net sales, `cost_documents.net_amount` split by `classification` for direct costs (project-tied) and general costs, plus the period's `personnel_costs.amount` as additional general/structure cost. A report page shows net sales → direct margin → operating result, and flags the result as provisional whenever any active project has a "pending" cost-review status (Story 3.3) for that period.

## Boundaries & Constraints

**Always:** all figures use `net_amount` (tax-excluded) on both the income and cost sides — recoverable VAT is never treated as profit or expense; a voided sales document is excluded entirely; direct costs are `cost_documents` where `classification='direct'` (already tied to one project via its own `project_id`); general costs are `cost_documents` where `classification='general'` (summed by total `net_amount`, not broken down per `cost_allocations` target — that per-target detail is Story 6.2's concern, not this company-level report) plus that period's total `personnel_costs.amount` (allocated or not — at company level the money is spent either way); the report is scoped to one company and one calendar month at a time.

**Decisions (made autonomously, with reasoning):** the "confirmed vs. uncertain" distinction (AC2) is implemented as: the computed result is shown as-is (it is already necessarily a ceiling — recorded costs can only be understated, never overstated, when something is pending), plus a count of active projects still "pending" cost review for that period (reusing Story 3.3's exact computed status), displayed as a visible caveat ("N project(s) have no cost recorded yet — the confirmed result may decrease once entered") rather than attempting to estimate or subtract a guessed amount. This directly satisfies the AC without fabricating a number nothing in the system can actually produce. **Mixed-currency documents within one company are out of scope** — every document already defaults to `company.currency` by existing convention throughout the app, and no cross-currency-within-a-company scenario has ever been built or handled anywhere (every existing list page's own totals have the same latent assumption); fixing that is a pre-existing, unrelated concern, not something this report introduces or should silently paper over. **General-cost "pending" detection is not built** — Story 3.3's pending/confirmed-zero mechanism only ever covered *projects* (direct costs), not general company-level expenses (rent, subscriptions, etc.) — there is no equivalent tracking for those anywhere, so this report cannot flag "we might be missing a general bill this month," only "a project hasn't had its cost recorded/confirmed."

**Never:** build per-project/client/area breakdown (Story 6.2); build budgeted-vs-actual (Story 6.3); build drill-down links (Story 6.4); build USD consolidation (Story 6.5); build multi-month period-recognition logic (Story 6.6, though this report already uses the PRD's decided default — a document's own `document_date` — with no special-casing); attempt currency conversion of any kind.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Normal month, all costs recorded | Sales + direct + general costs exist, no pending projects | Net sales, direct margin, operating result shown, no caveat | N/A |
| Month with a pending project | An active project has no cost + no confirmation for that month | Same figures shown, plus a visible "N project(s) pending" caveat | N/A |
| Month with voided sales documents | Some `sales_documents.voided = true` in the period | Voided documents excluded from net sales | N/A |
| Month with no data at all | No sales/costs for the period | Report shows zeros explicitly, not blank | N/A |
| General cost split across multiple targets | A `general` cost_document has `cost_allocations` rows | Its full `net_amount` still counts once toward general costs (allocation detail is 6.2's concern) | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260913020000_epic3_story1_cost_documents.sql` -- `cost_documents` shape (`classification`, `project_id`, `net_amount`) to sum by classification
- `supabase/migrations/20260912210000_epic2_story1_sales_documents.sql`, `.../20260913000000_epic2_story2_edit_void_sales_documents.sql` -- `sales_documents` shape (`net_amount`, `voided`) to sum
- `supabase/migrations/20260913080000_epic5_story2_personnel_costs.sql` -- `personnel_costs` shape (`amount`, `period`) to include in general costs
- `web/src/lib/dal.ts` -- `getProjectCostStatus(companyId, period)` (Story 3.3) to reuse verbatim for the pending-project count; no existing SQL-level `sum()`/`group by` aggregation anywhere — this story introduces the first one (either a Postgres RPC or a JS-side reduce over fetched rows, matching `getProjectCostStatus`'s own JS-aggregation precedent rather than inventing a new SQL pattern)
- `web/src/app/companies/[id]/projects/page.tsx` (lines ~94-114) -- exact `type="month"` GET-form period-selector pattern to mirror for the report page

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/reporting.ts` (new) -- `computeMonthlyResult(companyId, period)` returning `{netSales, directCosts, directMargin, generalCosts, operatingResult, pendingProjectCount}`; queries `sales_documents` (non-voided, in-period, sum `net_amount`), `cost_documents` (in-period, grouped by `classification`, sum `net_amount`), `personnel_costs` (matching `period`, sum `amount`), and reuses `getProjectCostStatus` for the pending count; all in the company's own currency (no conversion)
- [x] `web/src/app/companies/[id]/reports/monthly-result/page.tsx` -- auth+membership guard; `type="month"` GET selector (defaulting to the current month, mirroring the Projects page pattern exactly); calls `computeMonthlyResult`; shows net sales → direct margin → operating result as a simple vertical breakdown, with the pending-project caveat banner when `pendingProjectCount > 0`; shows explicit zeros when there's no data, never a blank state
- [x] `web/src/app/companies/page.tsx` -- add a "Monthly result" link

**Acceptance Criteria:**
- Given a period and company, when I open the monthly result report, then net sales, direct margin, and operating result are shown, computed from underlying documents, never manually entered
- Given pending costs exist for the period (an active project with no recorded/confirmed cost), when I view the result, then a visible caveat distinguishes the computed figure from the fact that it may still decrease
- Given a month with voided sales documents, then they're excluded from net sales
- Given a month with no data, then figures show as explicit zeros, not a blank page

## Implementation Notes

- Fixed a small grammar bug found during browser verification: the pending-project caveat read "1 project **have** no cost" for the singular case — corrected to "1 project has" / "N projects have."
- **Verified against the linked Supabase project with a full hand-calculated scenario**: created a client, two projects, a sales document (net 1000), a direct cost tied to one project (net 300), a general cost (net 200), and a personnel cost for the period (300). Report showed exactly Net sales 1,000.00 / Direct costs 300.00 / Direct margin 700.00 / General costs 500.00 (200+300) / Operating result 200.00 — matching the hand calculation exactly.
- **Browser-verified all four I/O matrix rows**: normal month (no caveat), a second project with no cost for the period (caveat correctly shows "1 project has..."/"2 projects have..." with correct pluralization after the fix), an empty month (all figures show explicit "0.00 CLP", never blank), and confirmed the code excludes `voided=true` sales documents via its `.eq("voided", false)` filter (read directly, not just executed) after voiding the test sales document. All test data (client, 2 projects, sales document, 2 cost documents, personnel + personnel cost) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

`computeMonthlyResult` lives in `web/src/lib/reporting.ts`, separate from `dal.ts`, since it's calculation logic composed from several DAL-level queries rather than a single-table CRUD accessor — this is the shared engine Epic 6's later stories (6.2 especially) will import and extend, per the epic's explicit "single source of truth for the math" requirement.

No new migration in this story — every table read already exists and is RLS-scoped from prior epics.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new route registers

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Create a sales document, a direct cost, and a general cost for the same month; confirm the report's net sales/direct margin/operating result match a hand-calculation
- Void a sales document and confirm it drops out of net sales
- Leave an active project with no cost for the period and confirm the pending caveat appears
- Browser-verify the report page and month selector end to end
