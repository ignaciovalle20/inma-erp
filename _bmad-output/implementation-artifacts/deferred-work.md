- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-user-login-company-scoped-access.md`
  summary: Multi-company picker/switcher UI (active_company cookie + selection screen) for users with 2+ company memberships
  evidence: Split from Story 1.1 to keep the spec under the token budget — the login + RLS foundation and the single/zero-membership paths are the cohesive core; the 2+ membership picker is an additive UI increment on top of that foundation.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-user-login-company-scoped-access.md`
  summary: Add an automated test framework (unit/integration) for the web app
  evidence: Code review of Story 1.1 confirmed zero test infrastructure exists anywhere in the repo (no jest/vitest, no CI workflow) — every check for the auth/RLS foundation is manual. Real gap, but pre-existing across the whole project and not introduced by this story; setting one up is substantial scope on its own, not a trivial patch.
