-- Epic 5, Story 5.2: Track Personnel/Labor Costs
--
-- Adds `personnel` (a company-scoped roster of employees/partners,
-- mirroring the `suppliers` shape/RLS exactly) and `personnel_costs`
-- (one row per person per period, a plain monthly amount -- no hours
-- field anywhere here; hours belong entirely to Story 5.3's allocation
-- concern, not to this cost record).
--
-- Owner/partner labor cost uses this exact same mechanism as any
-- employee -- `type` merely labels the row, it does not change
-- validation or RLS.
--
-- No cross-company validation trigger is needed on `personnel_costs`:
-- it references only `personnel` (a single entity whose own
-- `company_id` is authoritative via RLS), unlike tables referencing two
-- or more entities that could mismatch companies.

-- ---------------------------------------------------------------------
-- personnel
-- ---------------------------------------------------------------------
create table public.personnel (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name text not null,
  type text not null check (type in ('employee', 'partner')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index personnel_company_id_idx on public.personnel (company_id);

-- Reuses the shared set_updated_at() trigger function (Story 1.1/1.2).
create trigger personnel_set_updated_at
  before update on public.personnel
  for each row
  execute function public.set_updated_at();

alter table public.personnel enable row level security;

-- ---------------------------------------------------------------------
-- RLS: any member of the person's company (any role) may
-- select/insert/update. No DELETE policy -- deactivate only (active =
-- false), same pattern as clients/suppliers/recurring_services.
-- ---------------------------------------------------------------------
create policy "Members can view their company's personnel"
  on public.personnel
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = personnel.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create personnel for their company"
  on public.personnel
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = personnel.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's personnel"
  on public.personnel
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = personnel.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = personnel.company_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- personnel_costs: one row per person per period, a plain monthly
-- amount. `period` is normalized to the first day of its month via a
-- check constraint (same idea as recurring_services' period handling)
-- so the `(personnel_id, period)` unique constraint reliably enforces
-- "only one cost record per person per month".
-- ---------------------------------------------------------------------
create table public.personnel_costs (
  id uuid primary key default gen_random_uuid(),
  personnel_id uuid not null references public.personnel (id),
  period date not null check (period = date_trunc('month', period)::date),
  amount numeric not null,
  currency text not null check (currency in ('CLP', 'UYU', 'USD')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  unique (personnel_id, period)
);

create index personnel_costs_personnel_id_idx on public.personnel_costs (personnel_id);

-- Reuses the shared set_updated_at() trigger function (Story 1.1/1.2).
create trigger personnel_costs_set_updated_at
  before update on public.personnel_costs
  for each row
  execute function public.set_updated_at();

alter table public.personnel_costs enable row level security;

-- ---------------------------------------------------------------------
-- RLS: scoped through personnel.company_id (join-based, same pattern as
-- sales_lines/cost_lines). No DELETE policy.
-- ---------------------------------------------------------------------
create policy "Members can view their company's personnel costs"
  on public.personnel_costs
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.personnel p
      join public.company_memberships cm on cm.company_id = p.company_id
      where p.id = personnel_costs.personnel_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create personnel costs for their company"
  on public.personnel_costs
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.personnel p
      join public.company_memberships cm on cm.company_id = p.company_id
      where p.id = personnel_costs.personnel_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's personnel costs"
  on public.personnel_costs
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.personnel p
      join public.company_memberships cm on cm.company_id = p.company_id
      where p.id = personnel_costs.personnel_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.personnel p
      join public.company_memberships cm on cm.company_id = p.company_id
      where p.id = personnel_costs.personnel_id
        and cm.user_id = auth.uid()
    )
  );
