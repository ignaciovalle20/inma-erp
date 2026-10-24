-- cost_allocations.position: the order the user gave the rows in the
-- "Editar asignación" form, so reopening it shows them the same way.
--
-- set_cost_allocations inserts every row in one statement, so they all
-- share created_at (now() is the transaction time) and ordering by it
-- alone returned them in any order. position is the row's index in
-- p_allocations (0-based), taken with `with ordinality`.
--
-- Existing rows are numbered by created_at, then id: their original
-- order was never stored, so this only makes it stable from now on.

alter table public.cost_allocations
  add column position integer not null default 0;

update public.cost_allocations ca
set position = numbered.position
from (
  select id, (row_number() over (partition by cost_document_id order by created_at, id) - 1)::integer as position
  from public.cost_allocations
) numbered
where numbered.id = ca.id;

create index cost_allocations_cost_document_position_idx
  on public.cost_allocations (cost_document_id, position);

-- Same body as 20260913030000_epic3_story2_cost_allocations.sql; only the
-- final insert changes, to store each row's position.
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
  v_total_amount numeric;
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

  select classification, total_amount
  into v_classification, v_total_amount
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
      v_share := round(v_total_amount * v_value / 100, 2);
    else
      v_share := round(v_value, 2);
    end if;

    v_share_sum := v_share_sum + v_share;
    v_row_count := v_row_count + 1;
  end loop;

  if v_row_count < 2 then
    raise exception 'At least 2 targets are required to allocate a cost';
  end if;

  if abs(v_share_sum - v_total_amount) > 0.01 then
    raise exception 'Allocation shares (%) must sum to the document total (%)', v_share_sum, v_total_amount;
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
