-- Job quotes + kanban status (docs/cambios-flujo-v2.md, section 4.1).
-- Replaces the Planner board: a "trabajo" (project) is born from an
-- accepted Nubox quote, moves through a kanban-shaped lifecycle instead
-- of the old active/on_hold/closed, and can carry more than one quote
-- number over its life (e.g. quotes 1674 and 1691 for the same job).
--
-- ---------------------------------------------------------------------
-- project_quotes
-- ---------------------------------------------------------------------
-- Mirrors projects' RLS shape exactly (Story 1.6): any member of the
-- company (any role) may select/insert/update, no DELETE policy -- a
-- quote number is never removed once entered, only superseded by
-- adding another one. Unique per company_id+quote_number (not per
-- project) because a quote number identifies a specific Nubox
-- document company-wide -- two different jobs must never share one.
create table public.project_quotes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id),
  company_id uuid not null references public.companies (id),
  quote_number text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  constraint project_quotes_company_number_unique unique (company_id, quote_number)
);

create index project_quotes_project_id_idx on public.project_quotes (project_id);
create index project_quotes_company_id_idx on public.project_quotes (company_id);

create trigger project_quotes_set_updated_at
  before update on public.project_quotes
  for each row
  execute function public.set_updated_at();

alter table public.project_quotes enable row level security;

create policy "Members can view their company's project quotes"
  on public.project_quotes
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_quotes.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create project quotes for their company"
  on public.project_quotes
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_quotes.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's project quotes"
  on public.project_quotes
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_quotes.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_quotes.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Cross-company validation for project_id, same reasoning/shape as
-- projects_validate_company_refs (Story 1.6 review patch) and
-- cost_documents_validate_company_refs (Story 3.1): a plain FK can't
-- cross-check company_id equality, and RLS only verifies membership in
-- the submitted company_id, not that the referenced project belongs to
-- it.
create or replace function public.project_quotes_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  v_project_company_id uuid;
begin
  select company_id into v_project_company_id
  from public.projects
  where id = new.project_id;

  if v_project_company_id is null or v_project_company_id <> new.company_id then
    raise exception 'project_id must belong to the same company as the quote';
  end if;

  return new;
end;
$$;

create trigger project_quotes_validate_company_refs
  before insert or update on public.project_quotes
  for each row
  execute function public.project_quotes_validate_company_refs();

-- ---------------------------------------------------------------------
-- projects: kanban status + invoiceable + hold_reason
-- ---------------------------------------------------------------------
-- The old active/on_hold/closed didn't have room for "not quoted yet",
-- "finished but not yet paid off", or "cancelled" -- all needed to
-- retire the Planner board. Existing rows are migrated in place before
-- the constraint is tightened, so this is safe to run against a
-- database that already has projects in it.
alter table public.projects drop constraint if exists projects_status_check;

update public.projects set status = 'en_ejecucion' where status = 'active';
update public.projects set status = 'en_espera' where status = 'on_hold';
update public.projects set status = 'cerrado' where status = 'closed';

alter table public.projects
  add constraint projects_status_check check (
    status in ('por_cotizar', 'en_ejecucion', 'en_espera', 'finalizado', 'cerrado', 'cancelado')
  );

alter table public.projects alter column status set default 'en_ejecucion';

-- "¿Se factura?" -- clients marked as "sin factura" (invoiceable=false)
-- give birth to jobs that default to false too (see clients.invoiceable
-- below); either can be overridden per job.
alter table public.projects add column invoiceable boolean not null default true;

-- Free-text reason shown on the kanban card when a job sits in
-- en_espera -- not constrained beyond "required when the status is
-- en_espera", which is enforced app-side (Server Action), the same
-- "friendly check, not a DB invariant" choice already used for
-- cross-company refs' UI-facing error messages.
alter table public.projects add column hold_reason text;

-- ---------------------------------------------------------------------
-- clients: invoiceable + monthly
-- ---------------------------------------------------------------------
alter table public.clients add column invoiceable boolean not null default true;
alter table public.clients add column monthly boolean not null default false;

-- ---------------------------------------------------------------------
-- create_project_with_quote: the supported path for the mobile "alta de
-- trabajo" screen. Same shape as create_cost_document/
-- create_quick_cost_document -- not security definer (the caller
-- already has RLS-authorized INSERT on both tables via company
-- membership), this function only buys transactional atomicity between
-- the project row and its first quote, plus the "quote number required
-- unless por_cotizar" rule enforced before anything is inserted.
-- Additional quotes on an existing job (e.g. a second Nubox quote for
-- the same trabajo) are added directly against project_quotes, no RPC
-- needed there -- there's nothing else to keep atomic with.
-- ---------------------------------------------------------------------
create or replace function public.create_project_with_quote(
  p_company_id uuid,
  p_client_id uuid,
  p_business_area_id uuid,
  p_name text,
  p_status text,
  p_quote_number text,
  p_start_date date,
  p_end_date date,
  p_budget numeric,
  p_responsible text,
  p_invoiceable boolean
)
returns public.projects
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects;
  v_quote_number text := nullif(btrim(coalesce(p_quote_number, '')), '');
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a project';
  end if;

  if coalesce(p_status, 'en_ejecucion') <> 'por_cotizar' and v_quote_number is null then
    raise exception 'A quote number is required unless the job status is por_cotizar';
  end if;

  insert into public.projects (
    company_id,
    client_id,
    business_area_id,
    name,
    start_date,
    end_date,
    status,
    budget,
    responsible,
    invoiceable,
    created_by,
    updated_by
  )
  values (
    p_company_id,
    p_client_id,
    p_business_area_id,
    p_name,
    p_start_date,
    p_end_date,
    coalesce(p_status, 'en_ejecucion'),
    p_budget,
    p_responsible,
    coalesce(p_invoiceable, true),
    v_user_id,
    v_user_id
  )
  returning * into v_project;

  if v_quote_number is not null then
    insert into public.project_quotes (project_id, company_id, quote_number, created_by, updated_by)
    values (v_project.id, p_company_id, v_quote_number, v_user_id, v_user_id);
  end if;

  return v_project;
end;
$$;

revoke execute on function public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, text, boolean
) from public;
grant execute on function public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, text, boolean
) to authenticated;

-- ---------------------------------------------------------------------
-- Grants: this repo grants table privileges explicitly per migration
-- (see 20260915020000) even though `alter default privileges` already
-- covers new tables created by the same owning role -- kept explicit
-- here for the same belt-and-suspenders reason.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on public.project_quotes to authenticated, service_role;
