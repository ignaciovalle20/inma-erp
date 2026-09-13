---
title: 'Story 6.6: Period Recognition for Multi-Month Projects'
type: 'feature'
created: '2026-09-13'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '380ad23c8c011c265cfb3bf0515473a1d2ebc25d'
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every report (6.1-6.4) attributes a document to a period purely by its `document_date` — a multi-month project's income/cost can't be recognized against the period it actually reflects (e.g., an invoice dated at project kickoff for work spanning several months) without an audited override.

**Approach:** Add a nullable `recognized_period` (+ `recognized_period_set_by`/`recognized_period_set_at`) to both `sales_documents` and `cost_documents`. When null (the default), a document's effective period is its own `document_date`'s month — the existing simple rule, unchanged. A narrow, single-purpose RPC per table reassigns only these three columns (never the financial fields), preserving `document_date` exactly as entered. Every `reporting.ts` query switches from filtering on raw `document_date` to filtering on the effective period (`recognized_period` when set, else `document_date`'s month).

## Boundaries & Constraints

**Always:** `document_date` is never altered by a period reassignment — it stays the original entry date forever; every reassignment records who/when; every report figure (6.1-6.4) uses the *effective* period consistently — a document reassigned into or out of a period must move with it in every report, not just some; the reassignment RPC touches only `recognized_period`/`recognized_period_set_by`/`recognized_period_set_at` — never `net_amount`/`total_amount`/lines/classification, keeping this a strictly narrower capability than full document editing (which stays out of scope for `cost_documents`, per Story 6.4's own boundary).

**Decisions (made autonomously, with reasoning — the AC's "visible in the project's history" doesn't specify a dedicated history page, and none exists yet):** the reassignment audit is shown on the document's own detail page (sales edit page; the cost detail page Story 6.4 just added) as a small "Recognized in {period}, reassigned by {user} on {date}" note — reachable from the project's own profitability drill-down (Story 6.4), which is the existing path to "a project's documents." Building a dedicated project-history aggregation page is bigger scope than this one AC line justifies, and no story has ever asked for one; if a true per-project audit log is wanted later, that's a new story. Reassignment is available on any sales/cost document (not restricted to project-tied ones) — the AC frames the problem around multi-month projects, but nothing requires artificially blocking reassignment on a document with no project, and doing so would add complexity for no stated benefit.

**Never:** allow reassignment to alter `document_date` or any financial figure; build a dedicated project-history/audit-log page (out of scope, see Decisions); build period-by-period revenue-spreading/proration (the AC describes reassigning a document wholesale to one period, not splitting one document's amount across several).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Document with no reassignment | `recognized_period` is null | Reports use `document_date`'s month, exactly as before this story | N/A |
| Document reassigned to a different month | `recognized_period` set | Every report (6.1-6.4) attributes it to the new period, not `document_date`'s month | N/A |
| Reassign, then view the document | Any reassigned document | Detail page shows "Recognized in X, reassigned by Y on Z"; `document_date` field itself is unchanged | N/A |
| Reassignment RPC called with a non-month-start date | Invalid `recognized_period` | Rejected | Validation error |

</frozen-after-approval>

## Code Map

- `web/src/lib/reporting.ts` -- every `compute*` function's `document_date` range filter (12+ call sites per investigation) to convert to an effective-period filter via `.or()`: `(recognized_period.is.null AND document_date in range) OR (recognized_period in range)`
- `supabase/migrations/20260913020000_epic3_story1_cost_documents.sql`, `.../20260912210000_epic2_story1_sales_documents.sql` -- exact current schemas to extend
- `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/page.tsx`, `.../costs/[costDocumentId]/page.tsx` (Story 6.4) -- existing detail pages to add the reassignment action + audit note to

## Tasks & Acceptance

**Execution:**
- [ ] `supabase/migrations/<ts>_epic6_story6_period_recognition.sql` -- add `recognized_period date` (nullable, check `= date_trunc('month', recognized_period)::date` when non-null), `recognized_period_set_by uuid references auth.users(id)`, `recognized_period_set_at timestamptz` to both `sales_documents` and `cost_documents`; `reassign_sales_document_period(p_sales_document_id uuid, p_period date) returns sales_documents` and `reassign_cost_document_period(p_cost_document_id uuid, p_period date) returns cost_documents` RPCs -- each validates `p_period` is month-start, updates only the three new columns + sets `set_by`/`set_at`, never touches financial fields
- [ ] `web/src/lib/reporting.ts` -- update every period-range query (sales and cost, across `computeMonthlyResult`, `computeClientProfitability`, `computeProjectProfitability`, `computeAreaProfitability`) to filter by effective period via `.or()`, selecting `recognized_period` alongside existing columns
- [ ] `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/page.tsx` -- add a small "Reassign period" form (month input) calling the new RPC via a server action; show the audit note when `recognized_period` is set
- [ ] `web/src/app/companies/[id]/costs/[costDocumentId]/page.tsx` -- same reassignment form + audit note for cost documents

**Acceptance Criteria:**
- Given a document with no reassignment, then it's recognized in its `document_date`'s month, exactly as before
- Given I reassign a document's period, then it's saved with user/timestamp, shown on the document, and every report figure reflects the new period, not the old one
- Given a reassigned document, then its `document_date` is unchanged

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

Neither RPC is `security definer` — same reasoning as every other RPC in this codebase.

The `.or()`-based effective-period filter is a mechanical, uniform change across every `reporting.ts` query — no calculation logic changes, only which rows a query considers "in period."

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Create a sale in month A, reassign it to month B, confirm the monthly result for A no longer includes it and B does
- Confirm `document_date` is unchanged after reassignment
- Browser-verify the reassignment form and audit note on both a sales and a cost document
