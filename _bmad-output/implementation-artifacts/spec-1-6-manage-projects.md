---
title: 'Story 1.6: Manage Projects'
type: 'feature'
created: '09-12-2026'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '502351d74a3c0b9aaa3b6ff0b5904c23ce27f1ac'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No project entity yet — the last piece of Epic 1. Future income/cost stories need projects linked to a client, company, and business area to track margin per project.

**Approach:** Company-scoped `projects` table (client, area, name, dates, status, budget, responsible — free text, not a user reference), with server-side validation that the client/area belong to the same company. Any member manages projects (like clients/suppliers). Lifecycle is a `status` enum (`active`/`on_hold`/`closed`), not a separate `active` boolean.

## Boundaries & Constraints

**Always:** projects are scoped to one `company_id`; a project must reference an existing `client_id` and `business_area_id` belonging to that *same* company — validated server-side, not just by what the UI dropdown offers; any member can create/edit; `created_by`/`updated_by` populate from `auth.uid()`.

**Never:** hard-delete a project (status moves to `closed`, history stays); build income/cost/budget-actuals tracking here (Epic 2/3); let a project reference a client or area from a different company (cross-company FK confusion).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create project, valid client+area | Both belong to the project's company | Project created | N/A |
| Create project, missing client or area | Either left unselected | Blocked | Validation error, no insert |
| Create project, client/area from a different company | Mismatched `company_id` (e.g. tampered request) | Blocked | Server-side validation error, not a DB constraint violation |
| Edit project status | Any member, e.g. `active` → `closed` | Saves with `updated_by`/`updated_at`; no historical data touched | N/A |
| Cross-company access | User with no membership in that company | RLS returns zero rows | N/A |

</frozen-after-approval>

## Code Map

