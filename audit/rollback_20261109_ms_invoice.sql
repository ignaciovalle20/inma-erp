-- ROLLBACK (NO EJECUTADO) de la migración 20261109010000_ms_license_pool_per_invoice.
--
-- Solo si hay que volver atrás. Deja todo como quedó tras 20261108020000:
-- covered_by_cost_pool_id con la regla del mes (20261020010000),
-- reallocate_recurring_service_cost_pool de 20261108010000 y las funciones
-- del mes (ms_license_pool_months, create_ms_license_pool_for_month) de
-- 20261108020000.
--
-- Antes de correrlo, revisá estos datos, que el rollback NO deshace:
--   * pools creados con "Es factura de licencias MS -> repartir": quedan, sin
--     su factura, y vuelven a cubrir TODAS las facturas del proveedor de su
--     mes (la regla vieja);
--   * dos pools de licencias en el mismo mes (refacturación): el paso 4 falla
--     al volver a crear el unique (company_id, service_type, period);
--     deshacé uno desde la pantalla antes de correrlo;
--   * pools borrados con "Deshacer reparto": no vuelven.
-- Va dentro de una transacción: si algo falla, no cambia nada.

begin;

-- 1. Funciones y triggers nuevos
drop trigger if exists cost_documents_guard_ms_license_pool on public.cost_documents;
drop trigger if exists cost_allocations_guard_ms_license_pool on public.cost_allocations;
drop trigger if exists recurring_service_cost_pools_validate_document on public.recurring_service_cost_pools;
drop function if exists public.cost_documents_guard_ms_license_pool();
drop function if exists public.cost_allocations_guard_ms_license_pool();
drop function if exists public.recurring_service_cost_pools_validate_document();
drop function if exists public.create_ms_license_pool_for_invoice(uuid, boolean);
drop function if exists public.ms_license_invoices(uuid);
drop function if exists public.undo_recurring_service_cost_pool(uuid);

-- 2. covered_by_cost_pool_id como en 20261020010000
create or replace function public.covered_by_cost_pool_id(public.cost_documents)
returns uuid
language sql
stable
as $function$
  select p.id
  from public.recurring_service_cost_pools p
  where p.company_id = $1.company_id
    and p.service_type = 'ms_licenses'
    and p.period = coalesce($1.recognized_period, date_trunc('month', $1.document_date)::date)
    and not exists (
      select 1 from public.cost_service_allocations a
      where a.cost_document_id = $1.id and a.status = 'confirmed'
    )
    and not exists (
      select 1
      from public.projects pr
      where pr.id = $1.project_id
        and not public.is_ms_licenses_area(pr.business_area_id)
    )
    and not exists (
      select 1
      from public.cost_allocations ca
      left join public.projects pr on pr.id = ca.project_id
      where ca.cost_document_id = $1.id
        and (
          (ca.business_area_id is not null and not public.is_ms_licenses_area(ca.business_area_id))
          or (ca.project_id is not null and not public.is_ms_licenses_area(pr.business_area_id))
        )
    )
    and (
      (p.supplier_id is not null and p.supplier_id = $1.supplier_id)
      or exists (
        select 1
        from public.projects pr
        where pr.id = $1.project_id
          and public.is_ms_licenses_area(pr.business_area_id)
      )
      or exists (
        select 1
        from public.cost_allocations ca
        left join public.projects pr on pr.id = ca.project_id
        where ca.cost_document_id = $1.id
          and (
            public.is_ms_licenses_area(ca.business_area_id)
            or public.is_ms_licenses_area(pr.business_area_id)
          )
      )
    )
  order by p.created_at, p.id
  limit 1;
$function$;

-- 3. reallocate_recurring_service_cost_pool como en 20261108010000
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

-- 4. Un pool por mes y tipo; sin columna de factura
drop index if exists public.recurring_service_cost_pools_month_without_invoice_key;
drop index if exists public.recurring_service_cost_pools_cost_document_id_key;
alter table public.recurring_service_cost_pools
  add constraint recurring_service_cost_pools_company_id_service_type_period_key
  unique (company_id, service_type, period);
alter table public.recurring_service_cost_pools drop column cost_document_id;

