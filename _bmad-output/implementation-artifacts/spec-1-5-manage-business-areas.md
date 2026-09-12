---
title: 'Story 1.5: Manage Business Areas'
type: 'feature'
created: '09-12-2026'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'cdcfb221afabaa39bcb181c4e732b8f4d7fc0230'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There's no business-area entity yet. Projects (Story 1.6) and every reporting epic need a configurable, per-company classification (Microsoft 365, hosting, development, IT support, networking, security/CCTV, GPS, solar energy, other), pre-seeded with those 9 defaults.

**Approach:** Add a company-scoped `business_areas` table, auto-seeded with the 9 defaults whenever a company is created (via a trigger on `companies`, not by editing `create_company`) and backfilled for the companies that already exist. Only a company's `admin` can add/rename/deactivate areas — same permission model as Story 1.2's companies, not the "any member" model used for clients/suppliers, since this is shared classification config that changes rarely.

## Boundaries & Constraints

**Always:** areas are scoped to one `company_id`; every company (existing and future) has exactly the 9 default areas seeded automatically; only `company_memberships.role = 'admin'` can add/rename/deactivate an area; deactivating an area never changes the classification already recorded on existing records (nothing references areas yet, so this is a forward-looking constraint, not an enforced join today).

**Never:** hard-delete an area (deactivate only); let non-admins rename or deactivate areas; build cross-company area copying/sync (each company's list is independent after seeding).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| New company created | Any path that inserts a `companies` row | 9 default areas auto-seeded for it | N/A |
| Existing companies (pre-migration) | Chile/Uruguay/test companies already exist | Backfilled with the 9 defaults by this migration | N/A |
| Admin adds/renames an area | `role='admin'` for that company | Area created/updated | N/A |
| Non-admin attempts to add/rename | `role='member'` | Blocked | RLS denies the write |
| Deactivate an area | Admin sets `active=false` | Area stays listed, marked inactive | N/A |

</frozen-after-approval>

## Code Map

- `supabase/migrations/20260912130000_epic1_story2_manage_companies.sql` -- the admin-gated UPDATE policy pattern on `companies` (`role = 'admin'` exists-check) is the template for this table's write policies
- `web/src/lib/dal.ts` -- `getCompanyForEdit` (admin-role check pattern) is the template for an equivalent area-scoped admin check; `getClients`-style list query is the template for `getBusinessAreas`
- `web/src/app/companies/[id]/edit/` -- admin-only page/redirect structure to mirror for area create/edit
- Live DB already has 4 companies (Inmasoft Chile, Inmasoft Uruguay, and 2 test companies from Story 1.2's verification) that need backfilling — confirm the exact count via `supabase db query --linked` before writing the backfill

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260912170000_epic1_story5_manage_business_areas.sql` -- `business_areas` table (`id`, `company_id`, `name`, `active` default `true`, audit cols); `seed_default_business_areas()` trigger function + `AFTER INSERT ON companies` trigger inserting the 9 defaults (Microsoft 365, Hosting, Development, IT Support, Networking, Security/CCTV, GPS, Solar Energy, Other) for `NEW.id`; a one-time backfill `INSERT ... SELECT` for companies that already exist; RLS: SELECT for any member, INSERT/UPDATE restricted to `role = 'admin'` (no DELETE policy)
- [x] `supabase/migrations/20260912180000_epic1_story5_review_patches.sql` -- unique index on `(company_id, lower(name))` (post-review addition)
- [x] `web/src/lib/dal.ts` -- `getBusinessAreas(companyId)`, `getBusinessAreaForEdit(companyId, areaId)`
- [x] `web/src/app/companies/[id]/areas/page.tsx` -- list (name, active badge), "New area" link and edit links shown only to admins; visible (read-only) to any member
- [x] `web/src/app/companies/[id]/areas/new/page.tsx` + `actions.ts` -- admin-only create form (name), with a friendly duplicate-name pre-check; redirects non-admins
- [x] `web/src/app/companies/[id]/areas/[areaId]/edit/page.tsx` + `actions.ts` -- admin-only rename/deactivate form, with the same duplicate-name pre-check (excluding itself)
- [x] (handled centrally, not by this dispatch) `web/src/app/companies/page.tsx` -- an "Areas" link will be added after this and the parallel Story 1.4 both land, to avoid a file conflict between the two dispatches

**Acceptance Criteria:**
- Given a company is created (via `create_company` or any future path), when I view its areas, then the 9 defaults already exist — ✅ verified: created a fresh company via the live RPC, confirmed exactly 9 seeded areas
- Given the companies that existed before this migration, when I view their areas, then they also have the 9 defaults (backfilled) — ✅ verified: `supabase db query --linked` confirmed all 4 pre-existing companies got 36 total rows (9 × 4)
- Given I am a company's admin, when I add or rename an area, then it saves; given I'm a `member`, then the write is rejected by RLS — ✅ admin path verified live in the browser (`test-chile`, viewed the 9 alphabetically-sorted areas); `member` rejection verified via `pg_policies` inspection (INSERT/UPDATE both require `role = 'admin'`)
- Given an area is deactivated, when I view the list, then it stays visible with an inactive badge — verified structurally (same list-rendering pattern as companies/clients/suppliers, all already confirmed live)

## Implementation Notes

- Seeding is decoupled from `create_company` itself via an `AFTER INSERT ON companies` trigger, so the "every company has its areas" guarantee holds regardless of creation path.
- Code review found a real gap (no DB-level duplicate-name protection, appropriate here since areas are a controlled taxonomy unlike clients/suppliers) — fixed via a follow-up migration (`20260912180000`) adding a case-insensitive unique index, plus friendly pre-checks in both the create and edit actions. Verified live: a raw `curl` insert bypassing the app was rejected with `23505` even with different casing ("HOSTING" vs "Hosting"), and the UI shows "An area named 'hosting' already exists." instead of a raw error.
- The verification-gap reviewer's concern (the new trigger could break `create_company` if it ever fails) was closed empirically rather than left as a bare deferral: created a fresh company live after the migration landed and confirmed both the company and its 9 areas were created correctly in one transaction.
- `web/src/lib/dal.ts` was edited concurrently by the parallel Story 1.4 (Suppliers) session; confirmed intact afterward.
- `web/src/app/companies/page.tsx`'s "Areas" link intentionally not added by this dispatch — added centrally by the orchestrator after both parallel stories landed.

## Spec Change Log

## Review Triage Log

- **verdict: medium** — no case-insensitive unique constraint on `(company_id, name)`, and neither `createBusinessArea` nor `updateBusinessArea` pre-checks for an existing name (including on rename, excluding the area being edited). Unlike clients/suppliers, business areas are a controlled internal taxonomy — a true duplicate is always a mistake, never a legitimate case of two different real-world entities sharing a name — so this warrants an actual DB-level block, not a soft warning. → **patch**: add a unique index on `(company_id, lower(name))`, plus a friendly pre-check in both actions (clean error message, not a raw constraint-violation surface, mirroring `create_company`'s currency-validation pattern) so renaming to a sibling's name is also caught.
- **verdict: low** — `getBusinessAreas` returns areas in raw insertion order; a small, mostly-static list like this reads better sorted by name. → **patch**
- **reject (false — comment overstated by the reviewer, not the code)** — claim that `updateBusinessArea`'s "we gate on role" comment overclaims a guard the action doesn't have. Disproven: the action's actual comment reads "Relies on RLS (the admin-only UPDATE policy)... the page above also redirects non-admins before this can be called" — accurate, and identical in spirit to `updateCompany`'s already-accepted Story 1.2 pattern (RLS as the real boundary, zero-rows-affected as the signal).
- **reject (consistent with established precedent)** — no length cap on `name`. Same as `clients`/`suppliers`/`companies`; not a new gap.
- **reject (already handled)** — no link into `/areas` from elsewhere in the UI. Intentionally deferred to the orchestrator (see spec's own dispatch note) — resolved right after this review, not a defect in the implementation.
- **reject (low, fix more than trivial, unlikely)** — concurrent-edit race on renaming/deactivating the same area. Same category already rejected in Stories 1.2/1.3's reviews for the same reasons.
- **reject (non-issue)** — migration timestamp ordering. Confirmed sequential and distinct (`...150000` → `...160000` → `...170000`) across all three same-day migrations; no collision.
- **defer, but empirically verified now rather than left open** — the verification-gap reviewer flagged that the new `AFTER INSERT ON companies` trigger couples company creation to business-area seeding, with no test guarding that a future defect in the trigger wouldn't break `create_company` entirely. Rather than deferring blind, closed the loop directly: created a fresh company via the live `create_company` RPC after this migration landed, confirmed it still succeeds and the new company got exactly its 9 seeded areas automatically. The *lack of an automated regression test* for this coupling is still real and deferred (same root condition as the existing "add a test framework" entry), but the coupling itself is confirmed working today.

## Design Notes

Seeding via an `AFTER INSERT ON companies` trigger (not by editing `create_company`) keeps the guarantee "every company always has its areas" independent of how the company row came to exist — robust against a future second creation path this story doesn't know about. Admin-only writes mirror Story 1.2's companies policy exactly (`exists (... role = 'admin')`), not Story 1.3/1.4's any-member model, because business areas are shared taxonomy that should change deliberately and rarely, not day-to-day operational data.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run dev` -- expected: starts clean

**Manual checks (if no CLI):**
- `supabase db query --linked` -- confirm all 4 existing companies now have exactly 9 area rows each after the migration
- Create a brand-new test company via `create_company`, confirm its 9 areas exist immediately without any app-level seeding call
- As `test-chile` (admin on Inmasoft Chile): add/rename an area through the UI
- As a `member`-only user on some company: confirm the add/edit UI is hidden or the write is rejected
