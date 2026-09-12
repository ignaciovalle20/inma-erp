-- Epic 1, Story 1.1: User Login & Company-Scoped Access
-- Creates the minimal companies + company_memberships schema with RLS
-- scoped to auth.uid()'s memberships. Company fields beyond id/name/audit
-- columns (country/tax ID/currency/active) are added in Story 1.2.

-- ---------------------------------------------------------------------
-- Shared trigger: keep updated_at current on every UPDATE
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);

create trigger companies_set_updated_at
  before update on public.companies
  for each row
  execute function public.set_updated_at();

alter table public.companies enable row level security;

-- ---------------------------------------------------------------------
-- company_memberships
-- ---------------------------------------------------------------------
create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  company_id uuid not null references public.companies (id),
  role text not null default 'member',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  unique (user_id, company_id)
);

create trigger company_memberships_set_updated_at
  before update on public.company_memberships
  for each row
  execute function public.set_updated_at();

alter table public.company_memberships enable row level security;

-- ---------------------------------------------------------------------
-- RLS policies: a user may only see companies/memberships they hold a
-- membership row for. No INSERT/UPDATE/DELETE policies are defined here
-- (accounts and memberships are provisioned via the Supabase Dashboard,
-- never through client code with the anon key).
-- ---------------------------------------------------------------------
create policy "Members can view their own membership rows"
  on public.company_memberships
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Members can view companies they belong to"
  on public.companies
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = companies.id
        and cm.user_id = auth.uid()
    )
  );
