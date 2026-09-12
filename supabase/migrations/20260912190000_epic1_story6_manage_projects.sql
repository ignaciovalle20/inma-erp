-- Epic 1, Story 1.6: Manage Projects
-- Adds a `projects` table scoped to a company, referencing a client and
-- a business area (both must belong to the same company -- enforced
-- server-side in the app layer, since a plain FK can't cross-check
-- company_id equality). Any member of the company (any role) may
-- select/insert/update. No DELETE policy -- lifecycle is closed via the
-- `status` enum, never a hard delete.

-- ---------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  client_id uuid not null references public.clients (id),
  business_area_id uuid not null references public.business_areas (id),
  name text not null,
  start_date date,
  end_date date,
  status text not null default 'active' check (status in ('active', 'on_hold', 'closed')),
  budget numeric,
  responsible text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index projects_company_id_idx on public.projects (company_id);
create index projects_client_id_idx on public.projects (client_id);
create index projects_business_area_id_idx on public.projects (business_area_id);

-- Reuses the set_updated_at() trigger function from Story 1.1/1.2
-- (keeps updated_at and updated_by current on every UPDATE).
create trigger projects_set_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

alter table public.projects enable row level security;

-- ---------------------------------------------------------------------
-- RLS: any member of the project's company (any role) may
-- select/insert/update. No DELETE policy -- status moves to 'closed'.
-- ---------------------------------------------------------------------
create policy "Members can view their company's projects"
  on public.projects
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = projects.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create projects for their company"
  on public.projects
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = projects.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's projects"
  on public.projects
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = projects.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = projects.company_id
        and cm.user_id = auth.uid()
    )
  );
