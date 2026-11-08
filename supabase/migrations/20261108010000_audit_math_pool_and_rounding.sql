-- Audit 2026-11 (audit/INFORME_MATEMATICA_2026-11.md): MS licenses pool and
-- cost-period suggestions.
--
-- M-01. allocate_recurring_service_cost_pool split the supplier's invoice
--       among the cycles of the pool's month that EXISTED at that moment.
--       A cycle created later (the cron runs once a month, an "arrears"
--       cycle is only created the month after) got no share, and the split
--       could not be redone: allocations are insert-only for members. In prod
--       the Chile pool of 2026-11 (Intcomex, 1.036.626) went to 2 of the 4 MS
--       services; SIMTA and TOTAL GP carry 0.
--       * Before splitting, the cycle of the pool's month is created for every
--         active monthly service of the pool's type (advance: the month itself;
--         arrears: generated as the month after, which is when its cycle is
--         due) -- the same generator the cron uses, idempotent.
--       * reallocate_recurring_service_cost_pool(pool) deletes the pool's
--         shares and splits it again (same rule), for a member of the pool's
--         company. The pool page offers it when a cycle of the month has no
--         share, or a share sits on a voided cycle.
-- M-05. cost_service_allocations.suggestion_reason accepts 'rounding': a
--       purchase invoice one unit away from a period's expected cost (39.495
--       against 39.496) is now suggested instead of left unallocated
--       (web/src/lib/costAllocationSuggestions.ts).
--
-- No data changes: existing shares stay as they are until someone presses
-- "Volver a repartir" on the pool's page.

alter table public.cost_service_allocations
  drop constraint cost_service_allocations_suggestion_reason_check;
alter table public.cost_service_allocations
  add constraint cost_service_allocations_suggestion_reason_check
  check (suggestion_reason in ('exact', 'same_amount_batch', 'rounding', 'proportional'));

create or replace function public.allocate_recurring_service_cost_pool(p_cost_pool_id uuid)
returns setof public.recurring_service_cost_allocations
language plpgsql
as $$
declare
  v_pool public.recurring_service_cost_pools;
  v_service record;
  v_scale numeric;
  v_total_client_amount numeric;
  v_total_units numeric;
begin
  select * into v_pool
  from public.recurring_service_cost_pools
  where id = p_cost_pool_id;

  if v_pool is null then
    raise exception 'Cost pool not found';
  end if;

  if v_pool.total_expense_amount < 0 then
    raise exception 'The cost pool total cannot be negative';
  end if;

  if exists (
    select 1 from public.recurring_service_cost_allocations
    where cost_pool_id = p_cost_pool_id
  ) then
    raise exception 'This cost pool has already been allocated';
  end if;

  -- M-01: every active monthly service of the type has its cycle of the
  -- pool's month before the split (on conflict do nothing in the generator).
  for v_service in
    select id, invoicing_mode
    from public.recurring_services
    where company_id = v_pool.company_id
      and service_type = v_pool.service_type
      and status = 'active'
      and periodicity = 'monthly'
  loop
    perform public.generate_recurring_service_occurrences_for_month(
      case when v_service.invoicing_mode = 'arrears'
        then (v_pool.period + interval '1 month')::date
        else v_pool.period
      end,
      v_pool.company_id,
      v_service.id
    );
  end loop;

  select coalesce(sum(greatest(coalesce(
    nullif(public.recurring_service_period_billed_amount(o.id), 0), o.amount), 0)), 0)
  into v_total_client_amount
  from public.recurring_service_occurrences o
  join public.recurring_services rs on rs.id = o.recurring_service_id
  where rs.company_id = v_pool.company_id
    and rs.service_type = v_pool.service_type
    and o.period = v_pool.period
    and o.currency = v_pool.currency
    and o.status <> 'void';

  if v_total_client_amount = 0 then
    raise exception 'No occurrences found to allocate this cost pool against';
  end if;

  -- CLP: whole pesos; UYU / USD: cents (mirrors web/src/lib/currencies.ts).
  v_scale := case when v_pool.currency = 'CLP' then 1 else 100 end;
  v_total_units := v_pool.total_expense_amount * v_scale;

  insert into public.recurring_service_cost_allocations (
    cost_pool_id,
    occurrence_id,
    allocated_amount,
    currency
  )
  with cohort as (
    select
      o.id,
      greatest(coalesce(nullif(public.recurring_service_period_billed_amount(o.id), 0), o.amount), 0) as amount
    from public.recurring_service_occurrences o
    join public.recurring_services rs on rs.id = o.recurring_service_id
    where rs.company_id = v_pool.company_id
      and rs.service_type = v_pool.service_type
      and o.period = v_pool.period
      and o.currency = v_pool.currency
      and o.status <> 'void'
  ),
  exact as (
    select id, amount, v_total_units * amount / v_total_client_amount as units
    from cohort
  ),
  floored as (
    select id, amount, floor(units) as base, units - floor(units) as fraction
    from exact
  ),
  ranked as (
    select
      floored.*,
      row_number() over (order by (amount > 0) desc, fraction desc, amount desc, id) as rank
    from floored
  ),
  leftover as (
    select v_total_units - sum(base) as units from floored
  )
  select
    p_cost_pool_id,
    ranked.id,
    (
      ranked.base
      -- one whole unit each to the largest remainders
      + case when ranked.amount > 0 and ranked.rank <= floor(leftover.units) then 1 else 0 end
      -- a total with more decimals than the currency's: the sub-unit rest
      -- goes to the first-ranked part, so the sum stays exact
      + case when ranked.rank = 1 then leftover.units - floor(leftover.units) else 0 end
    ) / v_scale,
    v_pool.currency
  from ranked
  cross join leftover;

  return query
    select * from public.recurring_service_cost_allocations
    where cost_pool_id = p_cost_pool_id;
end;
$$;

-- Members have no DELETE on the shares (insert-only snapshot): redoing a
-- split goes through this definer function, which checks the membership.
create or replace function public.reallocate_recurring_service_cost_pool(p_cost_pool_id uuid)
returns setof public.recurring_service_cost_allocations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required to split a cost pool';
  end if;

  select company_id into v_company_id
  from public.recurring_service_cost_pools
  where id = p_cost_pool_id
  for update;

  if v_company_id is null or not public.is_company_member(v_company_id) then
    raise exception 'Cost pool not found';
  end if;

  delete from public.recurring_service_cost_allocations where cost_pool_id = p_cost_pool_id;

  return query select * from public.allocate_recurring_service_cost_pool(p_cost_pool_id);
end;
$$;

revoke execute on function public.reallocate_recurring_service_cost_pool(uuid) from public, anon;
grant execute on function public.reallocate_recurring_service_cost_pool(uuid) to authenticated, service_role;

comment on function public.reallocate_recurring_service_cost_pool(uuid) is
  'Deletes the shares of an MS licenses pool and splits it again among every cycle of its month (audit 2026-11, M-01). Members of the pool''s company only.';