- `web/src/lib/dal.ts` -- `getClients`/`getBusinessAreas` (filter to `active` client-side for pickers) feed the two dropdowns; membership-check pattern mirrors `getClients` (any member), not `getCompanyForEdit` (admin-only)
- `web/src/app/companies/[id]/clients/`, `.../suppliers/` -- structural template (list/new/edit three-route shape, RLS-scoped, no client-side filtering)
- `supabase/migrations/20260912150000_epic1_story3_manage_clients.sql` -- RLS/trigger shape to mirror (any-member SELECT/INSERT/UPDATE, no DELETE)
- No test framework — verify via `npm run dev` + browser + `supabase db query --linked`

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260912190000_epic1_story6_manage_projects.sql` -- `projects` table (`id`, `company_id`, `client_id` references `clients`, `business_area_id` references `business_areas`, `name`, `start_date`, `end_date` nullable, `status text not null default 'active' check (status in ('active','on_hold','closed'))`, `budget numeric`, `responsible text`, audit cols with `auth.uid()` defaults); reused `set_updated_at` trigger; RLS mirroring `clients`' member-scoped SELECT/INSERT/UPDATE (no DELETE policy)
- [x] `supabase/migrations/20260912200000_epic1_story6_review_patches.sql` -- `BEFORE INSERT OR UPDATE` trigger enforcing `client_id`/`business_area_id` belong to the same `company_id` (post-review addition, closes a real DB-level bypass)
- [x] `web/src/lib/dal.ts` -- `getProjects(companyId)`, `getProjectForEdit(companyId, projectId)`, `validateProjectRefs(companyId, clientId, businessAreaId)` (shared cross-company check, post-review)
- [x] `web/src/app/companies/[id]/projects/page.tsx` -- list (name, client, area, status badge, budget), "New project" link, redirects non-members
- [x] `web/src/app/companies/[id]/projects/new/page.tsx` + `actions.ts` + `form.tsx` -- create form with client/area `<select>` pickers (active ones only); server action re-validates the selected client/area both exist and belong to `companyId` before inserting; empty-state message when no active clients/areas exist (post-review)
- [x] `web/src/app/companies/[id]/projects/[projectId]/edit/page.tsx` + `actions.ts` + `form.tsx` -- edit form (name, dates, status, budget, responsible, client/area reassignment); same server-side cross-company validation on change
- [x] `web/src/app/companies/page.tsx` -- add a "Projects" link

**Acceptance Criteria:**
- Given a client and business area exist for a company, when I create a project selecting both, then it saves scoped to that company — ✅ verified live in the browser (`test-chile`, "Website Revamp")
- Given I submit a project without a client or business area, then it's blocked with a validation error, not a DB error — ✅ verified: required `<select>`s plus server-side presence checks
- Given a client/area belonging to a different company is somehow submitted, then the server rejects it before inserting — ✅ **verified live, and this caught a real gap**: a raw API call bypassing the app succeeded before the review fix (confirmed empirically), and is now rejected by a DB-level trigger after the fix (re-verified with the exact same bypass attempt, now `400`/`P0001`)
- Given I edit a project's status, then it saves with `updated_by`/`updated_at`, and no other data is deleted — verified structurally (same trigger pattern as every other Epic 1 entity)
- Given I have no membership in a company, when I try to view/edit its projects, then RLS returns zero rows — verified via `pg_policies` inspection (SELECT/INSERT/UPDATE scoped to `company_memberships`, no DELETE)

## Implementation Notes

- **Critical finding, found and fixed during review**: the cross-company validation for `client_id`/`business_area_id` initially existed only in the Server Actions. The orchestrator verified live that a raw authenticated `POST /rest/v1/projects` could bypass the app and insert a project for one company referencing another company's business area — RLS only checks membership on the submitted `company_id`, not that the referenced rows belong to it. Fixed with a `BEFORE INSERT OR UPDATE` DB trigger (`20260912200000_epic1_story6_review_patches.sql`), re-verified with the identical bypass attempt now correctly rejected (`P0001`). This also structurally closes the TOCTOU race the edge-case-hunter reviewer flagged between the app's pre-check and the write, since the trigger runs atomically inside the same statement.
- Also fixed in review: budget accepts negative/non-finite values now rejected; `end_date >= start_date` enforced; both lookup errors logged instead of one being dropped; cross-company lookup logic deduplicated into `validateProjectRefs()`; empty-state message when a company has no active clients/areas yet.
- **Known minor gap, deferred**: the client/business-area `<select>` pickers don't preserve their value after a validation-error re-render (text inputs do via `defaultValue`, but `<select>` only honors it on initial mount) — caught live, not a data-integrity issue since the DB trigger still protects correctness, just a UX papercut. Logged in `deferred-work.md`.
- Full end-to-end browser verification: created a real project as `test-chile` (client + area pickers, budget validation error then success), confirmed it lists correctly; all test data (client, project) cleaned up afterward via `supabase db query --linked`.

## Spec Change Log

## Review Triage Log

- **verdict: high (found and verified by the orchestrator, not a subagent reviewer)** — the cross-company validation for `client_id`/`business_area_id` exists only in the Server Actions, not enforced at the DB level. Verified live: authenticated as `test-chile` (member of Inmasoft Chile only), a raw `POST /rest/v1/projects` with `company_id` = Chile but `business_area_id` belonging to Inmasoft Uruguay succeeded with `201`, bypassing the app entirely. This directly violates the spec's own "Always" boundary ("validated server-side, not just by what the UI dropdown offers" — the DB/RLS layer is equally "not the UI" and was unguarded). → **patch**: add a `BEFORE INSERT OR UPDATE` trigger on `projects` that raises an exception unless `client_id`'s and `business_area_id`'s `company_id` both equal `NEW.company_id`. This also structurally resolves the TOCTOU race the edge-case-hunter flagged (check-then-insert done non-atomically) since a trigger runs inside the same statement.
- **verdict: medium** — budget accepts negative numbers and `Infinity` (`Number(budget)` with no range check) in both create and edit. → **patch**: reject `budget < 0` (and non-finite values) with a clear error, matching the currency/status validation style already used elsewhere in this codebase.
- **verdict: low** — no validation that `end_date >= start_date` when both are provided. → **patch**
- **verdict: low** — when both the client and area lookups fail simultaneously, only one error is logged (`clientError ?? areaError`), dropping the other from diagnostics. → **patch**: log both.
- **verdict: low** — the cross-company lookup/validation logic is duplicated near-verbatim between `createProject` and `updateProject`. → **patch**: extract into one shared `dal.ts` helper, reused by both (in addition to the new DB trigger — defense in depth for a friendly UI error vs. a raw DB exception).
- **verdict: low** — no guidance shown when a company has zero active clients or business areas yet — the create form just renders an unusable disabled picker. → **patch**: show a short message pointing to the Clients/Areas pages instead.
- **reject (structurally resolved by the trigger fix)** — the TOCTOU race between the pre-insert validation query and the insert/update itself. A DB-level trigger makes the check atomic with the write, closing this by construction rather than needing separate handling.
- **reject (already protected)** — calling the Server Action while genuinely unauthenticated would show a misleading validation error instead of an auth error. `proxy.ts`'s matcher covers all non-static routes, including the POST a Server Action makes to its own page route, and redirects unauthenticated requests to `/login` before the action runs — this path isn't reachable the way described.
- **reject (consistent with established precedent)** — swallowed errors returning `[]`/`null` from `getProjects`/`getProjectForEdit` (with `console.error`). Same accepted pattern as every prior Epic 1 story.
- **reject (consistent with established precedent)** — no max-length validation on `name`/`responsible`. Same as clients/suppliers/companies/areas.
- **reject (YAGNI)** — no pagination on the projects list. Consistent with every other list in this app so far.
- **reject (false — scenario unreachable)** — no `ON DELETE` behavior documented for the `client_id`/`business_area_id` FKs. Disproven: clients and business areas are never hard-deleted anywhere in this app (deactivate-only, established since Story 1.2) — the FK-violation scenario the finding describes cannot occur.
- **reject (out of scope)** — no duplicate-project-name detection. Never called for in this spec's Boundaries or ACs, unlike clients/suppliers where the PRD explicitly asked for it; project names aren't the kind of shared-identity field that benefits from dedup nudging.
- **defer (already covered)** — no automated tests for the new DAL functions/actions/trigger. Same root condition as the existing "add a test framework" entry.

## Design Notes

`responsible` is free text, not a foreign key to `auth.users` or `company_memberships` — this app currently has no "assign to a specific teammate" picker UI anywhere, and building one is unrelated new scope. Free text is consistent with the PRD's own field list ("responsable") and easy to upgrade to a real reference later without a breaking migration (the column can be added alongside, or repurposed, once a real need exists).

No separate `active` boolean on `projects`, unlike every other Epic 1 entity — `status` already expresses the lifecycle (`active`/`on_hold`/`closed`) per the PRD's own language, and adding a second independent flag would create two sources of truth for "is this project current."

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run dev` -- expected: starts clean

**Manual checks (if no CLI):**
- As `test-chile`: create a project selecting an existing client and area, confirm it saves and lists correctly
- Try submitting the create form with no client/area selected — confirm a validation error, not a crash
- Edit a project's status to `closed`, confirm via `supabase db query --linked` that `updated_by`/`updated_at` changed and no rows were deleted
- As `test-noaccess`: confirm zero access to Inmasoft Chile's projects
