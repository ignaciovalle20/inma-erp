# Epic 3 Context: Costs, Expenses & Allocation

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Give users a reliable way to record direct and general (overhead) costs/expenses for their company, split shared costs fairly across the projects/clients/areas that actually consumed them, and keep margin figures trustworthy by never letting an absent cost silently pass as zero. This epic also guards against double-counting a cost that starts life on a sales line and later reappears as an imported supplier document. It is the cost-side counterpart to Epic 2 (income) and is a direct dependency for Epic 6's profitability engine, which relies on accurate, non-duplicated, correctly-flagged cost data.

## Stories

- Story 3.1: Manual Cost/Expense Entry
- Story 3.2: Cost Allocation Across Projects, Clients & Areas
- Story 3.3: Track Pending vs. Confirmed-Zero Costs
- Story 3.4: Prevent Duplicate Cost Counting

## Requirements & Constraints

- Cost/expense documents must be modeled as their own distinct entity (cost document + cost lines), never merged with sales or payment records into a generic transaction table.
- Every cost document is classified as either "direct" (tied to a specific project/client) or "general" (company-level overhead); this classification drives whether allocation is needed.
- Shared/general costs must support distribution across two or more targets (project, client, or business area) by percentage or fixed amount; allocations must validate to 100% (or the full cost amount) before saving.
- Reports must reflect only a target's allocated share of a shared cost, not the full original amount.
- An absent cost must never be displayed or aggregated as zero. The system must use explicit states — "pending" (not recorded yet) vs. "confirmed zero" (deliberately no charge) — and these must be visually/structurally distinguishable everywhere they appear, including in aggregated margin figures (pending costs are flagged and excluded from a "confirmed margin" total, shown separately).
- Costs already tied to a sales line must be checked against later-imported supplier documents for potential duplicates; a match is flagged for user review, not auto-merged or auto-rejected. Once a user resolves a duplicate, only one instance counts toward margin, but both records stay linked for traceability (never silently deleted).
- Every company-scoped entity is subject to RLS: a user can only see/modify cost data for companies they're authorized for.
- Sensitive entities (cost documents, allocations) must record creating/modifying user and timestamps.
- Corrections must be traceable; a cost document already used in a report must never be silently deleted — only voided/deactivated.
- All schema changes ship as versioned SQL migrations committed to GitHub.

## Technical Decisions

- Data model tables relevant to this epic: `cost_documents`, `cost_lines`, `cost_allocations`, plus references to `projects`, `clients`, `business_areas`, and `suppliers` established in Epic 1.
- `cost_allocations` is the mechanism for distributing one shared cost across multiple projects/clients/areas — this is also the mechanism used (optionally) for per-client/project proration of general/overhead expenses, per the resolved decision that overhead is shown at company level by default with proration as an opt-in use of this same allocation table.
- Multi-currency foundation applies here too: each cost document keeps its original currency/amount; any consolidated-currency view is a derived conversion, never an overwrite of source values.
- Duplicate-cost detection (Story 3.4) is a precursor/complement to the Chile importer's own duplicate detection (Epic 4) — the two are related but distinct: Epic 4 detects duplicate *sales* rows on import; Epic 3 detects a *cost* that was already captured via a sales line before a matching supplier document is imported.

## Cross-Story Dependencies

- Depends on Epic 1 for `companies`, `clients`, `suppliers`, `business_areas`, and `projects` existing and RLS-scoped.
- Story 3.2 (allocation) depends on Story 3.1 (base cost document/classification) existing first.
- Story 3.4 (duplicate prevention) anticipates the Epic 4 Chile importer producing supplier documents that need to be checked against costs already linked via sales lines — full end-to-end exercise of this flow likely completes once Epic 4 ships, but the detection/flagging logic itself belongs to this epic.
- Epic 5 (Personnel/Labor Costs) and Epic 6 (Profitability Engine) both consume the pending/confirmed-zero cost states and allocation shares defined here; Epic 6's "confirmed margin" and pending-cost visibility (FR23) build directly on Story 3.3.
