-- Two corrections to generate_due_recurring_service_occurrences()
-- (20260922040000), confirmed with the user after the Phase 4 tests:
--
-- 1. "Vencido" (arrears) now bills the cycle that just *closed*, as
--    plan-servicios-recurrentes.md says ("vencido: la de septiembre
--    factura agosto"). The run in cycle C generates:
--      monthly advance: period C,          due in C
--      monthly arrears: period C - 1 month, due in C
--      annual  advance: period this year,  due this year's due_month
--      annual  arrears: period last year,  due this year's due_month
--    i.e. the due date always falls in the cycle the job runs in. The
--    due-date arithmetic relative to the period is unchanged (arrears
--    = period + 1 unit, due_day clamped to the month's last day), so
--    an arrears occurrence that already exists under the old rule
--    (period = the month it was generated in, due the month after)
--    is the same (service, period) row the new rule would create a
--    cycle later -- the unique constraint keeps it from duplicating.
--
-- 2. Validity is checked against the *period being generated*, not
--    against today: a service generates if it was active on any day
--    of that period (start_date <= last day of the period, end_date
--    null or >= its first day). Previously the loop required
--    start_date <= today, so with the cron firing on the 1st a service
--    starting mid-month (or mid-year, for annual) never got its first
--    period. No proration: the full price is billed for any overlap.
--    Consequences worth knowing: an advance service starting on the
--    15th gets that month's occurrence on the 1st, with a due date
--    that can precede start_date; an arrears service ending mid-month
--    gets its last (partial) month billed the following month.
--
-- Same signature and return type, so CREATE OR REPLACE keeps the
-- function's ACL; the grants are restated anyway so this file alone
-- documents who may call it (service_role only -- see 20260922070000).
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
declare
  v_today date := current_date;
  v_service record;
  v_period date;
  v_period_end date;
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
  loop
    if v_service.periodicity = 'monthly' then
      v_period := date_trunc('month', v_today)::date;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 month')::date;
      end if;
      v_period_end := (v_period + interval '1 month - 1 day')::date;
    else
      -- Annual services generate once a year, in their due month. No
      -- due_month means "not configured for auto-generation" (the
      -- table's check constraint requires it for annual anyway).
      if v_service.due_month is null
         or v_service.due_month <> extract(month from v_today)::int then
        continue;
      end if;
      v_period := date_trunc('year', v_today)::date;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 year')::date;
      end if;
      v_period_end := (v_period + interval '1 year - 1 day')::date;
    end if;

    -- Active on any day of the period being generated.
    if v_service.start_date > v_period_end
       or (v_service.end_date is not null and v_service.end_date < v_period) then
      continue;
    end if;

    v_invoice_due_date := null;

    if v_service.due_day is not null then
      -- Due within the cycle this run belongs to: the period's own
      -- month/year for advance, the one after it for arrears.
      if v_service.periodicity = 'monthly' then
        v_due_year := extract(year from v_period + case when v_service.invoicing_mode = 'arrears' then interval '1 month' else interval '0' end)::int;
        v_due_month := extract(month from v_period + case when v_service.invoicing_mode = 'arrears' then interval '1 month' else interval '0' end)::int;
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

revoke execute on function public.generate_due_recurring_service_occurrences() from public, anon, authenticated;
grant execute on function public.generate_due_recurring_service_occurrences() to service_role;
