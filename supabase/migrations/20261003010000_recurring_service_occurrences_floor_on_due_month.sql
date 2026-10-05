-- Servicios recurrentes: the September 2026 floor applies to the month a
-- cycle is DUE (the board month), not to the period it bills.
--
-- 20261002010000 also skipped any monthly period before September 2026,
-- so a mes vencido service's August cycle -- billed and due in September
-- -- was never generated, and the September board had no vencido cards
-- at all (QA fase 2b: Trimant due 05/09 and Fabian due 10/09 missing).
-- That contradicted plan-servicios-recurrentes.md ("vencido: la de
-- septiembre factura agosto") and the annual rule of the same function,
-- which already floors on the due month (an annual vencido due in
-- December 2026 bills 2025). Now both work the same way: a month before
-- September 2026 generates nothing; from September on, whatever is due
-- that month is generated, whatever period it bills.
--
-- Same signature, return type and privileges; only the per-period floor
-- is removed. The backfill re-runs September 2026 so the missing
-- vencido cycles appear (ON CONFLICT DO NOTHING: every existing cycle is
-- left exactly as it is).

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
  -- The first month managed in the ERP: earlier months lived in Planner.
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
      -- Anticipado bills the month itself; vencido the one that closed
      -- (September's vencido cycle bills August).
      v_period := v_month;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 month')::date;
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

-- Backfill: the September 2026 vencido cycles (billing August) that the
-- previous version skipped. Runs as the migration owner, so every company.
select count(*) from public.generate_recurring_service_occurrences_for_month(date '2026-09-01', null);
