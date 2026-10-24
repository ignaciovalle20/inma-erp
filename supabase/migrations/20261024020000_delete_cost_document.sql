-- "Eliminar" on an expense (ficha del trabajo → Últimos gastos, Costos, and
-- the cost document's own page). Until now there was no way to delete a
-- cost document: members had no DELETE policy on cost_documents /
-- cost_lines / cost_document_attachments (nor on the cost-receipts bucket),
-- and every FK to cost_documents is NO ACTION, so even a direct DELETE
-- failed on its lines.
--
-- delete_cost_document() removes the document and everything hanging from
-- it in one transaction: lines, allocations to jobs / clients / areas
-- (cost_allocations), allocations to recurring services' cost periods
-- (cost_service_allocations), attachment rows, and the "duplicate of" mark
-- other documents may carry. It returns the attachments' storage paths: the
-- app removes those files right after (Storage objects can't be deleted from
-- SQL), with the member DELETE policy added below on the bucket.
--
-- Not deleted here:
-- * The cost of a technician's charge (Mano de obra, technician_charges):
--   refused, it is corrected or deleted from the job's Técnicos section
--   (update_technician_charge / delete_technician_charge), which keep the
--   technician's account and payments in step.
-- * project_cost_confirmations: they are per job + month "no cost this
--   month" marks, never tied to a document (and confirm_project_cost_zero
--   refuses them while the month has documents), so nothing to remove.
--
-- An imported document (cost_import_rows): the import row stays as a record,
-- unlinked, with the deleted document's match key (supplier, date, total).
-- import_cost_rows_batch skips a row with that key in the next import -- of
-- the same file or another -- unless "Importar igual" is checked, so a
-- deleted invoice doesn't come back on its own.
--
-- Security definer with its own membership check, like
-- delete_technician_charge / delete_recurring_service (it also writes
-- cost_import_rows, which members never update). The DELETE policies below
-- are the same membership rule for direct deletes; those still can't skip
-- the technician or import rules, since the FKs from technician_charges and
-- cost_import_rows keep refusing them.

-- ---------------------------------------------------------------------
-- cost_import_rows: the mark of a deleted document
-- ---------------------------------------------------------------------
alter table public.cost_import_rows
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id),
  add column deleted_supplier_id uuid,
  add column deleted_document_date date,
  add column deleted_total_amount numeric;

create index cost_import_rows_deleted_match_idx
  on public.cost_import_rows (deleted_supplier_id, deleted_document_date)
  where deleted_at is not null;

-- ---------------------------------------------------------------------
-- DELETE policies: members of the document's company
-- ---------------------------------------------------------------------
create policy "Members can delete their company's cost documents"
  on public.cost_documents
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = cost_documents.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete their company's cost lines"
  on public.cost_lines
  for delete
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

create policy "Members can delete their company's cost document attachments"
  on public.cost_document_attachments
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_document_attachments.cost_document_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete their company's cost receipts"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'cost-receipts'
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = (storage.foldername(name))[1]::uuid
        and cm.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.cost_document_attachments to authenticated, service_role;

-- ---------------------------------------------------------------------
-- delete_cost_document
-- ---------------------------------------------------------------------
create or replace function public.delete_cost_document(p_cost_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_paths text[];
  v_lines int;
  v_allocations int;
  v_service_allocations int;
  v_import_rows int;
begin
  if v_user_id is null then
    raise exception 'Authentication required to delete a cost document';
  end if;

  select * into v_document from public.cost_documents where id = p_cost_document_id for update;
  if v_document.id is null then
    raise exception 'Gasto no encontrado';
  end if;

  if not exists (
    select 1 from public.company_memberships cm
    where cm.company_id = v_document.company_id and cm.user_id = v_user_id
  ) then
    raise exception 'No tenés acceso a este gasto';
  end if;

  if exists (select 1 from public.technician_charges tc where tc.cost_document_id = p_cost_document_id) then
    raise exception 'Este gasto es el cargo de un técnico (Mano de obra): corregilo o eliminalo desde la sección Técnicos del trabajo, para no descuadrar sus pagos.';
  end if;

  select coalesce(array_agg(a.storage_path order by a.created_at), '{}') into v_paths
  from public.cost_document_attachments a
  where a.cost_document_id = p_cost_document_id;

  update public.cost_import_rows r
  set cost_document_id = null,
      deleted_at = now(),
      deleted_by = v_user_id,
      deleted_supplier_id = v_document.supplier_id,
      deleted_document_date = v_document.document_date,
      deleted_total_amount = v_document.total_amount
  where r.cost_document_id = p_cost_document_id or r.id = v_document.import_row_id;
  get diagnostics v_import_rows = row_count;

  update public.cost_documents d
  set duplicate_of_cost_document_id = null
  where d.duplicate_of_cost_document_id = p_cost_document_id;

  delete from public.cost_service_allocations a where a.cost_document_id = p_cost_document_id;
  get diagnostics v_service_allocations = row_count;

  delete from public.cost_allocations a where a.cost_document_id = p_cost_document_id;
  get diagnostics v_allocations = row_count;

  delete from public.cost_lines l where l.cost_document_id = p_cost_document_id;
  get diagnostics v_lines = row_count;

  delete from public.cost_document_attachments a where a.cost_document_id = p_cost_document_id;

  delete from public.cost_documents d where d.id = p_cost_document_id;

  return jsonb_build_object(
    'company_id', v_document.company_id,
    'project_id', v_document.project_id,
    'attachments', to_jsonb(v_paths),
    'lines', v_lines,
    'allocations', v_allocations,
    'service_allocations', v_service_allocations,
    'import_rows', v_import_rows
  );
end;
$$;

revoke execute on function public.delete_cost_document(uuid) from public, anon;
grant execute on function public.delete_cost_document(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- import_cost_rows_batch: same as 20260915060000, plus the deleted-document
-- skip right before the automatic duplicate detection.
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
  v_deleted_at timestamptz;
  v_time_zone text;
begin
  if v_user_id is null then
    raise exception 'Authentication required to import cost rows';
  end if;

  select b.company_id,
         case when upper(c.country) = 'UY' then 'America/Montevideo' else 'America/Santiago' end
  into v_company_id, v_time_zone
  from public.cost_import_batches b
  join public.companies c on c.id = b.company_id
  where b.id = p_import_batch_id;

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

      -- An invoice whose imported document was deleted on purpose
      -- (delete_cost_document) is not created again unless forced.
      if not v_force then
        select r.deleted_at into v_deleted_at
        from public.cost_import_rows r
        join public.cost_import_batches b on b.id = r.import_batch_id
        where b.company_id = v_company_id
          and r.deleted_at is not null
          and r.deleted_supplier_id = v_supplier_id
          and r.deleted_document_date = v_document_date
          and r.deleted_total_amount = v_total_amount
        order by r.deleted_at desc
        limit 1;

        if v_deleted_at is not null then
          insert into public.cost_import_rows (
            import_batch_id, row_number, raw_data, status, error_message
          )
          values (
            p_import_batch_id,
            v_row_number,
            v_raw_data,
            'duplicate',
            'Este gasto se eliminó el ' || to_char(v_deleted_at at time zone v_time_zone, 'DD/MM/YYYY')
              || ': no se vuelve a crear. Marcá "Importar igual" para crearlo de nuevo.'
          )
          returning * into v_import_row;

          return next v_import_row;
          continue;
        end if;
      end if;

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

revoke execute on function public.import_cost_rows_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_cost_rows_batch(uuid, jsonb) to authenticated;
