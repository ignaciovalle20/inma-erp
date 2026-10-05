-- Recurring Services redesign (plan-servicios-recurrentes.md), Phase 2:
-- schema only. Extends the existing `recurring_services` table (Epic
-- 5.1, 20260913070000) instead of creating a duplicate -- confirmed
-- with the user in Phase 1 that a table of this exact name/purpose
-- already exists and is live (client + price + currency + periodicity
-- + manual generation into sales_documents). Adds the occurrence /
-- cost-pool model that replaces the external Trello board (Pagos
-- Hosting CL/UY, Licencias MS, Starlink/Servidor, Pagos).
--
-- Deliberate deviations from plan-servicios-recurrentes.md's literal
-- wording, confirmed with the user before writing this:
-- * No `pais` column anywhere: `companies.country` already implies
--   country (Demo Chile SpA = CL, Demo Uruguay SRL = UY) and every
--   table in this schema is scoped by company_id, not a loose country
--   code.
-- * Field/enum names are English, matching every other table here
--   (Spanish is UI-only in this codebase); service_type values are
--   'ms_licenses' / 'hosting' / 'starlink' / 'server' / 'other', not
--   the plan's Spanish tokens.
-- * `active` (existing boolean, still read *and written* by the
--   already-shipped edit form) is left untouched. `status` is added
--   as an independent new column instead of replacing/deriving
--   `active` -- Phase 5 (UI) is the right place to decide how the two
--   reconcile once pause/cancel actions exist; forcing that now would
--   either break the current edit action's write path or require
--   speculative trigger logic.
-- * `due_day`/`due_month` are two nullable smallints instead of the
--   plan's `int / date`, so an annual service's due date doesn't need
--   a fake year. Left nullable (not required at the DB level) because
--   existing rows have no due date on record; Phase 3's form can
--   require it for new services.
-- * No DB trigger auto-populates `business_area_id` from
--   `service_type` -- the plan lists that as app behavior on create,
--   which belongs in Phase 3 (CRUD/server actions), not this
--   schema-only phase.

-- ---------------------------------------------------------------------
-- recurring_services: new columns
-- ---------------------------------------------------------------------
alter table public.recurring_services
  add column business_area_id uuid references public.business_areas (id),
  add column service_type text
    check (service_type in ('ms_licenses', 'hosting', 'starlink', 'server', 'other')),
  add column invoicing_mode text not null default 'arrears'
    check (invoicing_mode in ('advance', 'arrears')),
  add column due_day smallint
    check (due_day between 1 and 31),
  add column due_month smallint
    check (due_month between 1 and 12),
  add column status text,
  add column fixed_monthly_cost numeric,
  add column uses_cost_pool boolean not null default false,
  add column quote_ref text;

-- Backfill status from the existing `active` boolean (both columns
-- coexist going forward -- see note above). false -> 'cancelled': the
-- current UI only ever offered a single deactivate action, which maps
-- to the plan's terminal "dar de baja" state, not a resumable
-- "pausado".
update public.recurring_services
  set status = case when active then 'active' else 'cancelled' end;

alter table public.recurring_services
  alter column status set not null,
  add constraint recurring_services_status_check
    check (status in ('active', 'paused', 'cancelled'));

alter table public.recurring_services
  add constraint recurring_services_due_month_required_for_annual
    check (periodicity <> 'annual' or due_month is not null);

-- ---------------------------------------------------------------------
-- Cross-company validation for business_area_id (same pattern as this
-- table's own client_id check from Epic 5.1).
-- ---------------------------------------------------------------------
create or replace function public.recurring_services_validate_business_area()
returns trigger
language plpgsql
as $$
declare
  v_area_company_id uuid;
begin
  if new.business_area_id is null then
    return new;
  end if;

  select company_id into v_area_company_id
  from public.business_areas
  where id = new.business_area_id;

  if v_area_company_id is null or v_area_company_id <> new.company_id then
    raise exception 'business_area_id must belong to the same company as the recurring service';
  end if;

  return new;
end;
$$;

create trigger recurring_services_validate_business_area
  before insert or update on public.recurring_services
  for each row
  execute function public.recurring_services_validate_business_area();

-- ---------------------------------------------------------------------
-- Seed the two business areas the plan's tipo_servicio mapping needs
-- that don't exist yet ('Microsoft 365' and 'Hosting' already do, from
-- Epic 1.5). Mirrors that migration's own backfill exactly: additive
-- taxonomy rows, no schema change to business_areas.
-- ---------------------------------------------------------------------
insert into public.business_areas (company_id, name)
select c.id, defaults.name
from public.companies c
cross join (values ('Starlink'), ('Cloud')) as defaults (name)
where not exists (
  select 1
  from public.business_areas ba
  where ba.company_id = c.id
    and ba.name = defaults.name
);

