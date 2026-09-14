-- Performance: batch sales-row import into one round trip
--
-- commitImport() (web/src/app/companies/[id]/sales/import/actions.ts)
-- was calling import_sales_row() once per CSV row in a sequential
-- loop -- for a 200-row file, ~200 sequential network round trips to
-- the database, each paying full round-trip latency on top of the
-- (small) per-row work.
--
-- import_sales_rows_batch() does the exact same per-row work --
-- identical validation order, identical duplicate-detection query
-- (company_id + client_id + document_date + total_amount, non-voided,
-- earliest match), identical insert shape -- but as one PL/pgSQL loop
-- over a jsonb array, all within a single function call/round trip.
--
-- Two behaviors from the original are deliberately preserved:
--
-- 1. Row-level partial commit: a later row must never be lost because
--    an earlier row in the same file hit an unexpected error. The
--    original achieved this because each row was its own RPC call/
--    transaction; a batch loop within one transaction would lose that
--    unless each iteration is isolated. Each row's work below runs in
--    its own `begin ... exception when others` block, which PL/pgSQL
--    implicitly wraps in a subtransaction (savepoint) -- an unexpected
--    error rolls back only that row's own inserts and is recorded as
--    an 'error' import_rows entry, exactly like the app-level
--    `if (rowError || !importRow)` fallback did.
--
-- 2. Same-file duplicate detection: row 5 must still be flagged as a
--    duplicate of row 2 earlier in the same file. This still works
--    unchanged -- statements later in the same loop/transaction see
--    rows inserted earlier in that same loop (ordinary MVCC
--    read-your-own-writes), the same as row 2's separate, already-
--    committed transaction was visible to row 5's separate call
--    before.
--
-- import_sales_row() (single-row) is left in place, unused by the app
-- after this migration, rather than dropped -- no reason to remove a
-- working, RLS-scoped function nothing else references yet.
create or replace function public.import_sales_rows_batch(
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
  v_document public.sales_documents;
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
      v_error_message := null;

      -- Row-level validation -- identical order/messages to
      -- import_sales_row, so error text shown to the user is unchanged.
      if v_client_id is null then
        v_error_message := 'Client not found';
      elsif v_document_date is null then
        v_error_message := 'Invalid or missing date';
      elsif v_amount is null or v_amount <= 0 then
        v_error_message := 'Invalid or missing amount';
      elsif v_tax_amount < 0 then
        v_error_message := 'Tax amount must be non-negative';
      elsif v_currency is null or btrim(v_currency) = '' then
        v_error_message := 'Invalid or missing currency';
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
      else
        v_total_amount := v_amount + v_tax_amount;

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
        else
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
            v_client_id,
            'manual',
            v_document_date,
            v_currency,
            v_amount,
            v_tax_amount,
            v_total_amount,
            'import',
            v_duplicate_id is not null,
            v_duplicate_id,
            v_user_id,
            v_user_id
          )
          returning * into v_document;

          insert into public.sales_lines (
            sales_document_id, description, amount, created_by, updated_by
          )
          values (v_document.id, null, v_amount, v_user_id, v_user_id);

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
        end if;
      end if;
    exception when others then
      -- Mirrors the app's own per-row fallback (structural RPC failure
      -- -> local 'error' result, loop keeps going) -- an unexpected
      -- error on this row must never lose the rest of the file. The
      -- implicit savepoint around this block rolls back only this
      -- row's own partial inserts.
      insert into public.import_rows (
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

revoke execute on function public.import_sales_rows_batch(uuid, jsonb) from public;
grant execute on function public.import_sales_rows_batch(uuid, jsonb) to authenticated;
