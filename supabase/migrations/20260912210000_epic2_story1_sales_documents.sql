-- Epic 2, Story 2.1: Manual Sales Document Entry
-- Adds `sales_documents` (header) and `sales_lines` (detail), company-
-- scoped like the rest of the schema. Kept structurally separate from
-- any future cost/payment table (per epic constraint -- see
-- epic-2-context.md). No UPDATE/DELETE policies yet: nothing to edit
-- or void until Story 2.2.
--
-- net_amount/total_amount are never trusted from client input -- they
-- are always computed server-side by create_sales_document() from the
-- submitted lines + tax_amount. The columns still exist on the table
-- (with safe defaults) because RLS-authorized direct inserts are
-- technically possible for any member; the real guarantee that they
-- match the lines lives in the RPC being the documented/only supported
-- write path for creates, matching create_company()'s precedent of a
-- plain (non security-definer) atomicity-only RPC.
--
-- client_id cross-company validation reuses Story 1.6's reviewed
-- pattern: a BEFORE INSERT DB trigger, not just an app-layer check --
-- that story's own review found the app-only version bypassable via a
-- raw authenticated PostgREST call.

-- ---------------------------------------------------------------------
-- sales_documents
-- ---------------------------------------------------------------------
create table public.sales_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  client_id uuid not null references public.clients (id),
  document_type text not null check (
    document_type in ('invoice', 'receipt', 'credit_note', 'manual')
  ),
  document_date date not null,
  currency text not null,
  net_amount numeric not null default 0,
  tax_amount numeric not null default 0,
  total_amount numeric not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index sales_documents_company_id_idx on public.sales_documents (company_id);
create index sales_documents_client_id_idx on public.sales_documents (client_id);

-- Reuses the shared set_updated_at() trigger function (Story 1.1/1.2).
create trigger sales_documents_set_updated_at
  before update on public.sales_documents
  for each row
  execute function public.set_updated_at();

alter table public.sales_documents enable row level security;

create policy "Members can view their company's sales documents"
  on public.sales_documents
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_documents.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create sales documents for their company"
  on public.sales_documents
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_documents.company_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- DB-level cross-company validation for client_id (Story 1.6 pattern).
-- A plain FK can't cross-check company_id equality, and RLS only
-- verifies membership in the submitted company_id, not that the
-- referenced client belongs to it -- so this must be a trigger, not
-- just the Server Action check.
-- ---------------------------------------------------------------------
create or replace function public.sales_documents_validate_company_refs()
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
    raise exception 'client_id must belong to the same company as the sales document';
  end if;

  return new;
end;
$$;

create trigger sales_documents_validate_company_refs
  before insert or update on public.sales_documents
  for each row
  execute function public.sales_documents_validate_company_refs();

-- ---------------------------------------------------------------------
-- sales_lines
-- ---------------------------------------------------------------------
create table public.sales_lines (
  id uuid primary key default gen_random_uuid(),
  sales_document_id uuid not null references public.sales_documents (id),
  description text,
  amount numeric not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create index sales_lines_sales_document_id_idx on public.sales_lines (sales_document_id);

create trigger sales_lines_set_updated_at
  before update on public.sales_lines
  for each row
  execute function public.set_updated_at();

alter table public.sales_lines enable row level security;

-- RLS for sales_lines checks membership via a join to the parent
-- document's company_id -- there's no company_id directly on the line.
create policy "Members can view their company's sales lines"
  on public.sales_lines
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.sales_documents sd
      join public.company_memberships cm on cm.company_id = sd.company_id
      where sd.id = sales_lines.sales_document_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create sales lines for their company"
  on public.sales_lines
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.sales_documents sd
      join public.company_memberships cm on cm.company_id = sd.company_id
      where sd.id = sales_lines.sales_document_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- create_sales_document: the supported path to create a document with
-- its lines atomically. Not security definer -- unlike create_company,
-- there's no bootstrap problem: the caller already has RLS-authorized
-- INSERT rights on both tables via company membership, so this
-- function's only job is transactional atomicity plus computing
-- net_amount/total_amount server-side (never trusting client-submitted
-- totals) and rejecting an empty line set before any insert happens.
--
-- p_lines is a jsonb array of {description?: text, amount: numeric}.
-- ---------------------------------------------------------------------
create or replace function public.create_sales_document(
  p_company_id uuid,
  p_client_id uuid,
  p_document_type text,
  p_document_date date,
  p_currency text,
  p_tax_amount numeric,
  p_lines jsonb
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
  v_net_amount numeric := 0;
  v_tax_amount numeric := coalesce(p_tax_amount, 0);
  v_line jsonb;
  v_line_amount numeric;
  v_line_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a sales document';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A sales document needs at least one line';
  end if;

  -- Validate and sum lines up front, before inserting anything.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line -> 'amount') is null or jsonb_typeof(v_line -> 'amount') <> 'number' then
      raise exception 'Each sales line needs a numeric amount';
    end if;

    v_line_amount := (v_line ->> 'amount')::numeric;
    v_net_amount := v_net_amount + v_line_amount;
    v_line_count := v_line_count + 1;
  end loop;

  if v_line_count = 0 then
    raise exception 'A sales document needs at least one line';
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
    created_by,
    updated_by
  )
  values (
    p_company_id,
    p_client_id,
    p_document_type,
    p_document_date,
    p_currency,
    v_net_amount,
    v_tax_amount,
    v_net_amount + v_tax_amount,
    v_user_id,
    v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (sales_document_id, description, amount, created_by, updated_by)
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

revoke execute on function public.create_sales_document(uuid, uuid, text, date, text, numeric, jsonb) from public;
grant execute on function public.create_sales_document(uuid, uuid, text, date, text, numeric, jsonb) to authenticated;
