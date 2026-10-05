-- Recurring Services redesign, Phase 4: the monthly generation job.
-- plan-servicios-recurrentes.md: "cron (Vercel Cron o pg_cron)... crea
-- las occurrences que correspondan -- mensuales del mes, anuales si el
-- mes coincide con mes_dia_vencimiento -- para todo recurring_service
-- activo." Confirmed with the user: Vercel Cron (not pg_cron), hitting
-- web/src/app/api/cron/recurring-service-occurrences/route.ts on a
-- monthly schedule (see ../../web/vercel.json).
--
-- Unlike every other function in this schema, this one has no
-- authenticated caller to check RLS against -- Vercel Cron has no
-- Supabase session, so the route uses the service-role client
-- (lib/supabase/service.ts) and this function must be SECURITY
-- DEFINER to write across every company in one run. To keep that
-- privilege from leaking: EXECUTE is revoked from PUBLIC and granted
-- only to service_role, never to `authenticated` -- an ordinary user
-- must never be able to trigger cross-company generation via this
-- RPC. This is a deliberate exception to this codebase's usual "plain
-- function, caller's own RLS rights carry it" pattern (see
-- generate_recurring_service_entry's own comment) -- there is simply
-- no caller identity here to lean on.
--
-- created_by/updated_by are left NULL on generated rows (no human
-- triggered this) -- both columns already allow NULL.
--
-- Scope, deliberately kept simple per the plan's own wording ("una vez
-- al mes"): this only ever generates the *current* period (today's
-- month, or today's year for an annual service whose due_month is
-- this month). It does not backfill periods missed by a cron outage
-- or a paused service being reactivated -- Phase 9 can backfill by
-- hand via the CLI if that ever happens; re-running this function is
-- always safe either way (idempotent via the occurrences table's own
-- unique(recurring_service_id, period) constraint).
--
-- Due-date computation answers plan-servicios-recurrentes.md's open
-- question ("¿el día de facturar y el de cobrar son siempre el
-- mismo?") with a default: collection_due_date = invoice_due_date.
-- Both are editable per-occurrence afterward if a specific service
-- needs otherwise. A NULL due_day (not yet configured on the
-- template) still generates the occurrence -- just without due dates,
-- so it shows up to fill in rather than being silently skipped.
create or replace function public.generate_due_recurring_service_occurrences()
returns table (
  occurrence_id uuid,
  recurring_service_id uuid,
  period date
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
      -- Annual services get exactly one occurrence per year, the
      -- month they're due. No due_month on record yet means "not
      -- configured for auto-generation" -- skip rather than guess.
      if v_service.due_month is null
         or v_service.due_month <> extract(month from v_today)::int then
        continue;
      end if;
      v_period := date_trunc('year', v_today)::date;
      v_period_unit := 'year';
    end if;

    -- Re-check validity against the *period*, not just today -- a
    -- service starting mid-period shouldn't get an occurrence for a
    -- period before it started (mirrors generate_recurring_service_
    -- entry's own validity check, one period unit later).
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
          -- "vencido: la de septiembre factura agosto" -- the due
          -- date falls in the month *after* the period it bills.
          v_due_year := extract(year from v_period + interval '1 month')::int;
          v_due_month := extract(month from v_period + interval '1 month')::int;
        else
          v_due_year := extract(year from v_period)::int;
          v_due_month := extract(month from v_period)::int;
        end if;
      else
        -- Same advance/arrears shift applied to annual services, one
        -- year instead of one month -- the plan only spells this out
        -- for monthly services, extrapolated here for consistency.
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
      recurring_service_id := v_service.id;
      period := v_period;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public.generate_due_recurring_service_occurrences() from public;
grant execute on function public.generate_due_recurring_service_occurrences() to service_role;