-- 5. Funciones del mes como en 20261108020000
create or replace function public.ms_license_pool_months(p_company_id uuid)
returns table (
  period date,
  currency text,
  supplier_id uuid,
  supplier_name text,
  document_count integer,
  net_total numeric,
  pool_id uuid,
  pool_total numeric,
  pool_allocated boolean
)
language sql
stable
as $$
  with docs as (
    select
      coalesce(d.recognized_period, date_trunc('month', d.document_date)::date) as period,
      d.currency,
      d.supplier_id,
      d.net_amount
    from public.cost_documents d
    where d.company_id = p_company_id
      and d.supplier_id is not null
      and public.is_ms_licenses_supplier(d.supplier_id)
      and coalesce(d.recognized_period, date_trunc('month', d.document_date)::date) >= date '2026-01-01'
      and not exists (
        select 1 from public.cost_service_allocations a
        where a.cost_document_id = d.id and a.status = 'confirmed'
      )
      and not exists (
        select 1 from public.projects pr
        where pr.id = d.project_id and not public.is_ms_licenses_area(pr.business_area_id)
      )
      and not exists (
        select 1
        from public.cost_allocations ca
        left join public.projects pr on pr.id = ca.project_id
        where ca.cost_document_id = d.id
          and (
            (ca.business_area_id is not null and not public.is_ms_licenses_area(ca.business_area_id))
            or (ca.project_id is not null and not public.is_ms_licenses_area(pr.business_area_id))
          )
      )
  ),
  months as (
    select period, currency, supplier_id, count(*)::integer as document_count, sum(net_amount) as net_total
    from docs
    group by period, currency, supplier_id
  )
  select
    m.period,
    m.currency,
    m.supplier_id,
    s.name,
    m.document_count,
    m.net_total,
    p.id,
    p.total_expense_amount,
    exists (select 1 from public.recurring_service_cost_allocations a where a.cost_pool_id = p.id)
  from months m
  join public.suppliers s on s.id = m.supplier_id
  left join public.recurring_service_cost_pools p
    on p.company_id = p_company_id and p.service_type = 'ms_licenses' and p.period = m.period
  order by m.period, m.currency;
$$;

revoke execute on function public.ms_license_pool_months(uuid) from public, anon;
grant execute on function public.ms_license_pool_months(uuid) to authenticated, service_role;

create or replace function public.create_ms_license_pool_for_month(p_company_id uuid, p_period date)
returns uuid
language plpgsql
as $$
declare
  v_period date := date_trunc('month', p_period)::date;
  v_rows integer;
  v_month record;
  v_pool_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required to split a cost pool';
  end if;

  select count(*) into v_rows from public.ms_license_pool_months(p_company_id) m where m.period = v_period;
  if v_rows = 0 then
    raise exception 'NO_INVOICES: No hay facturas del proveedor de licencias en ese mes';
  end if;
  if v_rows > 1 then
    raise exception 'MIXED: Las facturas de licencias del mes están en más de una moneda o de más de un proveedor: repartilas a mano';
  end if;

  select * into v_month from public.ms_license_pool_months(p_company_id) m where m.period = v_period;

  if v_month.pool_id is not null then
    raise exception 'EXISTS: Ese mes ya tiene su reparto: abrilo para volver a repartir';
  end if;
  if v_month.net_total <= 0 then
    raise exception 'NOT_POSITIVE: Las facturas del mes suman % (las notas de crédito restan): no hay costo que repartir', v_month.net_total;
  end if;

  insert into public.recurring_service_cost_pools (
    company_id, service_type, period, total_expense_amount, currency, supplier_id
  )
  values (p_company_id, 'ms_licenses', v_period, v_month.net_total, v_month.currency, v_month.supplier_id)
  returning id into v_pool_id;

  perform public.allocate_recurring_service_cost_pool(v_pool_id);

  return v_pool_id;
end;
$$;

revoke execute on function public.create_ms_license_pool_for_month(uuid, date) from public, anon;
grant execute on function public.create_ms_license_pool_for_month(uuid, date) to authenticated, service_role;

-- 6. Historial de migraciones
delete from supabase_migrations.schema_migrations where version = '20261109010000';

-- Cambiá a commit solo después de revisar el resultado.
rollback;
