---
title: 'Story 5.1: Manage Recurring Services'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '2a3b44d8c0ef32f7f7f0ac088731c9995bc2ad88'
context: ['_bmad-output/implementation-artifacts/epic-5-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Recurring client services (Microsoft 365, hosting, Starlink, etc.) have no dedicated record today — each period's income gets re-typed from scratch via the generic sales form, with no memory of price/periodicity/validity between periods.

**Approach:** A `recurring_services` CRUD (client, price, expected cost, periodicity monthly/annual, start/end validity) plus a manual "Generate this period" action per service that creates the period's `sales_documents` entry (amount = price, `source='recurring'`, linked back to the service and period) — never a background job. `expected_cost` is stored on the service as a figure for Epic 6's margin engine to use later; it does not generate a `cost_documents` row (a cost document should correspond to a real supplier charge, not a forecast).

## Boundaries & Constraints

**Always:** a recurring service is scoped to one company and one client; `periodicity` is `monthly` or `annual`; generation is idempotent per `(recurring_service_id, period)` — generating twice for the same period never creates a duplicate; generation is blocked once `end_date` has passed, and blocked before `start_date`; every generated `sales_documents` row still has its `net_amount`/`total_amount` computed server-side exactly like every other creation path in this app, never trusted from client input.

**Decisions (made autonomously, with reasoning):** generation is **manual/prompted** (a button the user clicks), never a cron/scheduled job — Story 5.1's own AC2 explicitly says "generates **(or prompts to generate)**," no scheduling mechanism is specified anywhere in the PRD/architecture, and this app has zero background-job infrastructure anywhere; introducing one for a single story would be large unrequested scope. Generation only produces the **income** side (`sales_documents`) — `expected_cost` is stored as a plain field for Epic 6's future margin computation, not materialized into a `cost_documents` row, since a cost document in this app represents money actually paid (Epic 3's model), not a forecast. "Period" for a `monthly` service is the calendar month; for `annual`, the calendar year — generation is a single one-click action for "this period" only, no bulk backfill across multiple past periods (not requested, and backfilling silently could create surprising bulk income).

**Never:** build any cron/pg_cron/scheduled-job mechanism; auto-generate a `cost_documents` row from `expected_cost`; allow generating for a period outside `[start_date, end_date]`; allow a second generation for the same `(recurring_service_id, period)`; build Epic 6's margin computation (out of scope, this story only produces the inputs).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create a recurring service | Client, price, expected cost, periodicity, start date | Saved, available to generate from | N/A |
| Generate current period, first time | Active service, today within validity | `sales_documents` row created (`source='recurring'`), amount = price | N/A |
| Generate again for the same period | Already generated this period | Blocked | Validation error, no duplicate |
| Generate before start date or after end date | Today outside `[start_date, end_date]` | Blocked | Validation error, no insert |
| Service reaches end date | `end_date` passed | "Generate" action no longer offered/succeeds | N/A |

</frozen-after-approval>

## Code Map

- `web/src/app/companies/[id]/clients/{page,new,[clientId]/edit}.tsx` -- exact CRUD template to mirror (list + new + edit, `active` boolean toggle via the edit form)
- `supabase/migrations/20260912150000_epic1_story3_manage_clients.sql` -- `clients` shape (`id, company_id, name, active`) to FK against
- `supabase/migrations/20260913050000_epic4_story1_import_sales.sql` -- `sales_documents.source` check constraint (`'manual','import'`) to extend with `'recurring'`; the column-addition pattern (nullable FK + companion identifying column) to mirror for `recurring_service_id`/`period`
- `supabase/migrations/20260912210000_epic2_story1_sales_documents.sql` -- `create_sales_document` RPC to reuse/extend rather than duplicate its net/total computation
- `web/src/lib/dal.ts` -- `getClients(companyId)` for the client picker; add `getRecurringServices(companyId)`, `getRecurringServiceForEdit(companyId, id)` mirroring existing single-entity getters

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260913070000_epic5_story1_recurring_services.sql` -- `recurring_services` (`id`, `company_id` not null fk companies, `client_id` not null fk clients, `name text not null`, `price numeric not null`, `expected_cost numeric not null default 0`, `currency text not null check in ('CLP','UYU','USD')`, `periodicity text not null check in ('monthly','annual')`, `start_date date not null`, `end_date date`, `active boolean not null default true`, audit cols + `set_updated_at` trigger); a `BEFORE INSERT OR UPDATE` trigger validating `client_id`'s `company_id` matches (same pattern as `sales_documents_validate_company_refs`); RLS any-member SELECT/INSERT/UPDATE (no DELETE, deactivate via `active=false`, same as clients/suppliers); extend `sales_documents.source` check to include `'recurring'`; add `sales_documents.recurring_service_id uuid references recurring_services(id)` and `sales_documents.recurring_period date` (first-of-period date), with a unique partial index on `(recurring_service_id, recurring_period)` where `recurring_service_id is not null`; `generate_recurring_service_entry(p_recurring_service_id uuid, p_period date) returns sales_documents` RPC -- validates the service is active, normalizes `p_period` to the first of its containing period (month/year per `periodicity`) and checks it falls within `[start_date, end_date or infinity]`, checks no existing entry for that `(service, period)`; computes and inserts a single-line `sales_documents` row (amount = `price`, `tax_amount = 0`, `document_type='manual'`, `source='recurring'`) plus its `sales_lines` row, matching `create_sales_document`'s net/total approach
- [x] `web/src/lib/dal.ts` -- `getRecurringServices(companyId)` (joined with `clients.name`), `getRecurringServiceForEdit(companyId, id)` mirroring `getClients`/`getClientForEdit`'s shape; also added `getGeneratedRecurringServicePeriods(companyId, ids)` (not in the original code map, needed by the list page to know which rows already have a generated entry for their current period)
- [x] `web/src/app/companies/[id]/recurring-services/page.tsx` -- list (client, price, expected cost, periodicity, validity, active badge), a "Generate this period" button per active/in-validity row (hidden once already generated for the current period, outside validity, or inactive), "New recurring service" link; plus `actions.ts` (RPC-calling server action) and `generate-button.tsx` (client component that computes "this period" at click time, per Design Notes)
- [x] `web/src/app/companies/[id]/recurring-services/new/{page,actions,form}.tsx` -- create form mirroring the clients/suppliers pattern, with a client `<select>` and a server-side cross-company re-check of the selected client (defense-in-depth alongside the DB trigger)
- [x] `web/src/app/companies/[id]/recurring-services/[recurringServiceId]/edit/{page,actions,form}.tsx` -- edit form including the `active` toggle and client reassignment (same cross-company re-check)
- [x] `web/src/app/companies/page.tsx` -- add a "Recurring services" link

**Acceptance Criteria:**
- Given I create a recurring service with client/price/expected cost/periodicity/validity, then it's saved and listed
- Given an active service within its validity, when I click "Generate this period", then a `sales_documents` row is created with the right amount and `source='recurring'`
- Given I click "Generate this period" again for the same period, then it's blocked, not duplicated
- Given a service's `end_date` has passed, then generation is no longer offered/succeeds
- Given a tampered cross-company `client_id`, then the DB trigger rejects it (same mechanism as every other entity in this app)

## Implementation Notes

- Migration `20260913070000_epic5_story1_recurring_services.sql` applied to the live linked project (`gpxeikzpqldpxdijbsfs`) via `supabase db push --linked` and confirmed in `supabase migration list --linked`.
- `getGeneratedRecurringServicePeriods` was added to `dal.ts` beyond the original code map: the list page needs to know, per row, whether *that service's own current period* (month or year, depending on its `periodicity`) already has a generated `sales_documents` row, so it can hide the "Generate this period" button per the spec's "already generated" edge case. It fetches raw `(recurring_service_id, recurring_period)` pairs for the company's services and the page compares against each service's own computed current period, since periodicity (and therefore what "current period" means) differs per row.
- The "Generate this period" button is a small client component (`generate-button.tsx`) rather than a plain form action, because period resolution must happen at click time (per Design Notes: "no cron... period resolution happens client-side at the moment the user clicks"), not at page-render time -- a page left open across a month/year boundary would otherwise generate the wrong period.
- No new `dal.ts` type conflicts: `RecurringServicePeriodicity` is exported and reused by both the list page and the button component for the period-computation logic, kept in one place.
- **Browser-verified end to end**: created a real client and a monthly recurring service (Microsoft 365, price 100 CLP, expected cost 60 CLP, start 2026-01-01). List showed "Generate this period"; clicked it, confirmed the button disappeared and the row now reads "this period already generated"; reloaded the page and confirmed the state persisted (not just client-side). Checked the sales list: a new document appeared with client TEST-5-1 Recurring Client, date 2026-09-01 (first of the current month), Net 100 + Tax 0 = Total 100. All test data (client, recurring service, sales document/line) deleted afterward, confirmed zero residue.

## Spec Change Log

## Review Triage Log

## Design Notes

`generate_recurring_service_entry` is a plain function (not `security definer`), same reasoning as every other creation RPC in this codebase.

No cron/pg_cron anywhere in this story — "period" resolution (which month/year is "current") happens client-side at the moment the user clicks "Generate," passed to the RPC as `p_period`; the RPC is the enforcement point for idempotency and validity, not a scheduler.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new routes register

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- [x] Create a recurring service, generate the current period, confirm a correctly-computed `sales_documents` row appears -- verified: inserted a test client/recurring service (price 100, currency USD) under company "Good Currency Co", impersonated a real member via `set_config('request.jwt.claims', ...)`, called `generate_recurring_service_entry`; resulting row had `net_amount=100`, `tax_amount=0`, `total_amount=100`, `source='recurring'`, `recurring_period='2026-09-01'`, correctly linked `client_id`/`company_id`/`recurring_service_id`
- [x] Generate again for the same period — confirm blocked -- verified: second call raised `P0001: This period has already been generated for this service`, no duplicate row created
- [x] Attempt generation outside validity — confirm blocked -- verified both directions: a period before `start_date` raised `Cannot generate before the service start date`; after lowering `end_date` into the past, the current period raised `Cannot generate after the service end date`
- [x] Cross-company `client_id` on `recurring_services` rejected by the DB trigger -- verified: inserting a `recurring_services` row for one company with a `client_id` belonging to a different company raised `P0001: client_id must belong to the same company as the recurring service`
- [ ] Browser-verify the list page and generate action end to end -- **not done**: no test user credentials (email/password) for the linked Supabase project were available to this session (only a service-level DB connection); logic was instead verified directly at the DB layer as above, and `npx tsc --noEmit` / `npm run build` both pass cleanly for the new routes. Recommend a human (or a session with test credentials) click through `/companies/[id]/recurring-services` once before considering this fully closed.
- All test rows (client, recurring service, sales_documents/sales_lines) created for the above checks were deleted afterward; confirmed zero leftover rows.
