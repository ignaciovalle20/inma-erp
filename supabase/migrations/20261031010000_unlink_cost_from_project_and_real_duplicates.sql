-- "Quitar del trabajo" and duplicates that only count documents that exist.
--
-- Until now the only way to take an expense off a job was "Eliminar", which
-- ran delete_cost_document: the document, its lines and its receipts were gone
-- for good, for every job it was split on. And delete_cost_document leaves the
-- import row marked (deleted_at, deleted_supplier_id, ...), which
-- import_cost_rows_batch treated as "already imported": importing the invoice
-- again answered "duplicado" although no such document existed.
--
-- Now:
--   * unassign_cost_document_from_project removes only the relation with that
--     job. A direct cost goes back to a general cost without assignment; a
--     split one loses that job's row and keeps the others (what is left to
--     assign is said on its page). The document, its lines, attachments and
--     import row are not touched.
--   * import_cost_rows_batch looks for duplicates only in cost_documents. The
--     marks on the import row stay as history of what was deleted; nothing
--     reads them to decide anything.
--
-- delete_cost_document is unchanged: it already removes every child row of the
-- document (lines, allocations, service allocations, attachments, links to
-- charges, suggestions by cascade) in one transaction.

-- ---------------------------------------------------------------------
-- unassign_cost_document_from_project
-- ---------------------------------------------------------------------
-- Invoker, like assign_cost_document_to_project: RLS decides what the caller
-- can see and change, and the guard triggers still apply (a document backing a
-- technician's charges keeps refusing any change of assignment).
create or replace function public.unassign_cost_document_from_project(
  p_cost_document_id uuid,
  p_project_id uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_removed int := 0;
  v_remaining int;
begin
  if v_user_id is null then
    raise exception 'Authentication required to unassign a cost document';
  end if;
  if p_project_id is null then
    raise exception 'A project is required';
  end if;

  select * into v_document from public.cost_documents where id = p_cost_document_id for update;
  if v_document.id is null then
    raise exception 'Gasto no encontrado';
  end if;

  if exists (select 1 from public.technician_charges tc where tc.cost_document_id = p_cost_document_id) then
    raise exception 'Este gasto es el cargo de un técnico (Mano de obra): corregilo o eliminalo desde la sección Técnicos del trabajo, para no descuadrar sus pagos.';
  end if;

  if v_document.classification = 'direct' and v_document.project_id = p_project_id then
    update public.cost_documents
    set classification = 'general', project_id = null, updated_by = v_user_id
    where id = p_cost_document_id;
    v_removed := 1;
  else
    delete from public.cost_allocations a
    where a.cost_document_id = p_cost_document_id and a.project_id = p_project_id;
    get diagnostics v_removed = row_count;
  end if;

  if v_removed = 0 then
    raise exception 'Este gasto no está asignado a este trabajo';
  end if;

  select count(*) into v_remaining from public.cost_allocations a where a.cost_document_id = p_cost_document_id;

  return jsonb_build_object(
    'cost_document_id', p_cost_document_id,
    'project_id', p_project_id,
    'was_direct', v_document.classification = 'direct',
    'remaining_allocations', v_remaining
  );
end;
$$;

comment on function public.unassign_cost_document_from_project(uuid, uuid) is
  'Takes an expense off a job without deleting it: a direct cost becomes general and unassigned, a split one loses that job''s allocation.';

revoke execute on function public.unassign_cost_document_from_project(uuid, uuid) from public, anon;
grant execute on function public.unassign_cost_document_from_project(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- import_cost_rows_batch: same as 20261030020000, without the check against
-- deleted documents. A document that no longer exists is not a duplicate.
-- ---------------------------------------------------------------------
create or replace function public.import_cost_rows_batch(p_import_batch_id uuid, p_rows jsonb)
returns setof public.cost_import_rows
language plpgsql
as $function$
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
  v_exempt_amount numeric;
  v_tax_amount numeric;
  v_other_taxes numeric;
  v_document_type text;
  v_source_document_type text;
  v_document_number text;
  v_sign int;
  v_force boolean;
  v_link_to_id uuid;
  v_total_amount numeric;
  v_error_message text;
  v_duplicate_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required to import cost rows';
  end if;

  select b.company_id into v_company_id
  from public.cost_import_batches b
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
      v_exempt_amount := coalesce(nullif(v_row->>'exempt_amount', '')::numeric, 0);
      v_tax_amount := coalesce(nullif(v_row->>'tax_amount', '')::numeric, 0);
      v_other_taxes := coalesce(nullif(v_row->>'other_taxes', '')::numeric, 0);
      v_document_type := coalesce(nullif(v_row->>'document_type', ''), 'invoice');
      v_source_document_type := nullif(upper(btrim(v_row->>'source_document_type')), '');
      v_document_number := nullif(btrim(v_row->>'document_number'), '');
      v_force := coalesce((v_row->>'force')::boolean, false);
      v_link_to_id := nullif(v_row->>'link_to_cost_document_id', '')::uuid;
      v_error_message := null;
      v_document := null;
      v_duplicate_id := null;

      if v_supplier_id is null then
        v_error_message := 'Supplier not found';
      elsif v_document_date is null then
        v_error_message := 'Invalid or missing date';
      elsif v_document_type not in ('invoice', 'credit_note') then
        v_error_message := 'Tipo de documento inválido: ' || v_document_type;
      elsif v_amount is null or v_amount <= 0 then
        v_error_message := 'Neto + Exento en 0 o vacío';
      elsif v_exempt_amount < 0 or v_exempt_amount > v_amount then
        v_error_message := 'Exento inválido (' || v_exempt_amount::text || '): debe estar entre 0 y el neto';
      elsif v_tax_amount < 0 then
        v_error_message := 'Tax amount must be non-negative';
      elsif v_other_taxes < 0 then
        v_error_message := 'Otros impuestos no puede ser negativo';
      elsif v_currency is null or btrim(v_currency) = '' then
        v_error_message := 'Invalid or missing currency';
      elsif v_document_type = 'credit_note' and v_link_to_id is not null then
        v_error_message := 'Una nota de crédito no se vincula a un gasto ya cargado';
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

      -- A credit note subtracts: every amount is stored negative.
      v_sign := case when v_document_type = 'credit_note' then -1 else 1 end;
      v_amount := v_sign * v_amount;
      v_exempt_amount := v_sign * v_exempt_amount;
      v_tax_amount := v_sign * v_tax_amount;
      v_other_taxes := v_sign * v_other_taxes;
      v_total_amount := v_amount + v_tax_amount + v_other_taxes;

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
          exempt_amount = v_exempt_amount,
          tax_amount = v_tax_amount,
          other_taxes = v_other_taxes,
          total_amount = v_total_amount,
          document_type = v_document_type,
          source_document_type = v_source_document_type,
          document_number = v_document_number,
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

      -- Same document: with a number, same supplier + type code + number
      -- (a stored document without a number is compared by date + total);
      -- without a number, same supplier + date + total. Only documents that
      -- exist count: the marks a deleted document leaves on its import row do not.
      select id into v_duplicate_id
      from public.cost_documents
      where company_id = v_company_id
        and supplier_id = v_supplier_id
        and (
          (v_document_number is not null and document_number is not null
            and document_number = v_document_number
            and coalesce(source_document_type, '') = coalesce(v_source_document_type, ''))
          or ((v_document_number is null or document_number is null)
            and document_date = v_document_date
            and total_amount = v_total_amount)
        )
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
        exempt_amount,
        tax_amount,
        other_taxes,
        total_amount,
        document_type,
        source_document_type,
        document_number,
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
        v_exempt_amount,
        v_tax_amount,
        v_other_taxes,
        v_total_amount,
        v_document_type,
        v_source_document_type,
        v_document_number,
        'import',
        'confirmed',
        v_duplicate_id is not null,
        v_duplicate_id,
        v_user_id,
        v_user_id
      )
      on conflict (company_id, supplier_id, (coalesce(source_document_type, '')), document_number)
        where document_number is not null and source = 'import' and not duplicate_override
      do nothing
      returning * into v_document;

      -- Another import created this document after the check above.
      if v_document.id is null then
        select id into v_duplicate_id
        from public.cost_documents
        where company_id = v_company_id
          and supplier_id = v_supplier_id
          and coalesce(source_document_type, '') = coalesce(v_source_document_type, '')
          and document_number = v_document_number
          and source = 'import'
          and not duplicate_override;

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
$function$;
