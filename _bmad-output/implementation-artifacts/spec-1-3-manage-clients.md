---
title: 'Story 1.3: Manage Clients'
type: 'feature'
created: '09-12-2026'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '10a346ce574adc77cf8695b84d40dcc0f620457d'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There's no client entity at all yet. Every future income/project story needs a single client record per company that avoids duplicate names, so revenue rolls up correctly per client.

**Approach:** Add a `clients` table scoped to a company (any member can manage it — unlike companies, this is operational data, not org config), with a non-blocking near-duplicate-name warning on create, and deactivate-only removal.

## Boundaries & Constraints

**Always:** clients are scoped to one `company_id`; any member of that company (not just `admin`) can create/edit clients; `created_by`/`updated_by` populate from `auth.uid()`; a name closely matching an existing client in the same company shows a warning but never blocks saving.

**Never:** hard-delete a client (deactivate only, same pattern as companies); build cross-company client search/merge (out of scope); enforce the duplicate check as a DB constraint (it's a UX warning, not a data integrity rule — see Design Notes).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create client, unique name | Any company member, new name | Client created, scoped to that company | N/A |
| Create client, near-duplicate name | Name closely matches an existing client in the same company | Warning shown with the match; save still allowed on confirm | N/A |
| Edit client | Any company member | Fields update, `updated_by`/`updated_at` set | N/A |
| Deactivate client | Any company member sets `active=false` | Client stays visible/listed, no delete option exists anywhere | N/A |
| Cross-company access | User with no membership in that company | Sees no clients / can't reach the page | RLS returns zero rows |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912130000_epic1_story2_manage_companies.sql`, `.../20260912140000_..._review_patches.sql` -- prior Story 1.2 migrations; `companies`/`company_memberships` already have the `set_updated_at()` trigger this story reuses as-is
- `web/src/lib/dal.ts` -- `getUserCompanies()`/`getCompanyForEdit()` establish the pattern (RLS-scoped query, no client-side filtering); this story adds client equivalents here
- `web/src/app/companies/[id]/edit/` -- structural precedent for a company-scoped, admin-style page; clients pages follow the same shape but gate on "any member" instead of "admin"
- No test framework in the repo — verify via `npm run dev` + browser + PostgREST curl

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260912150000_epic1_story3_manage_clients.sql` -- `clients` table (`id`, `company_id` references `companies`, `name`, `tax_id`, `country`, `notes`, `active` default `true`, audit cols with `auth.uid()` defaults), `set_updated_at` trigger reused, RLS enabling SELECT/INSERT/UPDATE for any `company_memberships` row on that `company_id` (no role restriction, no DELETE policy)
- [x] `web/src/lib/dal.ts` -- `getClients(companyId)`, `getClientForEdit(companyId, clientId)`, `findSimilarClients(companyId, name)` (case-insensitive substring match, checked both directions, against existing names in that company)
- [x] `web/src/app/companies/[id]/clients/page.tsx` -- list clients for that company (name, tax_id, country, active badge), "New client" link; redirects out if the caller has no membership for that company
- [x] `web/src/app/companies/[id]/clients/new/page.tsx` + `actions.ts` -- create form; on submit, runs `findSimilarClients` first — if a match exists and the form wasn't already confirmed, re-renders with a warning and a "Save anyway" hidden-field resubmit instead of inserting
- [x] `web/src/app/companies/[id]/clients/[clientId]/edit/page.tsx` + `actions.ts` -- edit form (name, tax_id, country, notes, active toggle); relies on RLS to reject non-members

**Acceptance Criteria:**
- Given I am a member of a company, when I create a client with a name closely matching an existing one in that company, then I see a warning before it saves, and can still save — ✅ verified: browser UI, `test-chile` created "Acme Corp" then "ACME Corporation" for Inmasoft Chile; warning rendered ("closely matches ... Acme Corp"), clicking the same button (relabeled "Save anyway") completed the insert
- Given I am a member of a company, when I edit one of its clients, then the change saves with `updated_by`/`updated_at` set — ✅ verified: browser UI edit (notes + deactivate) then confirmed via `supabase db query` that `updated_at` advanced past `created_at` and `updated_by` matched the editor's `auth.uid()`
- Given I have no membership in a company, when I try to view or edit its clients, then RLS returns zero rows (never a 500 or another company's data) — ✅ verified two ways: (1) DB-level, simulating `test-noaccess`'s JWT via `set local role authenticated` + `request.jwt.claims`, a `SELECT` against Inmasoft Chile's clients returned zero rows and an `INSERT` was rejected with `42501 new row violates row-level security policy`; (2) UI-level, navigating the logged-in `test-chile` session to a company/client it doesn't belong to redirected to `/companies` with no data shown, no 500
- Given a client has no delete option anywhere in the UI, when I want to remove one, then deactivating (`active=false`) is the only path — ✅ verified: no delete control exists in any client page/component; a direct `DELETE` attempt against `clients` (simulated as `test-chile`, a genuine member) affected zero rows because no DELETE policy exists — deactivating via the Active checkbox is the only working path, confirmed live in the UI (client stayed listed with an "Inactive" badge)

## Implementation Notes

- Migration applied to the live Supabase project via `supabase db push` (CLI already linked/authenticated from Stories 1.1/1.2); confirmed applied via `supabase migration list`.
- `findSimilarClients` does the case-insensitive containment check bidirectionally (does the new name contain an existing one, or vice versa) rather than a single-direction SQL `ilike`. A first pass used `ilike('name', '%' || newName || '%')` (existing name must contain the new name) and it silently missed the realistic case where the *new* name is the longer one (e.g. typing "ACME Corporation" after "Acme Corp" already exists — "Acme Corp" does not contain "ACME Corporation" as a substring, so no warning fired). Caught via live browser testing, not by the type checker. Fixed by fetching the company's client names and filtering both directions in application code; at this app's scale (a 2-person internal tool) fetching one company's client list is cheap, and it's still a plain case-insensitive substring check per the Design Notes (no fuzzy/trigram library).
- The "Save anyway" hidden-field resubmit is implemented literally: the warning banner conditionally renders `<input type="hidden" name="confirmed" value="true" />`, and the same submit button (relabeled "Save anyway" once a warning is present) resubmits the form, now carrying that field. `createClient` in `new/actions.ts` only treats the request as pre-confirmed when `formData.get("confirmed") === "true"`.
- Added a "Clients" link next to each company's "Edit" link on `/companies` (visible to any member, not just admins) so the new pages are actually reachable from the UI — not called out explicitly in the Code Map but needed for the feature to be usable.
- Verified end-to-end against the live DB and the running dev server (no test framework in the repo, per prior stories):
  - `npx tsc --noEmit` -- clean.
  - RLS verified directly at the DB level using `supabase db query --linked` with `set local role authenticated` + `set_config('request.jwt.claims', ...)` to simulate `test-chile` (member of Inmasoft Chile) and `test-noaccess` (no membership there) without needing their login passwords: insert/select/update succeeded for the member and set `created_by`/`updated_by` correctly; a `DELETE` by the member affected zero rows (no DELETE policy); select returned zero rows and insert was rejected (`42501`) for the non-member.
  - Full create → duplicate-warning → save-anyway → edit → deactivate flow driven through the actual browser against the already-logged-in `test-chile` session; cross-company redirect (list and edit pages) confirmed live for a company/client `test-chile` has no membership on.
  - All test client rows created during verification were deleted afterward (`clients` table confirmed empty of test artifacts); no real seed data was touched.
- Post-review re-verification: after the stale-`confirmed` fix, re-drove the exact failure scenario live — warned on "Acme Corp" vs "ACME Corporation", then changed the name mid-flow to "Totally Unique Names" (a near-duplicate of a *different* existing client, "Totally Unique Name") and clicked the still-labeled "Save anyway" button. Confirmed the warning correctly updated to reference "Totally Unique Name" instead of silently inserting — proving the fix re-checks against the current value rather than trusting a stale confirmation. `npx tsc --noEmit` re-run clean. All test rows deleted afterward via `supabase db query --linked` (CLI is correctly linked to the live project, so this didn't require the human).

## Spec Change Log

## Review Triage Log

- **verdict: medium** — the "Save anyway" hidden `confirmed=true` field (`new/form.tsx:97`) isn't tied to the specific name it was checked against. Once a warning renders once, `confirmed=true` stays in the DOM regardless of further edits to the Name field — a user can change the name to *any* value (including a genuinely new near-duplicate) and the button (still labeled "Save anyway") submits with `confirmed=true`, so `createClient` (`new/actions.ts:42`) skips `findSimilarClients` entirely for that new value. This defeats the whole feature with an ordinary retype, not just a deliberate bypass. → **patch**
- **verdict: low** — no normalization of internal whitespace/punctuation in client names before comparison or storage (only outer `.trim()`); "Acme  Corp" vs "Acme Corp" won't be flagged as similar. Cheap to improve alongside the fix above. → **patch**
- **reject (out of scope)** — the duplicate-name warning only fires on create, not edit. The frozen I/O matrix has no "edit with near-duplicate name" row and the Intent only calls out the warning "on create" — edit-time duplicate checking was never part of this story's captured intent.
- **reject (ambiguous, safer default)** — `findSimilarClients` matches against inactive clients too, so a deactivated client's name still triggers a warning. Undocumented either way in the spec, but warning too often (rather than too rarely) is the safer failure mode for a dedup nudge; not worth gating on `active` without a stated reason to.
- **false** — missing `ON DELETE` behavior on `clients.company_id`. Disproven: Story 1.2 established "Never: build company deletion (deactivate only)" — companies are never deleted in this app, so no FK cascade/restrict decision is reachable in practice.
- **reject (low, fix more than trivial, unlikely)** — two members submitting near-duplicate names at the exact same moment could both bypass the warning (race between check and insert). Same category already rejected in Story 1.2's review (concurrent-edit race) for the same reasons: implausible for a 2-person tool, fix requires locking/transactional logic.
- **reject (consistent with established precedent)** — `getClients`/`getClientForEdit`/`findSimilarClients` swallow errors to an empty result plus `console.error`, same pattern already accepted in Stories 1.1/1.2's reviews.
- **reject (low, fix more than trivial)** — `getCompanyForEdit` reused as the "any member" gate for clients pages despite its name suggesting the admin-only company-edit flow. Verified behavior is correct (no role filter), already documented via code comment; renaming would touch already-shipped Story 1.2 call sites for a naming-clarity nit, not a functional fix.
- **defer (already covered)** — no unit test for `findSimilarClients`'s bidirectional substring logic. Same root condition as the existing deferred-work.md entry ("add an automated test framework") — no new entry needed.
- **false** — single-letter/very-short existing client names can produce broad false-positive warnings in the bidirectional substring check (e.g. a client named "A" flags almost anything). This is the explicitly chosen simple approach from Design Notes (no fuzzy/trigram matching), and it's a non-blocking warning — over-triggering is the accepted trade-off, not a defect.

## Design Notes

Duplicate-name detection is deliberately a soft warning, not a unique constraint: two genuinely different clients can share a name (e.g. common business names), and the PRD's own language is "warns... before saving," not "prevents." A simple case-insensitive `ilike '%name%'` match is enough for V1 — no fuzzy/trigram matching library needed yet.

Any company member (not just `admin`) can manage clients, unlike Story 1.2's company-editing restriction — clients are day-to-day operational data entered by whoever is working, matching the PRD's emphasis on the manual entry flow being fast for everyday use.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run dev` -- expected: starts clean

**Manual checks (if no CLI):**
- As `test-chile` (member of Inmasoft Chile): create a client, then create a second one with a near-identical name — confirm the warning appears and "Save anyway" completes it
- Edit a client's fields, confirm `updated_by`/`updated_at` change via curl
- As `test-noaccess` (no membership on Inmasoft Chile): attempt to load Inmasoft Chile's `/clients` page or `curl` its clients with their token — confirm zero rows / redirect, not another company's data