-- ---------------------------------------------------------------------
-- recurring_service_occurrences -- one row per billing cycle; the
-- in-ERP replacement for the Trello board's cards.
-- ---------------------------------------------------------------------
create table public.recurring_service_occurrences (
  id uuid primary key default gen_random_uuid(),
  recurring_service_id uuid not null references public.recurring_services (id),
  period date not null,
  invoice_due_date date,
  collection_due_date date,
  amount numeric not null,
  currency text not null check (currency in ('CLP', 'UYU', 'USD')),
  status text not null default 'pending_invoice'
    check (status in ('pending_invoice', 'invoiced', 'pending_collection', 'collected', 'void')),
  invoiced_at date,
  collected_at date,
  sales_document_id uuid references public.sales_documents (id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  unique (recurring_service_id, period)
);

create index recurring_service_occurrences_recurring_service_id_idx
  on public.recurring_service_occurrences (recurring_service_id);
create index recurring_service_occurrences_status_idx
  on public.recurring_service_occurrences (status);

create trigger recurring_service_occurrences_set_updated_at
  before update on public.recurring_service_occurrences
  for each row
  execute function public.set_updated_at();

alter table public.recurring_service_occurrences enable row level security;

-- RLS mirrors sales_lines' pattern (Epic 2.1): no company_id column
-- here, membership is checked via a join to the parent
-- recurring_service. Policy names are shortened vs. this codebase's
-- usual "...their company's X"/"...for their company" phrasing --
-- the full phrase would exceed Postgres' 63-byte identifier limit
-- given how long "recurring_service_occurrences" already is; scoping
-- itself is unaffected, it's enforced by the USING/WITH CHECK clause.
create policy "Members can view recurring service occurrences"
  on public.recurring_service_occurrences
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.recurring_services rs
      join public.company_memberships cm on cm.company_id = rs.company_id
      where rs.id = recurring_service_occurrences.recurring_service_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create recurring service occurrences"
  on public.recurring_service_occurrences
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.recurring_services rs
      join public.company_memberships cm on cm.company_id = rs.company_id
      where rs.id = recurring_service_occurrences.recurring_service_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update recurring service occurrences"
  on public.recurring_service_occurrences
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.recurring_services rs
      join public.company_memberships cm on cm.company_id = rs.company_id
      where rs.id = recurring_service_occurrences.recurring_service_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.recurring_services rs
      join public.company_memberships cm on cm.company_id = rs.company_id
      where rs.id = recurring_service_occurrences.recurring_service_id
        and cm.user_id = auth.uid()
    )
  );

-- Cross-company validation for sales_document_id, same defense-in-
-- depth spirit as every other FK-into-another-company's-table trigger
-- in this schema.
create or replace function public.recurring_service_occurrences_validate_sales_document()
returns trigger
language plpgsql
as $$
declare
  v_service_company_id uuid;
  v_document_company_id uuid;
begin
  if new.sales_document_id is null then
    return new;
  end if;

  select company_id into v_service_company_id
  from public.recurring_services
  where id = new.recurring_service_id;

  select company_id into v_document_company_id
  from public.sales_documents
  where id = new.sales_document_id;

  if v_document_company_id is null or v_document_company_id <> v_service_company_id then
    raise exception 'sales_document_id must belong to the same company as the recurring service';
  end if;

  return new;
end;
$$;

create trigger recurring_service_occurrences_validate_sales_document
  before insert or update on public.recurring_service_occurrences
  for each row
  execute function public.recurring_service_occurrences_validate_sales_document();

