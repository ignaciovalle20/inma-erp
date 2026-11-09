-- fix-math 2026-11 (audit/INFORME_MATEMATICA_2026-11.md, section 7).
--
-- 1. MS licenses pool, split among the services that USE the pool.
--    The cohort of allocate_recurring_service_cost_pool took every
--    ms_licenses service, including those without the pool (Chile:
--    ADQUICOMER, annual; Uruguay: Trimant and grupoAM, with a fixed cost).
--    The reports only count pool shares of pooled services, so a share given
--    to one of them was counted nowhere, while the supplier's invoice was
--    already "cubierta por pool". The cohort is now only uses_cost_pool
--    services.
--    The share logic moves to recurring_service_cost_pool_shares() so the
--    preview the screen shows and the split that is saved are the same query.
--    The month's cycles are created first (prepare_recurring_service_cost_pool_cycles,
--    same rule as 20261108010000).
--
-- 2. Automation: invoices of the MS licenses supplier.
--    * is_ms_licenses_supplier(supplier): Intcomex (Chile), TGM (Uruguay), or
--      any supplier already used by an MS pool of its company.
--    * ms_license_pool_months(company): by month (from 2026-01), the net of
--      that supplier's invoices the pool would cover, and the month's pool, if
--      any.
--    * create_ms_license_pool_for_month(company, month): creates the month's
--      pool with that net and splits it. The screen calls it after showing
--      the preview, one month at a time.
--    The cost of the pool is recognised in the pool's month (the supplier
--    invoice's month), whatever the state of the sale cycles
--    (web/src/lib/reporting.ts); this migration only provides the data.
--
-- 3. Uruguay: charges "sin documento de respaldo" (backing 'none'): the amount
--    is exactly what is paid, no IVA, like Chile's. technician_charges_guard
--    accepts 'none' in any company (factura / boleta stay Chile-only);
--    create_unbacked_technician_charge and update_uruguay_technician_charge
--    are the Uruguayan writes.
--
-- No data changes: functions and a trigger function only.

-- ---------------------------------------------------------------------
-- 1. Pool shares
-- ---------------------------------------------------------------------
create or replace function public.prepare_recurring_service_cost_pool_cycles(
  p_company_id uuid,
  p_service_type text,
  p_period date
)
returns void
language plpgsql
as $$
declare
  v_service record;
begin
  for v_service in
    select id, invoicing_mode
    from public.recurring_services
    where company_id = p_company_id
      and service_type = p_service_type
      and status = 'active'
      and periodicity = 'monthly'
      and uses_cost_pool
  loop
    perform public.generate_recurring_service_occurrences_for_month(
      case when v_service.invoicing_mode = 'arrears'
        then (date_trunc('month', p_period) + interval '1 month')::date
        else date_trunc('month', p_period)::date
      end,
      p_company_id,
      v_service.id
    );
  end loop;
end;
$$;

revoke execute on function public.prepare_recurring_service_cost_pool_cycles(uuid, text, date) from public, anon;
grant execute on function public.prepare_recurring_service_cost_pool_cycles(uuid, text, date) to authenticated, service_role;

