-- Epic 5, Story 5.3: Assign Personnel Cost/Hours to Projects
--
-- Adds `work_allocations` -- one row per (personnel_cost, project) linking
-- a slice of a monthly personnel cost's `amount` to a project, with an
-- optional `hours` value recorded alongside it purely for traceability.
--
-- Allocation is amount-based, not hours-based: `personnel_costs` stores a
-- flat monthly figure, not an hourly rate, so there is no data anywhere
-- in this schema to convert hours into money. Building that conversion
-- now would be speculative product design with no PRD backing (see the
-- spec's Design Notes) -- `hours` is captured as optional informational
-- metadata alongside the required `amount`, never as a second,
-- independent allocation currency.
--
-- Unlike cost_allocations' replace-all pattern (Story 3.2),
-- work_allocations accumulate incrementally -- separate allocation
-- actions over time as different projects get decided -- so this is a
-- single-row INSERT rpc (`allocate_work`), not a delete+reinsert set,
-- and the table gets a DELETE policy (unlike the append-only entities
-- elsewhere) so a user can remove/redo an individual allocation.
--
-- Cross-company validation mirrors cost_allocations_validate_company_refs
-- (Story 3.2): `project_id` must belong to the same company as the
-- personnel cost's person (`personnel_costs` -> `personnel.company_id`).

-- ---------------------------------------------------------------------
-- work_allocations
-- ---------------------------------------------------------------------
create table public.work_allocations (
  id uuid primary key default gen_random_uuid(),
  personnel_cost_id uuid not null references public.personnel_costs (id),
  project_id uuid not null references public.projects (id),
  amount numeric not null,
  hours numeric,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index work_allocations_personnel_cost_id_idx on public.work_allocations (personnel_cost_id);
create index work_allocations_project_id_idx on public.work_allocations (project_id);

-- Reuses the shared set_updated_at() trigger function (Story 1.1/1.2).
create trigger work_allocations_set_updated_at
  before update on public.work_allocations
  for each row
  execute function public.set_updated_at();

alter table public.work_allocations enable row level security;

-- ---------------------------------------------------------------------
-- RLS: any member of the personnel cost's person's company may
-- select/insert/delete, join-based through personnel_costs ->
-- personnel.company_id (same pattern as cost_allocations ->
-- cost_documents.company_id). DELETE is needed (unlike personnel/
-- personnel_costs) so a user can remove/redo an allocation.
-- ---------------------------------------------------------------------
create policy "Members can view their company's work allocations"
  on public.work_allocations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.personnel_costs pc
      join public.personnel p on p.id = pc.personnel_id
      join public.company_memberships cm on cm.company_id = p.company_id
      where pc.id = work_allocations.personnel_cost_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create work allocations for their company"
  on public.work_allocations
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.personnel_costs pc
      join public.personnel p on p.id = pc.personnel_id
      join public.company_memberships cm on cm.company_id = p.company_id
      where pc.id = work_allocations.personnel_cost_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete their company's work allocations"
  on public.work_allocations
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.personnel_costs pc
      join public.personnel p on p.id = pc.personnel_id
      join public.company_memberships cm on cm.company_id = p.company_id
      where pc.id = work_allocations.personnel_cost_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- DB-level cross-company validation: project_id must belong to the same
-- company as the personnel cost's person. RLS only verifies membership
-- in the personnel cost's own company, not that the target project
-- belongs to that same company -- a raw authenticated PostgREST call
-- could otherwise slip in a cross-company project_id.
-- ---------------------------------------------------------------------
create or replace function public.work_allocations_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  v_personnel_cost_company_id uuid;
  v_project_company_id uuid;
begin
  select p.company_id into v_personnel_cost_company_id
  from public.personnel_costs pc
  join public.personnel p on p.id = pc.personnel_id
  where pc.id = new.personnel_cost_id;

  if v_personnel_cost_company_id is null then
    raise exception 'personnel_cost_id must reference an existing personnel cost';
  end if;

  select company_id into v_project_company_id
  from public.projects
  where id = new.project_id;

  if v_project_company_id is null or v_project_company_id <> v_personnel_cost_company_id then
    raise exception 'project_id must belong to the same company as the personnel cost';
  end if;

  return new;
end;
$$;

create trigger work_allocations_validate_company_refs
  before insert on public.work_allocations
  for each row
  execute function public.work_allocations_validate_company_refs();

-- ---------------------------------------------------------------------
-- allocate_work: single-row insert RPC. Validates p_amount > 0 and that
-- existing allocations plus this one don't exceed the personnel cost's
-- total amount (over-allocation is rejected, not silently capped).
--
-- Plain function (not security definer), same reasoning as every other
-- creation RPC in this codebase -- the caller already has RLS-authorized
-- INSERT rights on work_allocations once its policies exist above.
-- ---------------------------------------------------------------------
create or replace function public.allocate_work(
  p_personnel_cost_id uuid,
  p_project_id uuid,
  p_amount numeric,
  p_hours numeric default null
)
returns public.work_allocations
language plpgsql
as $$
declare
  v_total_amount numeric;
  v_existing_sum numeric;
  v_result public.work_allocations;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Allocation amount must be greater than zero';
  end if;

  select amount into v_total_amount
  from public.personnel_costs
  where id = p_personnel_cost_id;

  if v_total_amount is null then
    raise exception 'Personnel cost not found';
  end if;

  select coalesce(sum(amount), 0) into v_existing_sum
  from public.work_allocations
  where personnel_cost_id = p_personnel_cost_id;

  if v_existing_sum + p_amount > v_total_amount then
    raise exception 'Allocation total (%) would exceed the personnel cost amount (%)', v_existing_sum + p_amount, v_total_amount;
  end if;

  insert into public.work_allocations (
    personnel_cost_id,
    project_id,
    amount,
    hours
  )
  values (
    p_personnel_cost_id,
    p_project_id,
    p_amount,
    p_hours
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke execute on function public.allocate_work(uuid, uuid, numeric, numeric) from public;
grant execute on function public.allocate_work(uuid, uuid, numeric, numeric) to authenticated;
