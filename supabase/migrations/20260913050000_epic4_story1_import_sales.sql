-- Epic 4, Story 4.1: Import Sales with Column Mapping & Preview
--
-- Adds `import_batches`/`import_rows` for traceability of file-based
-- sales imports (Chile only), plus `source`/`import_row_id` on
-- `sales_documents` to distinguish and link imported rows back to
-- their source. One CSV row = one single-line sales document -- see
-- spec Intent/Decisions.
--
-- import_sales_row() deliberately never raises for row-level
-- validation failures (invalid amount/tax, unmatched client, etc) --
-- only for structural problems like an unknown batch id. This lets the
-- calling loop record either a document+success or an error row for
-- every attempted row without per-row exception handling, matching the
-- epic's row-level partial-commit requirement.

-- ---------------------------------------------------------------------
-- import_batches
-- ---------------------------------------------------------------------
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  file_name text not null,
  total_rows int not null,
  imported_rows int not null default 0,
  error_rows int not null default 0,
  imported_by uuid references auth.users (id) default auth.uid(),
  imported_at timestamptz not null default now()
);

create index import_batches_company_id_idx on public.import_batches (company_id);

alter table public.import_batches enable row level security;

create policy "Members can view their company's import batches"
  on public.import_batches
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = import_batches.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create import batches for their company"
  on public.import_batches
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = import_batches.company_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- import_rows
-- ---------------------------------------------------------------------
create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches (id),
  row_number int not null,
  raw_data jsonb not null,
  status text not null check (status in ('imported', 'error')),
  error_message text,
  sales_document_id uuid references public.sales_documents (id),
  created_at timestamptz not null default now()
);

create index import_rows_import_batch_id_idx on public.import_rows (import_batch_id);

alter table public.import_rows enable row level security;

-- RLS for import_rows checks membership via a join to the parent
-- batch's company_id -- there's no company_id directly on the row,
-- same pattern as sales_lines -> sales_documents.
create policy "Members can view their company's import rows"
  on public.import_rows
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.import_batches ib
      join public.company_memberships cm on cm.company_id = ib.company_id
      where ib.id = import_rows.import_batch_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create import rows for their company"
  on public.import_rows
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.import_batches ib
      join public.company_memberships cm on cm.company_id = ib.company_id
      where ib.id = import_rows.import_batch_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- sales_documents: source + import_row_id
-- ---------------------------------------------------------------------
alter table public.sales_documents
  add column source text not null default 'manual' check (source in ('manual', 'import')),
  add column import_row_id uuid references public.import_rows (id);

-- ---------------------------------------------------------------------
-- create_import_batch: a plain (non security-definer) atomicity-only
-- RPC, matching create_sales_document's precedent -- the caller already
-- has RLS-authorized INSERT rights via company membership.
--
-- Also re-checks the Chile-only gate here (case-insensitive `country`,
-- not `currency` -- see spec Decisions), even though the app layer
-- already redirects away from the import page for non-Chile companies
-- -- this is the backstop against a direct/raw RPC call, per spec
-- acceptance ("a direct RPC call is rejected by the gate").
-- ---------------------------------------------------------------------
create or replace function public.create_import_batch(
  p_company_id uuid,
  p_file_name text,
  p_total_rows int
)
returns public.import_batches
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_country text;
  v_batch public.import_batches;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create an import batch';
  end if;

  select country into v_country
  from public.companies
  where id = p_company_id;

  if v_country is null or upper(v_country) <> 'CL' then
    raise exception 'Import is only available for Chile-based companies';
  end if;

  insert into public.import_batches (company_id, file_name, total_rows, imported_by)
  values (p_company_id, p_file_name, p_total_rows, v_user_id)
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.create_import_batch(uuid, text, int) from public;
grant execute on function public.create_import_batch(uuid, text, int) to authenticated;

