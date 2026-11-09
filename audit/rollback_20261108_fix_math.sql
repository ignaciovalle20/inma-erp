-- ROLLBACK (NO EJECUTADO) de las migraciones 20261108010000_audit_math_pool_and_rounding
-- y 20261108020000_fix_math_ms_pool_month_and_uy_unbacked.
--
-- Solo si hay que volver atrás. Deja las funciones como estaban en prod el
-- 2026-11-08 antes del deploy: allocate_recurring_service_cost_pool = cuerpo de
-- 20261016010000 (md5 de prosrc 07dc5a6a714a3b11e020509c3d3951c0) y
-- technician_charges_guard = cuerpo de 20261028010000 (md5 16373b4f7b6dd4ef15f7bed46ca135ed).
--
-- Antes de correrlo, revisá estos datos, que el rollback NO deshace:
--   * pools creados con "Confirmar reparto" o rehechos con "Volver a repartir" (quedan como están);
--   * sugerencias de costo con suggestion_reason = 'rounding' (bloque 2: se pasan a 'exact');
--   * cargos de Uruguay con backing = 'none' (el trigger viejo los rechaza: bloque 3 los pasa a backing null).
-- Va dentro de una transacción: si algo falla, no cambia nada.

begin;

-- 1. Funciones nuevas
drop function if exists public.create_ms_license_pool_for_month(uuid, date);
drop function if exists public.ms_license_pool_months(uuid);
drop function if exists public.is_ms_licenses_supplier(uuid);
drop function if exists public.reallocate_recurring_service_cost_pool(uuid);
drop function if exists public.create_unbacked_technician_charge(uuid, uuid, text, date, numeric);
drop function if exists public.update_uruguay_technician_charge(uuid, text, date, numeric, boolean, boolean);

-- 2. Motivo 'rounding' de las sugerencias de costo
update public.cost_service_allocations set suggestion_reason = 'exact' where suggestion_reason = 'rounding';
alter table public.cost_service_allocations drop constraint cost_service_allocations_suggestion_reason_check;
alter table public.cost_service_allocations
  add constraint cost_service_allocations_suggestion_reason_check
  check (suggestion_reason in ('exact', 'same_amount_batch', 'proportional'));

-- 3. Cargos de Uruguay sin respaldo -> cargo uruguayo común (mismo monto, sin IVA)
set local session_replication_role = replica;
update public.technician_charges tc
set backing = null, entered_as = null, document_status = 'recibida'
where tc.backing = 'none' and not public.company_is_chile(tc.company_id);
set local session_replication_role = origin;

-- 4. allocate_recurring_service_cost_pool como en 20261016010000
create or replace function public.allocate_recurring_service_cost_pool(p_cost_pool_id uuid)
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

drop function if exists public.recurring_service_cost_pool_shares(uuid, text, date, text, numeric);
drop function if exists public.prepare_recurring_service_cost_pool_cycles(uuid, text, date);

-- 5. technician_charges_guard como en 20261028010000
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

  if new.backing is not null and not public.company_is_chile(new.company_id) then
    raise exception 'El respaldo de los cargos se registra solo en empresas de Chile';
  end if;

  if new.backing = 'none' then
    if new.document_status <> 'no_aplica' then
      raise exception 'A charge without backing has no document (no_aplica)';
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

-- 6. Historial de migraciones
delete from supabase_migrations.schema_migrations where version in ('20261108010000', '20261108020000');

-- Cambiá a commit solo después de revisar el resultado.
rollback;
