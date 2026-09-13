-- Epic 6, Story 6.5: Consolidated Chile + Uruguay Result in USD
--
-- `exchange_rate_snapshots` stores the ARS-triangulated rate used to
-- convert one source currency (CLP/UYU) to USD for a given reporting
-- period, captured once on the first successful fetch/consolidation of
-- that period and reused on every later view (see spec Decisions --
-- MonedAPI has no historical endpoint, so re-fetching on every view of
-- a past period would silently reinterpret history each time).
--
-- This is shared reference data, not owned by any one company -- an
-- exchange rate isn't a company-scoped financial record -- so RLS is
-- open to any authenticated user for SELECT/INSERT, same reasoning the
-- spec's Design Notes give for skipping `security definer` here.
create table public.exchange_rate_snapshots (
  id uuid primary key default gen_random_uuid(),
  currency text not null check (currency in ('CLP', 'UYU')),
  period date not null check (period = date_trunc('month', period)::date),
  ars_per_unit numeric not null,
  ars_per_usd numeric not null,
  fetched_at timestamptz not null default now(),
  unique (currency, period)
);

alter table public.exchange_rate_snapshots enable row level security;

create policy "Authenticated users can read exchange rate snapshots"
  on public.exchange_rate_snapshots
  for select
  to authenticated
  using (true);

create policy "Authenticated users can insert exchange rate snapshots"
  on public.exchange_rate_snapshots
  for insert
  to authenticated
  with check (true);
