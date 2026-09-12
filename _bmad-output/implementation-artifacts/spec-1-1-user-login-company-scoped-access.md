---
title: 'Story 1.1: User Login & Company-Scoped Access'
type: 'feature'
created: '09-12-2026'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'eaa496123eb788be047ff76a81dd727fbe4b8e1d'
context: ['_bmad-output/implementation-artifacts/epic-1-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** No auth or data model exists yet — no Supabase client code, migrations, or login screen. Every later epic needs users to log in and see only their authorized companies, enforced at the DB level.

**Approach:** Wire up Supabase Auth (email/password) via `@supabase/ssr`, add a minimal `companies` + `company_memberships` schema with RLS scoped to `auth.uid()`'s memberships, and build a login screen landing single-membership users on their company or showing "no company access" for zero. (2+ membership picker is deferred — see `deferred-work.md`.)

## Boundaries & Constraints

**Always:** enforce company scoping via Postgres RLS, never client-side filtering alone; use `proxy.ts` (Next 16's renamed `middleware.ts`) to refresh the session cookie; record `created_at`/`created_by`/`updated_at`/`updated_by` on every table created; keep `service_role` out of all code — anon key only.

**Never:** build the multi-company picker (deferred); build public self-service signup (accounts provisioned via Supabase Dashboard invite); add `companies` fields beyond `id`/`name`/audit columns (country/tax ID/currency/active is Story 1.2's `ALTER TABLE`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Login, single membership | Valid credentials, 1 company membership | Land scoped to that company, no picker | N/A |
| Login, no membership | Valid credentials, 0 memberships | Show "no company access" message, no data queries fire | N/A |
| Invalid credentials | Wrong password | Stay on login page | Show inline error, no session created |
| Unauthenticated data access | No session cookie | Any Supabase query returns empty (RLS) | Proxy redirects to `/login` for app routes |
| Cross-company query attempt | Authenticated, queries a company without membership | RLS returns zero rows | N/A — never a 500, just empty |

</frozen-after-approval>

## Code Map

- `web/src/app/page.tsx`, `layout.tsx` -- default scaffold; page.tsx replaced, layout.tsx keeps fonts/shell
- `web/package.json` -- `@supabase/ssr`/`@supabase/supabase-js` already installed, no new deps
- `web/.env.local` -- created this session, verified reachable against the live project
- Next 16 renamed `middleware.ts` → `proxy.ts` (same `NextRequest`/`NextResponse` API, export named `proxy`) — write the new convention, not the deprecated one
- No `supabase/` dir yet (creates `supabase/migrations/`); no test framework configured — verify via `npm run dev` + browser + PostgREST curl

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/20260912120000_epic1_story1_auth_foundation.sql` -- `companies`(id,name,audit cols), `company_memberships`(user_id,company_id,role,unique pair), shared `set_updated_at()` trigger, RLS enabled + SELECT policies scoped to `auth.uid()`'s memberships
- [x] `web/src/lib/supabase/client.ts` -- `createBrowserClient` factory (`@supabase/ssr`)
- [x] `web/src/lib/supabase/server.ts` -- `createServerClient` factory using `next/headers` `cookies()`
- [x] `web/src/proxy.ts` -- refreshes the session cookie every request; redirects unauthenticated app routes to `/login`
- [x] `web/src/lib/dal.ts` -- `getSession()`, `getUserCompanies()` -- reused by later epics and the deferred picker
- [x] `web/src/app/login/page.tsx` + `actions.ts` -- email/password form, `signInWithPassword` via Server Action
- [x] `web/src/app/page.tsx` -- rewrite: no session → `/login`; 1 membership → land scoped; 0 → "no company access"; 2+ → plain placeholder list (switching is the deferred spec)
- [x] `web/src/app/logout/actions.ts` -- `signOut()`, redirect to `/login`

**Acceptance Criteria:**
- Given a user with valid credentials and one company membership, when they log in, then they land scoped to that company
- Given a user with no membership, when they log in, then they see a "no company access" message and no financial queries fire
- Given an unauthenticated request to any app route, then the proxy redirects to `/login`
- Given RLS policies are active, when querying `companies` or `company_memberships` with the anon key and no valid session, then zero rows return — verified directly via a PostgREST call, not only through the UI

## Implementation Notes

- All code-level tasks are implemented and verified locally (`npm run dev` starts clean; `npx tsc --noEmit` passes; unauthenticated `GET /` returns a 307 to `/login`).
- The migration file is written but **not yet applied** to the live Supabase project — per Design Notes, the local `supabase` CLI belongs to an unrelated account and cannot be used here. A `curl` against `${SUPABASE_URL}/rest/v1/companies?select=*` with the anon key currently returns `404 PGRST205` ("table not found in schema cache"), confirming the schema doesn't exist yet in the live DB. **Action needed from the human:** paste `supabase/migrations/20260912120000_epic1_story1_auth_foundation.sql` into the Supabase Dashboard's SQL Editor and run it, then create the two test users (Dashboard → Authentication → Users) — one with a `company_memberships` row inserted, one without — per the Design Notes.
- Once the migration is applied and test users exist, re-run the two manual checks from Verification (login as each test user; re-run the anon-key `curl` and confirm it now returns `[]` instead of a 404) to close out the acceptance criteria that depend on the live DB.
- Proxy matcher excludes `_next/static`, `_next/image`, `favicon.ico`, and common static image extensions; everything else (including `/login`) passes through the proxy, which then allow-lists `/login` itself before deciding to redirect.
- `dal.ts` returns `[]` from `getUserCompanies()` on any Supabase error (including "no session") rather than throwing, so `page.tsx` never fires a financial query path for the zero-membership case — it just renders the "no company access" message.
- Matrix Test Audit (post-implementation review): drove the "Invalid credentials" row through the actual browser against the live Supabase Auth service (doesn't need the migration) — submitted `nobody@example.com` / a wrong password on `/login`, confirmed "Invalid email or password." rendered inline and the page stayed on `/login`. This row was not covered by the implementation subagent's own pass.
- Migration applied by the human to the live project on 2026-09-12; confirmed via anon-key `curl` to `/rest/v1/companies` returning `200 []` (was `404 PGRST205` before). Two test users created (Dashboard, auto-confirmed): `test-noaccess@inma-erp.local` (no membership) and `test-chile@inma-erp.local` (membership to a seeded "Inmasoft Chile" row, inserted by the human via SQL Editor since RLS blocks the anon key from writing).
- Browser-verified end to end: `test-chile@inma-erp.local` logs in and lands directly on "Inmasoft Chile" (single-membership path); logout returns to `/login`; `test-noaccess@inma-erp.local` logs in and sees "No company access" (zero-membership path).
- Code review (3 parallel layers: blind-hunter, edge-case-hunter, verification-gap) found 5 real patchable gaps (exact-match route check, redirect authenticated users off `/login`, try/catch around all Supabase auth calls, env var validation, error logging on swallowed errors) — all fixed and re-verified (`npx tsc --noEmit` clean). Full triage in `## Review Triage Log` below.
- The cross-company RLS row was flagged by the verification-gap reviewer as unverified in the way that matters (anon-key check only proves the `to authenticated` role grant, never reaches the `exists` subquery). Closed out empirically: seeded a second company ("Inmasoft Uruguay", no membership for `test-chile`), signed in as `test-chile` via the password grant, and confirmed `GET /rest/v1/companies` returns only Inmasoft Chile — an explicit filter for Uruguay by name returns `[]`. All 5 I/O matrix rows are now verified end-to-end.

## Spec Change Log

- 2026-09-12: Split at the token-budget gate. Deferred the 2+ membership picker/switcher UI to a follow-up spec (`deferred-work.md`), narrowing this spec to login + RLS foundation + the single/zero-membership paths.

## Review Triage Log

- **verdict: low** — `proxy.ts` route matching uses `pathname.startsWith("/login")` instead of an exact match, so a hypothetical future route like `/login-as-admin` would bypass the auth redirect; no such route exists today, but the guard doesn't do what it's meant to. Fix: exact-match the public route list. → **patch**
- **verdict: low** — an already-authenticated user visiting `/login` sees the login form instead of being redirected home; cosmetic only (re-submitting just re-authenticates), but the fix is a trivial one-line addition to `proxy.ts`. → **patch**
- **verdict: medium** — none of `proxy.ts`'s `getUser()`, `login/actions.ts`'s `signInWithPassword()`, or `logout/actions.ts`'s `signOut()` are wrapped in try/catch; a thrown error (network blip, Supabase outage) crashes the request instead of degrading to a login redirect or a generic inline error — disproportionate impact (every request could 500) for a trivial fix. → **patch**
- **verdict: low** — `client.ts`/`server.ts`/`proxy.ts` use non-null assertions on the two Supabase env vars with no validation; a misconfigured deploy (e.g. a fresh Vercel env missing them) surfaces as an obscure SDK error instead of a clear config error. Relevant now that Epic 7 will deploy this. → **patch**
- **verdict: low** — `dal.ts`'s `getUserCompanies()` and `login/actions.ts`'s error branch both swallow the real Supabase error with no server-side logging, so a transient DB/auth error is indistinguishable from "no access" / "wrong password" in the logs. Fix: log the real error before returning the user-facing message. → **patch**
- **verdict: n/a (verification gap, filed disposition: patch)** — the cross-company RLS row (`using (exists (...))` on `companies`) was verified by inspection to be a standard, correct pattern, but had not been exercised end-to-end with an authenticated non-member against a second company — the anon-key check only proves the `to authenticated` role grant, never reaches the `exists` subquery. Closed out below by running the missing check directly rather than dispatching a code fix. → **patch** (verification only, no code change)
- **false** — `supabase/.temp/*` (pooler URL, project ref, linked-project.json) appearing in the review diff. Disproven: `git check-ignore -v supabase/.temp/project-ref` confirms it's ignored by `supabase/.gitignore`, and `git add -n supabase` only stages `.gitignore`, `config.toml`, and the migration file — these paths were pulled into the diff by my own ad-hoc `find`-based diff script bypassing `.gitignore`, not a real risk of being committed.
- **false** — `sprint-status.yaml` showing `in-progress` while the spec frontmatter shows `in-review`. Disproven: per `step-05-present.md`, syncing sprint-status to `review` is an explicit, documented action of the *next* step, not yet reached — this is expected transient state, not a bug.
- **false** — `page.tsx`'s `Signed in as {user.email}` rendering empty for a null email. Disproven: this app has no OAuth/phone signup path (explicitly out of scope per this story's "Never" boundary — accounts are Dashboard-provisioned email/password only), and Supabase email/password users always have a non-null email; the branch is unreachable given the app's actual constraints.
- **false** — `dal.ts`'s embedded `companies` relation possibly resolving as an array instead of an object. Disproven: `company_memberships.company_id` is a to-one foreign key to `companies.id`; PostgREST always embeds a to-one relation as a single object, never an array, regardless of generated-types presence.
- **reject (low, fix more than trivial)** — a session expiring between `page.tsx`'s `getSession()` and `getUserCompanies()` calls could show "No company access" instead of redirecting to `/login`. Window is a single fast server request; fixing it cleanly means restructuring the two calls into one, more than a direct correction for a not-plausible-in-everyday-use race.
- **defer** — no automated test framework exists anywhere in the repo; all verification for this story is manual/curl, recorded in prose. Real, but pre-existing across the whole project, not introduced by this story — appended to `deferred-work.md`.
- **defer (already covered)** — the 2+ membership placeholder branch (`page.tsx`) has no interaction and was never exercised by any check. This is the explicitly deferred multi-company picker itself (already an entry in `deferred-work.md`); no new entry needed.

## Design Notes

The Supabase project (`gpxeikzpqldpxdijbsfs`) was created via the Dashboard — the locally authenticated `supabase` CLI belongs to an unrelated employer account and must not be used here. The migration SQL must be applied by the human via the Dashboard's SQL Editor (no DB password or matching CLI session available to the agent). After that, the human creates two test users manually (Dashboard → Authentication → Users) — one with a membership row, one without — since there's no signup flow yet.

## Verification

**Commands:**
- `cd web && npm run dev` -- expected: starts on localhost:3000 with no build errors
- `cd web && npx tsc --noEmit` -- expected: no type errors

**Manual checks (if no CLI):**
- Open the app in a browser: unauthenticated → redirected to `/login`
- Log in with a test user that has 0 memberships and one with exactly 1, confirm the two distinct landing behaviors from the AC table
- `curl` the `companies` REST endpoint with the anon key and no `Authorization` bearer/session — confirm empty result, not an error or full table dump
