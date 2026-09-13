-- Epic 3, Story 3.2: Cost Allocation Across Projects, Clients & Areas
--
-- Adds `cost_allocations` -- one row per target (project, client, or
-- business area) that a `general` (company-overhead) cost document's
-- total_amount is distributed across -- plus `set_cost_allocations()`,
-- a replace-all RPC mirroring update_sales_document's delete+reinsert
-- pattern (Story 2.2).
--
-- Allocation is scoped to `general` costs only -- a `direct` cost
-- already has its single target via project_id, so allocating it too
-- would create two competing sources of truth (see spec Boundaries).
--
-- Each row has exactly one of project_id/client_id/business_area_id
-- set (DB check constraint, enforced regardless of app-layer
-- discipline). There's no shared "target" base table across
-- projects/clients/business_areas (Story 1.3/1.5/1.6), so three
-- separate nullable FK columns is the only option, same as
-- cost_documents' own supplier_id/project_id shape.
--
-- Cross-company validation for whichever target FK is set reuses the
-- same BEFORE INSERT trigger pattern as
-- cost_documents_validate_company_refs -- a raw authenticated
-- PostgREST call could otherwise bypass an app-only check. Only
-- BEFORE INSERT is needed (not UPDATE) because set_cost_allocations
-- never updates a row in place -- it deletes and reinserts.
--
-- set_cost_allocations is a plain function (not security definer),
-- same reasoning as create_cost_document/update_sales_document: the
-- caller already has RLS-authorized INSERT/DELETE rights on
-- cost_allocations once its policies exist below.

-- ---------------------------------------------------------------------
-- cost_allocations
-- ---------------------------------------------------------------------
create table public.cost_allocations (
  id uuid primary key default gen_random_uuid(),
  cost_document_id uuid not null references public.cost_documents (id),
  project_id uuid references public.projects (id),
  client_id uuid references public.clients (id),
  business_area_id uuid references public.business_areas (id),
  method text not null check (method in ('percentage', 'fixed_amount')),
  percentage numeric,
  amount numeric,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  constraint cost_allocations_single_target_check check (
    (
      (project_id is not null)::int
      + (client_id is not null)::int
      + (business_area_id is not null)::int
    ) = 1
  ),
  constraint cost_allocations_method_value_check check (
    (method = 'percentage' and percentage is not null and amount is null)
    or (method = 'fixed_amount' and amount is not null and percentage is null)
  )
);

create index cost_allocations_cost_document_id_idx on public.cost_allocations (cost_document_id);
create index cost_allocations_project_id_idx on public.cost_allocations (project_id);
create index cost_allocations_client_id_idx on public.cost_allocations (client_id);
create index cost_allocations_business_area_id_idx on public.cost_allocations (business_area_id);

create trigger cost_allocations_set_updated_at
  before update on public.cost_allocations
  for each row
  execute function public.set_updated_at();

alter table public.cost_allocations enable row level security;

create policy "Members can view their company's cost allocations"
  on public.cost_allocations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_allocations.cost_document_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost allocations for their company"
  on public.cost_allocations
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_allocations.cost_document_id
        and cm.user_id = auth.uid()
    )
  );

-- DELETE is needed for set_cost_allocations' own replace-all step, same
-- reasoning as sales_lines' DELETE policy in Story 2.2.
create policy "Members can delete their company's cost allocations"
  on public.cost_allocations
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_allocations.cost_document_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- DB-level cross-company validation for whichever target FK is set.
-- Mirrors cost_documents_validate_company_refs -- RLS only verifies
-- membership in the cost document's own company, not that the target
-- project/client/area belongs to that same company.
-- ---------------------------------------------------------------------
create or replace function public.cost_allocations_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  v_cost_document_company_id uuid;
  v_target_company_id uuid;
begin
  select company_id into v_cost_document_company_id
  from public.cost_documents
  where id = new.cost_document_id;

  if v_cost_document_company_id is null then
    raise exception 'cost_document_id must reference an existing cost document';
  end if;

  if new.project_id is not null then
    select company_id into v_target_company_id
    from public.projects
    where id = new.project_id;

    if v_target_company_id is null or v_target_company_id <> v_cost_document_company_id then
      raise exception 'project_id must belong to the same company as the cost document';
    end if;
  elsif new.client_id is not null then
    select company_id into v_target_company_id
    from public.clients
    where id = new.client_id;

    if v_target_company_id is null or v_target_company_id <> v_cost_document_company_id then
      raise exception 'client_id must belong to the same company as the cost document';
    end if;
  elsif new.business_area_id is not null then
    select company_id into v_target_company_id
    from public.business_areas
    where id = new.business_area_id;

    if v_target_company_id is null or v_target_company_id <> v_cost_document_company_id then
      raise exception 'business_area_id must belong to the same company as the cost document';
    end if;
  end if;

  return new;
end;
$$;

create trigger cost_allocations_validate_company_refs
  before insert on public.cost_allocations
  for each row
  execute function public.cost_allocations_validate_company_refs();

-- ---------------------------------------------------------------------
-- set_cost_allocations: replace-all RPC, mirroring
-- update_sales_document's delete+reinsert pattern (Story 2.2).
--
-- p_allocations is a jsonb array of:
--   { target_type: 'project'|'client'|'business_area', target_id: uuid,
--     method: 'percentage'|'fixed_amount', value: numeric }
--
-- Rejects: cost document not found, classification != 'general', fewer
-- than 2 rows, an unrecognized target_type, and a computed-share sum
-- that doesn't match total_amount within a 0.01 rounding tolerance.
-- All validation happens before any row is touched; the delete+insert
-- itself is the atomic replace-all step.
-- ---------------------------------------------------------------------
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
    v_user_id,
    v_user_id
  from jsonb_array_elements(p_allocations) as row_data
  returning *;
end;
$$;

revoke execute on function public.set_cost_allocations(uuid, jsonb) from public;
grant execute on function public.set_cost_allocations(uuid, jsonb) to authenticated;
