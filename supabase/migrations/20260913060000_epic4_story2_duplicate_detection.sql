-- Epic 4, Story 4.2: Duplicate Detection on Import
--
-- Extends Story 4.1's import pipeline so a row matching an existing
-- non-voided sales_documents row (manual or previously imported) on
-- company_id + client_id + document_date + total_amount is flagged as
-- a duplicate instead of silently creating a second document. The
-- server-side check inside import_sales_row is the actual
-- enforcement -- the client-side preview flag is only a convenience
-- hint (see spec Design Notes / Boundaries & Constraints).

-- ---------------------------------------------------------------------
-- import_rows.status: add 'duplicate' as its own outcome, distinct
-- from 'error' -- a skipped duplicate isn't a data problem the way an
-- invalid row is (see spec Decisions).
-- ---------------------------------------------------------------------
alter table public.import_rows
  drop constraint import_rows_status_check;

alter table public.import_rows
  add constraint import_rows_status_check
  check (status in ('imported', 'error', 'duplicate'));

-- ---------------------------------------------------------------------
-- import_batches: duplicate_rows count, mirroring imported_rows/error_rows.
-- ---------------------------------------------------------------------
alter table public.import_batches
  add column duplicate_rows int not null default 0;

-- ---------------------------------------------------------------------
-- sales_documents: duplicate_override + duplicate_of_sales_document_id,
-- so a forced duplicate keeps both records linked for traceability
-- (never merged, never deleted -- see spec Boundaries & Constraints).
-- ---------------------------------------------------------------------
alter table public.sales_documents
  add column duplicate_override boolean not null default false,
  add column duplicate_of_sales_document_id uuid references public.sales_documents (id);

-- ---------------------------------------------------------------------
-- import_sales_row: extended with p_force. Looks up a non-voided
-- sales_documents match on company_id + client_id + document_date +
-- total_amount (computed from the same net + tax this function already
-- calculates) *before* inserting. The match key intentionally ignores
-- `source` -- manual and previously-imported documents are checked the
-- same way (see spec Always).
--
-- If a match exists and p_force is false: insert only an import_rows
-- row with status='duplicate' naming the matched document, no
-- sales_documents row created.
-- If a match exists and p_force is true: insert the document as usual,
-- but set duplicate_override=true and duplicate_of_sales_document_id.
-- If no match: behaves exactly as Story 4.1.
--
-- This re-verification happens here regardless of what the client's
-- preview believed, closing the race described in the spec's I/O
-- matrix ("Preview says not a duplicate but a match appears before
-- commit").
-- ---------------------------------------------------------------------
create or replace function public.import_sales_row(
  p_import_batch_id uuid,
  p_row_number int,
  p_raw_data jsonb,
  p_client_id uuid,
  p_document_date date,
  p_currency text,
  p_amount numeric,
  p_tax_amount numeric,
  p_force boolean default false
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
  v_total_amount numeric;
  v_error_message text := null;
  v_duplicate_id uuid;
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

  v_total_amount := p_amount + v_tax_amount;

  -- Server-side duplicate check -- the authoritative one. Matches any
  -- non-voided sales_documents row for this company on
  -- client_id + document_date + total_amount, regardless of source
  -- (manual or import).
  select id into v_duplicate_id
  from public.sales_documents
  where company_id = v_company_id
    and client_id = p_client_id
    and document_date = p_document_date
    and total_amount = v_total_amount
    and voided = false
  order by created_at
  limit 1;

  if v_duplicate_id is not null and not p_force then
    insert into public.import_rows (
      import_batch_id, row_number, raw_data, status, error_message
    )
    values (
      p_import_batch_id,
      p_row_number,
      p_raw_data,
      'duplicate',
      'Possible duplicate of existing sales document ' || v_duplicate_id::text
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
    duplicate_override,
    duplicate_of_sales_document_id,
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
    v_total_amount,
    'import',
    v_duplicate_id is not null,
    v_duplicate_id,
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

revoke execute on function public.import_sales_row(uuid, int, jsonb, uuid, date, text, numeric, numeric, boolean) from public;
grant execute on function public.import_sales_row(uuid, int, jsonb, uuid, date, text, numeric, numeric, boolean) to authenticated;

-- Drop the old 8-arg overload from Story 4.1 -- the app always calls
-- with p_force now, and leaving both would be an ambiguous overload
-- for any caller that omits it entirely (default only resolves once
-- there's a single candidate at that arity elsewhere in this codebase's
-- convention).
drop function if exists public.import_sales_row(uuid, int, jsonb, uuid, date, text, numeric, numeric);

-- ---------------------------------------------------------------------
-- update_import_batch_counts: also compute duplicate_rows.
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
    ),
    duplicate_rows = (
      select count(*) from public.import_rows
      where import_batch_id = p_import_batch_id and status = 'duplicate'
    )
  where id = p_import_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.update_import_batch_counts(uuid) from public;
grant execute on function public.update_import_batch_counts(uuid) to authenticated;
