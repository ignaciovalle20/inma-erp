---
title: 'Story 6.4: Drill-Down from Any Report Figure'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '804fe9370dc7c33e404a8058e52e24d13a5e9cb3'
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Every figure across the three reports (6.1 monthly result, 6.2 profitability, 6.3 budget variance) is a plain number — nothing links back to the sales/cost documents that compose it, so a user can't verify or trust what's behind a total. Blocking gap found during investigation: `cost_documents` has no detail/edit page at all (only `costs/[costDocumentId]/allocate` exists) — "linkable to its record" has nowhere to land for costs today.

**Approach:** Add optional filter query params (date range + client/project/area/classification) to `getSalesDocuments`/`getCostDocuments` and their list pages; turn each report figure into a link to the correspondingly-filtered list. Add a minimal read-only cost document detail page (new — none exists) so a drilled-down cost row is linkable to its own record, matching the sales side's existing edit page.

## Boundaries & Constraints

**Always:** a drill-down link filters to exactly the same rows the figure's calculation summed — the filtered list total must reconcile with the report figure it came from; every listed row remains linkable to its own record (sales → existing edit page; costs → new read-only detail page); filters are plain GET query params, no new state/session mechanism.

**Decisions (made autonomously, with reasoning — the AC says "sales/cost documents," not personnel records):** drill-down covers `sales_documents` and `cost_documents` only — the AC's own wording is "the underlying sales/cost documents and lines," not personnel costs; the monthly result's `generalCosts` figure (which blends `cost_documents` classification='general' with `personnel_costs`) links only to the `cost_documents` portion, with the personnel portion shown as a labeled, non-linking sub-figure (each personnel cost record is already individually viewable from its own person's cost page — Story 5.2 — just not from an aggregate cross-person list, which would be new scope this story's AC doesn't ask for). Cost documents need a genuinely new detail page (`costs/[costDocumentId]/page.tsx`) since none exists — read-only (no edit form), since building edit capability for cost documents was never in any prior story's scope and isn't requested here either.

**Never:** build cost document editing (out of scope, no story has ever requested it); build a cross-person aggregate personnel-cost list (not requested, AC only names sales/cost documents); change any report's calculation logic (this story only adds navigation, never touches the numbers from 6.1-6.3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Click "Net sales" on the monthly result | Period X | Sales list filtered to that period, non-voided; sum of shown rows matches the report figure | N/A |
| Click "Direct costs" on the monthly result | Period X | Cost list filtered to that period, `classification='direct'` | N/A |
| Click a client's revenue in the profitability report | Client X, period Y | Sales list filtered to that client + period | N/A |
| Click a project's costs in the profitability report | Project X, period Y | Cost list filtered to that project (direct) + period; allocation/work-allocation shares are not separately listable rows (they're not documents themselves) -- noted inline | N/A |
| Open a cost document from the filtered list | Any cost document | New read-only detail page shows its full data (header + lines) | N/A |

</frozen-after-approval>

## Code Map

- `web/src/lib/dal.ts` -- `getSalesDocuments(companyId)`/`getCostDocuments(companyId)` to extend with an optional filter object (`{from?, to?, clientId?, projectId?, businessAreaId?, classification?}`); `getSalesDocumentForEdit`'s field list as the template for the new cost detail page's query
- `web/src/app/companies/[id]/sales/page.tsx`, `.../costs/page.tsx` -- plain unfiltered lists today; add `searchParams` reading + a visible active-filter summary
- `web/src/app/companies/[id]/sales/[salesDocumentId]/edit/page.tsx` -- existing detail/edit page to link sales rows to (reused as-is, no changes)
- `web/src/lib/reporting.ts` -- exact figure-to-query mapping already documented in each `compute*` function's own logic, to mirror precisely in each drill-down link's filter params so sums reconcile
- `web/src/app/companies/[id]/reports/monthly-result/page.tsx`, `.../reports/profitability/page.tsx` -- figures to convert from plain text to links

## Tasks & Acceptance

**Execution:**
- [x] `web/src/lib/dal.ts` -- extend `getSalesDocuments`/`getCostDocuments` with an optional filters parameter (date range, `client_id`, `project_id`, `business_area_id` for sales; date range, `project_id`, `classification` for costs), applied via additional `.eq()`/`.gte()`/`.lte()` calls when present
- [x] `web/src/app/companies/[id]/costs/[costDocumentId]/page.tsx` (new) -- read-only detail: header fields (supplier, project, classification, date, currency, net/tax/total) + its lines, mirroring the sales edit page's data display but without a form
- [x] `web/src/app/companies/[id]/sales/page.tsx`, `.../costs/page.tsx` -- read filter query params from `searchParams`, apply via the extended DAL calls, show a clear active-filter summary with a "Clear filters" link back to the unfiltered list
- [x] `web/src/app/companies/[id]/reports/monthly-result/page.tsx` -- "Net sales" links to `/sales?from=X&to=Y`; "Direct costs" links to `/costs?from=X&to=Y&classification=direct`; "General costs" shows the `cost_documents` portion as a link to `/costs?from=X&to=Y&classification=general` plus a non-linking "of which personnel: $Z" sub-line
- [x] `web/src/app/companies/[id]/reports/profitability/page.tsx` -- client/project/area revenue cells link to the filtered sales list; cost cells link to the filtered cost list (direct costs only, matching what's actually listable as documents)

**Acceptance Criteria:**
- Given any report figure (net sales, direct costs, a client/project/area's revenue or costs), when I click it, then I see the filtered list of underlying documents, and their sum reconciles with the figure
- Given a filtered list, when I open a row, then I reach that document's own record (sales: existing edit page; costs: new detail page)
- Given a cost document has no detail page today, then this story adds one so every drilled-down cost row is linkable

## Implementation Notes

**Browser-verified end to end**: created a client, a sale (700, September 2026), and a general cost document (200, September 2026). Confirmed the monthly result showed Net sales 700.00 / Direct costs 0.00 / Direct margin 700.00 / General costs 200.00 (of which cost documents 200.00, of which personnel 0.00) / Operating result 500.00. Clicked "Net sales" → filtered sales list showed "1 document, net total 700.00" (exact match). Clicked "General costs" → filtered cost list showed "1 document, net total 200.00" (exact match). Opened the new cost document detail page from that list — correctly showed all header fields, lines, and a link to the allocate page. On the profitability report, confirmed the client's revenue figure (700.00 CLP) is a real link with the correct `clientId` filter, distinct from the plain-text client name. All test data (client, sale, cost document) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

The new cost document detail page is deliberately read-only — adding cost-document editing is a much larger scope decision (validation rules, RLS UPDATE policy, void semantics like sales has) that no story has ever requested; building it silently as a side effect of a drill-down story would be scope creep.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new route registers

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- Create sales/cost documents, confirm each report figure's drill-down link shows exactly the rows that sum to that figure
- Open a cost document from a filtered list, confirm the new detail page shows correct data
- Browser-verify every drill-down link end to end
