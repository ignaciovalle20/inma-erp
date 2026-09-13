-- Epic 3, Story 3.3: Track Pending vs. Confirmed-Zero Costs
--
-- Adds `project_cost_confirmations` -- one row per (project_id, period)
-- marking that a human deliberately confirmed "no cost for this project
-- this month" (confirmed_zero). No row is ever inserted for "pending"
-- -- pending is the absence of both a confirmation row and any
-- cost_documents for that project+period, computed at read time (see
-- spec Intent). period is always normalized to the first day of its
-- month via the check constraint, mirroring how the app already
-- reasons about "the month" elsewhere (document_date ranges).
--
-- confirm_project_cost_zero() is the supported path to insert a
-- confirmation -- it rejects when cost_documents already exist for
-- that project+period (confirming zero and having real costs are
-- mutually exclusive facts about the same period, per spec
-- Boundaries), and no-ops (returns the existing row) if already
-- confirmed. Removing a confirmation is a plain DELETE via RLS -- no
-- RPC needed, since there's no server-side invariant to protect beyond
-- company membership (already enforced by the DELETE policy).
--
-- Not security definer -- same reasoning as create_cost_document /
-- set_cost_allocations: the caller already has RLS-authorized INSERT
-- rights on project_cost_confirmations once its policy exists below.

-- ---------------------------------------------------------------------
-- project_cost_confirmations
-- ---------------------------------------------------------------------
create table public.project_cost_confirmations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  period date not null check (period = date_trunc('month', period)::date),
  note text,
  confirmed_by uuid references auth.users (id) default auth.uid(),
  confirmed_at timestamptz not null default now(),
  unique (project_id, period)
);

create index project_cost_confirmations_project_id_idx
  on public.project_cost_confirmations (project_id);

alter table public.project_cost_confirmations enable row level security;

create policy "Members can view their company's cost confirmations"
  on public.project_cost_confirmations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.company_memberships cm on cm.company_id = p.company_id
      where p.id = project_cost_confirmations.project_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost confirmations for their company"
  on public.project_cost_confirmations
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.projects p
      join public.company_memberships cm on cm.company_id = p.company_id
      where p.id = project_cost_confirmations.project_id
        and cm.user_id = auth.uid()
    )
  );

-- Un-confirming is a plain DELETE via RLS -- a distinct explicit action,
-- never a side effect of something else (per spec Never).
create policy "Members can delete their company's cost confirmations"
  on public.project_cost_confirmations
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.company_memberships cm on cm.company_id = p.company_id
      where p.id = project_cost_confirmations.project_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- confirm_project_cost_zero: rejects if any cost_documents exist for
-- that project_id with document_date in that month; otherwise inserts
-- (or no-ops if already confirmed).
-- ---------------------------------------------------------------------
create or replace function public.confirm_project_cost_zero(
  p_project_id uuid,
  p_period date
)
returns public.project_cost_confirmations
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_period date := date_trunc('month', p_period)::date;
  v_period_end date := (date_trunc('month', p_period) + interval '1 month')::date;
  v_has_costs boolean;
  v_confirmation public.project_cost_confirmations;
begin
  if v_user_id is null then
    raise exception 'Authentication required to confirm a cost period';
  end if;

  select exists (
    select 1
    from public.cost_documents cd
    where cd.project_id = p_project_id
      and cd.document_date >= v_period
      and cd.document_date < v_period_end
  ) into v_has_costs;

  if v_has_costs then
    raise exception 'Cannot confirm zero cost -- cost documents already exist for this project and period';
  end if;

  select * into v_confirmation
  from public.project_cost_confirmations
  where project_id = p_project_id
    and period = v_period;

  if found then
    return v_confirmation;
  end if;

  insert into public.project_cost_confirmations (project_id, period, confirmed_by)
  values (p_project_id, v_period, v_user_id)
  returning * into v_confirmation;

  return v_confirmation;
end;
$$;

revoke execute on function public.confirm_project_cost_zero(uuid, date) from public;
grant execute on function public.confirm_project_cost_zero(uuid, date) to authenticated;
