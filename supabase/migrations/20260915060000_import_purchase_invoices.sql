-- Fase D: import purchase invoices (Chile) from CSV/Excel into
-- cost_documents, with duplicate detection and an explicit "link to an
-- existing manual expense" path so a gasto rápido entered from the
-- field (Fase A/B, `status='provisional'`) gets confirmed by the real
-- invoice instead of duplicated.
--
-- Parallel tables (cost_import_batches/cost_import_rows) rather than
-- reusing import_batches/import_rows -- that pair's `sales_document_id`
-- column is a plain FK to sales_documents specifically, and its RPCs
-- (create_import_batch, import_sales_rows_batch) already hard-code the
-- Chile gate and sales_documents shape. A polymorphic column or an
-- overloaded RPC would be messier than a same-shaped parallel table,
-- matching how cost_documents/cost_lines already mirror
-- sales_documents/sales_lines as their own tables rather than sharing
-- one.
--
-- Every imported invoice lands as `classification='general'` with no
-- project_id -- the CSV has no Trabajo column, so it can't be `direct`
-- at import time. That's exactly the existing "Sin asignar" bucket the
-- costs list already filters on (classification='general' and not
-- allocated), so no new "unassigned" state is needed. From there the
-- user either assigns it whole to one project
-- (assign_cost_document_to_project, previous migration) or splits it
-- (set_cost_allocations, unchanged) -- unless it's linked to an
-- existing manual entry, in which case that entry's own
-- classification/project_id (which may already be `direct`) is left
-- untouched, since linking is about confirming an amount, not
-- re-routing the expense.
--
-- No supplier_aliases table (unlike sales' client_aliases) -- an
-- unmatched supplier name is simply created, same default-create
-- behavior sales uses for an unmatched client, without the persisted
-- alias-learning step. That's a reasonable v1 cut; add it later the
-- same way client_aliases was added if re-imports of the same source
-- keep creating near-duplicate supplier names.

-- ---------------------------------------------------------------------
-- cost_import_batches / cost_import_rows
-- ---------------------------------------------------------------------
create table public.cost_import_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  file_name text not null,
  total_rows int not null,
  imported_rows int not null default 0,
  error_rows int not null default 0,
  duplicate_rows int not null default 0,
  imported_by uuid references auth.users (id) default auth.uid(),
  imported_at timestamptz not null default now()
);

create index cost_import_batches_company_id_idx on public.cost_import_batches (company_id);

alter table public.cost_import_batches enable row level security;

create policy "Members can view their company's cost import batches"
  on public.cost_import_batches
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = cost_import_batches.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost import batches for their company"
  on public.cost_import_batches
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = cost_import_batches.company_id
        and cm.user_id = auth.uid()
    )
  );

create table public.cost_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.cost_import_batches (id),
  row_number int not null,
  raw_data jsonb not null,
  status text not null check (status in ('imported', 'error', 'duplicate')),
  error_message text,
  cost_document_id uuid references public.cost_documents (id),
  created_at timestamptz not null default now()
);

create index cost_import_rows_import_batch_id_idx on public.cost_import_rows (import_batch_id);

alter table public.cost_import_rows enable row level security;

create policy "Members can view their company's cost import rows"
  on public.cost_import_rows
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.cost_import_batches cib
      join public.company_memberships cm on cm.company_id = cib.company_id
      where cib.id = cost_import_rows.import_batch_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost import rows for their company"
  on public.cost_import_rows
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.cost_import_batches cib
      join public.company_memberships cm on cm.company_id = cib.company_id
      where cib.id = cost_import_rows.import_batch_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- cost_documents: source + import_row_id + duplicate tracking, mirroring
-- sales_documents' own columns from Story 4.1/4.2 exactly.
-- ---------------------------------------------------------------------
alter table public.cost_documents
  add column source text not null default 'manual' check (source in ('manual', 'import')),
  add column import_row_id uuid references public.cost_import_rows (id),
  add column duplicate_override boolean not null default false,
  add column duplicate_of_cost_document_id uuid references public.cost_documents (id);

-- ---------------------------------------------------------------------
-- create_cost_import_batch: same shape and Chile gate as
-- create_import_batch.
-- ---------------------------------------------------------------------
create or replace function public.create_cost_import_batch(
  p_company_id uuid,
  p_file_name text,
  p_total_rows int
)
returns public.cost_import_batches
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_country text;
  v_batch public.cost_import_batches;
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

  insert into public.cost_import_batches (company_id, file_name, total_rows, imported_by)
  values (p_company_id, p_file_name, p_total_rows, v_user_id)
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.create_cost_import_batch(uuid, text, int) from public;
grant execute on function public.create_cost_import_batch(uuid, text, int) to authenticated;

