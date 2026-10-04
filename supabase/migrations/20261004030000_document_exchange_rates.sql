-- Every document keeps the exchange rate of its own date
-- (docs/verificacion-contable-2026-10-04.md, P03 -> point 3).
--
-- Until now a report converted each document with the rate of its month
-- read from exchange_rate_snapshots at report time. The snapshot of the
-- current month was rewritten every time someone opened a report, a month
-- nobody opened stayed "conversión pendiente" forever, and any signed-in
-- user could write the (global) table.
--
-- 1. exchange_rate_on(from, to, date): the rate to multiply an amount in
--    `from` by to get `to`, from the snapshot of that date's month or, if
--    there is none, the nearest earlier one. USD needs no snapshot (1 USD =
--    1 USD); CLP and UYU triangulate through their USD-per-unit snapshot,
--    exactly like web/src/lib/exchangeRates.ts. Null when a leg has no
--    snapshot at all (never a guessed 1:1).
-- 2. sales_documents, cost_documents, recurring_service_occurrences and
--    recurring_service_cost_pools get exchange_rate (units of the company's
--    currency per unit of the document's currency; 1 for the same currency)
--    and exchange_rate_period (the snapshot month used). A trigger fills
--    them on INSERT and keeps them on UPDATE: recomputed only when the
--    document's currency or date changes (a correction), or when they are
--    still empty; a value sent by a client is ignored.
--      - sales / costs: the document_date.
--      - recurring cycles: invoiced_at, else invoice_due_date, else period
--        (the date the reports already use for the cycle), at creation.
--      - pools: the pool's period.
-- 3. Non-destructive backfill: only rows whose exchange_rate is still null.
--    User triggers are disabled during the backfill so nothing else changes
--    (no updated_at bump, no currency normalisation); FK checks stay on.
-- 4. exchange_rate_snapshots: INSERT/UPDATE (and DELETE/TRUNCATE, which
--    were granted too) only for the service role. Members keep SELECT.
--
-- Additive: new nullable columns, new functions and triggers; the only
-- things removed are the two write policies and table privileges of
-- anon/authenticated on exchange_rate_snapshots.

-- ---------------------------------------------------------------------
-- 1. Rate lookup
-- ---------------------------------------------------------------------
create or replace function public.usd_per_unit_on(p_currency text, p_date date)
returns table (rate numeric, period date)
language sql
stable
as $$
  select 1::numeric, null::date
  where p_currency = 'USD'
  union all
  select s.ars_per_unit / s.ars_per_usd, s.period
  from (
    select ars_per_unit, ars_per_usd, period
    from public.exchange_rate_snapshots
    where currency = p_currency
      and period <= date_trunc('month', p_date)::date
      and ars_per_usd > 0
    order by period desc
    limit 1
  ) s
  where p_currency <> 'USD';
$$;

comment on function public.usd_per_unit_on(text, date) is
  'USD per unit of p_currency on p_date: the snapshot of that month or the nearest earlier one (USD = 1). No row when there is none.';

create or replace function public.exchange_rate_on(p_from text, p_to text, p_date date)
returns table (rate numeric, period date)
language plpgsql
stable
as $$
declare
  v_from_rate numeric;
  v_from_period date;
  v_to_rate numeric;
  v_to_period date;
begin
  if p_from is null or p_to is null or p_date is null then
    return query select null::numeric, null::date;
    return;
  end if;

  if p_from = p_to then
    return query select 1::numeric, null::date;
    return;
  end if;

  select u.rate, u.period into v_from_rate, v_from_period from public.usd_per_unit_on(p_from, p_date) u;
  select u.rate, u.period into v_to_rate, v_to_period from public.usd_per_unit_on(p_to, p_date) u;

  if v_from_rate is null or v_to_rate is null or v_to_rate = 0 then
    return query select null::numeric, null::date;
    return;
  end if;

  -- The snapshot month that was used (the CLP/UYU leg; USD has none).
  return query select v_from_rate / v_to_rate, greatest(v_from_period, v_to_period);
end;
$$;

comment on function public.exchange_rate_on(text, text, date) is
  'Units of p_to per unit of p_from on p_date (snapshot of that month or the nearest earlier one), and the snapshot month used. Null when a leg has no snapshot.';

revoke execute on function public.usd_per_unit_on(text, date) from public, anon;
revoke execute on function public.exchange_rate_on(text, text, date) from public, anon;
grant execute on function public.usd_per_unit_on(text, date) to authenticated, service_role;
grant execute on function public.exchange_rate_on(text, text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Columns and triggers
-- ---------------------------------------------------------------------
alter table public.sales_documents add column if not exists exchange_rate numeric;
alter table public.sales_documents add column if not exists exchange_rate_period date;
alter table public.cost_documents add column if not exists exchange_rate numeric;
alter table public.cost_documents add column if not exists exchange_rate_period date;
alter table public.recurring_service_occurrences add column if not exists exchange_rate numeric;
alter table public.recurring_service_occurrences add column if not exists exchange_rate_period date;
alter table public.recurring_service_cost_pools add column if not exists exchange_rate numeric;
alter table public.recurring_service_cost_pools add column if not exists exchange_rate_period date;

comment on column public.sales_documents.exchange_rate is
  'Units of the company currency per unit of this document''s currency on its date (1 when they are the same). Set by trigger; every report converts with it.';
comment on column public.cost_documents.exchange_rate is
  'Units of the company currency per unit of this document''s currency on its date (1 when they are the same). Set by trigger; every report converts with it.';
comment on column public.recurring_service_occurrences.exchange_rate is
  'Units of the company currency per unit of this cycle''s currency on its date when it was created (1 when they are the same). Set by trigger.';
comment on column public.recurring_service_cost_pools.exchange_rate is
  'Units of the company currency per unit of the pool''s currency for its period (1 when they are the same). Set by trigger.';

-- Shared body: p_old_* are null on INSERT.
create or replace function public.document_exchange_rate(
  p_company_currency text,
  p_currency text,
  p_date date,
  p_old_currency text,
  p_old_date date,
  p_old_rate numeric,
  p_old_period date,
  p_is_insert boolean,
  out rate numeric,
  out period date
)
language plpgsql
stable
as $$
begin
  if p_is_insert
     or p_old_rate is null
     or p_currency is distinct from p_old_currency
     or p_date is distinct from p_old_date then
    select r.rate, r.period into rate, period
    from public.exchange_rate_on(p_currency, p_company_currency, p_date) r;
  else
    rate := p_old_rate;
    period := p_old_period;
  end if;
end;
$$;

create or replace function public.sales_documents_set_exchange_rate()
returns trigger
language plpgsql
as $$
declare
  v_company_currency text;
begin
  select currency into v_company_currency from public.companies where id = new.company_id;
  select r.rate, r.period into new.exchange_rate, new.exchange_rate_period
  from public.document_exchange_rate(
    v_company_currency, new.currency, new.document_date,
    case when tg_op = 'UPDATE' then old.currency end,
    case when tg_op = 'UPDATE' then old.document_date end,
    case when tg_op = 'UPDATE' then old.exchange_rate end,
    case when tg_op = 'UPDATE' then old.exchange_rate_period end,
    tg_op = 'INSERT'
  ) r;
  return new;
end;
$$;

create or replace function public.cost_documents_set_exchange_rate()
returns trigger
language plpgsql
as $$
declare
  v_company_currency text;
begin
  select currency into v_company_currency from public.companies where id = new.company_id;
  select r.rate, r.period into new.exchange_rate, new.exchange_rate_period
  from public.document_exchange_rate(
    v_company_currency, new.currency, new.document_date,
    case when tg_op = 'UPDATE' then old.currency end,
    case when tg_op = 'UPDATE' then old.document_date end,
    case when tg_op = 'UPDATE' then old.exchange_rate end,
    case when tg_op = 'UPDATE' then old.exchange_rate_period end,
    tg_op = 'INSERT'
  ) r;
  return new;
end;
$$;

-- A cycle keeps the rate of the date it had when it was created: later
-- changes of invoiced_at (marking it invoiced) do not move it.
create or replace function public.recurring_service_occurrences_set_exchange_rate()
returns trigger
language plpgsql
as $$
declare
  v_company_currency text;
  v_date date := coalesce(new.invoiced_at, new.invoice_due_date, new.period);
begin
  select c.currency into v_company_currency
  from public.recurring_services s
  join public.companies c on c.id = s.company_id
  where s.id = new.recurring_service_id;

  select r.rate, r.period into new.exchange_rate, new.exchange_rate_period
  from public.document_exchange_rate(
    v_company_currency, new.currency, v_date,
    case when tg_op = 'UPDATE' then old.currency end,
    case when tg_op = 'UPDATE' then v_date end,
    case when tg_op = 'UPDATE' then old.exchange_rate end,
    case when tg_op = 'UPDATE' then old.exchange_rate_period end,
    tg_op = 'INSERT'
  ) r;
  return new;
end;
$$;

create or replace function public.recurring_service_cost_pools_set_exchange_rate()
returns trigger
language plpgsql
as $$
declare
  v_company_currency text;
begin
  select currency into v_company_currency from public.companies where id = new.company_id;
  select r.rate, r.period into new.exchange_rate, new.exchange_rate_period
  from public.document_exchange_rate(
    v_company_currency, new.currency, new.period,
    case when tg_op = 'UPDATE' then old.currency end,
    case when tg_op = 'UPDATE' then old.period end,
    case when tg_op = 'UPDATE' then old.exchange_rate end,
    case when tg_op = 'UPDATE' then old.exchange_rate_period end,
    tg_op = 'INSERT'
  ) r;
  return new;
end;
$$;

-- "zz_": BEFORE triggers fire in name order, and these must see the final
-- currency (recurring_service_occurrences_validate_currency forces CLP for
-- Chile, for example).
drop trigger if exists sales_documents_zz_set_exchange_rate on public.sales_documents;
create trigger sales_documents_zz_set_exchange_rate
  before insert or update on public.sales_documents
  for each row execute function public.sales_documents_set_exchange_rate();

drop trigger if exists cost_documents_zz_set_exchange_rate on public.cost_documents;
create trigger cost_documents_zz_set_exchange_rate
  before insert or update on public.cost_documents
  for each row execute function public.cost_documents_set_exchange_rate();

drop trigger if exists recurring_service_occurrences_zz_set_exchange_rate on public.recurring_service_occurrences;
create trigger recurring_service_occurrences_zz_set_exchange_rate
  before insert or update on public.recurring_service_occurrences
  for each row execute function public.recurring_service_occurrences_set_exchange_rate();

drop trigger if exists recurring_service_cost_pools_zz_set_exchange_rate on public.recurring_service_cost_pools;
create trigger recurring_service_cost_pools_zz_set_exchange_rate
  before insert or update on public.recurring_service_cost_pools
  for each row execute function public.recurring_service_cost_pools_set_exchange_rate();

-- ---------------------------------------------------------------------
-- 3. Backfill (only rows still without a rate)
-- ---------------------------------------------------------------------
alter table public.sales_documents disable trigger user;
update public.sales_documents d
set (exchange_rate, exchange_rate_period) = (
  select r.rate, r.period
  from public.companies c
  cross join lateral public.exchange_rate_on(d.currency, c.currency, d.document_date) r
  where c.id = d.company_id
)
where d.exchange_rate is null;
alter table public.sales_documents enable trigger user;

alter table public.cost_documents disable trigger user;
update public.cost_documents d
set (exchange_rate, exchange_rate_period) = (
  select r.rate, r.period
  from public.companies c
  cross join lateral public.exchange_rate_on(d.currency, c.currency, d.document_date) r
  where c.id = d.company_id
)
where d.exchange_rate is null;
alter table public.cost_documents enable trigger user;

alter table public.recurring_service_occurrences disable trigger user;
update public.recurring_service_occurrences o
set (exchange_rate, exchange_rate_period) = (
  select r.rate, r.period
  from public.recurring_services s
  join public.companies c on c.id = s.company_id
  cross join lateral public.exchange_rate_on(o.currency, c.currency, coalesce(o.invoiced_at, o.invoice_due_date, o.period)) r
  where s.id = o.recurring_service_id
)
where o.exchange_rate is null;
alter table public.recurring_service_occurrences enable trigger user;

alter table public.recurring_service_cost_pools disable trigger user;
update public.recurring_service_cost_pools p
set (exchange_rate, exchange_rate_period) = (
  select r.rate, r.period
  from public.companies c
  cross join lateral public.exchange_rate_on(p.currency, c.currency, p.period) r
  where c.id = p.company_id
)
where p.exchange_rate is null;
alter table public.recurring_service_cost_pools enable trigger user;

-- ---------------------------------------------------------------------
-- 4. exchange_rate_snapshots: written by the service role only
-- ---------------------------------------------------------------------
drop policy if exists "Authenticated users can insert exchange rate snapshots" on public.exchange_rate_snapshots;
drop policy if exists "Authenticated users can update exchange rate snapshots" on public.exchange_rate_snapshots;
revoke insert, update, delete, truncate on public.exchange_rate_snapshots from anon, authenticated;
grant select on public.exchange_rate_snapshots to authenticated;
grant select, insert, update, delete on public.exchange_rate_snapshots to service_role;

notify pgrst, 'reload schema';
