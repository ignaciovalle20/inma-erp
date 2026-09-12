-- Epic 1, Story 1.5: Manage Business Areas
-- Adds a `business_areas` table scoped to a company, auto-seeded with 9
-- defaults via an AFTER INSERT trigger on `companies` (not by editing
-- create_company, so the guarantee holds for any future creation path).
-- Admin-only writes mirror Story 1.2's companies policy exactly, since
-- this is shared taxonomy that should change deliberately and rarely --
-- not the any-member model used for clients (Story 1.3) / suppliers
-- (Story 1.4). No DELETE policy anywhere -- deactivate only.

-- ---------------------------------------------------------------------
-- business_areas
-- ---------------------------------------------------------------------
create table public.business_areas (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index business_areas_company_id_idx on public.business_areas (company_id);

-- Reuses the set_updated_at() trigger function from Story 1.1/1.2.
create trigger business_areas_set_updated_at
  before update on public.business_areas
  for each row
  execute function public.set_updated_at();

alter table public.business_areas enable row level security;

-- ---------------------------------------------------------------------
-- RLS: any member may view; only an admin may add/rename/deactivate.
-- ---------------------------------------------------------------------
create policy "Members can view their company's business areas"
  on public.business_areas
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = business_areas.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Admins can create business areas for their company"
  on public.business_areas
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = business_areas.company_id
        and cm.user_id = auth.uid()
        and cm.role = 'admin'
    )
  );

create policy "Admins can update their company's business areas"
  on public.business_areas
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = business_areas.company_id
        and cm.user_id = auth.uid()
        and cm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = business_areas.company_id
        and cm.user_id = auth.uid()
        and cm.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------
-- seed_default_business_areas: inserts the 9 defaults for a company.
-- security definer because the client has no INSERT policy that would
-- allow inserting without an existing admin membership (a brand-new
-- company has no memberships yet at the instant this trigger fires, so
-- it must bypass RLS -- mirrors create_company's own security-definer
-- rationale).
-- ---------------------------------------------------------------------
create or replace function public.seed_default_business_areas()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.business_areas (company_id, name)
  values
    (new.id, 'Microsoft 365'),
    (new.id, 'Hosting'),
    (new.id, 'Development'),
    (new.id, 'IT Support'),
    (new.id, 'Networking'),
    (new.id, 'Security/CCTV'),
    (new.id, 'GPS'),
    (new.id, 'Solar Energy'),
    (new.id, 'Other');

  return new;
end;
$$;

create trigger seed_business_areas_on_company_insert
  after insert on public.companies
  for each row
  execute function public.seed_default_business_areas();

-- ---------------------------------------------------------------------
-- One-time backfill for companies that already exist (confirmed: 4
-- companies live today -- Inmasoft Chile, Inmasoft Uruguay, Test Corp,
-- Good Currency Co -- so this seeds 9 areas x 4 companies = 36 rows).
-- Guarded with a not-exists check so this migration stays safe to run
-- more than once.
-- ---------------------------------------------------------------------
insert into public.business_areas (company_id, name)
select c.id, defaults.name
from public.companies c
cross join (
  values
    ('Microsoft 365'),
    ('Hosting'),
    ('Development'),
    ('IT Support'),
    ('Networking'),
    ('Security/CCTV'),
    ('GPS'),
    ('Solar Energy'),
    ('Other')
) as defaults (name)
where not exists (
  select 1
  from public.business_areas ba
  where ba.company_id = c.id
    and ba.name = defaults.name
);
