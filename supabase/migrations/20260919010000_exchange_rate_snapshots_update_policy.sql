-- getOrSnapshotRate() upserts the current period's rate on every report
-- load (web/src/lib/exchangeRates.ts). The first call per (currency,
-- period) is an INSERT, but every later call hits the unique(currency,
-- period) conflict and becomes an UPDATE -- and the table only had
-- SELECT/INSERT policies (20260913120000), so Postgres rejected it with
-- "new row violates row-level security policy (USING expression)" on
-- every load, surfacing as 2 issues in the Next.js dev overlay.
--
-- Same reasoning as the existing INSERT policy: an exchange rate is
-- shared reference data, not company-scoped, so any authenticated user
-- may refresh it.
create policy "Authenticated users can update exchange rate snapshots"
  on public.exchange_rate_snapshots
  for update
  to authenticated
  using (true)
  with check (true);
