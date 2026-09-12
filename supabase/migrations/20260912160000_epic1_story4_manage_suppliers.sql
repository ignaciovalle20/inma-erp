-- Epic 1, Story 1.4: Manage Suppliers
-- Adds a `suppliers` table scoped to a company. Identical shape and RLS
-- model to `clients` (Story 1.3) -- any member of the company (any
-- role) may select/insert/update. No DELETE policy exists anywhere --
-- removal is deactivate-only (active = false).

-- ---------------------------------------------------------------------
-- suppliers
-- ---------------------------------------------------------------------
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name text not null,
  tax_id text,
  country text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index suppliers_company_id_idx on public.suppliers (company_id);

-- Reuses the set_updated_at() trigger function from Story 1.1/1.2
-- (keeps updated_at and updated_by current on every UPDATE).
create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row
  execute function public.set_updated_at();

alter table public.suppliers enable row level security;

-- ---------------------------------------------------------------------
-- RLS: any member of the supplier's company (any role) may
-- select/insert/update. No DELETE policy -- deactivate only.
-- ---------------------------------------------------------------------
create policy "Members can view their company's suppliers"
  on public.suppliers
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = suppliers.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create suppliers for their company"
  on public.suppliers
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = suppliers.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's suppliers"
  on public.suppliers
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = suppliers.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = suppliers.company_id
        and cm.user_id = auth.uid()
    )
  );
