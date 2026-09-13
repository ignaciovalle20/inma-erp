# Epic 6 Context: Profitability Engine & Reporting

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Deliver a single trustworthy engine that computes the monthly economic result, profitability by client/project/business area, and budgeted-vs-actual — always calculated from underlying documents, never a manually entered figure — with drill-down to source records and explicit visibility of pending (not-yet-known) costs. The engine must be validated against a real historical month of Chile and Uruguay data before it's relied on for real decisions.

## Stories

- Story 6.1: Monthly Result Report
- Story 6.2: Profitability by Client, Project & Area
- Story 6.3: Budgeted vs. Actual
- Story 6.4: Drill-Down from Any Report Figure
- Story 6.5: Consolidated Chile + Uruguay Result in USD
- Story 6.6: Period Recognition for Multi-Month Projects
- Story 6.7: Validate Engine Against a Real Historical Month

## Requirements & Constraints

- Financial levels are distinct and must not be conflated: net sales (amount excluding recoverable taxes) → direct margin (net sales − attributable direct costs) → operating result (direct margin − general/structure costs for the period) → optionally adjusted management result. Project profitability = recognized income − all attributable costs, tracked both accumulated (life-to-date) and per-period.
- An empty/missing cost is never treated as zero — the system must distinguish "confirmed zero cost" from "pending cost," and reports must show a confirmed result separately from the amount still uncertain due to pending costs.
- Shared/general costs can be distributed by percentage or amount across project, client, area, or general expense; a cost must never be double-counted between a sales line and an imported supplier document.
- Recoverable VAT/taxes are never treated as profit or operating expense.
- Every aggregated report figure must be drillable down to the underlying sales/cost documents and lines that compose it, each linkable to its record.
- Corrections must be possible with full audit trail (user + timestamp); documents already used in reports should not be silently deleted.
- Success criterion for the epic: for a real month, produce net sales/direct margin/operating result for Chile and Uruguay, reconcile against known reference figures, and resolve any differences (as engine bugs or data-entry corrections) before sign-off.

## Technical Decisions

- All financial entities belong explicitly to one company; amounts and currency are always stored in their original currency — consolidation/conversion is a derived, non-destructive report-time operation (relevant data model: `sales_documents`/`sales_lines`, `cost_documents`/`cost_lines`, `cost_allocations`, `projects`, `management_periods`, `currencies`/`exchange_rates`).
- Consolidated Chile+Uruguay report is shown in USD. Exchange rates are fetched automatically from MonedAPI (`monedapi.ar` v2): `GET /api/v2/clp/oficial` and `GET /api/v2/uyu/oficial`, returning `buy`/`sell`/`updatedAt`/`currency`/`origin`. Authentication requirement is unconfirmed — verify when implementing.
- **Before building Story 6.5's conversion logic**: empirically verify whether MonedAPI's `buy`/`sell` for `clp`/`uyu` are quoted against USD or against ARS (the API is Argentine FX-market-oriented, so it may need triangulation via an ARS/USD rate). This check must happen first, not be assumed.
- If the exchange rate source is unavailable for a period, flag that period as "pending exchange rate" rather than using a stale or zero rate — consistent with the broader rule of using explicit states (`pending`/`confirmed`/`not_applicable`) instead of defaulting absent data to zero.
- Default period recognition for multi-month projects is the document's own date (simple rule); manual reassignment of a document's recognized period must be saved with user/timestamp and visible in the project's history, without altering the original document date.
- The profitability/reporting engine should be built as shared calculation logic reused identically by the monthly result report and the client/project/area profitability reports (single source of truth for the math).
- Enforce RLS by company: a user only sees results for companies they're authorized on.

## Cross-Story Dependencies

- Stories 6.1–6.4 depend on a working single calculation engine and on prior epics' data (sales, costs, allocations, projects, recurring services, personnel costs) already being entered/imported correctly.
- Story 6.5 (USD consolidation) depends on 6.1 producing correct per-company results first, plus the MonedAPI verification step noted above.
- Story 6.6 (period recognition) affects how 6.1–6.3 attribute multi-month project income/costs to a period, so it should be settled before those reports are considered final for multi-month projects.
- Story 6.7 (historical validation) is the epic's acceptance gate: it depends on 6.1, 6.2, and 6.3 being implemented and exercises them against real Chile/Uruguay data before sign-off.