-- ---------------------------------------------------------------------
-- import_cost_rows_batch: one PL/pgSQL loop over the whole file (same
-- single-round-trip shape as import_sales_rows_batch), with a third
-- outcome per row beyond create/duplicate: an explicit link to an
-- existing `provisional`, not-yet-linked cost document (p_rows'
-- optional `link_to_cost_document_id`). A link always wins over
-- duplicate detection -- it *is* the user's explicit "this is the same
-- expense" call, so the automatic amount-match heuristic doesn't need
-- to agree with it. Linking never touches the existing document's
-- classification/project_id -- only the parts a real invoice should
-- correct: amounts, date, currency, supplier, and status (confirmed).
-- ---------------------------------------------------------------------
create or replace function public.import_cost_rows_batch(
  p_import_batch_id uuid,
  p_rows jsonb
)
returns setof public.cost_import_rows
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_supplier_company_id uuid;
  v_document public.cost_documents;
  v_import_row public.cost_import_rows;
  v_row jsonb;
  v_row_number int;
  v_raw_data jsonb;
  v_supplier_id uuid;
  v_document_date date;
  v_currency text;
  v_amount numeric;
  v_tax_amount numeric;
  v_force boolean;
  v_link_to_id uuid;
  v_total_amount numeric;
  v_error_message text;
  v_duplicate_id uuid;
  v_link_status text;
  v_link_import_row_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required to import cost rows';
  end if;

  select company_id into v_company_id
  from public.cost_import_batches
  where id = p_import_batch_id;

  if v_company_id is null then
    raise exception 'Import batch not found';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_row_number := (v_row->>'row_number')::int;
      v_raw_data := coalesce(v_row->'raw_data', '{}'::jsonb);
      v_supplier_id := nullif(v_row->>'supplier_id', '')::uuid;
      v_document_date := nullif(v_row->>'document_date', '')::date;
      v_currency := v_row->>'currency';
      v_amount := nullif(v_row->>'amount', '')::numeric;
      v_tax_amount := coalesce(nullif(v_row->>'tax_amount', '')::numeric, 0);
      v_force := coalesce((v_row->>'force')::boolean, false);
      v_link_to_id := nullif(v_row->>'link_to_cost_document_id', '')::uuid;
      v_error_message := null;

      if v_supplier_id is null then
        v_error_message := 'Supplier not found';
      elsif v_document_date is null then
        v_error_message := 'Invalid or missing date';
      elsif v_amount is null or v_amount <= 0 then
        v_error_message := 'Invalid or missing amount';
      elsif v_tax_amount < 0 then
        v_error_message := 'Tax amount must be non-negative';
      elsif v_currency is null or btrim(v_currency) = '' then
        v_error_message := 'Invalid or missing currency';
      else
        select company_id into v_supplier_company_id
        from public.suppliers
        where id = v_supplier_id
          and active = true;

        if v_supplier_company_id is null or v_supplier_company_id <> v_company_id then
          v_error_message := 'Supplier not found';
        end if;
      end if;

      if v_error_message is not null then
        insert into public.cost_import_rows (
          import_batch_id, row_number, raw_data, status, error_message
        )
        values (
          p_import_batch_id, v_row_number, v_raw_data, 'error', v_error_message
        )
        returning * into v_import_row;

        return next v_import_row;
        continue;
      end if;

      v_total_amount := v_amount + v_tax_amount;

      -- Explicit link: re-validate server-side regardless of what the
      -- client's preview believed (same race the sales import closes
      -- for its own duplicate check) -- the target must still exist,
      -- belong to this company, be provisional, and not already linked
      -- to a prior import row.
      -- Plain (non-STRICT) SELECT INTO on a row-type target: when no
      -- row matches, every field of v_document is reset to null
      -- (including any value left over from a prior loop iteration),
      -- so the "not found" check right below is never fooled by stale
      -- data from an earlier row's successful insert.
      if v_link_to_id is not null then
        select cd.*
        into v_document
        from public.cost_documents cd
        where cd.id = v_link_to_id
          and cd.company_id = v_company_id
          and cd.status = 'provisional'
          and cd.import_row_id is null
        limit 1;
      end if;

      if v_link_to_id is not null and v_document.id is null then
        insert into public.cost_import_rows (
          import_batch_id, row_number, raw_data, status, error_message
        )
        values (
          p_import_batch_id,
          v_row_number,
          v_raw_data,
          'error',
          'The selected expense to link was not found, is no longer provisional, or is already linked'
        )
        returning * into v_import_row;

        return next v_import_row;
        continue;
      end if;

      if v_link_to_id is not null then
        update public.cost_documents
        set
          supplier_id = v_supplier_id,
          document_date = v_document_date,
          currency = v_currency,
          net_amount = v_amount,
          tax_amount = v_tax_amount,
          total_amount = v_total_amount,
          status = 'confirmed',
          source = 'import'
        where id = v_link_to_id
        returning * into v_document;

        insert into public.cost_import_rows (
          import_batch_id, row_number, raw_data, status, cost_document_id
        )
        values (
          p_import_batch_id, v_row_number, v_raw_data, 'imported', v_document.id
        )
        returning * into v_import_row;

        update public.cost_documents
        set import_row_id = v_import_row.id
        where id = v_document.id;

        return next v_import_row;
        continue;
      end if;

      -- No explicit link -- fall back to automatic duplicate detection,
      -- same match key as sales' own (company + counterparty + date +
      -- total), skipped instead of double-counted unless forced.
      select id into v_duplicate_id
      from public.cost_documents
      where company_id = v_company_id
        and supplier_id = v_supplier_id
        and document_date = v_document_date
        and total_amount = v_total_amount
      order by created_at
      limit 1;

      if v_duplicate_id is not null and not v_force then
        insert into public.cost_import_rows (
          import_batch_id, row_number, raw_data, status, error_message
        )
        values (
          p_import_batch_id,
          v_row_number,
          v_raw_data,
          'duplicate',
          'Possible duplicate of existing cost document ' || v_duplicate_id::text
        )
        returning * into v_import_row;

        return next v_import_row;
        continue;
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
        source,
        status,
        duplicate_override,
        duplicate_of_cost_document_id,
        created_by,
        updated_by
      )
      values (
        v_company_id,
        v_supplier_id,
        null,
        'general',
        v_document_date,
        v_currency,
        v_amount,
        v_tax_amount,
        v_total_amount,
        'import',
        'confirmed',
        v_duplicate_id is not null,
        v_duplicate_id,
        v_user_id,
        v_user_id
      )
      returning * into v_document;

      insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
      values (v_document.id, null, v_amount, v_user_id, v_user_id);

      insert into public.cost_import_rows (
        import_batch_id, row_number, raw_data, status, cost_document_id
      )
      values (
        p_import_batch_id, v_row_number, v_raw_data, 'imported', v_document.id
      )
      returning * into v_import_row;

      update public.cost_documents
      set import_row_id = v_import_row.id
      where id = v_document.id;

      return next v_import_row;
    exception when others then
      insert into public.cost_import_rows (
        import_batch_id, row_number, raw_data, status, error_message
      )
      values (
        p_import_batch_id,
        coalesce(v_row_number, -1),
        coalesce(v_raw_data, '{}'::jsonb),
        'error',
        'Unexpected error processing this row.'
      )
      returning * into v_import_row;

      return next v_import_row;
    end;
  end loop;

  return;
