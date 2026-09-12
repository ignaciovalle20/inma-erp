---
title: 'Story 7.1: Deploy to Vercel with Supabase Cloud'
type: 'feature'
created: '09-12-2026'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context: ['_bmad-output/implementation-artifacts/epic-7-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The app only runs locally. Nothing is deployed, so the Inmasoft team can't use it yet.

**Approach:** The human imports the GitHub repo into Vercel via the dashboard (their account, not something the agent can do), with `web/` as the project root; the agent prepares whatever the repo needs for that import to succeed cleanly (correct root-relative config, a documented env var list) and verifies the resulting deployment once live.

</frozen-after-approval>

## Implementation Notes

- Vercel project is created by the human via **vercel.com/new**, importing `ignaciovalle20/inma-erp` with **Root Directory** set to `web`. Vercel auto-detects Next.js; no build command override needed.
- Required environment variables (set in Vercel's project settings, **Production** + **Preview**):
  - `NEXT_PUBLIC_SUPABASE_URL` = `https://gpxeikzpqldpxdijbsfs.supabase.co`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = (the anon/publishable key already in `web/.env.local` — not a secret, safe to paste into Vercel's dashboard)
  - Never set `SUPABASE_SERVICE_ROLE_KEY` or any admin key anywhere in Vercel — this app has no server-side use for it.
- Nothing in the repo currently blocks a clean Vercel import (no vercel.json needed for a standard Next.js app; `web/next.config.ts` has no config Vercel can't handle). Confirmed by reading `web/package.json`'s build script (`next build`) — standard, no custom steps.
- HTTPS, auto-deploy on push to `main`, and preview deployments on PRs are Vercel defaults once imported — no repo-side configuration needed for those.
