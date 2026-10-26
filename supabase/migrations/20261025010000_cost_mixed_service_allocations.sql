-- Mixed allocation: one purchase invoice split between recurring service
-- cost periods AND jobs / clients / areas, from "Editar asignación".
--
-- Until now a general cost went either to services (cost_service_allocations,
-- 20261020010000) or to a "Dividir" split (cost_allocations), never both, so
-- no peso was counted twice. Mixing keeps that guarantee with one rule: both
-- parts together add up to the document's total, each peso in one place.
--
-- * cost_allocations keep their basis: shares of total_amount (IVA
--   included). Reports turn each share into net with net/total (toNetShare
--   in web/src/lib/reporting.ts), unchanged.
-- * A service row is entered on that same basis (gross_amount, IVA
--   included) and stored as the net the service receives, amount =
--   gross * net / total, rounded to the currency; the last service row takes
--   the rounding so the services' net is exactly the part of the net they
--   stand for. Reports already count a document's confirmed service amount
--   as the services' cost and the rest as general (generalNet), unchanged.
-- * position (both tables) is the row's place in the form, so it reopens in
--   the same order (cost_allocations.position: 20261024040000).
--
-- Only set_cost_document_allocations mixes: it sets a transaction-local flag
-- that the two "never both" guards honour. Every other way in keeps the old
-- rule: the "Asignar a servicios" screen (set_cost_service_allocations) and
-- a raw insert still refuse a split document, and set_cost_allocations still
-- refuses a document allocated to services.

alter table public.cost_service_allocations
  add column gross_amount numeric check (gross_amount > 0),
  add column position integer;

comment on column public.cost_service_allocations.gross_amount is
  'Share of the document total (IVA included) entered in "Editar asignación"; amount is its net. Null when allocated from "Asignar a servicios".';
comment on column public.cost_service_allocations.position is
  'Row order in "Editar asignación", shared with cost_allocations.position. Null when allocated from "Asignar a servicios".';

-- ---------------------------------------------------------------------
-- The "never both" guards, unless the mixed editor is saving.
-- Same bodies as 20261020010000 plus the flag check.
-- ---------------------------------------------------------------------
create or replace function public.cost_service_allocations_validate()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_doc public.cost_documents;
  v_period record;
  v_other numeric;
  v_tolerance numeric;
