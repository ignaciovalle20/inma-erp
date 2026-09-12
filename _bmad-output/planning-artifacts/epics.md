---
stepsCompleted: ["step-01-validate-prerequisites", "step-01-confirmed", "step-02-design-epics", "step-03-create-stories"]
inputDocuments: ["_bmad-output/planning-artifacts/prd.md", "_bmad-output/planning-artifacts/architecture.md", "docs/decisiones-abiertas.md"]
---

# INMA ERP - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for INMA ERP, decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: The system shall manage multiple companies (Inmasoft Chile, Inmasoft Uruguay), each with its own currency and configuration.
FR2: The system shall maintain a unique client record per company group to avoid name duplication and consolidate profitability per client.
FR3: The system shall maintain a unique supplier record with fiscal/commercial data.
FR4: The system shall support configurable business areas (Microsoft 365, hosting, development, IT support, networking, security/CCTV, GPS, solar energy, other).
FR5: The system shall manage projects with expected/actual income, costs, status, and accumulated + per-period margin.
FR6: The system shall allow manual entry of sales/income documents for both Chile and Uruguay.
FR7: The system shall support CSV/Excel import of sales/income for Chile, in addition to manual entry.
FR8: The system shall allow manual entry of costs/expenses for both companies, with optional import.
FR9: The system shall classify costs as direct or general, and allow distribution of shared costs between projects/clients/areas by percentage or amount.
FR10: The system shall manage recurring services with price, expected cost, periodicity, validity period, and associated client.
FR11: The system shall track monthly personnel/labor cost and allow assignment of cost/hours to projects.
FR12: The system shall generate a monthly result report (net sales, direct margin, operating result).
FR13: The system shall generate profitability reports by client, project, and business area.
FR14: The system shall generate a budgeted-vs-actual report.
FR15: The system shall provide an import workflow with preview, validation, duplicate detection, history, and traceability of the source file/batch.
FR16: The system shall calculate margin automatically from underlying income and cost; margin shall never be a manually entered value.
FR17: The system shall distinguish "confirmed zero cost" from "pending cost" — an empty cost is never treated as zero.
FR18: The system shall model sales document, income, cost, and payment as distinct entities (even though banking is out of scope for V1).
FR19: The system shall exclude recoverable VAT/taxes from profit and operating-expense calculations, while retaining tax and total amounts on each document.
FR20: The system shall prevent duplicate cost counting when a cost is both associated with a sales line and later imported as a supplier document.
FR21: The system shall support accumulated results and a period-recognition rule for multi-month projects (not merely the invoice date).
FR22: The system shall allow drill-down from any dashboard/report figure down to the originating documents/lines.
FR23: The system shall flag "pending costs" so an incomplete sale is never displayed as full profit.
FR24: The system shall preserve the original currency and amount of every transaction, deriving any consolidated-currency conversion for reporting without overwriting the source values.

### NonFunctional Requirements

NFR1 (Security): Row Level Security (RLS) per company — a user may only query/modify companies they are explicitly authorized for.
NFR2 (Security): `service_role` or other administrative Supabase keys shall never be used in the browser/client; secrets shall stay out of the Git repository.
NFR3 (Auditability): Every imported record shall retain its source/origin and external identifier to prevent duplicate ingestion.
NFR4 (Auditability): Sensitive entities shall record the creating/modifying user and timestamps.
NFR5 (Auditability): Corrections must be traceable; documents already included in a report must never be silently deleted.
NFR6 (Data integrity): The system shall never treat an absent value as zero; explicit states (`pending` / `confirmed` / `not_applicable`) shall be used instead.
NFR7 (Usability): The manual entry flow (used primarily by Uruguay, and always available for Chile) must be fast enough for everyday operational use.
NFR8 (Reliability): The Chile import flow must never be the sole source of truth — every imported record must remain manually creatable/editable with an audit trail.

### Additional Requirements

