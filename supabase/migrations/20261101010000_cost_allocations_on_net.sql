-- "Editar asignación" reparte el neto, no el total con IVA.
--
-- Until now the shares of a document (cost_allocations, and the gross_amount of
-- its service rows) added up to total_amount, IVA included, and reports scaled
-- each share by net/total (toNetShare in web/src/lib/reporting.ts). The reports
-- were right, but the screen asked to split 2.554.993 for a factura whose cost
-- is 2.147.053, and a job's list of expenses showed the share with IVA next to
-- a "Costos" figure without it. IVA is recoverable: it is never a cost.
--
-- From now on every share is a share of net_amount:
--   * set_cost_allocations and set_cost_document_allocations check the shares
--     against net_amount; a percentage is a percentage of the net.
--   * A service row comes as `amount`, the net the service receives, stored as
--     it is. gross_amount is no longer written (kept for the rows saved before).
--   * Existing fixed_amount rows are converted below with the same ratio the
--     reports used, so no report moves by more than the rounding. Percentage
--     rows do not change: the same percentage of the net is the same cost.

create or replace function public.set_cost_allocations(
  p_cost_document_id uuid,
  p_allocations jsonb
)
returns setof public.cost_allocations
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_classification text;
  v_net_amount numeric;
  v_row jsonb;
  v_target_type text;
  v_method text;
  v_value numeric;
  v_share numeric;
  v_share_sum numeric := 0;
  v_row_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required to set cost allocations';
  end if;

  select classification, net_amount
  into v_classification, v_net_amount
  from public.cost_documents
  where id = p_cost_document_id;

  if v_classification is null then
    raise exception 'Cost document not found';
  end if;

  if v_classification <> 'general' then
    raise exception 'Only general cost documents can be allocated';
  end if;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'Allocations must be provided as an array';
  end if;

  if jsonb_array_length(p_allocations) < 2 then
    raise exception 'At least 2 targets are required to allocate a cost';
  end if;

  -- Validate and sum shares up front, before touching any row.
  for v_row in select * from jsonb_array_elements(p_allocations)
  loop
    v_target_type := v_row ->> 'target_type';
    v_method := v_row ->> 'method';

    if v_target_type not in ('project', 'client', 'business_area') then
      raise exception 'Each allocation needs a valid target_type';
    end if;

    if v_row ->> 'target_id' is null then
      raise exception 'Each allocation needs a target_id';
    end if;

    if v_method not in ('percentage', 'fixed_amount') then
      raise exception 'Each allocation needs a valid method';
    end if;

    if jsonb_typeof(v_row -> 'value') is null or jsonb_typeof(v_row -> 'value') <> 'number' then
      raise exception 'Each allocation needs a numeric value';
    end if;

    v_value := (v_row ->> 'value')::numeric;

    if v_method = 'percentage' then
      v_share := round(v_net_amount * v_value / 100, 2);
    else
      v_share := round(v_value, 2);
    end if;

    v_share_sum := v_share_sum + v_share;
    v_row_count := v_row_count + 1;
  end loop;

  if v_row_count < 2 then
    raise exception 'At least 2 targets are required to allocate a cost';
  end if;

  if abs(v_share_sum - v_net_amount) > 0.01 then
    raise exception 'Allocation shares (%) must sum to the document net (%)', v_share_sum, v_net_amount;
  end if;

  delete from public.cost_allocations
  where cost_document_id = p_cost_document_id;

  return query
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
    (elements.idx - 1)::integer,
    v_user_id,
    v_user_id
  from jsonb_array_elements(p_allocations) with ordinality as elements (row_data, idx)
  returning *;
end;
$$;

