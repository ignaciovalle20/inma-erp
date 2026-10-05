-- MS licenses split (allocate_recurring_service_cost_pool): two fixes,
-- docs/verificacion-contable-2026-10-04.md (C05, C06).
--
-- 1. The rounding remainder used to land entirely on the last cycle by id
--    (a random UUID order). When every share rounded up, that last part
--    went negative (1+1+1+1 sold, invoice of 2 CLP -> 1, 1, 1, -1), and a
--    cycle sold at 0 could take the remainder. Now: largest remainder
--    method -- every share is floored to the currency's precision and the
--    units left over go one each to the largest fractional parts (ties:
--    larger amount, then id). Parts are never negative, a cycle sold at 0
--    takes 0, and they still add up to the invoice exactly.
-- 2. Voided cycles ('void') were part of the cohort and took a share of
--    the supplier invoice. They are left out now.
--
-- Same signature, same security (invoker) and same grants: CREATE OR
-- REPLACE keeps the existing EXECUTE privileges. Pools already split are
-- not touched (allocations are an insert-only snapshot; the function still
-- refuses to run twice for the same pool).
create or replace function public.allocate_recurring_service_cost_pool(
  p_cost_pool_id uuid
)
returns setof public.recurring_service_cost_allocations
language plpgsql
as $$
declare
  v_pool public.recurring_service_cost_pools;
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

  select coalesce(sum(greatest(o.amount, 0)), 0)
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
    select o.id, greatest(o.amount, 0) as amount
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
