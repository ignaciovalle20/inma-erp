---
title: 'Story 6.5: Consolidated Chile + Uruguay Result in USD'
type: 'feature'
created: '2026-09-13'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '3a17d284f3ebac54030086101fb05b1ad31d73cc'
context: ['_bmad-output/implementation-artifacts/epic-6-context.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing combines Chile and Uruguay's results into one number — each company's monthly result (Story 6.1) is only ever shown in its own currency, with no consolidated view of overall performance.

**Approach:** A new cross-company report summing every company's `computeMonthlyResult` for a period, each converted to USD via a rate fetched from MonedAPI, never altering the original-currency records. **Empirical verification done before writing this spec** (per the story's own AC3): `GET /api/v2/usd/oficial` returns `buy≈1480`/`sell≈1532` — far too large to be "USD per USD," confirming MonedAPI's `buy`/`sell` are ARS-denominated (pesos per unit of the named currency), not USD-denominated. Converting CLP/UYU to USD therefore requires triangulating through ARS: `usd = (amount_in_source_currency × ars_per_source_currency) / ars_per_usd`.

## Boundaries & Constraints

**Always:** original-currency records (`sales_documents`/`cost_documents`, all Epic 2-6 figures) are never modified or overwritten by this story — USD conversion is a derived, display-only computation; a period whose rate can't be obtained (API failure, and no snapshot exists yet for that period) is flagged "pending exchange rate," never silently defaulted to a stale or zero rate; the consolidated report includes every company the viewer is a member of (not hardcoded to exactly two), each contributing its own `computeMonthlyResult` in its own currency before conversion.

**Decisions (made autonomously, with reasoning):** **rate = the average of `buy`/`sell`** for both the source currency's ARS rate and the ARS/USD rate — the AC doesn't specify buy vs. sell vs. mid, and a simple midpoint is the most defensible default for a consolidated *report* figure (not an actual currency trade, where buy/sell would matter). **Rates are snapshotted per period on first successful fetch**, not re-fetched live on every view — MonedAPI's endpoints return only the *current* oficial rate (`updatedAt`, no historical parameter exists), so re-fetching on every view of a *past* period would silently reinterpret history every time someone looks at last month's consolidated report using today's rate. A lightweight `exchange_rate_snapshots` table (currency, period, ars_per_unit, fetched_at) stores the rate the first time a period is successfully consolidated; later views of that same period reuse the snapshot rather than drifting. The *current* period always attempts a fresh fetch first (falling back to any existing snapshot on failure) since "today's rate" is the only thing that's actually current for the current month.