begin
  select * into v_doc from public.cost_documents where id = new.cost_document_id;

  if v_doc.id is null then
    raise exception 'Cost document not found';
  end if;

  if v_doc.company_id <> new.company_id then
    raise exception 'cost_document_id must belong to the same company as the allocation';
  end if;

  select cp.company_id, rs.uses_cost_pool into v_period
  from public.recurring_service_cost_periods cp
  join public.recurring_services rs on rs.id = cp.recurring_service_id
  where cp.id = new.cost_period_id;

  if v_period.company_id is distinct from new.company_id then
    raise exception 'cost_period_id must belong to the same company as the allocation';
  end if;

  if v_period.uses_cost_pool then
    raise exception 'Un servicio con pool de licencias no recibe facturas por esta vía';
  end if;

  if v_doc.project_id is not null or v_doc.classification <> 'general' then
    raise exception 'Este costo ya está asignado a un trabajo: no se puede asignar además a servicios';
  end if;

  if coalesce(current_setting('inma.mixed_allocation', true), '') <> 'on'
     and exists (select 1 from public.cost_allocations ca where ca.cost_document_id = v_doc.id) then
    raise exception 'Este costo ya está dividido entre trabajos, clientes o áreas: editalo desde "Editar asignación"';
  end if;

  if new.status = 'confirmed' and public.covered_by_cost_pool_id(v_doc) is not null then
    raise exception 'Este costo está cubierto por el reparto de licencias MS: no se puede asignar además a servicios';
  end if;

  if new.status = 'confirmed' then
    select coalesce(sum(a.amount), 0) into v_other
    from public.cost_service_allocations a
    where a.cost_document_id = new.cost_document_id
      and a.status = 'confirmed'
      and a.id <> new.id;

    v_tolerance := case when v_doc.currency = 'CLP' then 0.5 else 0.005 end;

    if v_other + new.amount > v_doc.net_amount + v_tolerance then
      raise exception 'Las asignaciones a servicios (%) superan el neto del costo (%)',
        v_other + new.amount, v_doc.net_amount;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.cost_allocations_guard_service_allocations()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('inma.mixed_allocation', true), '') = 'on' then
    return new;
  end if;

  if exists (
    select 1 from public.cost_service_allocations a
    where a.cost_document_id = new.cost_document_id and a.status = 'confirmed'
  ) then
    raise exception 'Este costo está asignado a servicios recurrentes: quitá esas asignaciones antes de dividirlo';
  end if;

  delete from public.cost_service_allocations a
  where a.cost_document_id = new.cost_document_id and a.status = 'suggested';

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- set_cost_document_allocations: the "Editar asignación" save.
--
-- Replaces both kinds of rows of a general cost in one go:
--   p_allocations:          [{ target_type, target_id, method, value, position }]
--                           (as set_cost_allocations; value is a share of the total)
--   p_service_allocations:  [{ cost_period_id, gross_amount, position }]
-- At least 2 rows in all; every share of cost_allocations plus every
-- gross_amount add up to total_amount (0.01 of rounding, like
-- set_cost_allocations). Service rows are saved confirmed: saving here also
-- drops any pending suggestion of the document.
-- ---------------------------------------------------------------------
create or replace function public.set_cost_document_allocations(
  p_cost_document_id uuid,
  p_allocations jsonb,
  p_service_allocations jsonb
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_doc public.cost_documents;
  v_allocations jsonb := coalesce(p_allocations, '[]'::jsonb);
  v_services jsonb := coalesce(p_service_allocations, '[]'::jsonb);
  v_row jsonb;
  v_target_type text;
  v_method text;
  v_value numeric;
  v_share_sum numeric := 0;
  v_gross numeric;
  v_gross_sum numeric := 0;
  v_service_count integer;
  v_decimals integer;
  v_services_net numeric;
  v_net_so_far numeric := 0;
  v_index integer := 0;
  v_net numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required to set cost allocations';
  end if;

  select * into v_doc
  from public.cost_documents
  where id = p_cost_document_id
  for update;

  if v_doc.id is null then
    raise exception 'Cost document not found';
  end if;

  if v_doc.classification <> 'general' or v_doc.project_id is not null then
    raise exception 'Only general cost documents can be allocated';
  end if;

  if jsonb_typeof(v_allocations) <> 'array' or jsonb_typeof(v_services) <> 'array' then
    raise exception 'Allocations must be provided as arrays';
  end if;

  v_service_count := jsonb_array_length(v_services);

  if jsonb_array_length(v_allocations) + v_service_count < 2 then
    raise exception 'At least 2 targets are required to allocate a cost';
  end if;

  if v_service_count > 0 and (v_doc.total_amount <= 0 or v_doc.net_amount <= 0) then
    raise exception 'Solo un costo con monto positivo se asigna a servicios';
  end if;

  -- Validate and add up both parts before touching any row.
  for v_row in select * from jsonb_array_elements(v_allocations)
  loop
    v_target_type := v_row ->> 'target_type';
    v_method := v_row ->> 'method';

    if v_target_type is null or v_target_type not in ('project', 'client', 'business_area') then
      raise exception 'Each allocation needs a valid target_type';
    end if;
    if v_row ->> 'target_id' is null then
      raise exception 'Each allocation needs a target_id';
    end if;
    if v_method is null or v_method not in ('percentage', 'fixed_amount') then
      raise exception 'Each allocation needs a valid method';
    end if;
    if jsonb_typeof(v_row -> 'value') is distinct from 'number' then
      raise exception 'Each allocation needs a numeric value';
    end if;

    v_value := (v_row ->> 'value')::numeric;
    v_share_sum := v_share_sum + case
      when v_method = 'percentage' then round(v_doc.total_amount * v_value / 100, 2)
      else round(v_value, 2)
    end;
  end loop;

  for v_row in select * from jsonb_array_elements(v_services)
  loop
    if nullif(v_row ->> 'cost_period_id', '') is null then
      raise exception 'Cada asignación a servicios necesita un período de costo';
    end if;
    if jsonb_typeof(v_row -> 'gross_amount') is distinct from 'number' then
      raise exception 'Cada asignación a servicios necesita un monto';
    end if;
    v_gross := (v_row ->> 'gross_amount')::numeric;
    if v_gross <= 0 then
      raise exception 'Cada asignación a servicios necesita un monto mayor que cero';
    end if;
    v_gross_sum := v_gross_sum + round(v_gross, 2);
  end loop;

  if abs(v_share_sum + v_gross_sum - v_doc.total_amount) > 0.01 then
    raise exception 'Allocation shares (%) must sum to the document total (%)',
      v_share_sum + v_gross_sum, v_doc.total_amount;
  end if;

  delete from public.cost_service_allocations where cost_document_id = p_cost_document_id;
  delete from public.cost_allocations where cost_document_id = p_cost_document_id;

  perform set_config('inma.mixed_allocation', 'on', true);

  -- Services first: covered_by_cost_pool_id is then judged as it was before
  -- this save, the same as "Asignar a servicios" does.
  if v_service_count > 0 then
    v_decimals := case when v_doc.currency = 'CLP' then 0 else 2 end;
    v_services_net := round(v_gross_sum * v_doc.net_amount / v_doc.total_amount, v_decimals);

    for v_row in select * from jsonb_array_elements(v_services)
    loop
      v_index := v_index + 1;
      v_gross := round((v_row ->> 'gross_amount')::numeric, 2);
      v_net := case
        when v_index = v_service_count then v_services_net - v_net_so_far
        else round(v_gross * v_doc.net_amount / v_doc.total_amount, v_decimals)
      end;
      if v_net <= 0 then
        raise exception 'La parte de un servicio es demasiado chica para asignarla';
      end if;
      v_net_so_far := v_net_so_far + v_net;

      insert into public.cost_service_allocations (
        company_id, cost_document_id, cost_period_id, amount, gross_amount, position, status, created_by, updated_by
      ) values (
        v_doc.company_id,
        p_cost_document_id,
        (v_row ->> 'cost_period_id')::uuid,
        v_net,
        v_gross,
        nullif(v_row ->> 'position', '')::integer,
        'confirmed',
        v_user_id,
        v_user_id
      );
    end loop;
  end if;

  insert into public.cost_allocations (
    cost_document_id,
    project_id,
    client_id,
    business_area_id,
    method,
    percentage,
    amount,
    position,
    created_by,
    updated_by
  )
  select
    p_cost_document_id,
    case when row_data ->> 'target_type' = 'project' then (row_data ->> 'target_id')::uuid end,
    case when row_data ->> 'target_type' = 'client' then (row_data ->> 'target_id')::uuid end,
    case when row_data ->> 'target_type' = 'business_area' then (row_data ->> 'target_id')::uuid end,
    row_data ->> 'method',
    case when row_data ->> 'method' = 'percentage' then (row_data ->> 'value')::numeric end,
    case when row_data ->> 'method' = 'fixed_amount' then (row_data ->> 'value')::numeric end,
    coalesce(nullif(row_data ->> 'position', '')::integer, (elements.idx - 1)::integer),
    v_user_id,
    v_user_id
  from jsonb_array_elements(v_allocations) with ordinality as elements (row_data, idx);

  perform set_config('inma.mixed_allocation', 'off', true);
end;
$$;

revoke execute on function public.set_cost_document_allocations(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.set_cost_document_allocations(uuid, jsonb, jsonb) to authenticated, service_role;