-- ---------------------------------------------------------------------
-- import_sales_row: validates the already-mapped row values (client
-- already resolved to an id by the caller, since matching depends on
-- the company's client list) and either creates a single-line
-- sales_documents/sales_lines pair with source='import', or records an
-- import_rows error row -- never both, never neither, and never raises
-- for a row-level validation problem (only for an unknown batch id).
--
-- net_amount/total_amount are computed server-side here exactly like
-- create_sales_document, never trusted from the file.
-- ---------------------------------------------------------------------
create or replace function public.import_sales_row(
  p_import_batch_id uuid,
  p_row_number int,
  p_raw_data jsonb,
  p_client_id uuid,
  p_document_date date,
  p_currency text,
  p_amount numeric,
  p_tax_amount numeric
)
returns public.import_rows
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_client_company_id uuid;
  v_document public.sales_documents;
  v_import_row public.import_rows;
  v_tax_amount numeric := coalesce(p_tax_amount, 0);
  v_error_message text := null;
begin
  if v_user_id is null then
    raise exception 'Authentication required to import a sales row';
  end if;

  select company_id into v_company_id
  from public.import_batches
  where id = p_import_batch_id;

  if v_company_id is null then
    raise exception 'Import batch not found';
  end if;

  -- Row-level validation -- every failure here records an error row
  -- instead of raising, so the caller's per-row loop never needs
  -- exception handling.
  if p_client_id is null then
    v_error_message := 'Client not found';
  elsif p_document_date is null then
    v_error_message := 'Invalid or missing date';
  elsif p_amount is null or p_amount <= 0 then
    v_error_message := 'Invalid or missing amount';
  elsif v_tax_amount < 0 then
    v_error_message := 'Tax amount must be non-negative';
  elsif p_currency is null or btrim(p_currency) = '' then
    v_error_message := 'Invalid or missing currency';
  else
    -- Client must belong to the same company as the batch -- same
    -- company-scoped trust model as sales_documents_validate_company_refs,
    -- checked here (not just relying on the trigger) so a mismatched
    -- client resolves to a friendly row error instead of a raised
    -- exception aborting the whole row.
    select company_id into v_client_company_id
    from public.clients
    where id = p_client_id
      and active = true;

    if v_client_company_id is null or v_client_company_id <> v_company_id then
      v_error_message := 'Client not found';
    end if;
  end if;

  if v_error_message is not null then
    insert into public.import_rows (
      import_batch_id, row_number, raw_data, status, error_message
    )
    values (
      p_import_batch_id, p_row_number, p_raw_data, 'error', v_error_message
    )
    returning * into v_import_row;

    return v_import_row;
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
    created_by,
    updated_by
  )
  values (
    v_company_id,
    p_client_id,
    'manual',
    p_document_date,
    p_currency,
    p_amount,
    v_tax_amount,
    p_amount + v_tax_amount,
    'import',
    v_user_id,
    v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (sales_document_id, description, amount, created_by, updated_by)
  values (v_document.id, null, p_amount, v_user_id, v_user_id);

  insert into public.import_rows (
    import_batch_id, row_number, raw_data, status, sales_document_id
  )
  values (
    p_import_batch_id, p_row_number, p_raw_data, 'imported', v_document.id
  )
  returning * into v_import_row;

  -- Link the document back to its import row (import_row_id references
  -- import_rows, so this must happen after the row is inserted).
  update public.sales_documents
  set import_row_id = v_import_row.id
  where id = v_document.id;

  return v_import_row;
end;
$$;

revoke execute on function public.import_sales_row(uuid, int, jsonb, uuid, date, text, numeric, numeric) from public;
grant execute on function public.import_sales_row(uuid, int, jsonb, uuid, date, text, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- update_import_batch_counts: recomputes imported_rows/error_rows on a
-- batch from its import_rows, called once by the commit action after
-- the per-row loop finishes.
--
-- security definer because import_batches deliberately has no UPDATE
-- policy (a batch is a historical record -- see spec Tasks). This is
-- the one narrow, purpose-built exception: it bypasses RLS only to
-- write the two aggregate count columns, and re-implements the
-- membership check itself (the same company-scoped rule the missing
-- UPDATE policy would have enforced) so a non-member can't touch
-- another company's batch -- mirrors create_company's precedent for a
-- write RLS can't authorize.
-- ---------------------------------------------------------------------
create or replace function public.update_import_batch_counts(
  p_import_batch_id uuid
)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_is_member boolean;
  v_batch public.import_batches;
begin
  if v_user_id is null then
    raise exception 'Authentication required to update an import batch';
  end if;

  select company_id into v_company_id
  from public.import_batches
  where id = p_import_batch_id;

  if v_company_id is null then
    raise exception 'Import batch not found';
  end if;

  select exists (
    select 1
    from public.company_memberships cm
    where cm.company_id = v_company_id
      and cm.user_id = v_user_id
  ) into v_is_member;

  if not v_is_member then
    raise exception 'Import batch not found';
  end if;

  update public.import_batches
  set
    imported_rows = (
      select count(*) from public.import_rows
      where import_batch_id = p_import_batch_id and status = 'imported'
    ),
    error_rows = (
      select count(*) from public.import_rows
      where import_batch_id = p_import_batch_id and status = 'error'
    )
  where id = p_import_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.update_import_batch_counts(uuid) from public;
grant execute on function public.update_import_batch_counts(uuid) to authenticated;