- Stack: Next.js (App Router) + TypeScript, hosted on Vercel with GitHub-integrated auto-deploy (push/PR); Supabase Cloud (PostgreSQL, Auth, Storage, RLS) as backend.
- No starter-template scaffold is required for Epic 1 Story 1 — a working Next.js app already exists locally (`web/`) with verified Supabase connectivity; build on top of it rather than re-scaffolding.
- All schema changes must ship as versioned SQL migrations committed to GitHub — no unmigrated manual changes in Supabase.
- Multi-company and multi-currency support must exist from the first schema: every financial entity belongs explicitly to one company; each transaction keeps its original currency/amount, with consolidated views computed via a derived conversion (never overwriting the source).
- Data model to implement across epics: `companies`, `profiles`/`company_memberships`, `clients`, `suppliers`, `business_areas`, `projects`, `sales_documents`, `sales_lines`, `cost_documents`, `cost_lines`, `cost_allocations`, `recurring_services`, `personnel_costs`, `work_allocations`, `currencies`/`exchange_rates`, `import_batches`/`import_rows`, `management_periods`.
- Before any real financial data is loaded: verify the GitHub repository (`ignaciovalle20/inma-erp`) is private — **already confirmed private** as of 2026-09-12 — review `.gitignore`, and confirm a Supabase backup/recovery policy is in place.
- Validation dataset: the historical Excel "FINANZAS INMASOFT 2026" (123 sales records, Jan–Jun 2026) should be used to validate the profitability engine against real numbers once Epic 6/7 are reached — not as a physical data model.
- New external dependency (now recorded in Architecture): [MonedAPI](https://monedapi.ar/docs) (`GET /api/v2/clp/oficial`, `GET /api/v2/uyu/oficial`) is the exchange-rate provider for the CL/UY USD consolidation (Epic 6, Story 6.5). Open verification item before implementation: confirm whether `clp`/`uyu` rates are quoted against USD directly or against ARS (would require triangulating via an ARS/USD rate) — see Architecture doc.

### Open Constraints (from docs/decisiones-abiertas.md)

- ~~OC1: Owner/partner labor cost~~ — **Resolved**: modeled via Epic 5 (Personnel/Labor Costs) as an internal monthly/hourly assignable cost.
- ~~OC2: Period-recognition rule for multi-month projects~~ — **Resolved**: V1 uses a simple rule (recognize by document date) plus auditable manual period reassignment — see Epic 6, Story 6.6.
- ~~OC3: Consolidated reporting currency/FX source~~ — **Resolved**: consolidated Chile/Uruguay reporting is in **USD**, with the exchange rate fetched automatically from **MonedAPI** (`monedapi.ar`, v2 endpoints) each period — see Epic 6, Story 6.5, and Architecture's "Consolidación de moneda" section. Base-currency of the CLP/UYU quotes (USD vs. ARS) still needs empirical verification before implementation.
- ~~OC4: General/overhead expense distribution~~ — **Resolved**: shown at company level by default in the main report; per-client/project proration remains available as an optional use of the cost allocation mechanism (Epic 3, Story 3.2).
- **OC5 (still open)**: The exact column format of Chile's real export CSV/Excel. A real sample file is still needed to lock the importer's column mapping (Epic 4). Blocks finalizing Epic 4 story implementation details, not story creation itself.

### UX Design Requirements

None — no dedicated UX design specification exists for this project. The Architecture document defines the screen structure at a high level (Dashboard, Gestión, Ingresos, Costos, Reportes, Configuración); no additional actionable UX-DRs were identified. Screen/interaction detail will be resolved at the story level as each epic is implemented.

### FR Coverage Map

FR1: Epic 1 - Companies (multi-company setup)
FR2: Epic 1 - Unique client record
FR3: Epic 1 - Unique supplier record
FR4: Epic 1 - Configurable business areas
FR5: Epic 1 - Projects
FR6: Epic 2 - Manual income entry (Chile/Uruguay)
FR7: Epic 4 - Chile CSV/Excel import
FR8: Epic 3 - Manual cost/expense entry
FR9: Epic 3 - Direct/general cost classification and allocation
FR10: Epic 5 - Recurring services
FR11: Epic 5 - Personnel/labor cost and project assignment
FR12: Epic 6 - Monthly result report
FR13: Epic 6 - Profitability by client/project/area
FR14: Epic 6 - Budgeted vs. actual report
FR15: Epic 4 - Import preview/validation/dedup/history
FR16: Epic 6 - Margin always calculated, never manual
FR17: Epic 3 - Confirmed-zero vs. pending cost distinction
FR18: Epic 1 - Distinct sales/income/cost/payment entities (schema foundation)
FR19: Epic 2 - Net sales / tax handling on income documents
FR20: Epic 3 - Duplicate cost prevention (sales line vs. imported supplier doc)
FR21: Epic 6 - Multi-month accumulated result and period recognition
FR22: Epic 6 - Drill-down from report figures to source documents
FR23: Epic 6 - Pending-cost visibility at report level
FR24: Epic 1 - Original currency/amount preservation (multi-currency foundation)

NFR1: Epic 1 - RLS per company
NFR2: Epic 1 (foundation) / Epic 7 (launch hardening) - No service_role/secrets in browser or repo
NFR3: Epic 4 - Import source/origin traceability
NFR4: Epic 1 - User/timestamp auditing on sensitive entities
NFR5: Epic 1 - No silent deletion of reported documents
NFR6: Epic 3 - Absent value never treated as zero
NFR7: Epic 2 - Fast manual entry flow (Uruguay primary, Chile always available)
NFR8: Epic 4 - Import never the sole source of truth

## Epic List

### Epic 1: Foundational Setup & Master Data
Users can log in, set up the companies (Inmasoft Chile, Inmasoft Uruguay), and manage clients, suppliers, business areas, and projects — with company-scoped security (RLS) and audit trail from day one.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR18, FR24
**NFRs covered:** NFR1, NFR2, NFR4, NFR5

### Epic 2: Manual Income Entry
Users in both Chile and Uruguay can record and edit sales/income documents manually — with correct net amount, tax, total, and currency — fast enough for daily operational use.
**FRs covered:** FR6, FR19
**NFRs covered:** NFR7

### Epic 3: Costs, Expenses & Allocation
Users can record direct and general costs/expenses, distribute shared costs across projects/clients/areas by percentage or amount, and the system distinguishes a confirmed-zero cost from a pending one while preventing duplicate cost counting.
**FRs covered:** FR8, FR9, FR17, FR20
**NFRs covered:** NFR6

### Epic 4: Chile CSV/Excel Importer
Users in Chile can import sales/income from CSV/Excel with preview, validation, duplicate detection, and batch history — without ever depending solely on the imported file.
**FRs covered:** FR7, FR15
**NFRs covered:** NFR3, NFR8

### Epic 5: Recurring Services & Personnel Costs
Users can model recurring services (Microsoft 365, hosting, Starlink, etc.) and personnel/labor costs, assigning cost or hours to projects.
**FRs covered:** FR10, FR11

### Epic 6: Profitability Engine & Reporting
Users get the monthly result, profitability by client/project/area, and budgeted-vs-actual, with drill-down to source documents and visibility of pending costs — validated against a real historical month of data.
**FRs covered:** FR12, FR13, FR14, FR16, FR21, FR22, FR23
**Implementation note:** OC1-OC4 resolved during epic/story design (see Open Constraints). Requires adding an FX-rate API dependency to Architecture before Story 6.5.

### Epic 7: Production Launch
The application is deployed to Vercel connected to Supabase Cloud, with HTTPS, secured environment variables, and the GitHub repository verified private — ready for real use by the Inmasoft team.
**NFRs covered:** NFR2 (final hardening)

## Epic 1: Foundational Setup & Master Data

Users can log in scoped to their authorized companies, and manage companies, clients, suppliers, business areas, and projects with audit trail and RLS security from day one.

### Story 1.1: User Login & Company-Scoped Access

As a registered Inmasoft user,
I want to log in and see only the companies I'm authorized to access,
So that my work stays scoped to the right company and financial data isn't exposed across companies.

**Acceptance Criteria:**

**Given** a user with valid credentials and at least one company membership
**When** they log in
**Then** they see only the companies where they have a membership

**Given** a user without any company membership
**When** they log in
**Then** they see a "no company access" message and no financial data

**Given** a logged-in user has selected a company
**When** they query any data via the API
**Then** Row Level Security limits results to that company only, enforced at the database level

**Given** an unauthenticated request
**When** it hits any data endpoint
**Then** it is rejected

**Given** a single user account holds memberships in more than one company (e.g., both Inmasoft Chile and Inmasoft Uruguay)
**When** they log in
**Then** they see all of those companies under the one account and can switch context between them without a separate login or a separate user record — each company's data stays isolated per RLS regardless of which one is active

### Story 1.2: Manage Companies

As an admin,
I want to create and edit companies with their own base currency and configuration,
So that all financial data is correctly scoped per legal entity.

**Acceptance Criteria:**

**Given** I am an admin
**When** I create a company with name, country, tax ID, and base currency
**Then** it is saved and becomes selectable for authorized users

**Given** Inmasoft Chile and Inmasoft Uruguay don't yet exist
**When** I complete initial setup
**Then** both are created with CLP and UYU as their respective base currencies

**Given** a company exists
**When** I edit its configuration
**Then** the change is saved with modifying user and timestamp (audit trail)

**Given** a company is marked inactive
**When** users try to select it for new records
**Then** it no longer appears as selectable, though its historical data stays visible

### Story 1.3: Manage Clients

As a user,
I want a single client record per company that avoids duplicate names,
So that revenue and profitability roll up correctly per client.

**Acceptance Criteria:**

**Given** I am creating a client for a company
**When** I enter a name closely matching an existing client in that company
**Then** the system warns me of the potential duplicate before saving

**Given** a client record
**When** I save it
**Then** it stores tax ID, country, status, and metadata, scoped to one company, with audit fields

**Given** a client has existing sales or projects
**When** someone tries to remove it
**Then** it can only be deactivated, never silently deleted

### Story 1.4: Manage Suppliers

As a user,
I want a single supplier record per company,
So that costs and expenses roll up correctly per supplier without duplicates.

**Acceptance Criteria:**

**Given** I am creating a supplier
**When** I enter a name closely matching an existing supplier in that company
**Then** the system warns me of the potential duplicate

**Given** a supplier record
**When** I save it
**Then** it stores fiscal/commercial data and status, scoped to one company, with audit fields

### Story 1.5: Manage Business Areas

As a user,
I want a configurable list of business areas,
So that revenue, costs, and projects are classified consistently for reporting.

**Acceptance Criteria:**

**Given** the system is newly set up
**When** an admin views business areas
**Then** the 8 default areas (Microsoft 365, hosting, development, IT support, networking, security/CCTV, GPS, solar energy, other) are pre-seeded and editable

**Given** I am an admin
**When** I add, rename, or deactivate a business area
**Then** the change applies company-wide and existing records keep their historical classification

### Story 1.6: Manage Projects

As a user,
I want to create and manage projects linked to a client, company, and business area,
So that I can later track expected/actual income, costs, and margin per project.

**Acceptance Criteria:**

**Given** a client and business area exist for a company
**When** I create a project with name, dates, status, budget, and responsible person
**Then** it is saved scoped to that company, ready for future income/cost entry

**Given** a project exists
**When** I edit its status
**Then** the change is saved with audit fields and doesn't delete any linked historical financial data

**Given** I try to create a project without a client or business area
**Then** the system blocks saving with a validation error

## Epic 2: Manual Income Entry

Users in both Chile and Uruguay can record and edit sales/income documents manually — with correct net amount, tax, total, and currency — fast enough for daily operational use.

### Story 2.1: Manual Sales Document Entry

As a user,
I want to manually create a sales/income document with one or more lines for my company,
So that revenue is captured accurately regardless of country.

**Acceptance Criteria:**

**Given** I am creating a sales document for a company
**When** I enter document type, date, client, currency, and one or more lines with an amount
**Then** the system calculates and stores net amount, tax, and total separately, preserving the original currency

**Given** a document has multiple lines
**When** I add or remove a line before saving
**Then** the document's net/tax/total recalculate automatically from all lines

**Given** I save a sales document
**Then** it is stored as its own sales document/line record, kept distinct from cost or payment data — never merged into a single generic transaction

### Story 2.2: Edit & Correct Sales Documents with Audit Trail

As a user,
I want to correct a sales document after saving it, even if it's already been used in a report,
So that mistakes can be fixed without losing traceability of what changed.

**Acceptance Criteria:**

**Given** a sales document has already been included in a monthly report
**When** I edit its amount, date, or client
**Then** the correction is saved with the modifying user, timestamp, and a visible record that a change occurred (never a silent overwrite)

**Given** a sales document is no longer valid
**When** I need to remove it
**Then** the system voids/deactivates it instead of deleting it outright, keeping it auditable

### Story 2.3: Fast Manual Entry Flow for Uruguay

As an Uruguay-based user,
I want a streamlined manual entry screen with sensible defaults and minimal required fields,
So that recording daily sales is quick enough for everyday use.

**Acceptance Criteria:**

**Given** I am entering a sales document for Uruguay
**When** I open the manual entry screen
**Then** currency defaults to UYU, and only the essential fields (client, date, amount, area) are required to save

**Given** I've just saved a document
**When** I want to enter another one
**Then** the form resets ready for the next entry without extra navigation steps

## Epic 3: Costs, Expenses & Allocation

Users can record direct and general costs/expenses, distribute shared costs across projects/clients/areas, and the system distinguishes a confirmed-zero cost from a pending one while preventing duplicate cost counting.

### Story 3.1: Manual Cost/Expense Entry

As a user,
I want to manually record a cost/expense document for my company,
So that costs are captured accurately alongside revenue.

**Acceptance Criteria:**

**Given** I am creating a cost document for a company
**When** I enter document type, date, supplier, currency, and amount
**Then** it is stored as its own cost document/line record, distinct from sales or payment data

**Given** a cost document
**When** I save it
**Then** I classify it as either "direct" (tied to a specific project/client) or "general" (company-level overhead)

### Story 3.2: Cost Allocation Across Projects, Clients & Areas

As a user,
I want to distribute a shared cost across multiple projects, clients, or areas by percentage or amount,
So that shared expenses are fairly attributed to what actually consumed them.

**Acceptance Criteria:**

**Given** a cost document classified as shared
**When** I split it across two or more targets (project/client/area) by percentage or fixed amount
**Then** the system validates that allocations sum to 100% (or the full cost amount) before saving

**Given** an allocation is saved
**When** a project/client/area report is generated
**Then** it reflects only that target's allocated share of the cost

### Story 3.3: Track Pending vs. Confirmed-Zero Costs

As a user,
I want the system to distinguish "cost not recorded yet" from "cost confirmed as zero,"
So that margin is never overstated by silently treating a missing cost as zero.

**Acceptance Criteria:**

**Given** a sale or project has no linked cost yet
**When** I view it
**Then** it shows an explicit "pending" status, never a blank or $0 value

**Given** a cost is genuinely zero (e.g., an internal/no-charge item)
**When** I explicitly mark it "confirmed zero"
**Then** it is visually and structurally distinguished from "pending" everywhere it appears

**Given** a report aggregates margin for a period
**When** pending costs exist within that period
**Then** those records are flagged and excluded from a "confirmed margin" figure, shown separately rather than counted as full margin

### Story 3.4: Prevent Duplicate Cost Counting

As a user,
I want the system to detect when a cost already linked to a sales line is later matched by an imported supplier document,
So that the same cost is never counted twice toward margin.

**Acceptance Criteria:**

**Given** a cost is already associated with a sales line
**When** a matching supplier document is later imported
**Then** the system flags a potential duplicate for review before counting it

**Given** I confirm two cost records represent the same expense
**When** I resolve the duplicate
**Then** only one instance counts toward margin, with both records linked for traceability

## Epic 4: Chile CSV/Excel Importer

Users in Chile can import sales/income from CSV/Excel with preview, validation, duplicate detection, and batch history — without ever depending solely on the imported file.

### Story 4.1: Import Sales with Column Mapping & Preview

As a Chile-based user,
I want to upload a CSV/Excel file of sales and preview the mapped records before committing,
So that I can verify the data is interpreted correctly before it becomes official.

**Acceptance Criteria:**

**Given** I upload a sales file
**When** the system maps its columns to internal fields (date, client, amount, currency, tax)
**Then** I see a preview table of the mapped records before anything is saved

**Given** a row has invalid or missing required data (date, amount, client)
**When** I view the preview
**Then** that row is flagged with a specific error and excluded from the commit until fixed or explicitly skipped

### Story 4.2: Duplicate Detection on Import

As a user,
I want the importer to detect rows that duplicate previously imported or manually entered sales,
So that revenue is never double-counted.

**Acceptance Criteria:**

**Given** a row's external identifier or key fields (date, client, amount) match an existing sales document
**When** I view the preview
**Then** it is flagged as a likely duplicate with an option to skip or force-import

**Given** I choose to force-import a flagged duplicate
**When** the import completes
**Then** both records exist with the override noted for audit

### Story 4.3: Import Batch History & Traceability

As a user,
I want every import recorded as a batch with its source file and results,
So that I can trace any imported sales record back to the file it came from.

**Acceptance Criteria:**

**Given** an import completes, fully or partially
**When** I view import history
**Then** I see the batch with file name, date, user, and row counts (imported/error/duplicate)

**Given** I open a sales document that came from an import
**When** I view its origin
**Then** I see which import batch and source row it came from

**Given** the Chile import flow exists
**When** a user needs to add or fix a record
**Then** manual create/edit (Epic 2) remains fully available — the importer is never the only way in

## Epic 5: Recurring Services & Personnel Costs

Users can model recurring services (Microsoft 365, hosting, Starlink, etc.) and personnel/labor costs, assigning cost or hours to projects.

### Story 5.1: Manage Recurring Services

As a user,
I want to define recurring services with price, expected cost, periodicity, and validity, tied to a client,
So that recurring revenue and margin are modeled explicitly instead of re-entered every month.

**Acceptance Criteria:**

**Given** I create a recurring service (e.g., Microsoft 365, hosting, Starlink)
**When** I set client, price, expected cost, periodicity (monthly/annual), and start/end validity
**Then** it is saved and available to generate the expected entry for each period

**Given** an active recurring service
**When** a new period starts
**Then** the system generates (or prompts to generate) the expected income/cost entry for that period without manual re-entry from scratch

**Given** a recurring service reaches its end validity date
**When** the period rolls over
**Then** it stops generating new entries automatically

### Story 5.2: Track Personnel/Labor Costs

As a user,
I want to record the monthly cost of personnel or partners,
So that labor cost is included in the overall cost structure.

**Acceptance Criteria:**

**Given** a person (employee or partner)
**When** I record their monthly cost for a company and period
**Then** it is saved and available as a basis for project cost allocation

### Story 5.3: Assign Personnel Cost/Hours to Projects

As a user,
I want to assign a portion of a person's monthly cost or hours to specific projects,
So that labor cost is reflected in project profitability when relevant.

**Acceptance Criteria:**

**Given** a personnel cost record for a period
**When** I allocate hours or a cost amount to one or more projects
**Then** each project's cost includes its allocated share

**Given** allocations to projects don't consume the full monthly cost
**When** a remainder is left unallocated
**Then** it is tracked as general/unassigned labor cost, never silently dropped

## Epic 6: Profitability Engine & Reporting

Users get the monthly result, profitability by client/project/area, and budgeted-vs-actual, with drill-down to source documents and visibility of pending costs — validated against a real historical month of data.

### Story 6.1: Monthly Result Report

As a user,
I want a monthly result report per company showing net sales, direct margin, and operating result,
So that I know the real economic outcome of the month.

**Acceptance Criteria:**

**Given** a period and company
**When** I open the monthly result report
**Then** I see net sales, direct margin, and operating result computed automatically from underlying documents — never a manually entered figure

**Given** pending costs exist for the period
**When** I view the result
**Then** it explicitly shows a "confirmed" result separately from the amount that's uncertain due to pending costs

### Story 6.2: Profitability by Client, Project & Area

As a user,
I want to see profitability by client, project, and business area for a period,
So that I know which relationships and workstreams are actually profitable.

**Acceptance Criteria:**

**Given** a period
**When** I view the client, project, or area profitability report
**Then** it shows revenue, allocated costs, and margin per entity, using the same calculation engine as the monthly result

**Given** a project spans multiple months
**When** I view its profitability
**Then** I see both accumulated (life-to-date) and per-period figures

### Story 6.3: Budgeted vs. Actual

As a user,
I want to compare budgeted vs. actual results for a project,
So that I can see how far off plan we are.

**Acceptance Criteria:**

**Given** a project has a budget set
**When** I view its budget-vs-actual
**Then** I see planned amount, actual amount (from real income/costs), and variance

### Story 6.4: Drill-Down from Any Report Figure

As a user,
I want to click any aggregated figure in a report and see the documents behind it,
So that I can verify and trust the numbers.

**Acceptance Criteria:**

**Given** any report figure (net sales, margin, cost total)
**When** I drill into it
**Then** I see the underlying sales/cost documents and lines that compose it, each linkable to its record

### Story 6.5: Consolidated Chile + Uruguay Result in USD

As a user,
I want a consolidated profitability view combining Chile and Uruguay in USD,
So that I can see Inmasoft's overall performance in one number.

**Acceptance Criteria:**

**Given** both companies have results for a period
**When** I view the consolidated report
**Then** each company's figures are converted to USD using that period's exchange rate, fetched automatically from an external rate source, without altering the original-currency records

**Given** the external rate source is unavailable for a period
**When** generating the consolidated report
**Then** the system flags the period as "pending exchange rate" rather than silently using a stale or zero rate

**Given** the exchange rate is sourced from MonedAPI (`GET /api/v2/clp/oficial`, `GET /api/v2/uyu/oficial`)
**When** implementing this story
**Then** the developer first verifies empirically whether the returned `buy`/`sell` values are quoted against USD or against ARS, and triangulates via an ARS/USD rate if needed — this check happens before the conversion logic is built, not assumed

### Story 6.6: Period Recognition for Multi-Month Projects

As a user,
I want income and costs of a multi-month project recognized against the correct period (not just invoice date), with room for audited manual adjustments,
So that a project's per-period result reflects real progress rather than billing timing.

**Acceptance Criteria:**

**Given** a multi-month project
**When** income/cost documents are dated
**Then** by default they are recognized in the period of their document date (simple rule)

**Given** I need to reassign a document's recognized period manually
**When** I make that adjustment
**Then** it is saved with user/timestamp and visible in the project's history, without altering the original document date

### Story 6.7: Validate Engine Against a Real Historical Month

As Inmasoft's team,
We want to load one real month of Chile and Uruguay data and compare calculated results against known figures,
So that we trust the profitability engine before relying on it for real decisions.

**Acceptance Criteria:**

**Given** a real month's sales and costs from Chile and Uruguay are loaded
**When** the monthly result and profitability reports are generated
**Then** any differences against manually-reconciled reference figures are documented and resolved — as engine bugs or data-entry corrections — before sign-off

## Epic 7: Production Launch

The application is deployed to Vercel connected to Supabase Cloud, with HTTPS, secured environment variables, and the GitHub repository verified private — ready for real use by the Inmasoft team.

### Story 7.1: Deploy to Vercel with Supabase Cloud

As the team,
We want the Next.js app deployed to Vercel connected to Supabase Cloud, with HTTPS and secure environment variables,
So that the ERP is accessible for real use.

**Acceptance Criteria:**

**Given** the app is ready for release
**When** it is deployed to Vercel connected to the GitHub repository
**Then** it builds and deploys automatically on push to main, served over HTTPS with production Supabase environment variables set — no secrets committed to Git

**Given** the deployed app
**When** reviewing client-side code
**Then** `service_role` or any admin Supabase key is never referenced from the browser

### Story 7.2: Repository & Secrets Hardening

As the team,
We want to confirm the GitHub repository is private and a secrets/backup policy is in place,
So that real financial data is protected before go-live.

**Acceptance Criteria:**

**Given** the repository is `ignaciovalle20/inma-erp` (already confirmed private as of 2026-09-12)
**When** this story completes
**Then** `.gitignore` has been reviewed for potential secret leakage and a Supabase backup/recovery policy is documented
