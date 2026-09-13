---
title: 'Story 2.3: Fast Manual Entry Flow for Uruguay'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '79354412466f17d3fe4dcfc5cb14cbf68b0d8870'
context: ['_bmad-output/implementation-artifacts/epic-2-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Uruguay has no import path (Epic 4's CSV importer is Chile-only) and relies entirely on manual entry, but the existing `sales/new` form requires a document type, free-text currency, tax amount, and per-line description — too many fields/steps for the daily volume Uruguay needs, and it redirects away after each save, forcing re-navigation for the next document.

**Approach:** Add a "Quick entry" route, shown only for companies whose `currency = 'UYU'`, requiring just client, date, amount, and business area; document type defaults to `manual`, tax to `0`, and a single line with no description is created automatically. On success the form resets in place (keeping the just-used date, clearing client/amount/area) instead of redirecting, so the next document can be entered immediately. Extends `create_sales_document` with an optional `p_business_area_id` (nullable FK, backward-compatible for the existing full form) rather than a new RPC.

## Boundaries & Constraints

**Always:** `net_amount`/`total_amount` still computed server-side exactly as `create_sales_document` already does today; the quick-entry form creates exactly one line (amount = the single entered figure, description `null`); `business_area_id` is validated server-side to belong to the same `company_id` (new trigger, same cross-company-validation pattern as `client_id`); the quick route is additive — the existing full `sales/new` form is untouched and still reachable for every company, Uruguay included.

