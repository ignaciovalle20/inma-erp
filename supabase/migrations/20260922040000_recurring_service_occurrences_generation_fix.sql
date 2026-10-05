-- Fixes a bug in 20260922030000's generate_due_recurring_service_
-- occurrences(): its RETURNS TABLE columns were named
-- `recurring_service_id` and `period`, identical to real columns of
-- recurring_service_occurrences. PL/pgSQL auto-declares RETURNS TABLE
-- columns as variables in scope for the whole function body, and its
-- default `variable_conflict = error` setting makes any SQL statement
-- inside the function that could resolve that name as either the
-- variable or a table column fail with "column reference ... is
-- ambiguous" (hit via ON CONFLICT's target list, which -- unlike a
-- plain INSERT column list -- is parsed as a list of expressions, not
-- guaranteed-unambiguous column names). Renamed to `service_id` /
-- `occurrence_period`, which collide with nothing.
--
-- CREATE OR REPLACE can't change a function's OUT-parameter row type,
-- so the old signature is dropped first.
drop function if exists public.generate_due_recurring_service_occurrences();

create function public.generate_due_recurring_service_occurrences()
returns table (
  occurrence_id uuid,
  service_id uuid,
  occurrence_period date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := current_date;
  v_service record;
  v_period date;
  v_period_unit text;
  v_due_year int;
  v_due_month int;
  v_last_day_of_due_month int;
  v_clamped_day int;
  v_invoice_due_date date;
  v_new_id uuid;
begin
  for v_service in
    select *
    from public.recurring_services
    where status = 'active'
      and start_date <= v_today
      and (end_date is null or end_date >= v_today)
  loop
    if v_service.periodicity = 'monthly' then
      v_period := date_trunc('month', v_today)::date;
      v_period_unit := 'month';
    else
      if v_service.due_month is null
         or v_service.due_month <> extract(month from v_today)::int then
        continue;
      end if;
      v_period := date_trunc('year', v_today)::date;
      v_period_unit := 'year';
    end if;

    if v_period < date_trunc(v_period_unit, v_service.start_date)::date then
      continue;
    end if;

    if v_service.end_date is not null
       and v_period > date_trunc(v_period_unit, v_service.end_date)::date then
      continue;
    end if;

    v_invoice_due_date := null;

    if v_service.due_day is not null then
      if v_service.periodicity = 'monthly' then
        if v_service.invoicing_mode = 'arrears' then
          v_due_year := extract(year from v_period + interval '1 month')::int;
          v_due_month := extract(month from v_period + interval '1 month')::int;
        else
          v_due_year := extract(year from v_period)::int;
          v_due_month := extract(month from v_period)::int;
        end if;
      else
        v_due_month := v_service.due_month;
        v_due_year := extract(year from v_period)::int
          + case when v_service.invoicing_mode = 'arrears' then 1 else 0 end;
      end if;

      v_last_day_of_due_month := extract(
        day from (make_date(v_due_year, v_due_month, 1) + interval '1 month - 1 day')
      )::int;
      v_clamped_day := least(v_service.due_day, v_last_day_of_due_month);
      v_invoice_due_date := make_date(v_due_year, v_due_month, v_clamped_day);
    end if;

    insert into public.recurring_service_occurrences (
      recurring_service_id,
      period,
      invoice_due_date,
      collection_due_date,
      amount,
      currency
    )
    values (
      v_service.id,
      v_period,
      v_invoice_due_date,
      v_invoice_due_date,
      v_service.price,
      v_service.currency
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

revoke execute on function public.generate_due_recurring_service_occurrences() from public;
grant execute on function public.generate_due_recurring_service_occurrences() to service_role;
