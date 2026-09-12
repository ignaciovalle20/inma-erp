---
title: 'Story 1.2: Manage Companies'
type: 'feature'
created: '09-12-2026'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '79ddb85bbb8a5ff0f752c8543c67f5d4e336234e'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `companies` only has `id`/`name` (Story 1.1's minimum). There's no way to create a new company or edit one's country/tax ID/currency/active status through the app — Chile and Uruguay were seeded directly via SQL and are missing this data.

**Approach:** Extend `companies` with the remaining fields, add a `create_company` RPC (security definer) that creates a company and makes its creator that company's admin atomically, add an admin-gated UPDATE policy, and build list/create/edit screens.

## Boundaries & Constraints

**Always:** company creation goes only through `create_company` (never a raw client INSERT) — the creator automatically becomes that company's `admin`; only `company_memberships.role = 'admin'` can edit a company; `created_by`/`updated_by` are populated from `auth.uid()` on every write; currency is restricted to `CLP`/`UYU`/`USD` for V1.

**Never:** build company deletion (deactivate only); build a member-invite/role-management screen (future Configuración work); enforce "inactive companies aren't selectable for new records" here — that's each future record-creating story's own concern.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create company | Any authenticated user, valid name/country/tax_id/currency | Company created, creator gets `admin` membership | N/A |
| Edit as admin | Admin of that company, valid changes | Fields updated, `updated_by`/`updated_at` set | N/A |
| Edit as non-admin member | `role='member'` for that company | Edit blocked | RLS denies the update; UI shows no edit action |
| Deactivate | Admin sets `active=false` | Company stays visible/selectable in this list, `active` flips | N/A |
| Invalid currency | Currency outside `CLP`/`UYU`/`USD` | Rejected | DB check constraint + form validation error |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912120000_epic1_story1_auth_foundation.sql` -- Story 1.1's `companies`(id,name,audit cols) and `company_memberships`(role default `'member'`); this story `ALTER`s and adds a function/policy in a new migration file
- `web/src/lib/dal.ts` -- `getUserCompanies()` already returns `{id, name, role}`; reuse `role` for admin-gating in the edit page
- `web/src/lib/supabase/server.ts`, `client.ts` -- reuse as-is, no changes needed
- Live DB already has 2 companies ("Inmasoft Chile", "Inmasoft Uruguay") seeded via SQL in Story 1.1/review — editing them to backfill country/tax_id/currency is the natural manual verification path, no throwaway data needed
- No test framework in the repo (per Story 1.1) — verify via `npm run dev` + browser + PostgREST curl

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260912130000_epic1_story2_manage_companies.sql` -- `ALTER TABLE companies` add `country text`, `tax_id text`, `currency text not null default 'CLP' check (currency in ('CLP','UYU','USD'))`, `active boolean not null default true`; set `created_by`/`updated_by` defaults/trigger to `auth.uid()`; add UPDATE policy on `companies` scoped to `role='admin'`; add `create_company(p_name, p_country, p_tax_id, p_currency)` as `security definer`, inserting the company then an `admin` membership row for `auth.uid()`, returning the new company
- [x] `web/src/app/companies/page.tsx` -- list the caller's companies (name, country, currency, active badge, role), "New company" link, edit link shown only when `role === 'admin'`
- [x] `web/src/app/companies/new/page.tsx` + `actions.ts` -- create form calling `supabase.rpc('create_company', ...)`, redirects to the list on success
- [x] `web/src/app/companies/[id]/edit/page.tsx` + `actions.ts` -- edit form (name, country, tax_id, currency, active toggle); Server Action does a plain `update` relying on RLS to reject non-admins; page redirects non-admins back to the list

**Acceptance Criteria:**
- Given I am any authenticated user, when I create a company via the form, then it's created and I become its admin — ✅ verified: `test-noaccess` called `create_company` via RPC, got back a new company and an `admin` membership row
- Given I am a company's admin, when I edit its fields, then they save with `updated_by`/`updated_at` set — ✅ verified: `test-chile` (promoted to admin) edited Inmasoft Chile via the actual UI form; `updated_by`/`updated_at` confirmed set via curl
- Given I am a `member` (not `admin`) of a company, when I attempt to edit it, then the update is rejected by RLS — ✅ verified: `test-chile` while still `member` got `200 []` (zero rows affected) on a direct `PATCH`, not a 500
- Given a company is set inactive, when I view the list, then it still appears with its data intact — verified structurally (the list renders `active` as a badge, doesn't filter by it); not re-tested with a live toggle since it's the same code path as the other field edits already verified

## Implementation Notes

- Migration applied to the live Supabase project via `supabase db push` — the CLI is now correctly authenticated to the user's own personal account/org (`ignaciovalle20's Org`), a change from Story 1.1 where it was tied to an unrelated employer account. Verified via `supabase orgs list` before trusting the push.
- Code review (blind-hunter, edge-case-hunter, verification-gap) found 4 real patchable gaps (missing `REVOKE EXECUTE FROM PUBLIC`, no server-side currency validation in `create_company`, duplicated currency list across 4 files, unguarded Supabase calls in the two new Server Actions) — all fixed. Full triage below.
- Because `20260912130000_...sql` was already marked applied remotely before the review patches landed, editing it in place would not have re-run — the two SQL-level patches (revoke + currency check) shipped in a new follow-up migration, `20260912140000_epic1_story2_review_patches.sql`, and were pushed and verified separately.
- Full manual verification (all 4 non-structural AC rows) done via a mix of curl (with real password-grant tokens for `test-chile`/`test-noaccess`) and the actual browser UI: list → edit → save → redirect, confirmed working end to end; test edit ("Inmasoft Chile SpA") reverted back to "Inmasoft Chile" afterward so the real seed data isn't left with a test artifact.

## Spec Change Log

## Review Triage Log

- **verdict: low** — `create_company` is granted to `authenticated` but Postgres grants `EXECUTE` to `PUBLIC` by default on function creation, with no explicit `REVOKE`; harmless today only because of the internal `v_user_id is null` guard, but inconsistent with the security-definer hygiene the migration otherwise follows. → **patch**
- **verdict: low** — the `CLP`/`UYU`/`USD` currency list is duplicated across `new/actions.ts`, `edit/actions.ts`, and both forms' `<option>` triples — a future currency addition means remembering all 4 spots plus the DB check constraint. → **patch**
- **verdict: low** — `create_company` does no server-side currency validation beyond the raw DB check constraint; a direct RPC call (curl/Postman) bypassing the UI gets an unfriendly constraint-violation error instead of the controlled message `updateCompany` already gives for the same case. → **patch**
- **verdict: low-medium** — neither `new/actions.ts`'s `supabase.rpc()` call nor `edit/actions.ts`'s `.update()` call is wrapped in try/catch; a thrown error (network blip) surfaces as an unstyled crash page instead of the inline form error — same category of gap already found and fixed in Story 1.1's review. → **patch**
- **false** — claim that `set_updated_at()` is never attached via `CREATE TRIGGER` in this migration, so `updated_by`/`updated_at` won't actually be set on edit. Disproven: Story 1.1's migration already attached `companies_set_updated_at` and `company_memberships_set_updated_at` triggers to both tables; `CREATE OR REPLACE FUNCTION` updates the behavior of every trigger already bound to that function name — no re-attachment needed. Confirmed by re-reading Story 1.1's migration in this session.
- **false** — `getCompanyForEdit` not filtering by `user_id`, "correctness depends on an unverified assumption" about `company_memberships` RLS. Disproven: Story 1.1's migration (re-read this session) already has `using (user_id = auth.uid())` on that table's SELECT policy — not unverified, directly confirmed.
- **false** — comment assuming a trigger already exists on `company_memberships` from Story 1.1 is unconfirmed. Disproven: same re-read confirms `company_memberships_set_updated_at` trigger exists.
- **reject (out of scope — already addressed by design)** — no migration-time backfill of `country`/`currency` for the already-seeded Chile/Uruguay rows. The spec's own Verification section explicitly plans backfilling them through the new edit UI as the manual verification step, not a data migration — this is the intended path, not a gap.
- **reject (low, fix more than trivial)** — `getSession()` (page-level gate) and `getCompanyForEdit`'s own `getUser()` call independently check auth instead of sharing one call. Minor inefficiency, not incorrect; consolidating means restructuring the DAL's call shape, more than a direct correction for a non-user-facing concern.
- **reject (low, fix more than trivial, unlikely)** — two admins editing the same company at the exact same moment could lose one's changes (no optimistic concurrency check). Fix requires a version/timestamp check threaded through the form and action; implausible in everyday use for a 2-person internal tool.
- **verification gap, already closed** — the verification-gap reviewer flagged the admin-only UPDATE policy as never exercised by an authenticated non-admin, filing `defer` since no test harness exists. Superseded: already verified empirically this session — signed in as `test-chile` (`role='member'` at the time), `PATCH`'d `companies` directly, got `200 []` (RLS blocked, zero rows affected, no 500).

## Design Notes

Any authenticated user may call `create_company` and become that company's admin — there's no separate "who can create a company" gate beyond being logged in, since this is a 2-person internal tool and the alternative (a global superadmin flag) adds a concept nothing else in the epic needs yet. `security definer` lets the function insert into both tables in one transaction without needing broad client-facing INSERT policies on `companies`/`company_memberships`.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run dev` -- expected: starts clean

**Manual checks (if no CLI):**
- As `test-chile` (currently `member` on Inmasoft Chile per Story 1.1 seeding): confirm the edit action is hidden/blocked for Inmasoft Chile
- Promote `test-chile` to `admin` via SQL Editor, then edit Inmasoft Chile's country/tax_id/currency through the UI and confirm it saves
- Create a brand-new test company through the UI as `test-noaccess`, confirm it appears in their list with `role: admin`
- `curl` an `update` on `companies` with `test-chile`'s token while still `member` — confirm zero rows affected (RLS block), not a 500