-- The split of p_total among the month's cycles of the pooled services: each
-- weighs what was billed to its client that month (confirmed invoices of the
-- cycle's currency), else its expected amount; largest remainder in whole
-- units of the currency, so the parts add up exactly to p_total. A cycle sold
-- at 0 takes nothing. Read only.
create or replace function public.recurring_service_cost_pool_shares(
  p_company_id uuid,
  p_service_type text,
  p_period date,
  p_currency text,
  p_total numeric
)
returns table (occurrence_id uuid, weight numeric, basis text, share numeric)
language sql
stable
as $$
  with cohort as (
    select
      o.id,
      public.recurring_service_period_billed_amount(o.id) as billed,
      o.amount
    from public.recurring_service_occurrences o
    join public.recurring_services rs on rs.id = o.recurring_service_id
    where rs.company_id = p_company_id
      and rs.service_type = p_service_type
      and rs.uses_cost_pool
      and o.period = date_trunc('month', p_period)::date
      and o.currency = p_currency
      and o.status <> 'void'
  ),
  weighted as (
    select id, greatest(coalesce(nullif(billed, 0), amount), 0) as weight,
           case when billed > 0 then 'billed' else 'expected' end as basis
    from cohort
  ),
  scale as (
    select case when p_currency = 'CLP' then 1 else 100 end::numeric as factor,
           (select sum(weight) from weighted) as total_weight
  ),
  exact as (
    select w.id, w.weight, w.basis,
           p_total * s.factor * w.weight / s.total_weight as units, s.factor
    from weighted w cross join scale s
    where s.total_weight > 0
  ),
  floored as (
    select id, weight, basis, factor, floor(units) as base, units - floor(units) as fraction
    from exact
  ),
  ranked as (
    select floored.*,
           row_number() over (order by (weight > 0) desc, fraction desc, weight desc, id) as rank
    from floored
  ),
  leftover as (
    select p_total * max(factor) - sum(base) as units from floored
  )
  select
    r.id,
    r.weight,
    r.basis,
    (
      r.base
      + case when r.weight > 0 and r.rank <= floor(l.units) then 1 else 0 end
      + case when r.rank = 1 then l.units - floor(l.units) else 0 end
    ) / r.factor
  from ranked r cross join leftover l;
$$;

revoke execute on function public.recurring_service_cost_pool_shares(uuid, text, date, text, numeric) from public, anon;
grant execute on function public.recurring_service_cost_pool_shares(uuid, text, date, text, numeric) to authenticated, service_role;

create or replace function public.allocate_recurring_service_cost_pool(p_cost_pool_id uuid)
returns setof public.recurring_service_cost_allocations
language plpgsql
as $$
declare
  v_pool public.recurring_service_cost_pools;
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

  perform public.prepare_recurring_service_cost_pool_cycles(v_pool.company_id, v_pool.service_type, v_pool.period);

  if not exists (
    select 1
    from public.recurring_service_cost_pool_shares(
      v_pool.company_id, v_pool.service_type, v_pool.period, v_pool.currency, v_pool.total_expense_amount
    )
  ) then
    raise exception 'No occurrences found to allocate this cost pool against';
  end if;

  insert into public.recurring_service_cost_allocations (cost_pool_id, occurrence_id, allocated_amount, currency)
  select p_cost_pool_id, s.occurrence_id, s.share, v_pool.currency
  from public.recurring_service_cost_pool_shares(
    v_pool.company_id, v_pool.service_type, v_pool.period, v_pool.currency, v_pool.total_expense_amount
  ) s;

  return query
    select * from public.recurring_service_cost_allocations
    where cost_pool_id = p_cost_pool_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. MS licenses supplier and the months to split
-- ---------------------------------------------------------------------
create or replace function public.is_ms_licenses_supplier(p_supplier_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.suppliers s
    join public.companies c on c.id = s.company_id
    where s.id = p_supplier_id
      and (
        (c.country = 'CL' and lower(btrim(s.name)) like 'intcomex%')
        or (c.country = 'UY' and lower(btrim(s.name)) ~ '^tgm([^a-z]|$)')
        or exists (
          select 1 from public.recurring_service_cost_pools p
          where p.company_id = s.company_id and p.supplier_id = s.id and p.service_type = 'ms_licenses'
        )
      )
  );
$$;

revoke execute on function public.is_ms_licenses_supplier(uuid) from public, anon;
grant execute on function public.is_ms_licenses_supplier(uuid) to authenticated, service_role;

-- Per month (2026-01 on, the first month managed in the ERP) and currency:
-- the net of the MS licenses supplier's documents a pool of that month would
-- cover (covered_by_cost_pool_id's rule: not allocated to services, not
-- attributed to a job or area outside the licenses area; credit notes
-- subtract), and that month's pool.
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

-- The month's pool from its supplier invoices, split at once. One month,
-- one supplier and one currency; a month that already has a pool is redone
-- from its own page (reallocate_recurring_service_cost_pool). Runs as the
-- caller: RLS decides who can create the pool.
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

-- ---------------------------------------------------------------------
-- 3. Uruguay: charges without backing
-- ---------------------------------------------------------------------
create or replace function public.technician_charges_guard()
returns trigger
language plpgsql
as $$
declare
  v_project_company_id uuid;
  v_personnel_company_id uuid;
  v_personnel_type text;
  v_document public.cost_documents;
  v_linking boolean := coalesce(current_setting('inma.technician_document_link', true), '') = 'on';
  v_edit_key text := coalesce(current_setting('inma.technician_charge_edit', true), '');
  v_editing boolean := false;
  v_expected_total numeric;
begin
  if tg_op = 'UPDATE' then
    v_editing := v_edit_key <> ''
      and (v_edit_key = coalesce(old.cost_document_id::text, '') or v_edit_key = 'charge:' || old.id::text);

    if new.company_id is distinct from old.company_id
      or new.project_id is distinct from old.project_id
      or new.personnel_id is distinct from old.personnel_id
      or new.cost_document_id is distinct from old.cost_document_id
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by
    then
      raise exception 'A technician charge cannot change its company, job, technician or cost document';
    end if;

    if not v_editing and (
      new.description is distinct from old.description
      or new.charge_date is distinct from old.charge_date
      or new.amount is distinct from old.amount
      or new.vat_included is distinct from old.vat_included
      or new.vat_rate is distinct from old.vat_rate
      or new.net_amount is distinct from old.net_amount
      or new.backing is distinct from old.backing
      or new.entered_as is distinct from old.entered_as
      or new.withholding_rate is distinct from old.withholding_rate
    ) then
      raise exception 'A technician charge can only have its document status changed; use update_technician_charge to correct it';
    end if;

    if new.document_status is distinct from old.document_status
      and new.backing is not null and not v_linking and not v_editing then
      raise exception 'El documento de un cargo con respaldo se marca vinculando la factura o boleta';
    end if;
  end if;

  select company_id into v_project_company_id from public.projects where id = new.project_id;
  if v_project_company_id is null or v_project_company_id <> new.company_id then
    raise exception 'project_id must belong to the same company as the technician charge';
  end if;

  select company_id, type into v_personnel_company_id, v_personnel_type
  from public.personnel
  where id = new.personnel_id;
  if v_personnel_company_id is null or v_personnel_company_id <> new.company_id then
    raise exception 'personnel_id must belong to the same company as the technician charge';
  end if;
  if v_personnel_type <> 'contractor' then
    raise exception 'Only external technicians can have technician charges';
  end if;

  -- Factura and boleta de honorarios are Chile's; "sin respaldo" exists in
  -- every company (fix-math 2026-11: Uruguay too).
  if new.backing in ('factura', 'boleta') and not public.company_is_chile(new.company_id) then
    raise exception 'El respaldo con factura o boleta de los cargos se registra solo en empresas de Chile';
  end if;

  if new.backing = 'none' then
    if new.document_status <> 'no_aplica' then
      raise exception 'A charge without backing has no document (no_aplica)';
    end if;
    if new.vat_included or new.amount <> new.net_amount then
      raise exception 'Un cargo sin respaldo es exactamente lo pagado, sin IVA';
    end if;
  elsif new.document_status not in ('pendiente', 'recibida') then
    raise exception 'The document status must be pendiente or recibida';
  end if;

  if new.cost_document_id is null then
    raise exception 'A technician charge needs its own cost document';
  end if;

  -- Its own cost: a direct cost of its job at its cost. The total of the
  -- document is what is paid, except for a boleta (gross, like an imported boleta).
  v_expected_total := new.amount;
  if new.backing = 'boleta' then
    v_expected_total := new.net_amount;
  end if;

  select * into v_document from public.cost_documents where id = new.cost_document_id;
  if not found
    or v_document.company_id <> new.company_id
    or v_document.project_id is distinct from new.project_id
    or v_document.classification <> 'direct'
    or v_document.net_amount <> new.net_amount
    or v_document.total_amount <> v_expected_total
  then
    raise exception 'The technician charge does not match its cost document';
  end if;

  return new;
end;
$$;

-- A Uruguayan charge without backing: the job's cost is exactly what is paid.
create or replace function public.create_unbacked_technician_charge(
  p_project_id uuid,
  p_personnel_id uuid,
  p_description text,
  p_charge_date date,
  p_amount numeric
)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_charge public.technician_charges;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required to create a technician charge';
  end if;

  select company_id into v_company_id from public.projects where id = p_project_id;
  if v_company_id is null or not public.is_company_member(v_company_id) then
    raise exception 'Project not found';
  end if;
  if public.company_is_chile(v_company_id) then
    raise exception 'En Chile el cargo sin respaldo se registra con create_backed_technician_charge';
  end if;

  v_charge := public.create_technician_charge(p_project_id, p_personnel_id, p_description, p_charge_date, p_amount, false, 0);

  perform set_config('inma.technician_charge_edit', 'charge:' || v_charge.id::text, true);
  update public.technician_charges
  set backing = 'none', entered_as = 'amount', document_status = 'no_aplica'
  where id = v_charge.id
  returning * into v_charge;
  perform set_config('inma.technician_charge_edit', '', true);

  return v_charge;
end;
$$;

revoke execute on function public.create_unbacked_technician_charge(uuid, uuid, text, date, numeric) from public, anon;
grant execute on function public.create_unbacked_technician_charge(uuid, uuid, text, date, numeric) to authenticated, service_role;

-- Corrects a Uruguayan charge, with or without backing: p_unbacked turns it
-- into (or keeps it) "sin documento de respaldo" (no IVA, the amount is what
-- is paid); false is the usual Uruguayan charge (amount + "IVA incluido").
create or replace function public.update_uruguay_technician_charge(
  p_charge_id uuid,
  p_description text,
  p_charge_date date,
  p_amount numeric,
  p_vat_included boolean,
  p_unbacked boolean
)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_charge public.technician_charges;
  v_currency text;
  v_name text;
  v_net numeric;
  v_vat_included boolean := coalesce(p_vat_included, false) and not coalesce(p_unbacked, false);
  v_vat_rate numeric;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  v_charge := public.technician_charge_for_edit(p_charge_id);

  if public.company_is_chile(v_charge.company_id) then
    raise exception 'En Chile el cargo se corrige con update_backed_technician_charge';
  end if;
  if p_charge_date is null then
    raise exception 'A charge date is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'The charge amount must be greater than zero';
  end if;

  -- The rate the charge was loaded with (an unbacked one was created with 0):
  -- a later rate change never rewrites an old charge; Uruguay's 22 % otherwise.
  v_vat_rate := coalesce(nullif(v_charge.vat_rate, 0), 0.22);

  select currency into v_currency from public.cost_documents where id = v_charge.cost_document_id;
  select name into v_name from public.personnel where id = v_charge.personnel_id;

  v_net := public.technician_charge_net(p_amount, v_vat_included, v_vat_rate, v_currency);
  if v_net <= 0 then
    raise exception 'The charge amount is too small';
  end if;

  perform set_config('inma.technician_charge_edit', v_charge.cost_document_id::text, true);

  update public.cost_documents
  set document_date = p_charge_date,
      net_amount = v_net,
      tax_amount = p_amount - v_net,
      total_amount = p_amount,
      updated_by = v_user_id
  where id = v_charge.cost_document_id;

  delete from public.cost_lines where cost_document_id = v_charge.cost_document_id;
  insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
  values (v_charge.cost_document_id, 'Técnico: ' || v_name || coalesce(' — ' || v_description, ''), v_net, v_user_id, v_user_id);

  update public.technician_charges
  set description = v_description,
      charge_date = p_charge_date,
      amount = p_amount,
      vat_included = v_vat_included,
      vat_rate = v_vat_rate,
      net_amount = v_net,
      backing = case when coalesce(p_unbacked, false) then 'none' end,
      entered_as = case when coalesce(p_unbacked, false) then 'amount' end,
      document_status = case
        when coalesce(p_unbacked, false) then 'no_aplica'
        when v_charge.document_status = 'no_aplica' then 'pendiente'
        else v_charge.document_status
      end,
      updated_by = v_user_id
  where id = p_charge_id
  returning * into v_charge;

  perform set_config('inma.technician_charge_edit', '', true);

  return v_charge;
end;
$$;

revoke execute on function public.update_uruguay_technician_charge(uuid, text, date, numeric, boolean, boolean) from public, anon;
grant execute on function public.update_uruguay_technician_charge(uuid, text, date, numeric, boolean, boolean) to authenticated, service_role;
