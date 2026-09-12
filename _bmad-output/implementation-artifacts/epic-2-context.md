# Epic 2 Context: Manual Income Entry

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Enable users in both Chile and Uruguay to manually create, edit, and correct sales/income documents — capturing net amount, tax, total, and original currency correctly — through a flow fast enough for daily operational use (Uruguay has no import path and relies on this entirely; Chile always has it available alongside its future importer). This is the manual-entry counterpart to Epic 4's Chile importer, and both must remain independently usable — manual entry is never replaced by import.

## Stories

- Story 2.1: Manual Sales Document Entry (multi-line documents, net/tax/total calculated and stored)
- Story 2.2: Edit & Correct Sales Documents with Audit Trail (post-report corrections, void instead of delete)
- Story 2.3: Fast Manual Entry Flow for Uruguay (streamlined form, sensible defaults, minimal required fields)

## Requirements & Constraints

- A sales/income document must store net amount, tax, and total as separate values, computed automatically from its lines — never entered as a single blended figure.
- Recoverable VAT/tax must be excluded from profit and operating-expense calculations, but the tax and total amounts must still be retained on the document (don't discard them, just don't fold them into margin).
- The original currency and amount of every document must be preserved exactly as entered; any currency conversion for consolidated reporting is a derived, separate value and must never overwrite the source record.
- Sales/income documents, cost documents, and payments are distinct entities — sales entry must never merge into a generic transaction table shared with costs or payments.
- Documents already referenced by a generated report must never be silently deleted or silently overwritten on edit; corrections require an audit trail (modifying user, timestamp, visible change marker), and removal must be a void/deactivate, not a hard delete.
- Every sales document and line carries creating/modifying user and timestamps (applies broadly to sensitive entities, sales documents included).
- The manual entry flow must be fast enough for everyday operational use — this is a binding usability requirement, not just a nice-to-have, since it is Uruguay's only entry path and Chile's always-available path.
- Margin is never a manually entered value anywhere in the system — relevant background, since income entered here later feeds margin calculation in Epic 6, but margin itself is out of scope for this epic.

## Technical Decisions

- Data model: `sales_documents` (header — type, date, client, currency, computed net/tax/total) and `sales_lines` (detail, one or more lines per document) are separate tables; a document's totals are derived by summing/recalculating from its lines whenever lines are added or removed, not stored independently of them.
- Every financial entity belongs explicitly to one company (multi-company foundation from Epic 1); sales documents are always scoped to a single company via RLS.
- Stack: Next.js (App Router) + TypeScript on Vercel; Supabase (Postgres/Auth/RLS) as backend. Schema changes ship as versioned SQL migrations, no unmigrated manual changes.
- Screen location per architecture's screen map: sales entry lives under "Ingresos" → "Documentos de venta" / "Carga manual" (import CSV/Excel is a separate item under the same section, built in Epic 4).

## UX & Interaction Patterns

- No dedicated UX design spec exists for this project; screen/interaction detail is resolved at the story level.
- Uruguay's entry screen should default currency to UYU and require only client, date, amount, and area to save — everything else optional.
- After saving, the form should reset in place for immediate re-entry of the next document, without extra navigation (rapid back-to-back data entry is the primary use case).

## Cross-Story Dependencies

- Depends on Epic 1 master data: companies, clients, and business areas must exist before a sales document can be created against them.
- Feeds Epic 6 (Profitability Engine): sales documents/lines created here are the income-side input to the monthly result, profitability, and drill-down reports.
- Runs alongside Epic 4 (Chile CSV/Excel Importer): the importer must never become the sole path for Chile — manual create/edit from this epic must stay fully functional and is the fallback for any record the importer can't handle.
- Story 2.2's audit/void pattern (correction trail, no silent delete) should stay consistent with the equivalent handling expected for cost documents in Epic 3.