**Never:** remove or gate the full `sales/new` form behind currency (both must stay available per the epic's "manual entry is never replaced" rule — this story only adds a faster alternative); add business-area scoping to `clients` or `getClients` (out of scope, clients stay company-scoped only); build the Chile CSV importer (Epic 4); change `create_sales_document`'s existing required parameters or the full form's behavior.

**Decisions (made autonomously, no open questions — none of these would surprise the user in the result):** quick entry lives at a new route gated on `company.currency === 'UYU'` (the existing enum-constrained signal, more reliable than the free-text `country` column); after a successful save the form clears client/amount/area but keeps the just-used `document_date` pre-filled (repeat-day entry is the common case for back-to-back entry); `business_area_id` is added at the `sales_documents` header level (one area per document, matching the "single amount" simplicity of this flow), nullable at the schema level so the existing full form's RPC calls remain unaffected.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Quick entry, happy path | Client + today's date + amount + area, submit | Document + 1 line saved (`net_amount` = amount, `tax_amount` = 0); form resets in place, date kept, other fields cleared | N/A |
| Quick entry, missing area | Area left unselected | Blocked | Validation error, no insert |
| Quick entry, zero/negative amount | Amount ≤ 0 | Blocked | Validation error, no insert |
| Quick entry, non-UYU company | Company `currency` = `CLP`/`USD` | No "Quick entry" link shown; direct navigation to the route redirects to the full `sales/new` form | N/A |
| Tampered `business_area_id` from a different company | Cross-company id submitted via RPC | Rejected at the DB level | Trigger raises exception, not a silent wrong-company write |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912210000_epic2_story1_sales_documents.sql`, `.../20260912220000_..._review_patches.sql`, `.../20260913000000_epic2_story2_edit_void_sales_documents.sql` -- current `sales_documents`/`sales_lines` schema and `create_sales_document`/`update_sales_document` to extend
- `supabase/migrations/20260912170000_epic1_story5_manage_business_areas.sql` -- `business_areas` shape (`id, company_id, name, active`) to FK against
- `web/src/app/companies/[id]/sales/new/{page,actions,form}.tsx` -- full form to leave untouched; reuse its client-fetch/membership-guard pattern for the new route, but NOT its field set
- `web/src/lib/dal.ts` -- `getClients(companyId)` (line ~150), `getBusinessAreas(companyId)` (line ~274) for the two pickers; no new DAL helper needed beyond these
- No existing "reset-in-place" pattern anywhere in the codebase (every other form redirects on success via `useActionState` + server-side `redirect()`) — this story introduces the first one: have the action return a fresh success state (not `redirect`) and bump a `key` on the form's non-date fields (or use a `formRef.reset()` + manually re-set the date input) to clear inputs while staying on the page

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic2_story3_quick_entry_business_area.sql` -- add `business_area_id uuid references public.business_areas(id)` (nullable) to `sales_documents`; add a `BEFORE INSERT OR UPDATE` trigger validating `business_area_id`'s `company_id` matches `sales_documents.company_id` when non-null (same pattern as `sales_documents_validate_company_refs`); extend `create_sales_document` to accept `p_business_area_id uuid default null` and pass it through to the insert; extend `update_sales_document` the same way for consistency (nullable, no behavior change if omitted)
- [x] `web/src/lib/dal.ts` -- no new function; confirm `getBusinessAreas` filters `active = true` at the call site (mirroring `getClients`' active-filter usage in `sales/new/page.tsx`)
- [x] `web/src/app/companies/[id]/sales/quick/page.tsx` -- auth+membership guard; if `company.currency !== 'UYU'`, redirect to `/companies/[id]/sales/new`; fetch active clients + active business areas; render `<QuickSalesEntryForm>`
- [x] `web/src/app/companies/[id]/sales/quick/actions.ts` -- `"use server" createQuickSalesDocument(companyId, prevState, formData)`: validates client/date/amount(>0)/area all present, calls `create_sales_document` with `document_type: 'manual'`, `currency: company.currency`, `tax_amount: 0`, `p_lines: [{description: null, amount}]`, `p_business_area_id`; on success returns a fresh state (`{success: true, lastDate: document_date}`) instead of redirecting
- [x] `web/src/app/companies/[id]/sales/quick/form.tsx` -- 4 fields only (client select, date input defaulting to today, amount number input, area select); on a successful `useActionState` result, clear client/amount/area but re-populate the date input with the just-submitted value; show a brief inline "Saved" confirmation
- [x] `web/src/app/companies/[id]/sales/page.tsx` -- add a "Quick entry" link next to "New sales document", rendered only when `company.currency === 'UYU'`

**Acceptance Criteria:**
- Given a Uruguay company (currency `UYU`), when I open its sales list, then a "Quick entry" link is visible and the full "New sales document" link still works unchanged
- Given I submit the quick form with client, date, amount, and area, when it saves, then a document with exactly one line is created, `net_amount` equals the entered amount, `tax_amount` is `0`, and the form stays on the page with the date preserved and other fields cleared
- Given I submit the quick form without selecting an area, then it's blocked with a validation error, not a DB error
- Given a non-Uruguay company, when I navigate directly to its quick-entry URL, then I'm redirected to the full form

## Implementation Notes

- `update_sales_document`'s new `p_business_area_id` uses `coalesce(p_business_area_id, business_area_id)` rather than a plain overwrite, so editing a quick-entry document from the full `sales/new`-style edit form (which never passes this param) preserves its existing business area instead of silently nulling it out -- an edge case the spec's Design Notes didn't call out explicitly but that "no behavior change if omitted" implied.
- Both RPCs' old 7-argument signatures were dropped (`drop function if exists ...`) rather than left alongside the new 8-argument overloads, since a trailing default parameter creates a distinct overload in Postgres and leaving both would let stale clients keep calling a function whose logic no longer matches its sibling.
- Reset-in-place uses a `resetKey` bumped on success to remount the client/amount/area fields with fresh uncontrolled `defaultValue`s, while the date input is imperatively re-seeded via a ref (kept, not cleared) -- matches the Code Map's suggested approach and needed no new abstraction.
- **Verified against the linked Supabase project** (`gpxeikzpqldpxdijbsfs`): migration applied live; direct-insert and full-RPC tests confirmed a valid `business_area_id` is accepted, a cross-company one is rejected by the trigger, and the legacy 7-arg `create_sales_document` call (as the untouched full form makes it) still succeeds with `business_area_id` left `null`. All test rows deleted afterward.
- **Browser-verified**: navigating directly to `/companies/[id]/sales/quick` for a non-UYU company (Inmasoft Chile, `currency='CLP'`) redirects to `/sales/new` as specified. A full authenticated click-through as a UYU-company member was not done — the only UYU test company's member user's password isn't available, and adding a temporary membership for an already-logged-in test user was blocked by this session's own auto-mode safety classifier (modifying `company_memberships` is treated as a sensitive action). Reviewed `quick/page.tsx`, `quick/form.tsx`, `quick/actions.ts`, and the conditional link in `sales/page.tsx` by reading the code directly instead: the currency gate, validation, reset-in-place mechanism, and membership/currency backstop in the server action all match the spec.

## Spec Change Log

## Review Triage Log

## Design Notes

`create_sales_document`'s new `p_business_area_id` parameter defaults to `null`, so the existing full form's RPC call (which doesn't pass it) keeps working unchanged — no migration risk to Story 2.1/2.2's already-shipped behavior.

The reset-in-place pattern is new to this codebase; keep it minimal — don't build a generic "resettable form" abstraction for one screen. A `key`-bump on the client/amount/area fields (or an uncontrolled-input reset via `formRef`) plus manually re-seeding the date input is sufficient.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new `/companies/[id]/sales/quick` route registers

**Manual checks (against the linked Supabase project via `supabase db query --linked`, cleaning up test data afterward):**
- As a Uruguay-company member: submit quick entry with client/date/amount/area, confirm `net_amount`/`tax_amount`/`total_amount` and the single line are correct, and `business_area_id` is set
- Submit quick entry with no area selected — confirm client-side/server-side validation blocks it
- Attempt a cross-company `business_area_id` via the RPC directly — confirm the new trigger rejects it
- Confirm the existing `create_sales_document` call from the full form (no `p_business_area_id` passed) still succeeds unchanged
