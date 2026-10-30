-- Import deduplication guaranteed by the database (audit A-DB-05).
-- The importers already looked for an existing document before inserting,
-- but two imports running at the same time could both miss it. These unique
-- indexes close that window, and the importers now insert with
-- ON CONFLICT DO NOTHING: a row that loses the race is recorded as a
-- duplicate instead of failing as an unexpected error. Re-importing the same
-- file stays idempotent (every row comes back duplicate/unchanged).
--
-- Natural keys (checked against prod on 2026-10-30, read-only: 0 duplicates):
-- - sales_documents: company + document type + folio. Already unique since
--   20260920010000 (sales_documents_company_type_number_key), so no new index.
-- - cost_documents: company + supplier (the issuer's RUT) + Nubox type code
--   + folio, for imported documents only, and never for a row the user chose
--   to import anyway ("Importar igual", duplicate_override): both stay
--   possible on purpose. Manual documents keep their current rules.
-- - One document per import row: import_row_id unique on both document tables
--   (replaces the plain indexes of 20261029010000).
-- - cost_import_rows: one result per (batch, row number).
-- NOT created: import_rows (import_batch_id, row_number). Prod has 18 repeated
-- pairs, all in batch 5072cfa8 (the one-off UY 2026 import script numbered
-- rows per sheet), so the index would fail. See docs/DEPLOY_hardening.md.

create unique index cost_documents_import_natural_key
  on public.cost_documents (company_id, supplier_id, (coalesce(source_document_type, '')), document_number)
  where document_number is not null and source = 'import' and not duplicate_override;

drop index if exists public.sales_documents_import_row_id_idx;
create unique index sales_documents_import_row_id_key
  on public.sales_documents (import_row_id) where import_row_id is not null;

drop index if exists public.cost_documents_import_row_id_idx;
create unique index cost_documents_import_row_id_key
  on public.cost_documents (import_row_id) where import_row_id is not null;

create unique index cost_import_rows_batch_row_key
  on public.cost_import_rows (import_batch_id, row_number) where row_number >= 0;


CREATE OR REPLACE FUNCTION public.import_sales_rows_batch(p_import_batch_id uuid, p_rows jsonb)
 RETURNS SETOF import_rows
 LANGUAGE plpgsql
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_client_company_id uuid;
  v_document public.sales_documents;
  v_existing public.sales_documents;
  v_import_row public.import_rows;
  v_row jsonb;
  v_row_number int;
  v_raw_data jsonb;
  v_client_id uuid;
  v_document_date date;
  v_currency text;
  v_amount numeric;
  v_tax_amount numeric;
  v_force boolean;
  v_total_amount numeric;
  v_number text;
  v_pstatus text;
  v_paid_at date;
  v_error_message text;
  v_duplicate_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required to import sales rows';
  end if;

  select company_id into v_company_id
  from public.import_batches
  where id = p_import_batch_id;

  if v_company_id is null then
    raise exception 'Import batch not found';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_row_number := (v_row->>'row_number')::int;
      v_raw_data := coalesce(v_row->'raw_data', '{}'::jsonb);
      v_client_id := nullif(v_row->>'client_id', '')::uuid;
      v_document_date := nullif(v_row->>'document_date', '')::date;
      v_currency := v_row->>'currency';
      v_amount := nullif(v_row->>'amount', '')::numeric;
      v_tax_amount := coalesce(nullif(v_row->>'tax_amount', '')::numeric, 0);
      v_force := coalesce((v_row->>'force')::boolean, false);
      v_number := nullif(btrim(coalesce(v_row->>'document_number', '')), '');
      v_pstatus := nullif(v_row->>'payment_status', '');
      v_paid_at := nullif(v_row->>'paid_at', '')::date;
      v_error_message := null;
      v_existing := null;
      v_duplicate_id := null;

      if v_client_id is null then
        v_error_message := 'Client not found';
      elsif v_document_date is null then
        v_error_message := 'Invalid or missing date';
      elsif v_amount is null or v_amount <= 0 then
        v_error_message := 'Invalid or missing amount';
      elsif v_tax_amount < 0 then
        v_error_message := 'Tax amount must be non-negative';
      elsif v_currency is null or v_currency not in ('CLP', 'UYU', 'USD') then
        v_error_message := 'Invalid or missing currency';
      elsif v_pstatus is not null and v_pstatus not in ('pagado', 'impago') then
        v_error_message := 'Estado de pago inválido';
      else
        select company_id into v_client_company_id
        from public.clients
        where id = v_client_id
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
          p_import_batch_id, v_row_number, v_raw_data, 'error', v_error_message
        )
        returning * into v_import_row;

        return next v_import_row;
        continue;
      end if;

      v_total_amount := v_amount + v_tax_amount;

      if v_number is not null then
        -- Identified by folio, like the Nubox import: an invoice that is
        -- already there is never created again nor changed, except for its
        -- payment status when the file carries one.
        select * into v_existing
        from public.sales_documents
        where company_id = v_company_id
          and document_type = 'invoice'
          and document_number = v_number;

        if v_existing.id is not null then
          if v_pstatus is not null
             and not v_existing.voided
             and (
               v_existing.payment_status is distinct from v_pstatus
               or (v_pstatus = 'pagado' and v_paid_at is not null
                   and v_existing.paid_at is distinct from v_paid_at)
             ) then
            update public.sales_documents
            set payment_status = v_pstatus,
                paid_at = case when v_pstatus = 'pagado' then coalesce(v_paid_at, paid_at) else null end,
                payment_method = case when v_pstatus = 'pagado' then payment_method else null end,
                payment_status_updated_at = now(),
                updated_by = v_user_id
            where id = v_existing.id;

            insert into public.import_rows (
              import_batch_id, row_number, raw_data, status, error_message, sales_document_id
            )
            values (
              p_import_batch_id, v_row_number, v_raw_data, 'updated',
              'Ya existía el folio ' || v_number || '; estado de pago: '
                || v_existing.payment_status || ' → ' || v_pstatus,
              v_existing.id
            )
            returning * into v_import_row;
          else
            insert into public.import_rows (
              import_batch_id, row_number, raw_data, status, error_message, sales_document_id
            )
            values (
              p_import_batch_id, v_row_number, v_raw_data, 'duplicate',
              'Ya existe el folio ' || v_number || '; no se importó',
              v_existing.id
            )
            returning * into v_import_row;
          end if;

          return next v_import_row;
          continue;
        end if;
      else
        select id into v_duplicate_id
        from public.sales_documents
        where company_id = v_company_id
          and client_id = v_client_id
          and document_date = v_document_date
          and total_amount = v_total_amount
          and voided = false
        order by created_at
        limit 1;

        if v_duplicate_id is not null and not v_force then
          insert into public.import_rows (
            import_batch_id, row_number, raw_data, status, error_message
          )
          values (
            p_import_batch_id,
            v_row_number,
            v_raw_data,
            'duplicate',
            'Possible duplicate of existing sales document ' || v_duplicate_id::text
          )
          returning * into v_import_row;

          return next v_import_row;
          continue;
        end if;
      end if;

      insert into public.sales_documents (
        company_id,
        client_id,
        document_type,
        document_number,
        document_date,
        currency,
        net_amount,
        tax_amount,
        total_amount,
        payment_status,
        paid_at,
        payment_status_updated_at,
        source,
        duplicate_override,
        duplicate_of_sales_document_id,
        created_by,
        updated_by
      )
      values (
        v_company_id,
        v_client_id,
        case when v_number is not null then 'invoice' else 'manual' end,
        v_number,
        v_document_date,
        v_currency,
        v_amount,
        v_tax_amount,
        v_total_amount,
        coalesce(v_pstatus, 'impago'),
        case when v_pstatus = 'pagado' then v_paid_at else null end,
        now(),
        'import',
        v_number is null and v_duplicate_id is not null,
        case when v_number is null then v_duplicate_id else null end,
        v_user_id,
        v_user_id
      )
      on conflict (company_id, document_type, document_number) where document_number is not null
      do nothing
      returning * into v_document;

      -- Another import created this folio after the check above.
      if v_document.id is null then
        select id into v_duplicate_id
        from public.sales_documents
        where company_id = v_company_id
          and document_type = 'invoice'
          and document_number = v_number;

        insert into public.import_rows (
          import_batch_id, row_number, raw_data, status, error_message, sales_document_id
        )
        values (
          p_import_batch_id, v_row_number, v_raw_data, 'duplicate',
          'Ya existe el folio ' || v_number || '; no se importó',
          v_duplicate_id
        )
        returning * into v_import_row;

        return next v_import_row;
        continue;
      end if;

      insert into public.sales_lines (
        sales_document_id, description, amount, created_by, updated_by
      )
      values (
        v_document.id,
        case when v_number is not null then 'Folio ' || v_number else null end,
        v_amount,
        v_user_id,
        v_user_id
      );

      insert into public.import_rows (
        import_batch_id, row_number, raw_data, status, sales_document_id
      )
      values (
        p_import_batch_id, v_row_number, v_raw_data, 'imported', v_document.id
      )
      returning * into v_import_row;

      update public.sales_documents
      set import_row_id = v_import_row.id
      where id = v_document.id;

      return next v_import_row;
    exception when others then
      insert into public.import_rows (
        import_batch_id, row_number, raw_data, status, error_message
      )
      values (
        p_import_batch_id,
        coalesce(v_row_number, -1),
        coalesce(v_raw_data, '{}'::jsonb),
        'error',
        'Error al procesar la fila: ' || sqlerrm
      )
      returning * into v_import_row;

      return next v_import_row;
    end;
  end loop;

  return;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.import_nubox_documents_batch(p_import_batch_id uuid, p_rows jsonb)
 RETURNS SETOF import_rows
 LANGUAGE plpgsql
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_client_company_id uuid;
  v_project public.projects;
  v_existing public.sales_documents;
  v_legacy public.sales_documents;
  v_adopt_id uuid;
  v_review_reason text;
  v_legacy_lines int;
  v_legacy_period date;
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
      -- Two states; the old Nubox values are still understood.
      v_pstatus := case
        when v_row->>'payment_status' in ('pagado', 'no_aplica') then 'pagado'
        when v_row->>'payment_status' in ('impago', 'por_vencer', 'vencido', 'pendiente') then 'impago'
        else null
      end;
      v_send := nullif(v_row->>'nubox_send_number', '');
      v_project_id := nullif(v_row->>'project_id', '')::uuid;
      v_adopt_id := nullif(v_row->>'adopt_document_id', '')::uuid;
      v_review_reason := nullif(btrim(coalesce(v_row->>'review_reason', '')), '');
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
      elsif v_pstatus is null then
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

        if v_existing.id is null and v_review_reason is not null then
          v_status := 'review';
          v_message := v_review_reason;

        elsif v_existing.id is null and v_adopt_id is not null then
          select * into v_legacy
          from public.sales_documents
          where id = v_adopt_id and company_id = v_company_id
          for update;

          select count(*) into v_legacy_lines
          from public.sales_lines
          where sales_document_id = v_adopt_id;

          if v_legacy.id is null
             or v_legacy.voided
             or v_legacy.document_number is not null
             or v_legacy.document_type not in ('invoice', 'manual', 'receipt')
             or v_legacy.client_id <> v_client_id
             or (
               (v_legacy.document_date <> v_date or v_legacy.net_amount <> v_net)
               and not (
                 v_legacy.document_type = 'manual'
                 and v_type = 'invoice'
                 and abs(v_legacy.net_amount - v_net) <= 1
                 and abs(v_legacy.document_date - v_date) <= 31
                 and (v_legacy.net_amount = v_net or v_legacy_lines = 1)
               )
             ) then
            v_status := 'review';
            v_message := 'La venta ya cargada cambió desde la vista previa; no se vinculó ni se creó nada';
          else
            v_legacy_period := coalesce(
              v_legacy.recognized_period,
              date_trunc('month', v_legacy.document_date)::date
            );

            update public.sales_documents
            set document_type = v_type,
                document_number = v_number,
                document_date = v_date,
                net_amount = v_net,
                due_date = v_due,
                tax_amount = v_tax,
                other_taxes = v_other,
                total_amount = v_total,
                payment_status = v_pstatus,
                paid_at = case when v_pstatus = 'pagado' then v_legacy.paid_at else null end,
                payment_method = case when v_pstatus = 'pagado' then v_legacy.payment_method else null end,
                payment_status_updated_at = now(),
                nubox_send_number = v_send,
                recognized_period = case
                  when v_legacy_period <> date_trunc('month', v_date)::date then v_legacy_period
                  else v_legacy.recognized_period
                end,
                recognized_period_set_by = case
                  when v_legacy_period <> date_trunc('month', v_date)::date
                       and v_legacy.recognized_period is null then v_user_id
                  else v_legacy.recognized_period_set_by
                end,
                recognized_period_set_at = case
                  when v_legacy_period <> date_trunc('month', v_date)::date
                       and v_legacy.recognized_period is null then now()
                  else v_legacy.recognized_period_set_at
                end,
                updated_by = v_user_id
            where id = v_legacy.id;

            if v_legacy.net_amount <> v_net then
              update public.sales_lines
              set amount = v_net, updated_by = v_user_id
              where sales_document_id = v_legacy.id;
            end if;

            v_status := 'updated';
            v_message := 'Vinculada a una venta ya cargada: se le asignó el folio ' || v_number;
            v_document_id := v_legacy.id;
          end if;

        elsif v_existing.id is null then
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
          on conflict (company_id, document_type, document_number) where document_number is not null
          do nothing
          returning * into v_document;

          if v_document.id is null then
            -- Another import created this folio after the check above.
            select id into v_document_id
            from public.sales_documents
            where company_id = v_company_id
              and document_type = v_type
              and document_number = v_number;

            v_status := 'unchanged';
            v_message := 'Otra importación lo creó al mismo tiempo; no se modificó';
          else
            insert into public.sales_lines (
              sales_document_id, description, amount, created_by, updated_by
            )
            values (v_document.id, 'Folio ' || v_number, v_net, v_user_id, v_user_id);

            v_status := 'imported';
            v_document_id := v_document.id;
          end if;

        elsif v_existing.client_id <> v_client_id
              or v_existing.net_amount <> v_net
              or v_existing.total_amount <> v_total then
          v_status := 'review';
          v_message := 'Ya existe con cliente o montos distintos; no se modificó';
          v_document_id := v_existing.id;

        elsif v_existing.payment_status is distinct from v_pstatus
              or v_existing.due_date is distinct from v_due then
          -- The imported status wins over one changed by hand.
          update public.sales_documents
          set payment_status = v_pstatus,
              paid_at = case when v_pstatus = 'pagado' then paid_at else null end,
              payment_method = case when v_pstatus = 'pagado' then payment_method else null end,
              due_date = v_due,
              payment_status_updated_at = now(),
              updated_by = v_user_id
          where id = v_existing.id;

          v_status := 'updated';
          v_message := 'Cobro: ' || v_existing.payment_status || ' → ' || v_pstatus;
          v_document_id := v_existing.id;

        else
          v_status := 'unchanged';
          v_document_id := v_existing.id;
        end if;
      end if;
    exception when others then
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

  -- Pass 2: credit-note pairings.
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
$function$
;

CREATE OR REPLACE FUNCTION public.import_cost_rows_batch(p_import_batch_id uuid, p_rows jsonb)
 RETURNS SETOF cost_import_rows
 LANGUAGE plpgsql
AS $function$
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
      v_deleted_at := null;

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

      -- An invoice whose imported document was deleted on purpose
      -- (delete_cost_document) is not created again unless forced. With a
      -- document number, it is that number; without one, supplier + date + total.
      if not v_force then
        select r.deleted_at into v_deleted_at
        from public.cost_import_rows r
        join public.cost_import_batches b on b.id = r.import_batch_id
        where b.company_id = v_company_id
          and r.deleted_at is not null
          and r.deleted_supplier_id = v_supplier_id
          and (
            (v_document_number is not null and r.deleted_document_number is not null
              and r.deleted_document_number = v_document_number
              and coalesce(r.deleted_source_document_type, '') = coalesce(v_source_document_type, ''))
            or ((v_document_number is null or r.deleted_document_number is null)
              and r.deleted_document_date = v_document_date
              and r.deleted_total_amount = v_total_amount)
          )
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

      -- Same document: with a number, same supplier + type code + number
      -- (a stored document without a number is compared by date + total);
      -- without a number, same supplier + date + total.
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
$function$
;