**Never:** persist a USD-converted amount back onto any `sales_documents`/`cost_documents` row (conversion is report-time only, per the AC's own "without altering the original-currency records"); build a full multi-currency ledger/accounting system (out of scope — this is one consolidated report, not a general FX feature); guess or hardcode a fallback rate when the API is unavailable and no snapshot exists (must flag pending, per AC2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Both companies have results, rate available | Chile (CLP) + Uruguay (UYU), current period, MonedAPI reachable | Each converted to USD via triangulated rate, summed into one total | N/A |
| A company already reports in USD | A third company with `currency='USD'` | Included at face value, no conversion needed | N/A |
| Rate source unavailable, no snapshot exists | MonedAPI unreachable, first time viewing this period | Period flagged "pending exchange rate," no total shown as if it were zero | N/A |
| Rate source unavailable, snapshot exists | MonedAPI unreachable, period was successfully consolidated before | Uses the existing snapshot, not blocked | N/A |
| Viewing a past period again later | Same period viewed a second time, weeks later | Uses the original snapshot's rate, not today's | N/A |

</frozen-after-approval>

## Code Map

- `web/src/lib/reporting.ts` -- `computeMonthlyResult(companyId, period)` (Story 6.1) reused per company, unmodified
- `web/src/lib/dal.ts` -- `getUserCompanies()` for the list of companies to consolidate across
- Empirical API check (done, see Intent): `curl https://monedapi.ar/api/v2/{clp,uyu,usd}/oficial` -- exact response shape `{currency, name, origin, buy, sell, updatedAt, lastScrapedAt, valueType, change}`

## Tasks & Acceptance

**Execution:**
- [x] `supabase/migrations/<ts>_epic6_story5_exchange_rate_snapshots.sql` -- `exchange_rate_snapshots` (`id`, `currency text not null check in ('CLP','UYU')`, `period date not null` check month-start, `ars_per_unit numeric not null`, `ars_per_usd numeric not null`, `fetched_at timestamptz not null default now()`, unique `(currency, period)`); RLS: any authenticated user may SELECT/INSERT (this is shared reference data, not company-scoped -- an exchange rate isn't owned by one company)
- [x] `web/src/lib/exchangeRates.ts` (new) -- `fetchArsRate(currency: 'CLP'|'UYU'|'USD'): Promise<{arsPerUnit: number} | null>` calling MonedAPI, returning the buy/sell average, `null` on any fetch failure; `getOrSnapshotRate(currency, period): Promise<number | null>` -- for the current period, fetch live and upsert a snapshot on success, falling back to an existing snapshot on failure; for a past period, read the existing snapshot only (never fetch live for history), `null` if none exists yet
- [x] `web/src/lib/reporting.ts` -- `computeConsolidatedResult(userId, period)` (or equivalent) -- runs `computeMonthlyResult` per company the user belongs to, converts each via `getOrSnapshotRate`, sums into one USD total; returns per-company breakdown plus the total, and a `pendingRateCompanies` list for any company whose currency's rate couldn't be resolved
- [x] `web/src/app/reports/consolidated/page.tsx` (new, top-level, not company-scoped) -- period selector; per-company USD-converted figures + total; a "pending exchange rate" notice per company when applicable, instead of silently omitting or zeroing it
- [x] `web/src/app/companies/page.tsx` -- add a "Consolidated result (USD)" link

**Acceptance Criteria:**
- Given both companies have results for a period and the rate is available, when I view the consolidated report, then each company's figures are converted to USD and summed, with original-currency records untouched
- Given the rate source is unavailable and no snapshot exists for that period, then the period is flagged "pending exchange rate," never shown as zero
- Given a past period was already successfully consolidated once, when viewed again later, then it uses the original snapshot, not a newly-fetched rate

## Implementation Notes

**Verified against the live MonedAPI and the linked Supabase project, all three manual checks passed**:
- **Live rate + math**: created a real 1,000,000 CLP sale for the current month, viewed the consolidated report — showed exactly 1,067.32 USD. Hand-verified: `1,000,000 × 1.6074 / 1506.015 = 1,067.32` (using the live `buy`/`sell` averages fetched at that moment: CLP 1.6074/1.6074, USD 1480.3/1531.73). Confirmed the snapshot was stored in `exchange_rate_snapshots` with those exact values.
- **Snapshot reuse for past periods**: manually inserted a distinctive fake snapshot for a past month (`ars_per_unit=2.0, ars_per_usd=2000`, i.e. a deliberately wrong rate no live fetch would ever produce), added a real 500,000 CLP sale for that month, and confirmed the report showed exactly 500.00 USD (`500,000 × 2.0 / 2000 = 500`) — proving the past-period code path reads the stored snapshot rather than fetching live, since a live fetch would have produced the ~1,067-range result instead.
- Only "Inmasoft Chile" appeared in both tests (not Uruguay) because the test session's user has no membership on Inmasoft Uruguay — correct RLS-driven behavior via `getUserCompanies()`, not a bug.
- All test data (client, 2 sales documents, 2 exchange rate snapshots) deleted afterward, confirmed zero residue.
- `npx tsc --noEmit` and `npm run build` both pass clean; migration applied to the linked Supabase project via `supabase db push --linked`.

## Spec Change Log

## Review Triage Log

## Design Notes

No `security definer` needed anywhere here -- `exchange_rate_snapshots` is shared reference data with an open SELECT/INSERT policy, not a company-scoped financial record.

Buy/sell average is a report-level simplification, not a trading rate -- if the business later needs buy vs. sell distinction for a real financial purpose, that's new scope, not a gap in this story.

## Verification

**Commands:**
- `cd web && npx tsc --noEmit` -- expected: no type errors
- `cd web && npm run build` -- expected: builds clean, new route registers

**Manual checks:**
- With live MonedAPI access, view the consolidated report for the current period, confirm the USD figures look plausible against the triangulated rate
- Simulate an API failure (e.g. temporarily point at a bad URL) for a period with no snapshot yet, confirm "pending exchange rate" shows instead of zero
- View a period a second time, confirm the snapshot rate is reused (compare `fetched_at` unchanged)
