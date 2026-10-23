-- Annual recurring services follow the anniversary of start_date, not the
-- calendar year (prompt_costos_servicios_recurrentes.md, point 7).
--
-- The bug: an annual period was the calendar year and was only generated
-- in due_month. "EBCO LA LIGUA - ANUAL" (Starlink, annual, advance,
-- 2026-07-01 -> 2027-06-01, due "1 de junio") got no cycle at all: June
-- 2026 was before it started and the next June is 2027.
--
-- Now period N runs from start_date + N years to the day before the next
-- anniversary; its key (`period`) is day 1 of the month it starts in.
-- * Advance: it is generated -- to invoice and collect -- in the month it
--   starts (EBCO: period 2026-07, due July 2026).
-- * Arrears: in the month it ends.
-- due_month of an annual service is derived from that (it is no longer
-- asked); due_day stays editable.
-- Existing annual cycles get their new key, keeping status, notes and
-- sales_allocations; then every missing cycle since January 2026 is made.

-- ---------------------------------------------------------------------
-- 1. due_month of annual services, derived
-- ---------------------------------------------------------------------
create or replace function public.recurring_services_derive_due_month()
returns trigger
language plpgsql
as $$
begin
  if new.periodicity = 'annual' then
    new.due_month := case
      when new.invoicing_mode = 'advance' then extract(month from new.start_date)::smallint
      else extract(month from (new.start_date + interval '1 year' - interval '1 day'))::smallint
    end;
  end if;
  return new;
end;
$$;

create trigger recurring_services_derive_due_month
  before insert or update of periodicity, invoicing_mode, start_date, due_month on public.recurring_services
  for each row
  execute function public.recurring_services_derive_due_month();

-- ---------------------------------------------------------------------
-- 2. Generation
-- ---------------------------------------------------------------------
-- Monthly services: unchanged (20261003010000 / 20261016010000).
create or replace function public.generate_recurring_service_occurrences_for_month(
  p_month date,
  p_company_id uuid default null,
  p_service_id uuid default null
)
returns table (occurrence_id uuid, service_id uuid, occurrence_period date)
language plpgsql
set search_path = public
as $$
declare
  c_first_month constant date := date '2026-01-01';
  v_month date := date_trunc('month', p_month)::date;
  v_service record;
  v_period date;
  v_period_end date;
  v_anniversary date;
  v_years int;
  v_last_day int;
  v_due_date date;
  v_new_id uuid;
