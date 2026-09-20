-- Nubox import: reconcile with sales that were loaded before Nubox.
--
-- The first Nubox file meets a ledger that already holds the same sales
-- (loaded with the generic CSV importer or by hand, as 'manual' / 'invoice'
-- with no folio). Matching only by folio would create each of them a second
-- time and double the sales. This migration teaches
-- import_nubox_documents_batch to take an existing folio-less sale over:
-- the app sends adopt_document_id for a document whose client, date and net
-- match a stored sale, and the function -- after checking it again -- gives
-- that sale the folio, due date, taxes and cobro instead of inserting a row.
-- The outcome is reported as 'updated' with an explanatory message.
--
-- Each element of p_rows is as in the previous version plus the optional
-- adopt_document_id.
--
-- Only the function changes (same signature, so create or replace is
-- enough); no table or data is touched. Apply it after
-- 20260920010000_sales_nubox_import_payment_status.sql.

create or replace function public.import_nubox_documents_batch(
  p_import_batch_id uuid,
  p_rows jsonb
)
returns setof public.import_rows
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_client_company_id uuid;
  v_project public.projects;
  v_existing public.sales_documents;
  v_legacy public.sales_documents;
  v_adopt_id uuid;
  v_document public.sales_documents;
  v_import_row public.import_rows;
  v_row jsonb;
  v_row_number int;
  v_raw_data jsonb;
  v_type text;
  v_number text;
  v_client_id uuid;
  v_date date;
  v_due date;
  v_currency text;
  v_net numeric;
  v_tax numeric;
  v_other numeric;
  v_total numeric;
  v_pstatus text;
  v_send text;
  v_project_id uuid;
  v_pair_number text;
  v_invoice_id uuid;
  v_credit_note_id uuid;
  v_error text;
  v_status text;
  v_message text;
  v_document_id uuid;
  v_outcome jsonb;
  -- One entry per input row, in order: {row_number, raw, status, message,
  -- document_id}. import_rows is written only at the very end, once the
  -- pairing pass has had its say, because the table has no UPDATE policy
  -- (a message could not be amended after the fact).
  v_outcomes jsonb := '[]'::jsonb;
  v_pair_errors jsonb := '{}'::jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required to import Nubox documents';
  end if;

  select company_id into v_company_id
  from public.import_batches
  where id = p_import_batch_id;

  if v_company_id is null then
    raise exception 'Import batch not found';
  end if;

  -- Pass 1: create / update / unchanged / review, one savepoint per row.
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_row_number := null;
    v_raw_data := null;
    v_status := null;
    v_message := null;
    v_document_id := null;

    begin
      v_row_number := (v_row->>'row_number')::int;
      v_raw_data := coalesce(v_row->'raw_data', '{}'::jsonb);
      v_type := v_row->>'document_type';
      v_number := nullif(btrim(coalesce(v_row->>'document_number', '')), '');
      v_client_id := nullif(v_row->>'client_id', '')::uuid;
      v_date := nullif(v_row->>'document_date', '')::date;
      v_due := nullif(v_row->>'due_date', '')::date;
      v_currency := v_row->>'currency';
      v_net := nullif(v_row->>'net_amount', '')::numeric;
      v_tax := coalesce(nullif(v_row->>'tax_amount', '')::numeric, 0);
      v_other := coalesce(nullif(v_row->>'other_taxes', '')::numeric, 0);
      v_total := nullif(v_row->>'total_amount', '')::numeric;
      v_pstatus := v_row->>'payment_status';
      v_send := nullif(v_row->>'nubox_send_number', '');
      v_project_id := nullif(v_row->>'project_id', '')::uuid;
      v_adopt_id := nullif(v_row->>'adopt_document_id', '')::uuid;
      v_error := null;

      if v_type is null or v_type not in ('invoice', 'credit_note') then
        v_error := 'Tipo de documento no soportado';
      elsif v_number is null then
        v_error := 'Falta el folio';
      elsif v_client_id is null then
        v_error := 'Cliente no encontrado';
      elsif v_date is null then
        v_error := 'Fecha inválida o faltante';
      elsif v_net is null or v_net <= 0 then
        v_error := 'Monto neto inválido o cero';
      elsif v_tax < 0 or v_other < 0 then
        v_error := 'IVA e impuestos no pueden ser negativos';
      elsif v_total is null or v_total <> v_net + v_tax + v_other then
        v_error := 'El total no cuadra con neto + IVA + impuestos';
      elsif v_currency is null or v_currency not in ('CLP', 'UYU', 'USD') then
        v_error := 'Moneda inválida';
      elsif v_pstatus is null
            or v_pstatus not in ('pagado', 'por_vencer', 'vencido', 'no_aplica') then
        v_error := 'Estado de cobro inválido';
      else
        select company_id into v_client_company_id
        from public.clients
        where id = v_client_id;

        if v_client_company_id is null or v_client_company_id <> v_company_id then
          v_error := 'Cliente no encontrado';
        end if;
      end if;

      if v_error is not null then
        v_status := 'error';
        v_message := v_error;
      else
        select * into v_existing
        from public.sales_documents
        where company_id = v_company_id
          and document_type = v_type
          and document_number = v_number;

        if v_existing.id is null and v_adopt_id is not null then
          -- The sale was loaded before Nubox (CSV importer / manual entry)
          -- and has no folio: it takes the type, folio, due date and cobro of
          -- the Nubox document instead of being created a second time. That
          -- includes a credit note that was loaded as a positive sale: it
          -- becomes the credit note, so pairing it annuls the invoice. The match is
          -- re-checked here, not trusted from the preview.
          select * into v_legacy
          from public.sales_documents
          where id = v_adopt_id and company_id = v_company_id
          for update;

          if v_legacy.id is null
             or v_legacy.voided
             or v_legacy.document_number is not null
             or v_legacy.document_type not in ('invoice', 'manual', 'receipt')
             or v_legacy.client_id <> v_client_id
             or v_legacy.document_date <> v_date
             or v_legacy.net_amount <> v_net then
            v_status := 'review';
            v_message := 'La venta ya cargada cambió desde la vista previa; no se vinculó ni se creó nada';
          else
            update public.sales_documents
            set document_type = v_type,
                document_number = v_number,
                due_date = v_due,
                tax_amount = v_tax,
                other_taxes = v_other,
                total_amount = v_total,
                payment_status = v_pstatus,
                payment_status_updated_at = now(),
                nubox_send_number = v_send,
                updated_by = v_user_id
            where id = v_legacy.id;

            v_status := 'updated';
            v_message := 'Vinculada a una venta ya cargada: se le asignó el folio ' || v_number;
            v_document_id := v_legacy.id;
          end if;

        elsif v_existing.id is null then
          -- New document.
          v_project := null;
          if v_project_id is not null and v_type = 'invoice' then
            select * into v_project from public.projects where id = v_project_id;

            if v_project.id is null or v_project.company_id <> v_company_id then
              raise exception 'El trabajo elegido no pertenece a esta empresa';
            end if;

            if v_project.client_id <> v_client_id then
              raise exception 'El trabajo elegido pertenece a otro cliente';
            end if;
          end if;

          insert into public.sales_documents (
            company_id, client_id, project_id, business_area_id,
            document_type, document_number, document_date, due_date, currency,
            net_amount, tax_amount, other_taxes, total_amount,
            payment_status, payment_status_updated_at, nubox_send_number,
            source, created_by, updated_by
          )
          values (
            v_company_id, v_client_id, v_project.id, v_project.business_area_id,
            v_type, v_number, v_date, v_due, v_currency,
            v_net, v_tax, v_other, v_total,
            v_pstatus, now(), v_send,
            'import', v_user_id, v_user_id
          )
          returning * into v_document;

          insert into public.sales_lines (
            sales_document_id, description, amount, created_by, updated_by
          )
          values (v_document.id, 'Folio ' || v_number, v_net, v_user_id, v_user_id);

          v_status := 'imported';
          v_document_id := v_document.id;

        elsif v_existing.client_id <> v_client_id
              or v_existing.net_amount <> v_net
              or v_existing.total_amount <> v_total then
          v_status := 'review';
          v_message := 'Ya existe con cliente o montos distintos; no se modificó';
          v_document_id := v_existing.id;

        elsif v_existing.payment_status is distinct from v_pstatus
              or v_existing.due_date is distinct from v_due then
          update public.sales_documents
          set payment_status = v_pstatus,
              due_date = v_due,
              payment_status_updated_at = now(),
              updated_by = v_user_id
          where id = v_existing.id;

          v_status := 'updated';
          v_message := 'Cobro: ' || coalesce(v_existing.payment_status, 'sin dato') || ' → ' || v_pstatus;
          v_document_id := v_existing.id;

        else
          v_status := 'unchanged';
          v_document_id := v_existing.id;
        end if;
      end if;
    exception when others then
      -- Only this row's own writes roll back (implicit savepoint). The
      -- real message is kept: the screen shows it.
      v_status := 'error';
      v_message := 'Error al procesar la fila: ' || sqlerrm;
      v_document_id := null;
    end;

    v_outcomes := v_outcomes || jsonb_build_array(
      jsonb_build_object(
        'row_number', coalesce(v_row_number, -1),
        'raw', coalesce(v_raw_data, '{}'::jsonb),
        'status', v_status,
        'message', v_message,
        'document_id', v_document_id
      )
    );
  end loop;

  -- Pass 2: credit-note pairings. Done after every create/update so the
  -- invoice to annul is found whether it was already stored or came in
  -- this same file. A pairing that is no longer valid is reported on the
  -- credit note's own row instead of failing the whole batch.
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_pair_number := nullif(btrim(coalesce(v_row->>'pair_with_document_number', '')), '');

    if v_pair_number is null or coalesce(v_row->>'document_type', '') <> 'credit_note' then
      continue;
    end if;

    begin
      select id into v_credit_note_id
      from public.sales_documents
      where company_id = v_company_id
        and document_type = 'credit_note'
        and document_number = nullif(btrim(coalesce(v_row->>'document_number', '')), '');

      select id into v_invoice_id
      from public.sales_documents
      where company_id = v_company_id
        and document_type = 'invoice'
        and document_number = v_pair_number;

      if v_credit_note_id is null or v_invoice_id is null then
        raise exception 'No se encontró la factura % para emparejar', v_pair_number;
      end if;

      -- Already paired with this very invoice (re-import): nothing to do.
      if not exists (
        select 1 from public.sales_documents
        where id = v_credit_note_id and annuls_document_id = v_invoice_id
      ) then
        perform public.pair_credit_note(v_credit_note_id, v_invoice_id);
      end if;
    exception when others then
      v_pair_errors := v_pair_errors || jsonb_build_object(
        coalesce(v_row->>'row_number', '-1'),
        'No se pudo emparejar con la factura ' || v_pair_number || ': ' || sqlerrm
      );
    end;
  end loop;

  -- Pass 3: write the rows and hand them back.
  for v_outcome in select * from jsonb_array_elements(v_outcomes)
  loop
    v_message := nullif(v_outcome->>'message', '');

    if v_pair_errors ? (v_outcome->>'row_number') then
      v_message := coalesce(v_message || ' · ', '') || (v_pair_errors->>(v_outcome->>'row_number'));
    end if;

    insert into public.import_rows (
      import_batch_id, row_number, raw_data, status, error_message, sales_document_id
    )
    values (
      p_import_batch_id,
      (v_outcome->>'row_number')::int,
      v_outcome->'raw',
      v_outcome->>'status',
      v_message,
      nullif(v_outcome->>'document_id', '')::uuid
    )
    returning * into v_import_row;

    if v_outcome->>'status' = 'imported' then
      update public.sales_documents
      set import_row_id = v_import_row.id
      where id = v_import_row.sales_document_id;
    end if;

    return next v_import_row;
  end loop;

  return;
end;
$$;

revoke execute on function public.import_nubox_documents_batch(uuid, jsonb) from public;
grant execute on function public.import_nubox_documents_batch(uuid, jsonb) to authenticated;
