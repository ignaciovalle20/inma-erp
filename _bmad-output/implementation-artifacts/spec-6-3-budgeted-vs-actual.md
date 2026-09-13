---
title: 'Story 6.3: Budgeted vs. Actual'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '977970fc4b3128476669b8bed74c361a5bec642b'
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `projects.budget` is captured at project creation and shown on the list, but nothing compares it against what the project actually cost — there's no way to see how far off plan a project is.

**Approach:** Extend `computeProjectProfitability`'s existing accumulated figures with a budget comparison: `variance = accumulatedCosts - budget` (positive means over budget), shown on the project's own page alongside its already-existing period/accumulated revenue-cost-margin figures from Story 6.2.

## Boundaries & Constraints

**Always:** the comparison only appears when `projects.budget` is set (non-null) — a project without a budget shows no variance, never a misleading comparison against zero; "actual" is the project's accumulated (life-to-date) cost, matching Story 6.2's existing accumulated-figures convention and the AC's own life-to-date framing for multi-month projects; the budget figure itself is never modified by this story (still only editable via the existing project edit form).

**Decisions (made autonomously, with reasoning — the AC's single "actual amount (from real income/costs)" doesn't specify which of revenue/cost/margin a single `budget` scalar compares against):** budget is compared against **accumulated actual cost**, not revenue or margin — a project budget colloquially and in standard project-management usage means an allowed spending ceiling, and there is only one `budget` field (not separate budgeted-revenue/budgeted-cost fields), so cost is the figure that scalar can meaningfully represent. Revenue and margin are already fully visible via Story 6.2's profitability report; this story adds specifically the budget-ceiling comparison Story 6.2 doesn't have.

**Never:** add separate budgeted-revenue or budgeted-margin fields (not requested, and the single existing `budget` column doesn't support that split); build alerts/notifications for over-budget projects (not requested); change how `budget` is entered or edited (Story 1.6's existing form already does this).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Project with a budget, under spend | `budget=1000`, accumulated costs=700 | Shows planned 1000, actual 700, variance -300 (under budget) | N/A |
| Project with a budget, over spend | `budget=1000`, accumulated costs=1200 | Shows planned 1000, actual 1200, variance +200 (over budget) | N/A |
| Project with no budget set | `budget` is null | No variance shown, explicit "No budget set" message, not a comparison against zero | N/A |
| Project with a budget and zero costs so far | `budget=1000`, no costs yet | Shows planned 1000, actual 0, variance -1000 | N/A |

</frozen-after-approval>

## Code Map

- `web/src/lib/reporting.ts` (Story 6.2) -- `computeProjectProfitability`'s exact `accumulatedCosts` figure to compare against budget, no new cost calculation needed
- `web/src/app/companies/[id]/projects/page.tsx` (line ~153-154) -- existing `budget` display pattern on the list to extend with a link to the new comparison, or inline variance if trivial
- `web/src/lib/dal.ts` -- `Project`/`ProjectWithRelations` types already carry `budget: number | null`, no DAL change needed for the field itself

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/reporting.ts` -- extend `computeProjectProfitability`'s return type with `budget: number | null` and `budgetVariance: number | null` (`accumulatedCosts - budget`, `null` when `budget` is null)
- [x] `web/src/app/companies/[id]/reports/profitability/page.tsx` (Story 6.2) -- add a "Budget" and "Variance" column to the project rows (showing "No budget set" when `budget` is null, styled to distinguish over/under)

**Acceptance Criteria:**
- Given a project has a budget set, when I view its budget-vs-actual, then I see the planned amount, actual accumulated cost, and variance
- Given a project has no budget set, then no variance is shown, only an explicit "No budget set" indicator
- Given a project is over budget, then the variance is visually distinguishable from an under-budget project

## Implementation Notes

- `computeProjectProfitability` now fetches the project's own `budget` (`projects.budget`, scoped by `company_id` + `id`, via `.maybeSingle()`) alongside its existing sales/cost/allocation/work queries, and returns `budget: number | null` plus `budgetVariance: number | null` (`accumulatedCosts - budget`; `null` whenever `budget` is `null`, never compared against zero).
- The profitability report page (`.../reports/profitability/page.tsx`) adds "Budget" and "Variance" columns to the project table: budget shows an em dash when unset, variance shows "No budget set" (neutral zinc) when `budget`/`budgetVariance` is `null`, otherwise red for over-budget (`variance > 0`) and green for under-budget, with a leading `+` on positive variances.
- No DAL or migration changes were needed -- `Project`/`ProjectWithRelations` already carried `budget`; this story only extends the reporting engine and the report page as scoped.
- **Browser-verified end to end, all four I/O matrix rows**: created a client and a project with `budget=1000` and no costs yet — confirmed "Budget 1,000.00 / Variance -1,000.00". Added a direct cost of 1500 to the project — confirmed "Budget 1,000.00 / Variance +500.00" (in red, visually distinct). Created a second project with no budget — confirmed "— / No budget set" (neutral, not a comparison against zero). All test data (client, 2 projects, cost document) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

No new migration, no new query beyond what Story 6.2 already computes — this is a small, additive extension of `computeProjectProfitability`'s existing accumulated-cost figure, displayed on the report page Story 6.2 already built.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Set a project's budget, add costs above and below it, confirm variance sign and value are correct in both directions
- Confirm a project with no budget shows no variance
- Browser-verify the profitability report's new budget/variance columns