end;
$$;

revoke execute on function public.import_cost_rows_batch(uuid, jsonb) from public;
grant execute on function public.import_cost_rows_batch(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- update_cost_import_batch_counts: security definer for the same
-- reason as update_import_batch_counts -- cost_import_batches
-- deliberately has no UPDATE policy (it's a historical record), so
-- this is the one narrow exception, re-checking membership itself.
-- ---------------------------------------------------------------------
create or replace function public.update_cost_import_batch_counts(
  p_import_batch_id uuid
)
returns public.cost_import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_is_member boolean;
  v_batch public.cost_import_batches;
begin
  if v_user_id is null then
    raise exception 'Authentication required to update an import batch';
  end if;

  select company_id into v_company_id
  from public.cost_import_batches
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

  update public.cost_import_batches
  set
    imported_rows = (
      select count(*) from public.cost_import_rows
      where import_batch_id = p_import_batch_id and status = 'imported'
    ),
    error_rows = (
      select count(*) from public.cost_import_rows
      where import_batch_id = p_import_batch_id and status = 'error'
    ),
    duplicate_rows = (
      select count(*) from public.cost_import_rows
      where import_batch_id = p_import_batch_id and status = 'duplicate'
    )
  where id = p_import_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.update_cost_import_batch_counts(uuid) from public;
grant execute on function public.update_cost_import_batch_counts(uuid) to authenticated;

grant select, insert, update, delete on
  public.cost_import_batches,
  public.cost_import_rows
to authenticated, service_role;
