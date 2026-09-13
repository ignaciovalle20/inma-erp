-- Epic 5, Story 5.1: Manage Recurring Services
--
-- Adds `recurring_services` (client, price, expected cost, periodicity,
-- validity), company-scoped like the rest of the schema. Generation is
-- manual/prompted only -- there is no cron/pg_cron mechanism anywhere in
-- this app, and none is introduced here (see spec Decisions/Never).
--
-- `expected_cost` is stored as a plain figure for Epic 6's future margin
-- computation -- it never materializes into a `cost_documents` row (a
-- cost document represents money actually paid, not a forecast).
--
-- Generation only produces the income side: `generate_recurring_service_
-- entry` inserts a single-line `sales_documents` row, reusing
-- `create_sales_document`'s net/total computation approach, with
-- `source='recurring'` and back-links (`recurring_service_id`,
-- `recurring_period`) enforcing idempotency per (service, period) via a
-- partial unique index.

-- ---------------------------------------------------------------------
-- recurring_services
-- ---------------------------------------------------------------------
create table public.recurring_services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  client_id uuid not null references public.clients (id),
  name text not null,
  price numeric not null,
  expected_cost numeric not null default 0,
  currency text not null check (currency in ('CLP', 'UYU', 'USD')),
  periodicity text not null check (periodicity in ('monthly', 'annual')),
  start_date date not null,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index recurring_services_company_id_idx on public.recurring_services (company_id);
create index recurring_services_client_id_idx on public.recurring_services (client_id);

-- Reuses the shared set_updated_at() trigger function (Story 1.1/1.2).
create trigger recurring_services_set_updated_at
  before update on public.recurring_services
  for each row
  execute function public.set_updated_at();

alter table public.recurring_services enable row level security;

-- ---------------------------------------------------------------------
-- RLS: any member of the service's company (any role) may
-- select/insert/update. No DELETE policy -- deactivate only (same
-- pattern as clients/suppliers).
-- ---------------------------------------------------------------------
create policy "Members can view their company's recurring services"
  on public.recurring_services
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_services.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create recurring services for their company"
  on public.recurring_services
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_services.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's recurring services"
  on public.recurring_services
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_services.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = recurring_services.company_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- DB-level cross-company validation for client_id (same pattern as
-- sales_documents_validate_company_refs / Story 1.6). A plain FK can't
-- cross-check company_id equality, and RLS only verifies membership in
-- the submitted company_id, not that the referenced client belongs to
-- it -- so this must be a trigger, not just an app-layer check.
-- ---------------------------------------------------------------------
create or replace function public.recurring_services_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  client_company_id uuid;
begin
  select company_id into client_company_id
  from public.clients
  where id = new.client_id;

  if client_company_id is null or client_company_id <> new.company_id then
    raise exception 'client_id must belong to the same company as the recurring service';
  end if;

  return new;
end;
$$;

create trigger recurring_services_validate_company_refs
  before insert or update on public.recurring_services
  for each row
  execute function public.recurring_services_validate_company_refs();

-- ---------------------------------------------------------------------
-- sales_documents: extend `source` to allow 'recurring', add the
-- back-links to the generating service/period, and enforce idempotency
-- per (recurring_service_id, recurring_period) with a partial unique
-- index (partial so multiple manual/import rows with null
-- recurring_service_id are unaffected).
-- ---------------------------------------------------------------------
alter table public.sales_documents
  drop constraint sales_documents_source_check;

alter table public.sales_documents
  add constraint sales_documents_source_check
  check (source in ('manual', 'import', 'recurring'));

alter table public.sales_documents
  add column recurring_service_id uuid references public.recurring_services (id),
  add column recurring_period date;

create unique index sales_documents_recurring_service_period_idx
  on public.sales_documents (recurring_service_id, recurring_period)
  where recurring_service_id is not null;

-- ---------------------------------------------------------------------
-- generate_recurring_service_entry: the supported path to materialize
-- one period's income for an active, in-validity recurring service.
-- Not security definer -- same reasoning as create_sales_document: the
-- caller already has RLS-authorized INSERT rights on sales_documents/
-- sales_lines via company membership, so this function's job is just
-- atomicity, validity/idempotency enforcement, and computing
-- net_amount/total_amount server-side (never trusted from client
-- input).
--
-- p_period is normalized to the first day of its containing period
-- (month for 'monthly', year for 'annual') so idempotency and validity
-- checks are robust to whatever day-of-period the caller passes -- the
-- app always passes the first of the period anyway (see Design Notes:
-- period resolution happens client-side), this is a backstop.
-- ---------------------------------------------------------------------
create or replace function public.generate_recurring_service_entry(
  p_recurring_service_id uuid,
  p_period date
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_service public.recurring_services;
  v_document public.sales_documents;
  v_period_start date;
begin
  if v_user_id is null then
    raise exception 'Authentication required to generate a recurring service entry';
  end if;

  if p_period is null then
    raise exception 'A period is required';
  end if;

  select * into v_service
  from public.recurring_services
  where id = p_recurring_service_id;

  if v_service is null then
    raise exception 'Recurring service not found';
  end if;

  if not v_service.active then
    raise exception 'Recurring service is not active';
  end if;

  if v_service.periodicity = 'annual' then
    v_period_start := date_trunc('year', p_period)::date;
  else
    v_period_start := date_trunc('month', p_period)::date;
  end if;

  if v_period_start < v_service.start_date then
    raise exception 'Cannot generate before the service start date';
  end if;

  if v_service.end_date is not null and v_period_start > v_service.end_date then
    raise exception 'Cannot generate after the service end date';
  end if;

  if exists (
    select 1 from public.sales_documents
    where recurring_service_id = p_recurring_service_id
      and recurring_period = v_period_start
  ) then
    raise exception 'This period has already been generated for this service';
  end if;

  insert into public.sales_documents (
    company_id,
    client_id,
    document_type,
    document_date,
    currency,
    net_amount,
    tax_amount,
    total_amount,
    source,
    recurring_service_id,
    recurring_period,
    created_by,
    updated_by
  )
  values (
    v_service.company_id,
    v_service.client_id,
    'manual',
    v_period_start,
    v_service.currency,
    v_service.price,
    0,
    v_service.price,
    'recurring',
    v_service.id,
    v_period_start,
    v_user_id,
    v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (sales_document_id, description, amount, created_by, updated_by)
  values (v_document.id, v_service.name, v_service.price, v_user_id, v_user_id);

  return v_document;
end;
$$;

revoke execute on function public.generate_recurring_service_entry(uuid, date) from public;
grant execute on function public.generate_recurring_service_entry(uuid, date) to authenticated;