-- ---------------------------------------------------------------------
-- recurring_service_cost_pools -- one per company + service_type +
-- period; holds the supplier invoice total (today: MS licenses) to be
-- split proportionally across that period's occurrences.
-- ---------------------------------------------------------------------
create table public.recurring_service_cost_pools (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  service_type text not null
    check (service_type in ('ms_licenses', 'hosting', 'starlink', 'server', 'other')),
  period date not null,
  total_expense_amount numeric not null,
  currency text not null check (currency in ('CLP', 'UYU', 'USD')),
  supplier_id uuid references public.suppliers (id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  unique (company_id, service_type, period)
);

create index recurring_service_cost_pools_company_id_idx
  on public.recurring_service_cost_pools (company_id);

create trigger recurring_service_cost_pools_set_updated_at
  before update on public.recurring_service_cost_pools
  for each row
  execute function public.set_updated_at();

alter table public.recurring_service_cost_pools enable row level security;

create policy "Members can view recurring service cost pools"
  on public.recurring_service_cost_pools
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_service_cost_pools.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create recurring service cost pools"
  on public.recurring_service_cost_pools
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_service_cost_pools.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update recurring service cost pools"
  on public.recurring_service_cost_pools
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_service_cost_pools.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_service_cost_pools.company_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- recurring_service_cost_allocations -- proportional split snapshot,
-- one row per (cost_pool, occurrence). Insert-only, like sales_lines:
-- no UPDATE/DELETE policy, so a historical split is never rewritten --
-- matches the plan's explicit "snapshot, para no perder trazabilidad
-- histórica" requirement.
-- ---------------------------------------------------------------------
create table public.recurring_service_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  cost_pool_id uuid not null references public.recurring_service_cost_pools (id),
  occurrence_id uuid not null references public.recurring_service_occurrences (id),
  allocated_amount numeric not null,
  currency text not null check (currency in ('CLP', 'UYU', 'USD')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  unique (cost_pool_id, occurrence_id)
);

create index recurring_service_cost_allocations_cost_pool_id_idx
  on public.recurring_service_cost_allocations (cost_pool_id);
create index recurring_service_cost_allocations_occurrence_id_idx
  on public.recurring_service_cost_allocations (occurrence_id);

create trigger recurring_service_cost_allocations_set_updated_at
  before update on public.recurring_service_cost_allocations
  for each row
  execute function public.set_updated_at();

alter table public.recurring_service_cost_allocations enable row level security;

create policy "Members can view recurring service cost allocations"
  on public.recurring_service_cost_allocations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.recurring_service_cost_pools cp
      join public.company_memberships cm on cm.company_id = cp.company_id
      where cp.id = recurring_service_cost_allocations.cost_pool_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create recurring service cost allocations"
  on public.recurring_service_cost_allocations
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.recurring_service_cost_pools cp
      join public.company_memberships cm on cm.company_id = cp.company_id
      where cp.id = recurring_service_cost_allocations.cost_pool_id
        and cm.user_id = auth.uid()
    )
  );

-- Cross-company validation: the pool and the occurrence being
-- allocated must belong to the same company (a pool split must never
-- reach across companies).
create or replace function public.recurring_service_cost_allocations_validate_company()
returns trigger
language plpgsql
as $$
declare
  v_pool_company_id uuid;
  v_occurrence_company_id uuid;
begin
  select company_id into v_pool_company_id
  from public.recurring_service_cost_pools
  where id = new.cost_pool_id;

  select rs.company_id into v_occurrence_company_id
  from public.recurring_service_occurrences o
  join public.recurring_services rs on rs.id = o.recurring_service_id
  where o.id = new.occurrence_id;

  if v_pool_company_id is null or v_occurrence_company_id is null
     or v_pool_company_id <> v_occurrence_company_id then
    raise exception 'cost_pool_id and occurrence_id must belong to the same company';
  end if;

  return new;
end;
$$;

create trigger recurring_service_cost_allocations_validate_company
  before insert or update on public.recurring_service_cost_allocations
  for each row
  execute function public.recurring_service_cost_allocations_validate_company();