-- ---------------------------------------------------------------------
-- set_cost_document_allocations: the "Editar asignación" save.
--   p_allocations:          [{ target_type, target_id, method, value, position }]
--   p_service_allocations:  [{ cost_period_id, amount, position }]
-- At least 2 rows in all; the shares plus the service amounts add up to
-- net_amount (0.01 of rounding). Service rows are saved confirmed: saving here
-- also drops any pending suggestion of the document.
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
  v_amount numeric;
  v_service_sum numeric := 0;
  v_service_count integer;
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

  if v_service_count > 0 and v_doc.net_amount <= 0 then
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
      when v_method = 'percentage' then round(v_doc.net_amount * v_value / 100, 2)
      else round(v_value, 2)
    end;
  end loop;

  for v_row in select * from jsonb_array_elements(v_services)
  loop
    if nullif(v_row ->> 'cost_period_id', '') is null then
      raise exception 'Cada asignación a servicios necesita un período de costo';
    end if;
    if jsonb_typeof(v_row -> 'amount') is distinct from 'number' then
      raise exception 'Cada asignación a servicios necesita un monto';
    end if;
    v_amount := (v_row ->> 'amount')::numeric;
    if v_amount <= 0 then
      raise exception 'Cada asignación a servicios necesita un monto mayor que cero';
    end if;
    v_service_sum := v_service_sum + round(v_amount, 2);
  end loop;

  if abs(v_share_sum + v_service_sum - v_doc.net_amount) > 0.01 then
    raise exception 'Allocation shares (%) must sum to the document net (%)',
      v_share_sum + v_service_sum, v_doc.net_amount;
  end if;

  delete from public.cost_service_allocations where cost_document_id = p_cost_document_id;
  delete from public.cost_allocations where cost_document_id = p_cost_document_id;

  perform set_config('inma.mixed_allocation', 'on', true);

  -- Services first: covered_by_cost_pool_id is then judged as it was before
  -- this save, the same as "Asignar a servicios" does.
  for v_row in select * from jsonb_array_elements(v_services)
  loop
    insert into public.cost_service_allocations (
      company_id, cost_document_id, cost_period_id, amount, position, status, created_by, updated_by
    ) values (
      v_doc.company_id,
      p_cost_document_id,
      (v_row ->> 'cost_period_id')::uuid,
      round((v_row ->> 'amount')::numeric, 2),
      nullif(v_row ->> 'position', '')::integer,
      'confirmed',
      v_user_id,
      v_user_id
    );
  end loop;

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

-- ---------------------------------------------------------------------
-- Existing fixed amounts: from a share of the total to a share of the net.
-- The last fixed row of each document takes the rounding, so the document adds
-- up to its net exactly (with its percentage rows and confirmed services).
-- ---------------------------------------------------------------------
alter table public.cost_allocations disable trigger cost_allocations_set_updated_at;

do $$
declare
  v_doc record;
  v_row record;
  v_decimals integer;
  v_converted numeric;
  v_sum numeric;
  v_last uuid;
  v_rows integer := 0;
begin
  for v_doc in
    select d.id, d.net_amount, d.total_amount, d.currency,
      coalesce((
        select sum(s.amount) from public.cost_service_allocations s
        where s.cost_document_id = d.id and s.status = 'confirmed'
      ), 0) as services,
      coalesce((
        select sum(round(d.net_amount * a.percentage / 100, 2)) from public.cost_allocations a
        where a.cost_document_id = d.id and a.method = 'percentage'
      ), 0) as percentages
    from public.cost_documents d
    where d.total_amount <> d.net_amount
      and d.total_amount <> 0
      and exists (
        select 1 from public.cost_allocations a
        where a.cost_document_id = d.id and a.method = 'fixed_amount'
      )
  loop
    v_decimals := case when v_doc.currency = 'CLP' then 0 else 2 end;
    v_sum := 0;
    v_last := null;

    for v_row in
      select a.id, a.amount from public.cost_allocations a
      where a.cost_document_id = v_doc.id and a.method = 'fixed_amount'
      order by a.position, a.id
    loop
      v_converted := round(v_row.amount * v_doc.net_amount / v_doc.total_amount, v_decimals);
      update public.cost_allocations set amount = v_converted where id = v_row.id;
      v_sum := v_sum + v_converted;
      v_last := v_row.id;
      v_rows := v_rows + 1;
    end loop;

    update public.cost_allocations
    set amount = amount + (v_doc.net_amount - v_doc.services - v_doc.percentages - v_sum)
    where id = v_last
      and abs(v_doc.net_amount - v_doc.services - v_doc.percentages - v_sum) <= v_rows;
  end loop;

  raise notice 'cost_allocations converted to net: % rows', v_rows;
end;
$$;

alter table public.cost_allocations enable trigger cost_allocations_set_updated_at;

comment on column public.cost_allocations.amount is
  'fixed_amount: the share of the document''s net_amount (no IVA) that goes to this target.';
comment on column public.cost_allocations.percentage is
  'percentage: the share of the document''s net_amount that goes to this target.';
comment on column public.cost_service_allocations.gross_amount is
  'No longer written: "Editar asignación" works on the net and stores it in amount (20261101010000). Kept on rows saved before.';
