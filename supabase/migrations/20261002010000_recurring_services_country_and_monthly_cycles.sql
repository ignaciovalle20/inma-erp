-- Servicios recurrentes: país/moneda automáticos y ciclos mes a mes
-- (docs/servicios-recurrentes-cambios.md).
--
-- Additive only: new nullable/defaulted columns, new triggers and one
-- new function; no existing service or occurrence is deleted, recreated
-- or rewritten (the backfill below only *inserts* missing cycles, ON
-- CONFLICT DO NOTHING keeps every existing one exactly as it is).
--
-- 1. recurring_services.country -- copied from companies.country by a
--    trigger on every insert/update, never taken from the client. The
--    20260922010000 notes deliberately derived country from the company
--    instead of storing it; it is now stored too (the user wants it on
--    the service) but still never editable: the trigger overwrites
--    whatever the caller sends.
--    Chile forces CLP. Uruguay must be USD or UYU. Companies with no
--    country (test fixtures) keep the old free choice of the three.
-- 2. recurring_services.requires_invoice (default true): false means the
--    client doesn't ask for an invoice, so each cycle is born
--    'pending_collection' instead of 'pending_invoice'.
-- 3. recurring_services.notes / recurring_service_occurrences.note:
--    free text for the board cards ("23 STD / 3 XCH2", "Facturar según
--    HES", contact, ...).
-- 4. generate_recurring_service_occurrences_for_month(p_month, company):
--    the cycle generator, now callable for any month, so opening a month
--    on the board creates whatever is missing for it. Same rules as the
--    cron's 20260922090000 version (vencido bills the month that just
--    closed, annual only in its due month, active on any day of the
--    period), plus:
--      * a missing due_day falls back to day 1 (the UI flags it as "sin
--        vencimiento definido") instead of leaving the due date null;
--      * nothing before September 2026, the first month managed in the
--        ERP: months before it generate nothing, and a monthly period
--        before it is never created (a vencido service's August 2026,
--        billed in September, was still handled in Planner).
--    Plain (security invoker) function, like every other member RPC
--    here: a logged-in caller only reads/inserts what RLS lets them, so
--    it can only ever generate for their own companies.
-- 5. generate_due_recurring_service_occurrences() (cron, service_role
--    only) now just calls the generator for the current month across
--    every company, so the cron and the board share one rule.
-- 6. Backfill: September and October 2026 for every active service.

-- ---------------------------------------------------------------------
-- 1-3. New columns
-- ---------------------------------------------------------------------
alter table public.recurring_services
  add column country text check (country in ('CL', 'UY')),
  add column requires_invoice boolean not null default true,
  add column notes text;

alter table public.recurring_service_occurrences
  add column note text;

-- Backfill country on existing services without bumping updated_at
-- (the service itself didn't change; it just gains a derived field).
alter table public.recurring_services disable trigger recurring_services_set_updated_at;

update public.recurring_services rs
set country = upper(c.country)
from public.companies c
where c.id = rs.company_id
  and upper(c.country) in ('CL', 'UY');

alter table public.recurring_services enable trigger recurring_services_set_updated_at;

create or replace function public.recurring_services_apply_company_country()
returns trigger
language plpgsql
as $$
declare
  v_country text;
begin
  select upper(country) into v_country
  from public.companies
  where id = new.company_id;

  new.country := case when v_country in ('CL', 'UY') then v_country else null end;

  if new.country = 'CL' then
    new.currency := 'CLP';
  elsif new.country = 'UY' and new.currency not in ('USD', 'UYU') then
    raise exception 'Uruguay recurring services must be billed in USD or UYU';
  end if;

  return new;
end;
$$;

create trigger recurring_services_apply_company_country
  before insert or update on public.recurring_services
  for each row
  execute function public.recurring_services_apply_company_country();

-- Same currency rule on each cycle (its amount/currency are editable).
create or replace function public.recurring_service_occurrences_validate_currency()
returns trigger
language plpgsql
as $$
declare
  v_country text;
begin
  select country into v_country
  from public.recurring_services
  where id = new.recurring_service_id;

  if v_country = 'CL' then
    new.currency := 'CLP';
  elsif v_country = 'UY' and new.currency not in ('USD', 'UYU') then
    raise exception 'Uruguay recurring service cycles must be in USD or UYU';
  end if;

  return new;
end;
$$;

create trigger recurring_service_occurrences_validate_currency
  before insert or update on public.recurring_service_occurrences
  for each row
  execute function public.recurring_service_occurrences_validate_currency();

-- ---------------------------------------------------------------------
-- 4. Generator for one month (the "cycle" the board shows)
-- ---------------------------------------------------------------------
create or replace function public.generate_recurring_service_occurrences_for_month(
  p_month date,
  p_company_id uuid default null
)
returns table (
  occurrence_id uuid,
  service_id uuid,
  occurrence_period date
)
language plpgsql
set search_path = public
as $$
declare
  c_first_month constant date := date '2026-09-01';
  v_month date := date_trunc('month', p_month)::date;
  v_service record;
  v_period date;
  v_period_end date;
  v_due_month int;
  v_last_day int;
  v_due_date date;
  v_new_id uuid;
begin
  if v_month < c_first_month then
    return;
  end if;

  for v_service in
    select *
    from public.recurring_services
    where status = 'active'
      and (p_company_id is null or company_id = p_company_id)
  loop
    if v_service.periodicity = 'monthly' then
      -- Anticipado bills the month itself; vencido the one that closed.
      v_period := v_month;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 month')::date;
      end if;
      if v_period < c_first_month then
        continue;
      end if;
      v_period_end := (v_period + interval '1 month - 1 day')::date;
      v_due_month := extract(month from v_month)::int;
    else
      -- Annual: only in its due month (required for annual by
      -- recurring_services_due_month_required_for_annual).
      if v_service.due_month is null
         or v_service.due_month <> extract(month from v_month)::int then
        continue;
      end if;
      v_period := date_trunc('year', v_month)::date;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 year')::date;
      end if;
      v_period_end := (v_period + interval '1 year - 1 day')::date;
      v_due_month := v_service.due_month;
    end if;

    -- Active on any day of the period being generated.
    if v_service.start_date > v_period_end
       or (v_service.end_date is not null and v_service.end_date < v_period) then
      continue;
    end if;

    -- Due within the month being generated; day 1 when not configured.
    v_last_day := extract(
      day from (make_date(extract(year from v_month)::int, v_due_month, 1) + interval '1 month - 1 day')
    )::int;
    v_due_date := make_date(
      extract(year from v_month)::int,
      v_due_month,
      least(coalesce(v_service.due_day, 1), v_last_day)
    );

    v_new_id := null;

    insert into public.recurring_service_occurrences (
      recurring_service_id,
      period,
      invoice_due_date,
      collection_due_date,
      amount,
      currency,
      status
    )
    values (
      v_service.id,
      v_period,
      v_due_date,
      v_due_date,
      v_service.price,
      v_service.currency,
      case when v_service.requires_invoice then 'pending_invoice' else 'pending_collection' end
    )
    on conflict (recurring_service_id, period) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      occurrence_id := v_new_id;
      service_id := v_service.id;
      occurrence_period := v_period;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public.generate_recurring_service_occurrences_for_month(date, uuid) from public, anon;
grant execute on function public.generate_recurring_service_occurrences_for_month(date, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Cron: the current month, every company. Same signature and return
-- type as before, so the route and its grants are unchanged.
-- ---------------------------------------------------------------------
create or replace function public.generate_due_recurring_service_occurrences()
returns table (
  occurrence_id uuid,
  service_id uuid,
  occurrence_period date
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select g.occurrence_id, g.service_id, g.occurrence_period
    from public.generate_recurring_service_occurrences_for_month(current_date, null) g;
end;
$$;

revoke execute on function public.generate_due_recurring_service_occurrences() from public, anon, authenticated;
grant execute on function public.generate_due_recurring_service_occurrences() to service_role;

-- ---------------------------------------------------------------------
-- 6. Backfill September and October 2026 (pending; the user marks what
-- was already paid). Runs as the migration owner, so every company.
-- ---------------------------------------------------------------------
select count(*) from public.generate_recurring_service_occurrences_for_month(date '2026-09-01', null);
select count(*) from public.generate_recurring_service_occurrences_for_month(date '2026-10-01', null);
