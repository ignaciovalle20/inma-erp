---
title: 'Story 3.1: Manual Cost/Expense Entry'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'e16a4b1bce8c3aa8b19bb26bb41a7c9ab61553fb'
context: ['_bmad-output/implementation-artifacts/epic-3-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No cost/expense entity exists yet. Profitability calculations (Epic 6) need cost documents with net/tax/total computed correctly, classified as "direct" (tied to a project) or "general" (company overhead), so later stories (3.2 allocation, 3.3 pending-tracking) have a base to build on.

**Approach:** Mirror Epic 2 Story 2.1's `sales_documents`/`sales_lines` pattern exactly, swapping client→supplier and adding a `classification` column (`direct`/`general`) that gates whether `project_id` is required. One `create_cost_document` RPC inserts header + lines atomically, computing `net_amount`/`total_amount` server-side — never trusting client-submitted totals. Any member creates cost documents (same access model as sales). No edit/void, no allocation, no pending/confirmed-zero states, no duplicate detection — those are Stories 3.2/3.3/3.4.

## Boundaries & Constraints

**Always:** `net_amount`/`total_amount` computed server-side from lines + `tax_amount`, never accepted as raw client input; a document needs at least one line to save; original `currency` stored exactly as entered; `supplier_id` (when provided) and `project_id` (when classification is `direct`) validated to belong to the same `company_id` via a DB trigger (reusing Story 1.6/2.1's cross-company pattern, not just an app check); `classification = 'direct'` requires a non-null `project_id`, `classification = 'general'` requires a null `project_id` (DB check constraint).

**Decisions (made autonomously — none would surprise the user in the result):** `supplier_id` is nullable — not every cost has a registered supplier (e.g. bank fees, misc charges), and the epic's requirements never mandate one; classification is its own `text check in ('direct','general')` column, separate from any paper-document-type field, since the epic only asks for this binary split and nothing else — no `document_type` (invoice/receipt/etc.) field is added for costs, avoiding an unrequested field the epic never asks for.

**Never:** build edit/void (future story, mirroring how 2.2 followed 2.1); build allocation across projects/clients/areas (Story 3.2); build pending-vs-confirmed-zero tracking (Story 3.3); build duplicate-cost detection (Story 3.4); merge costs into a shared table with sales/payments; let the client submit `net_amount`/`total_amount` directly.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create, direct cost | `classification='direct'`, valid `project_id`, one line | Document + line saved; `net_amount` = line amount | N/A |
| Create, general cost | `classification='general'`, no `project_id`, one line | Document + line saved | N/A |
| Create, direct with no project | `classification='direct'`, `project_id` omitted | Blocked | DB check constraint violation surfaced as a validation error |
| Create, general with a project | `classification='general'`, `project_id` provided | Blocked | DB check constraint violation surfaced as a validation error |
| Create, no lines | Zero lines | Blocked | Validation error, no insert |
| Project from a different company | Tampered/mismatched `project_id` | Rejected at the DB level | Trigger raises exception |
| Supplier from a different company | Tampered/mismatched `supplier_id` | Rejected at the DB level | Trigger raises exception |

</frozen-after-approval>

## Code Map

- `_bmad-output/implementation-artifacts/spec-2-1-manual-sales-document-entry.md`, `supabase/migrations/20260912210000_epic2_story1_sales_documents.sql`, `.../20260912220000_..._review_patches.sql` -- exact schema/RPC/trigger pattern to mirror 1:1 for costs (header+lines, atomic RPC, cross-company trigger, currency check constraint `in ('CLP','UYU','USD')`)
- `supabase/migrations/20260912160000_epic1_story4_manage_suppliers.sql` -- `suppliers` shape (`id, company_id, name, tax_id, country, notes, active`) to FK against
- `supabase/migrations/20260912190000_epic1_story6_manage_projects.sql` -- `projects` shape (`id, company_id, client_id not null, business_area_id not null, status`); `client_id` is mandatory on projects, so a direct cost's client is implied transitively via `project_id` — no separate `client_id` needed on `cost_documents`
- `web/src/lib/dal.ts` -- `getSuppliers(companyId)` (line ~339), `getProjects(companyId)` (line ~468, returns `ProjectWithRelations`) for the two pickers; add `getCostDocuments(companyId)` following `getSalesDocuments`'s shape
- `web/src/app/companies/[id]/sales/new/{page,actions,form}.tsx` -- structural template: server guard + client-fetch page, `"use server"` action with dynamic-line parsing via `formData.getAll`, client form with add/remove line rows and client-side positive-amount validation
- `web/src/app/companies/[id]/sales/page.tsx` -- list-page template (client, date, currency, net/tax/total) to mirror for `costs/page.tsx` (supplier, classification badge, date, currency, net/tax/total)
- `web/src/app/companies/page.tsx` -- add a "Costs" link next to the existing section links

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic3_story1_cost_documents.sql` -- `cost_documents` (`id`, `company_id` not null fk companies, `supplier_id` nullable fk suppliers, `project_id` nullable fk projects, `classification text not null check in ('direct','general')`, `document_date date not null`, `currency text not null check in ('CLP','UYU','USD')`, `net_amount numeric not null default 0`, `tax_amount numeric not null default 0`, `total_amount numeric not null default 0`, audit cols + `set_updated_at` trigger, plus a check constraint `(classification = 'direct' and project_id is not null) or (classification = 'general' and project_id is null)`) and `cost_lines` (`id`, `cost_document_id` fk cost_documents, `description text`, `amount numeric not null`, audit cols); RLS any-member SELECT/INSERT (no UPDATE/DELETE, same as Story 2.1); a `BEFORE INSERT OR UPDATE` trigger validating `supplier_id`'s and `project_id`'s `company_id` match when non-null; `create_cost_document(p_company_id, p_supplier_id, p_project_id, p_classification, p_document_date, p_currency, p_tax_amount, p_lines jsonb)` computing and inserting document + lines atomically, rejecting non-positive line amounts and negative tax (matching Story 2.1's already-reviewed validation, built in from the start this time)
- [x] `web/src/lib/dal.ts` -- `getCostDocuments(companyId)` mirroring `getSalesDocuments`
- [x] `web/src/app/companies/[id]/costs/page.tsx` -- list (supplier or "—", classification badge, project name when direct, date, currency, net/tax/total), "New cost document" link
- [x] `web/src/app/companies/[id]/costs/new/page.tsx` + `actions.ts` + `form.tsx` -- classification select (direct/general) that toggles a project picker (active projects only, required when direct, hidden/cleared when general); supplier picker (active suppliers, optional — includes a "No supplier" option); dynamic add/remove line rows mirroring `sales/new/form.tsx`; currency defaults to the company's base currency; calls `create_cost_document` via RPC; client-side rejection of zero/negative line amounts and of a direct/general + project_id mismatch before submit
- [x] `web/src/app/companies/page.tsx` -- add a "Costs" link

**Acceptance Criteria:**
- Given I create a direct cost with a valid project and one line, when I submit, then `net_amount`/`total_amount` are computed server-side and the document is saved with that `project_id`
- Given I create a general cost with no project, when I submit, then it saves successfully with `project_id` null
- Given I submit a direct cost without a project (or a general cost with one), then it's blocked with a validation error, not a raw DB error
- Given I submit with zero lines, then it's blocked with a validation error
- Given a tampered `project_id` or `supplier_id` from a different company is submitted, then the DB trigger rejects it

## Implementation Notes

- **Verified against the linked Supabase project** (`gpxeikzpqldpxdijbsfs`): migration applied live; all 5 I/O matrix scenarios plus extras (zero-amount line, negative tax) run inside a transaction rolled back afterward — direct cost with valid project succeeded (net=1000/tax=190/total=1190), general cost with no project succeeded, direct-without-project and general-with-project both rejected by the check constraint, empty line set rejected, cross-company `project_id` and `supplier_id` both rejected by the trigger.
- **Browser-verified end to end**: logged in as an existing company member, navigated Companies → Costs → New cost document; confirmed the classification toggle hides/shows the project picker live (no page reload); submitted a general cost (no project, no supplier, amount 500) and confirmed it landed on the list as "General · 2026-09-13 · CLP · Net 500 + Tax 0 · Total 500". Test document deleted afterward via `supabase db query --linked`, confirmed no residue.

## Spec Change Log

## Review Triage Log

## Design Notes

`create_cost_document` is a plain function (not `security definer`), same reasoning as `create_sales_document` — caller already has RLS-authorized INSERT rights.

No `document_type` (invoice/receipt/etc.) field on cost documents — the epic only asks for the direct/general classification; a paper-type field would be unrequested scope.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new `/companies/[id]/costs` routes register

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- As a company member: create a direct cost tied to a real project, confirm net/tax/total computed correctly
- Create a general cost with no project, confirm it saves
- Attempt a direct cost with no project, and a general cost with a project — confirm both rejected
- Attempt the cross-company `project_id`/`supplier_id` bypass technique from Story 2.1's review — confirm the new trigger rejects both
