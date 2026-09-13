-- Epic 3, Story 3.1: Manual Cost/Expense Entry
-- Adds `cost_documents` (header) and `cost_lines` (detail), mirroring
-- Epic 2 Story 2.1's sales_documents/sales_lines pattern exactly
-- (client -> supplier), plus a `classification` column (`direct`/
-- `general`) that gates whether `project_id` is required. Kept
-- structurally separate from sales/payments (per epic constraint --
-- see epic-3-context.md). No UPDATE/DELETE policies yet, no edit/void,
-- no allocation, no pending/confirmed-zero states, no duplicate
-- detection -- those are Stories 3.2/3.3/3.4.
--
-- net_amount/total_amount are never trusted from client input -- they
-- are always computed server-side by create_cost_document() from the
-- submitted lines + tax_amount, same reasoning as create_sales_document.
--
-- supplier_id and project_id cross-company validation reuses Story
-- 1.6/2.1's reviewed pattern: a BEFORE INSERT OR UPDATE DB trigger, not
-- just an app-layer check -- a raw authenticated PostgREST call could
-- otherwise bypass an app-only check.
--
-- classification is its own text check column, separate from any
-- paper-document-type field -- the epic only asks for this binary
-- split (see spec Design Notes). supplier_id is nullable -- not every
-- cost has a registered supplier (e.g. bank fees, misc charges).

-- ---------------------------------------------------------------------
-- cost_documents
-- ---------------------------------------------------------------------
create table public.cost_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  supplier_id uuid references public.suppliers (id),
  project_id uuid references public.projects (id),
  classification text not null check (classification in ('direct', 'general')),
  document_date date not null,
  currency text not null check (currency in ('CLP', 'UYU', 'USD')),
  net_amount numeric not null default 0,
  tax_amount numeric not null default 0,
  total_amount numeric not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  constraint cost_documents_classification_project_check check (
    (classification = 'direct' and project_id is not null)
    or (classification = 'general' and project_id is null)
  )
);

create index cost_documents_company_id_idx on public.cost_documents (company_id);
create index cost_documents_supplier_id_idx on public.cost_documents (supplier_id);
create index cost_documents_project_id_idx on public.cost_documents (project_id);

-- Reuses the shared set_updated_at() trigger function (Story 1.1/1.2).
create trigger cost_documents_set_updated_at
  before update on public.cost_documents
  for each row
  execute function public.set_updated_at();

alter table public.cost_documents enable row level security;

create policy "Members can view their company's cost documents"
  on public.cost_documents
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = cost_documents.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost documents for their company"
  on public.cost_documents
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = cost_documents.company_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- DB-level cross-company validation for supplier_id/project_id. A plain
-- FK can't cross-check company_id equality, and RLS only verifies
-- membership in the submitted company_id, not that the referenced
-- supplier/project belongs to it -- so this must be a trigger, not just
-- the Server Action check.
-- ---------------------------------------------------------------------
create or replace function public.cost_documents_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  supplier_company_id uuid;
  project_company_id uuid;
begin
  if new.supplier_id is not null then
    select company_id into supplier_company_id
    from public.suppliers
    where id = new.supplier_id;

    if supplier_company_id is null or supplier_company_id <> new.company_id then
      raise exception 'supplier_id must belong to the same company as the cost document';
    end if;
  end if;

  if new.project_id is not null then
    select company_id into project_company_id
    from public.projects
    where id = new.project_id;

    if project_company_id is null or project_company_id <> new.company_id then
      raise exception 'project_id must belong to the same company as the cost document';
    end if;
  end if;

  return new;
end;
$$;

create trigger cost_documents_validate_company_refs
  before insert or update on public.cost_documents
  for each row
  execute function public.cost_documents_validate_company_refs();

-- ---------------------------------------------------------------------
-- cost_lines
-- ---------------------------------------------------------------------
create table public.cost_lines (
  id uuid primary key default gen_random_uuid(),
  cost_document_id uuid not null references public.cost_documents (id),
  description text,
  amount numeric not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index cost_lines_cost_document_id_idx on public.cost_lines (cost_document_id);

create trigger cost_lines_set_updated_at
  before update on public.cost_lines
  for each row
  execute function public.set_updated_at();

alter table public.cost_lines enable row level security;

-- RLS for cost_lines checks membership via a join to the parent
-- document's company_id -- there's no company_id directly on the line.
create policy "Members can view their company's cost lines"
  on public.cost_lines
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_lines.cost_document_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost lines for their company"
  on public.cost_lines
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_lines.cost_document_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- create_cost_document: the supported path to create a document with
-- its lines atomically. Not security definer -- there's no bootstrap
-- problem: the caller already has RLS-authorized INSERT rights on both
-- tables via company membership, so this function's only job is
-- transactional atomicity plus computing net_amount/total_amount
-- server-side (never trusting client-submitted totals) and rejecting
-- an empty line set, non-positive line amounts, and negative tax before
-- any insert happens (matching Story 2.1's already-reviewed
-- validation, built in from the start this time).
--
-- p_lines is a jsonb array of {description?: text, amount: numeric}.
-- ---------------------------------------------------------------------
create or replace function public.create_cost_document(
  p_company_id uuid,
  p_supplier_id uuid,
  p_project_id uuid,
  p_classification text,
  p_document_date date,
  p_currency text,
  p_tax_amount numeric,
  p_lines jsonb
)
returns public.cost_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_net_amount numeric := 0;
  v_tax_amount numeric := coalesce(p_tax_amount, 0);
  v_line jsonb;
  v_line_amount numeric;
  v_line_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a cost document';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A cost document needs at least one line';
  end if;

  if v_tax_amount < 0 then
    raise exception 'tax_amount must be non-negative';
  end if;

  -- Validate and sum lines up front, before inserting anything.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line -> 'amount') is null or jsonb_typeof(v_line -> 'amount') <> 'number' then
      raise exception 'Each cost line needs a numeric amount';
    end if;

    v_line_amount := (v_line ->> 'amount')::numeric;

    if v_line_amount <= 0 then
      raise exception 'Line amount must be greater than zero';
    end if;

    v_net_amount := v_net_amount + v_line_amount;
    v_line_count := v_line_count + 1;
  end loop;

  if v_line_count = 0 then
    raise exception 'A cost document needs at least one line';
  end if;

  insert into public.cost_documents (
    company_id,
    supplier_id,
    project_id,
    classification,
    document_date,
    currency,
    net_amount,
    tax_amount,
    total_amount,
    created_by,
    updated_by
  )
  values (
    p_company_id,
    p_supplier_id,
    p_project_id,
    p_classification,
    p_document_date,
    p_currency,
    v_net_amount,
    v_tax_amount,
    v_net_amount + v_tax_amount,
    v_user_id,
    v_user_id
  )
  returning * into v_document;

  insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
  select
    v_document.id,
    nullif(line ->> 'description', ''),
    (line ->> 'amount')::numeric,
    v_user_id,
    v_user_id
  from jsonb_array_elements(p_lines) as line;

  return v_document;
end;
$$;

revoke execute on function public.create_cost_document(uuid, uuid, uuid, text, date, text, numeric, jsonb) from public;
grant execute on function public.create_cost_document(uuid, uuid, uuid, text, date, text, numeric, jsonb) to authenticated;
