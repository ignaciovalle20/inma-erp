---
title: 'Story 3.3: Track Pending vs. Confirmed-Zero Costs'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '23fb3711705d44aff00ecfbcdea2d1d30f0b34d8'
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Per FR17/NFR6, an absent cost must never be silently treated as zero — but today a project with no `cost_documents` for a given month is indistinguishable from one that genuinely had no cost that month. Neither state is recorded anywhere.

**Approach:** Add a `project_cost_confirmations` table: one row per `(project_id, period)` marking that a human deliberately confirmed "no cost for this project this month" (`confirmed_zero`). No row is ever inserted for "pending" — pending is the absence of both a confirmation row and any `cost_documents` for that project+period, computed at read time. A small monthly view on the Projects page shows each active project's status for the selected period: "Has costs" (documents exist), "Confirmed zero" (a confirmation row exists), or "Pending" (neither).

## Boundaries & Constraints

**Always:** a confirmation is scoped to one `(project_id, period)` pair, `period` stored as the first day of its month; confirming a project+period that already has `cost_documents` for that month is rejected (confirming zero and having real costs are mutually exclusive facts about the same period); a confirmation records who/when (audit cols), matching the app's existing pattern for sensitive entities; the three states (`has_costs`/`confirmed_zero`/`pending`) are computed, never stored redundantly — `cost_documents` remains the single source of truth for "has costs."

