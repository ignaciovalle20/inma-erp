# Epic 1 Context: Foundational Setup & Master Data

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

This epic establishes the technical and data foundation for the entire ERP: authentication scoped to company membership, the company entity itself, and the core master data (clients, suppliers, business areas, projects) that every later epic's income, cost, and reporting features build on top of. It matters because every financial entity in the system must belong explicitly to one company, and every user's access must be restricted to their authorized companies at the database level (RLS) before any real data is loaded — get this wrong here and every downstream epic inherits the flaw. Master data must also avoid duplicate client/supplier records so profitability rolls up correctly per entity, and every sensitive record needs an audit trail (creator/modifier + timestamps) with no silent deletion, since corrections must remain traceable once documents are used in reports.

## Stories

- Story 1.1: User Login & Company-Scoped Access
- Story 1.2: Manage Companies
- Story 1.3: Manage Clients
- Story 1.4: Manage Suppliers
- Story 1.5: Manage Business Areas
- Story 1.6: Manage Projects

## Requirements & Constraints

- A user must see and access only the companies they hold a membership for; one user account can hold memberships in multiple companies (e.g., both Inmasoft Chile and Inmasoft Uruguay) and switch between them without separate logins or separate user records, with data isolation enforced per company regardless of which is active.
- Row Level Security must enforce company scoping at the database level, not just in the UI — unauthenticated requests and cross-company queries must be rejected/filtered at that layer.
- Client and supplier records must be unique per company and warn on likely duplicate names before saving, since fragmented records break profitability roll-ups.
- Clients/suppliers with existing sales, projects, or cost history can only be deactivated, never deleted.
- Business areas ship with 8 pre-seeded defaults (Microsoft 365, hosting, development, IT support, networking, security/CCTV, GPS, solar energy, other); admins can add/rename/deactivate them, and existing records must retain their historical classification after a change.
- Projects must link to a client, company, and business area; creation without a client or business area must be blocked with a validation error. Editing a project's status must never delete linked historical financial data.
- Companies (Inmasoft Chile, Inmasoft Uruguay) each need name, country, tax ID, and base currency (CLP and UYU respectively); inactive companies stay selectable for viewing historical data but not for new records.
- Every sensitive entity (companies, clients, suppliers, business areas, projects) must record creating/modifying user and timestamps, and corrections must be visible/auditable rather than silent overwrites.
- `service_role` or other admin Supabase keys must never be used client-side, and secrets must stay out of the Git repository — relevant from this epic onward since it sets up the initial Supabase/auth wiring.

## Technical Decisions

- Stack: Next.js (App Router) + TypeScript on Vercel (GitHub-integrated auto-deploy on push/PR); Supabase Cloud (PostgreSQL, Auth, Storage, RLS) as backend.
- A working Next.js app already exists locally (`web/`) with verified Supabase connectivity — build on top of it; no starter-template scaffolding needed for Story 1.1.
- All schema changes ship as versioned SQL migrations committed to GitHub; no unmigrated manual changes directly in Supabase.
- Core tables this epic establishes or depends on: `companies`, `profiles`/`company_memberships`, `clients`, `suppliers`, `business_areas`, `projects`. Every financial entity must belong explicitly to one company from the first schema — this is the multi-company/multi-currency foundation later epics (income, cost, reporting) rely on.
- Multi-currency handling: each company has its own base currency; transactions elsewhere in the system keep original currency/amount, with consolidated views derived rather than overwriting source values (this epic just needs to carry base currency at the company level correctly).
- Before loading real financial data: the GitHub repo (`ignaciovalle20/inma-erp`) is already confirmed private; still need to review `.gitignore` and confirm a Supabase backup/recovery policy — flagged as a pre-production gate, formally closed out in Epic 7.

## Cross-Story Dependencies

- Story 1.2 (Companies) must exist before Story 1.1's company-scoped login can show real company selection, and before any of 1.3–1.6 (clients, suppliers, business areas, projects) can be scoped to a company.
- Story 1.5 (Business Areas) and Story 1.3 (Clients) must exist before Story 1.6 (Projects), since a project requires both a client and a business area to be created.
- This entire epic is a prerequisite for Epic 2 (Manual Income Entry) and Epic 3 (Costs & Allocation), which attach sales/cost documents to companies, clients, suppliers, and projects defined here; and for the RLS/audit patterns established here to be reused by every later financial entity.
