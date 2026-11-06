
-- Sales import: a folio written with or without its series is the same
-- invoice (possible duplicate).
--
-- Uruguayan sales were first loaded with the series in the folio ("A-13791",
-- scripts/import-uy-2026.mjs), while the invoicing export (VentasExport)
-- brings only the number ("13791"). The folio check was exact, and the
-- client + date + total check only ran for rows without a folio, so the same
-- invoice was imported a second time.
--
-- Now, when a row's folio is not found exactly, it is still flagged as a
-- possible duplicate (status 'duplicate', the user can "Importar igual")
-- when the same client already has a non-voided document with:
--  - the same folio number and the same series, or no series on one side
--    ("13791" = "A-13791"; "B-13791" is not "A-13791"), or
--  - no folio at all, on the same date and for the same total (the rule rows
--    without a folio already had: e.g. a sale entered by hand).
-- Forced rows keep duplicate_override / duplicate_of_sales_document_id, as
-- forced rows without a folio already did. Only the function changes; no
-- data is touched. The preview applies the same rule
-- (web/src/lib/salesDuplicates.ts).

create or replace function public.folio_number(p_folio text)
returns text
language sql
immutable
as $$
  select nullif(ltrim(regexp_replace(coalesce(p_folio, ''), '[^0-9]', '', 'g'), '0'), '')
$$;

comment on function public.folio_number(text) is
  'Digits of a folio without leading zeros ("A-013791" -> "13791"); null when it has none.';

create or replace function public.folio_series(p_folio text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(coalesce(p_folio, ''), '[^A-Za-z]', '', 'g'))
$$;

comment on function public.folio_series(text) is
  'Letters of a folio, upper case ("A-13791" -> "A"); empty when it has none.';

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
  v_duplicate_number text;
  v_number_key text;
  v_series text;
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
      v_duplicate_number := null;
      v_number_key := public.folio_number(v_number);
      v_series := public.folio_series(v_number);

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

        -- Not there exactly: the same invoice may be stored with or
        -- without its series, or entered by hand without a folio.
        select id, document_number into v_duplicate_id, v_duplicate_number
        from public.sales_documents d
        where d.company_id = v_company_id
          and d.client_id = v_client_id
          and d.voided = false
          and (
            (
              v_number_key is not null
              and public.folio_number(d.document_number) = v_number_key
              and (
                v_series = ''
                or public.folio_series(d.document_number) = ''
                or public.folio_series(d.document_number) = v_series
              )
            )
            or (
              d.document_number is null
              and d.document_date = v_document_date
              and d.total_amount = v_total_amount
            )
          )
        order by d.created_at
        limit 1;
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
      end if;

      if v_duplicate_id is not null and not v_force then
        if v_duplicate_number is not null then
          v_error_message := 'Posible duplicado: el cliente ya tiene el folio ' || v_duplicate_number
            || ' (mismo número que ' || v_number || ')';
        else
          v_error_message := 'Possible duplicate of existing sales document ' || v_duplicate_id::text;
        end if;

        -- Not linked to the existing document (sales_document_id stays
        -- null, as before): it is only a suspicion, and the batch's
        -- allocation suggestions must not touch that document.
        insert into public.import_rows (
          import_batch_id, row_number, raw_data, status, error_message
        )
        values (
          p_import_batch_id,
          v_row_number,
          v_raw_data,
          'duplicate',
          v_error_message
        )
        returning * into v_import_row;

        return next v_import_row;
        continue;
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
        v_duplicate_id is not null,
        v_duplicate_id,
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