begin
  -- The first month managed in the ERP.
  if v_month < c_first_month then
    return;
  end if;

  for v_service in
    select *
    from public.recurring_services
    where status = 'active'
      and (p_company_id is null or company_id = p_company_id)
      and (p_service_id is null or id = p_service_id)
  loop
    if v_service.periodicity = 'monthly' then
      -- Anticipado bills the month itself; vencido the one that closed.
      v_period := v_month;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 month')::date;
      end if;
      v_period_end := (v_period + interval '1 month - 1 day')::date;

      -- Active on any day of the period being generated.
      if v_service.start_date > v_period_end
         or (v_service.end_date is not null and v_service.end_date < v_period) then
        continue;
      end if;
    else
      -- Annual: the anniversary period that starts (advance) or ends
      -- (arrears) in this month.
      if v_service.invoicing_mode = 'advance' then
        if extract(month from v_service.start_date) <> extract(month from v_month) then
          continue;
        end if;
        v_years := extract(year from v_month)::int - extract(year from v_service.start_date)::int;
      else
        v_period_end := (v_service.start_date + interval '1 year' - interval '1 day')::date;
        if extract(month from v_period_end) <> extract(month from v_month) then
          continue;
        end if;
        v_years := extract(year from v_month)::int - extract(year from v_period_end)::int;
      end if;

      if v_years < 0 then
        continue;
      end if;

      v_anniversary := (v_service.start_date + make_interval(years => v_years))::date;
      v_period := date_trunc('month', v_anniversary)::date;

      if v_service.end_date is not null and v_service.end_date < v_anniversary then
        continue;
      end if;
    end if;

    -- Due within the month being generated; day 1 when not configured.
    v_last_day := extract(day from (v_month + interval '1 month - 1 day'))::int;
    v_due_date := make_date(
      extract(year from v_month)::int,
      extract(month from v_month)::int,
      least(coalesce(v_service.due_day, 1), v_last_day)
    );

    v_new_id := null;

    insert into public.recurring_service_occurrences (
      recurring_service_id,
      period,
      invoice_due_date,
      collection_due_date,
      amount,
      quantity,
      currency,
      status
    )
    values (
      v_service.id,
      v_period,
      v_due_date,
      v_due_date,
      coalesce(v_service.reference_amount, 0),
      case when v_service.pricing_mode = 'per_unit' then v_service.default_quantity end,
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

-- Since start: every month from max(start, January 2026) through p_until,
-- and the service's cost periods with it.
create or replace function public.generate_recurring_service_occurrences_since_start(
  p_service_id uuid,
  p_until date default current_date
)
returns table (occurrence_id uuid, service_id uuid, occurrence_period date)
language plpgsql
set search_path = public
as $$
declare
  v_start date;
  v_month date;
  v_until date := date_trunc('month', coalesce(p_until, current_date))::date;
begin
  select start_date into v_start
  from public.recurring_services
  where id = p_service_id;

  if v_start is null then
    return;
  end if;

  v_month := greatest(date_trunc('month', v_start)::date, date '2026-01-01');

  while v_month <= v_until loop
    return query
      select g.occurrence_id, g.service_id, g.occurrence_period
      from public.generate_recurring_service_occurrences_for_month(v_month, null, p_service_id) g;
    v_month := (v_month + interval '1 month')::date;
  end loop;

  perform public.generate_recurring_service_cost_periods(null, p_service_id, p_until);
end;
$$;

-- Legacy Epic 5.1 entry generator (no caller in the app): the anniversary
-- period that contains p_period.
create or replace function public.generate_recurring_service_entry(p_recurring_service_id uuid, p_period date)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_service public.recurring_services;
  v_document public.sales_documents;
  v_period_start date;
  v_years int;
  v_amount numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required to generate a recurring service entry';
  end if;

  if p_period is null then
    raise exception 'A period is required';
  end if;

  select * into v_service
  from public.recurring_services
  where id = p_recurring_service_id;

  if v_service is null then
    raise exception 'Recurring service not found';
  end if;

  if not v_service.active then
    raise exception 'Recurring service is not active';
  end if;

  if v_service.periodicity = 'annual' then
    v_years := greatest(extract(year from age(p_period, v_service.start_date))::int, 0);
    v_period_start := date_trunc('month', v_service.start_date + make_interval(years => v_years))::date;
  else
    v_period_start := date_trunc('month', p_period)::date;
  end if;

  if v_period_start < date_trunc('month', v_service.start_date)::date then
    raise exception 'Cannot generate before the service start date';
  end if;

  if v_service.end_date is not null and v_period_start > v_service.end_date then
    raise exception 'Cannot generate after the service end date';
  end if;

  if exists (
    select 1 from public.sales_documents
    where recurring_service_id = p_recurring_service_id
      and recurring_period = v_period_start
  ) then
    raise exception 'This period has already been generated for this service';
  end if;

  v_amount := coalesce(v_service.reference_amount, 0);

  insert into public.sales_documents (
    company_id, client_id, document_type, document_date, currency,
    net_amount, tax_amount, total_amount, source,
    recurring_service_id, recurring_period, created_by, updated_by
  )
  values (
    v_service.company_id, v_service.client_id, 'manual', v_period_start, v_service.currency,
    v_amount, 0, v_amount, 'recurring',
    v_service.id, v_period_start, v_user_id, v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (sales_document_id, description, amount, created_by, updated_by)
  values (v_document.id, v_service.name, v_amount, v_user_id, v_user_id);

  return v_document;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Existing annual cycles: new key
-- ---------------------------------------------------------------------
-- Each cycle goes to the anniversary period it was billed for: the month
-- it is (or was) due -- its invoice_due_date, else its old period -- is
-- the month the period starts (advance) or ends (arrears).
create temp table _annual_rekey as
with cycles as (
  select
    o.id,
    o.recurring_service_id,
    o.period as old_period,
    rs.name as service_name,
    rs.start_date,
    rs.invoicing_mode,
    date_trunc('month', coalesce(o.invoice_due_date, o.period))::date as due_month
  from public.recurring_service_occurrences o
  join public.recurring_services rs on rs.id = o.recurring_service_id
  where rs.periodicity = 'annual'
),
targets as (
  select
    c.*,
    case when c.invoicing_mode = 'advance' then c.due_month else (c.due_month - interval '11 months')::date end as target
  from cycles c
),
years as (
  select
    t.*,
    extract(year from t.target)::int - extract(year from t.start_date)::int as n0
  from targets t
)
select
  y.id,
  y.recurring_service_id,
  y.service_name,
  y.old_period,
  date_trunc('month', y.start_date + make_interval(years => greatest(
    case
      when date_trunc('month', y.start_date + make_interval(years => y.n0)) > y.target then y.n0 - 1
      else y.n0
    end, 0)))::date as new_period
from years y;

do $$
declare
  v_conflicts text;
begin
  select string_agg(distinct service_name, ', ' order by service_name) into v_conflicts
  from (
    select r.service_name
    from _annual_rekey r
    group by r.recurring_service_id, r.service_name, r.new_period
    having count(*) > 1
  ) x;

  if v_conflicts is not null then
    raise exception 'Two annual cycles of the same service would get the same anniversary period; fix them by hand first: %', v_conflicts;
  end if;
end $$;

-- Two steps so a key that moves onto another cycle's old key never trips
-- the unique (service, period) mid-update. Triggers off: only the key
-- changes (status, dates, stored rate, notes and allocations stay).
alter table public.recurring_service_occurrences disable trigger user;

update public.recurring_service_occurrences o
set period = (r.new_period - interval '1000 years')::date
from _annual_rekey r
where r.id = o.id and r.new_period <> r.old_period;

update public.recurring_service_occurrences o
set period = r.new_period
from _annual_rekey r
where r.id = o.id and r.new_period <> r.old_period;

alter table public.recurring_service_occurrences enable trigger user;

drop table _annual_rekey;

-- due_month of the annual services, derived (the trigger runs on update).
-- updated_at stays as it was: a data move, not an edit.
alter table public.recurring_services disable trigger recurring_services_set_updated_at;
update public.recurring_services
set due_month = due_month
where periodicity = 'annual';
alter table public.recurring_services enable trigger recurring_services_set_updated_at;

-- ---------------------------------------------------------------------
-- 4. Missing cycles since January 2026, with the new rule
-- ---------------------------------------------------------------------
select count(*)
from public.recurring_services rs
cross join lateral public.generate_recurring_service_occurrences_since_start(
  rs.id, public.company_local_date(rs.company_id)
) g
where rs.status = 'active';

revoke execute on function public.generate_recurring_service_occurrences_for_month(date, uuid, uuid) from public, anon;
grant execute on function public.generate_recurring_service_occurrences_for_month(date, uuid, uuid) to authenticated, service_role;
revoke execute on function public.generate_recurring_service_occurrences_since_start(uuid, date) from public, anon;
grant execute on function public.generate_recurring_service_occurrences_since_start(uuid, date) to authenticated, service_role;
