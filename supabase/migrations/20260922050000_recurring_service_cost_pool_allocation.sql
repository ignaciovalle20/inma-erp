-- Recurring Services redesign, Phase 6: proportional split of a
-- supplier cost pool (today: MS licenses) across that period's
-- occurrences. plan-servicios-recurrentes.md: "un botón 'repartir'
-- calcula y guarda las allocations proporcional a monto_cliente de
-- las occurrences activas de ese tipo/país/período."
--
-- The cohort being split across is every occurrence whose
-- recurring_service matches the pool's company_id + service_type,
-- and whose own period/currency match the pool's -- not filtered by
-- the *current* status of the parent recurring_service: an
-- occurrence already represents what was actually billed that period
-- even if the service was since paused/cancelled, and that billed
-- amount still earned its share of that period's real supplier
-- invoice.
--
-- Plain function (not security definer), same reasoning as
-- generate_recurring_service_entry: the caller already has RLS-
-- authorized INSERT rights on recurring_service_cost_allocations via
-- company membership (through the cost_pool -> company_memberships
-- join in that table's own policy, 20260922010000) -- this function's
-- job is just the atomicity of computing and inserting every row
-- together, and doing the arithmetic server-side rather than trusting
-- client-computed splits.
--
-- Refuses to run twice for the same pool: allocations are an insert-
-- only historical snapshot (no UPDATE/DELETE policy on that table),
-- so a pool that already has any is left alone rather than silently
-- creating a second, conflicting split.
--
-- Rounds each share to the currency's usual display precision (CLP:
-- 0 decimals, everything else: 2 -- mirrors web/src/lib/currencies.ts
-- currencyDecimals(), duplicated here since SQL can't import that
-- module) and assigns the last occurrence (ordered by id, a stable
-- tie-break) whatever rounding remainder is left, so the allocated
-- amounts always sum to exactly total_expense_amount -- never a few
-- cents short or over due to independent rounding.
create or replace function public.allocate_recurring_service_cost_pool(
  p_cost_pool_id uuid
)
returns setof public.recurring_service_cost_allocations
language plpgsql
as $$
declare
  v_pool public.recurring_service_cost_pools;
  v_decimals int;
  v_total_client_amount numeric;
  v_count int;
  v_index int := 0;
  v_allocated_sum numeric := 0;
  v_share numeric;
  v_row record;
begin
  select * into v_pool
  from public.recurring_service_cost_pools
  where id = p_cost_pool_id;

  if v_pool is null then
    raise exception 'Cost pool not found';
  end if;

  if exists (
    select 1 from public.recurring_service_cost_allocations
    where cost_pool_id = p_cost_pool_id
  ) then
    raise exception 'This cost pool has already been allocated';
  end if;

  select count(*), coalesce(sum(o.amount), 0)
  into v_count, v_total_client_amount
  from public.recurring_service_occurrences o
  join public.recurring_services rs on rs.id = o.recurring_service_id
  where rs.company_id = v_pool.company_id
    and rs.service_type = v_pool.service_type
    and o.period = v_pool.period
    and o.currency = v_pool.currency;

  if v_count = 0 or v_total_client_amount = 0 then
    raise exception 'No occurrences found to allocate this cost pool against';
  end if;

  v_decimals := case when v_pool.currency = 'CLP' then 0 else 2 end;

  for v_row in
    select o.id as occurrence_id, o.amount
    from public.recurring_service_occurrences o
    join public.recurring_services rs on rs.id = o.recurring_service_id
    where rs.company_id = v_pool.company_id
      and rs.service_type = v_pool.service_type
      and o.period = v_pool.period
      and o.currency = v_pool.currency
    order by o.id
  loop
    v_index := v_index + 1;

    if v_index = v_count then
      -- Last row absorbs whatever rounding remainder is left, so the
      -- total always matches exactly.
      v_share := v_pool.total_expense_amount - v_allocated_sum;
    else
      v_share := round(
        v_pool.total_expense_amount * v_row.amount / v_total_client_amount,
        v_decimals
      );
      v_allocated_sum := v_allocated_sum + v_share;
    end if;

    insert into public.recurring_service_cost_allocations (
      cost_pool_id,
      occurrence_id,
      allocated_amount,
      currency
    )
    values (
      p_cost_pool_id,
      v_row.occurrence_id,
      v_share,
      v_pool.currency
    );
  end loop;

  return query
    select * from public.recurring_service_cost_allocations
    where cost_pool_id = p_cost_pool_id;
end;
$$;

revoke execute on function public.allocate_recurring_service_cost_pool(uuid) from public;
grant execute on function public.allocate_recurring_service_cost_pool(uuid) to authenticated;
