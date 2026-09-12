- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-user-login-company-scoped-access.md`
  summary: Multi-company picker/switcher UI (active_company cookie + selection screen) for users with 2+ company memberships
  evidence: Split from Story 1.1 to keep the spec under the token budget — the login + RLS foundation and the single/zero-membership paths are the cohesive core; the 2+ membership picker is an additive UI increment on top of that foundation.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-manage-projects.md`
  summary: The client/business-area `<select>` pickers on the new-project form don't preserve their selected value after a validation error re-render (text inputs do, via `defaultValue`, but `<select>` elements only honor `defaultValue` on initial mount, not on re-renders of the same DOM node)
  evidence: Caught during live browser verification — submitting an invalid budget with a client/area already selected returned an error and reset both dropdowns to their placeholder, forcing re-selection. Real UX papercut, not a data-integrity issue (the DB trigger added in this story's review still protects correctness); worth a small follow-up (e.g. keying the `<select>` on the state or controlling it) rather than blocking this story on it.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-4-manage-suppliers.md`
  summary: Extract the repeated "is this user a member (optionally with a given role) of this company" RLS subquery into a reusable Postgres helper function
  evidence: Code review of Story 1.4 found the same `exists (select 1 from company_memberships cm where cm.company_id = ... and cm.user_id = auth.uid() [and cm.role = 'admin'])` pattern now duplicated inline across the `companies`, `clients`, `suppliers`, and `business_areas` migrations. A shared `is_company_member(company_id, required_role default null)` function would reduce drift risk, but refactoring it touches multiple already-shipped migrations — out of scope for any single story.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-user-login-company-scoped-access.md`
  summary: Add an automated test framework (unit/integration) for the web app
  evidence: Code review of Story 1.1 confirmed zero test infrastructure exists anywhere in the repo (no jest/vitest, no CI workflow) — every check for the auth/RLS foundation is manual. Real gap, but pre-existing across the whole project and not introduced by this story; setting one up is substantial scope on its own, not a trivial patch.
