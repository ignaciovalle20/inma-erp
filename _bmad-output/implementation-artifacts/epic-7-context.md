# Epic 7 Context: Production Launch

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Get the finished application live for real use by the Inmasoft team: deployed to Vercel, connected to Supabase Cloud, served over HTTPS, with production secrets properly secured and the source repository confirmed private. This is the final hardening step before real financial data flows through the system — it closes out the security requirement that no privileged Supabase key ever reaches the browser, and confirms the basic operational safety net (private repo, reviewed `.gitignore`, backup/recovery policy) is in place before go-live.

## Stories

- Story 7.1: Deploy to Vercel with Supabase Cloud
- Story 7.2: Repository & Secrets Hardening

## Requirements & Constraints

- Administrative/`service_role` Supabase keys must never be referenced or reachable from client-side (browser) code; secrets must never be committed to the Git repository.
- The production deploy must build and release automatically on push to the main branch via the GitHub integration, and must be served over HTTPS with production Supabase environment variables configured in the hosting platform (not hardcoded or committed).
- Before real financial data is loaded, three things must hold: the GitHub repository is private, `.gitignore` has been reviewed for potential secret leakage, and a Supabase backup/recovery policy exists and is documented.
- The GitHub repository (`ignaciovalle20/inma-erp`) was already confirmed private as of 2026-09-12 — this story is about verifying/documenting the remaining hardening items, not the privacy setting itself.

## Technical Decisions

- Stack: Next.js (App Router) + TypeScript, hosted on Vercel with native GitHub integration (auto-deploy on push/PR); Supabase Cloud (PostgreSQL, Auth, Storage, RLS) is the backend and is not being replaced or migrated at this stage.
- A working Next.js app already exists locally (`web/`) with verified Supabase connectivity — this epic is about shipping that app, not scaffolding a new one.
- All schema changes must already exist as versioned SQL migrations committed to GitHub; deployment should not introduce any unmigrated manual Supabase changes.
- Long-term option (not part of this epic): if full backend independence is ever pursued, only Supabase (Postgres/Auth/Storage) would migrate to self-hosted infrastructure (VPS + Docker) as a separate project — Vercel would continue serving the frontend regardless.