**Decisions (made autonomously, with reasoning — the PRD specifies the requirement but not the mechanism, so this is a genuine design call):** scoped to **projects**, not sales documents — Story 3.3's own acceptance criteria says "a sale or project has no linked cost yet," and a project is the entity `direct` costs already attach to via `cost_documents.project_id`; a "sale" has no structural cost-expectation link in this schema (that's Epic 6's margin computation, which doesn't exist yet). Scoped to **general/company-level review by month**, not a bespoke report — Epic 6 (the actual reporting/margin engine that would consume this pervasively, per the epic's own "Epic 6's 'confirmed margin' ... build directly on Story 3.3" dependency note) isn't built yet, so this story delivers the underlying mechanism plus the one place it can meaningfully surface today (the Projects list) rather than a report UI that has nothing to report from yet. Only `general`-adjacent absence is tracked this way for now — a `direct` cost project either has documents or doesn't; this story doesn't retroactively require every historical month to be confirmed, only going forward from whenever a user chooses to.

**Never:** build Epic 6's margin/profitability report (out of scope, no report engine exists); apply this to sales documents (no requirement or structural link supports it yet); auto-mark anything as `confirmed_zero` (always an explicit human action); allow un-confirming by deleting the row silently — removing a confirmation is a distinct explicit action, not a side effect of something else.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Confirm zero, no costs exist | Project + period with zero `cost_documents` | Confirmation row saved | N/A |
| Confirm zero, costs already exist | Project + period that already has `cost_documents` | Blocked | Validation error, no insert |
| View status, no confirmation and no costs | Project + period, neither exists | Shows "Pending" | N/A |
| View status, confirmation exists | Project + period has a confirmation row | Shows "Confirmed zero" | N/A |
| View status, costs exist | Project + period has `cost_documents` | Shows "Has costs" (confirmation irrelevant/blocked from existing here) | N/A |
| Remove a confirmation | Existing confirmation row | Deleted; status reverts to "Pending" | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260913020000_epic3_story1_cost_documents.sql` -- `cost_documents` shape (`project_id`, `document_date`) to query against when computing "has costs" for a period
- `supabase/migrations/20260912190000_epic1_story6_manage_projects.sql` -- `projects` shape (`id`, `company_id`, `status`) to FK against and to filter the list to active projects
- `web/src/lib/dal.ts` -- `getProjects(companyId)` (line ~468) to extend with per-period status, or add a new `getProjectCostStatus(companyId, period)` batched function; no existing period-selector pattern anywhere in the app to reuse — this is the first
- `web/src/app/companies/[id]/projects/page.tsx` -- existing projects list to extend with a period selector + status column, rather than building a separate page (this is where "which projects need cost review this month" naturally belongs)

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic3_story3_project_cost_confirmations.sql` -- `project_cost_confirmations` (`id`, `project_id` not null fk projects, `period date not null` check `period = date_trunc('month', period)::date`, unique `(project_id, period)`, audit cols `confirmed_by`/`confirmed_at` default `auth.uid()`/`now()`, optional `note text`); RLS any-member SELECT/INSERT/DELETE scoped through `projects.company_id`; `confirm_project_cost_zero(p_project_id uuid, p_period date)` RPC -- rejects if any `cost_documents` exist for that `project_id` with `document_date` in that month, otherwise inserts (or no-ops if already confirmed); a plain DELETE (via RLS, no RPC needed) removes a confirmation
- [x] `web/src/lib/dal.ts` -- `getProjectCostStatus(companyId, period)` returning each active project with a computed `status: 'has_costs' | 'confirmed_zero' | 'pending'` for that period (one query against `cost_documents` grouped by project+month, one against `project_cost_confirmations`, merged in code — no new view needed for this scale)
- [x] `web/src/app/companies/[id]/projects/page.tsx` -- add a month selector (defaulting to the current month) and a status column/badge per project ("Has costs" / "Confirmed zero" / "Pending"); a "Confirm zero" action button on `pending` rows, a "Remove confirmation" action on `confirmed_zero` rows
- [x] `web/src/app/companies/[id]/projects/actions.ts` (new or extended) -- `"use server" confirmProjectCostZero(companyId, projectId, period)` calling the RPC; `removeProjectCostConfirmation(companyId, projectId, period)` doing the DELETE

**Acceptance Criteria:**
- Given a project with no cost documents for the selected month and no confirmation, when I view the projects list, then it shows "Pending", never blank or $0
- Given I confirm zero for that project+period, then it shows "Confirmed zero" and is visually distinct from "Pending"
- Given I attempt to confirm zero for a project+period that already has cost documents, then it's blocked with a clear error
- Given a project has cost documents for the selected month, then it shows "Has costs" regardless of any prior confirmation attempt
- Given I remove an existing confirmation, then the project reverts to "Pending" for that period

## Implementation Notes

- **Verified against the linked Supabase project** (`gpxeikzpqldpxdijbsfs`): migration applied live; `confirm_project_cost_zero` tested with real (temporary) test data — confirming zero with no cost documents succeeds, confirming a project+month that already has a `cost_documents` row is correctly rejected, and deleting a confirmation reverts the status. All test data cleaned up afterward.
- **Browser-verified end to end**: created a real client + project, confirmed the Projects list showed "Pending" with a "Confirm zero" button by default; clicked it, confirmed the badge changed to "Confirmed zero" with a "Remove confirmation" button; clicked that, confirmed it reverted to "Pending"; created a real direct cost document for that project in the same month, confirmed the badge changed to "Has costs" with no confirm/remove buttons shown (correctly gated). All test data (client, project, cost document) deleted afterward via `supabase db query --linked`, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

No `security definer` needed on `confirm_project_cost_zero` — same reasoning as every other RPC in this codebase (caller already has RLS-authorized INSERT rights on `project_cost_confirmations` once its policy exists).

This story deliberately does NOT build a margin/profitability view — Epic 6 doesn't exist yet, so there's no "confirmed margin" total to exclude pending costs from. What this story delivers is the raw fact-recording mechanism (a project+period is genuinely zero-cost vs. simply unrecorded) and the one place it's checkable today. When Epic 6 is built, its report reads `project_cost_confirmations` and the absence-vs-presence-of-`cost_documents` computation this story establishes.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- As a company member: confirm zero-cost for a project+period with no cost documents, confirm the status shows "Confirmed zero"
- Attempt to confirm a project+period that already has cost documents — confirm rejected
- Remove a confirmation, confirm status reverts to "Pending"
- Browser-verify the projects list: month selector changes the shown status per project, action buttons work
