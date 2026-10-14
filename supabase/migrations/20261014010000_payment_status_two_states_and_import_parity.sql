-- Sales payment status with two states, and the same importers for every
-- company (docs/cambios-pago-multimoneda-paridad-2026-10-14.md).
--
-- 1. companies.country is free text and one real company says "Uruguay"
--    instead of "UY": every rule keyed on the country (recurring services
--    currency, the app's company configuration) missed it. Normalised to the
--    ISO code, and recurring_services.country back-filled for those
--    companies (user triggers off, so nothing else changes).
-- 2. sales_documents.payment_status: only 'pagado' / 'impago', not null,
--    default 'impago'. Existing values map as:
--      pagado, no_aplica (Nubox: nothing to collect)      -> pagado
--      por_vencer, vencido, pendiente, null (no data)     -> impago
--    Overdue is no longer a state: it is derived from due_date on screen.
--    paid_at is optional and cleared whenever a sale is impaga.
-- 3. set_sales_documents_payment_status: one RPC for the single and the
--    bulk change from the sales list. mark_sales_document_paid (payment
--    date now optional) and mark_sales_document_pending (any sale, not only
--    manual ones) keep their signatures for the pendientes screen.
--    create_manual_sale_without_invoice starts its sale as 'impago'.
-- 4. import_nubox_documents_batch: same body as 20261004020000, with the
--    payment status normalised to the two states. The imported status
--    always overwrites the stored one (and clears paid_at when impaga).
-- 5. create_import_batch / create_cost_import_batch: no Chile-only gate.
--    Membership is still enforced by the INSERT policy of each table.
-- 6. import_sales_rows_batch (generic importer with column mapping): each
--    row may carry document_number, payment_status and paid_at. A row with
--    a folio is an invoice identified by company + folio, exactly like the
--    Nubox import: an existing one is never created again nor touched,
--    except that an imported payment status overwrites the stored one.
--    Rows without a folio keep the client + date + total duplicate check.

-- ---------------------------------------------------------------------
-- 1. Country codes
-- ---------------------------------------------------------------------
update public.companies
set country = case upper(btrim(country))
  when 'URUGUAY' then 'UY'
  when 'CHILE' then 'CL'
  else upper(btrim(country))
end
where upper(btrim(country)) in ('URUGUAY', 'CHILE', 'UY', 'CL')
  and country not in ('UY', 'CL');

alter table public.recurring_services disable trigger user;
update public.recurring_services s
set country = upper(c.country)
from public.companies c
where c.id = s.company_id
  and s.country is null
  and upper(c.country) in ('CL', 'UY');
alter table public.recurring_services enable trigger user;

-- ---------------------------------------------------------------------
-- 2. Two payment states
-- ---------------------------------------------------------------------
alter table public.sales_documents
  drop constraint if exists sales_documents_payment_status_check;

alter table public.sales_documents disable trigger user;
update public.sales_documents
set payment_status = case
      when payment_status in ('pagado', 'no_aplica') then 'pagado'
      else 'impago'
    end,
    paid_at = case
      when payment_status in ('pagado', 'no_aplica') then paid_at
      else null
    end
where payment_status is null
   or payment_status not in ('pagado', 'impago')
   or (payment_status = 'impago' and paid_at is not null);
alter table public.sales_documents enable trigger user;

alter table public.sales_documents
  alter column payment_status set default 'impago',
  alter column payment_status set not null,
  add constraint sales_documents_payment_status_check
    check (payment_status in ('pagado', 'impago'));

comment on column public.sales_documents.payment_status is
  'pagado / impago (default). An import that carries a status overwrites it; paid_at is optional and null while impago.';

-- ---------------------------------------------------------------------
-- 3. Changing the status by hand
-- ---------------------------------------------------------------------
-- Not security definer: the caller needs the ordinary UPDATE right on the
-- rows (company membership). Voided documents and credit notes are left
-- alone. Returns how many sales changed.
create or replace function public.set_sales_documents_payment_status(
  p_sales_document_ids uuid[],
  p_payment_status text,
  p_paid_at date default null
)
returns int
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_count int;
begin
  if v_user_id is null then
    raise exception 'Authentication required to change a payment status';
  end if;

  if p_payment_status is null or p_payment_status not in ('pagado', 'impago') then
    raise exception 'The payment status must be pagado or impago';
  end if;

  update public.sales_documents
  set payment_status = p_payment_status,
      paid_at = case when p_payment_status = 'pagado' then p_paid_at else null end,
      payment_method = case when p_payment_status = 'pagado' then payment_method else null end,
      payment_status_updated_at = now(),
      updated_by = v_user_id
  where id = any(coalesce(p_sales_document_ids, '{}'::uuid[]))
    and voided = false
    and document_type <> 'credit_note';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.set_sales_documents_payment_status(uuid[], text, date) from public, anon;
grant execute on function public.set_sales_documents_payment_status(uuid[], text, date) to authenticated;

create or replace function public.mark_sales_document_paid(
  p_sales_document_id uuid,
  p_paid_at date,
  p_payment_method text
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to mark a sale as paid';
  end if;

  update public.sales_documents
  set payment_status = 'pagado',
      paid_at = p_paid_at,
      payment_method = nullif(btrim(coalesce(p_payment_method, '')), ''),
      payment_status_updated_at = now(),
      updated_by = v_user_id
  where id = p_sales_document_id
    and voided = false
    and document_type <> 'credit_note'
  returning * into v_document;

  if v_document.id is null then
    raise exception 'Sales document not found or cannot be marked as paid';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.mark_sales_document_paid(uuid, date, text) from public, anon;
grant execute on function public.mark_sales_document_paid(uuid, date, text) to authenticated;

create or replace function public.mark_sales_document_pending(
  p_sales_document_id uuid
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to mark a sale as unpaid';
  end if;

  update public.sales_documents
  set payment_status = 'impago',
      paid_at = null,
      payment_method = null,
      payment_status_updated_at = now(),
      updated_by = v_user_id
  where id = p_sales_document_id
    and voided = false
    and document_type <> 'credit_note'
  returning * into v_document;

  if v_document.id is null then
    raise exception 'Sales document not found or cannot be marked as unpaid';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.mark_sales_document_pending(uuid) from public, anon;
grant execute on function public.mark_sales_document_pending(uuid) to authenticated;

create or replace function public.create_manual_sale_without_invoice(
  p_company_id uuid,
  p_project_id uuid,
  p_document_date date,
  p_net_amount numeric,
  p_tax_amount numeric,
  p_description text
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects;
  v_currency text;
  v_tax numeric := coalesce(p_tax_amount, 0);
  v_document public.sales_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a sale';
  end if;

  if p_document_date is null then
    raise exception 'The sale date is required';
  end if;

  if p_net_amount is null or p_net_amount <= 0 then
    raise exception 'The net amount must be greater than zero';
  end if;

  if v_tax < 0 then
    raise exception 'The tax amount must be non-negative';
  end if;

  select * into v_project
  from public.projects
  where id = p_project_id and company_id = p_company_id;

  if v_project.id is null then
    raise exception 'Job not found';
  end if;

  select currency into v_currency from public.companies where id = p_company_id;

  insert into public.sales_documents (
    company_id, client_id, project_id, business_area_id,
    document_type, document_date, currency,
    net_amount, tax_amount, total_amount,
    payment_status, payment_status_updated_at,
    source, created_by, updated_by
  )
  values (
    p_company_id, v_project.client_id, v_project.id, v_project.business_area_id,
    'manual', p_document_date, v_currency,
    p_net_amount, v_tax, p_net_amount + v_tax,
    'impago', now(),
    'manual', v_user_id, v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (
    sales_document_id, description, amount, created_by, updated_by
  )
  values (
    v_document.id,
    coalesce(nullif(btrim(coalesce(p_description, '')), ''), 'Venta sin factura'),
    p_net_amount,
    v_user_id,
    v_user_id
  );

  return v_document;
end;
$$;

revoke execute on function public.create_manual_sale_without_invoice(uuid, uuid, date, numeric, numeric, text) from public, anon;
grant execute on function public.create_manual_sale_without_invoice(uuid, uuid, date, numeric, numeric, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Nubox import with the two states
-- ---------------------------------------------------------------------
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
$$;

revoke execute on function public.import_nubox_documents_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_nubox_documents_batch(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Import batches for every company
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
  v_batch public.import_batches;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create an import batch';
  end if;

  -- The INSERT policy only lets members of the company through.
  insert into public.import_batches (company_id, file_name, total_rows, imported_by)
  values (p_company_id, p_file_name, p_total_rows, v_user_id)
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.create_import_batch(uuid, text, int) from public, anon;
grant execute on function public.create_import_batch(uuid, text, int) to authenticated;

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
  v_batch public.cost_import_batches;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create an import batch';
  end if;

  insert into public.cost_import_batches (company_id, file_name, total_rows, imported_by)
  values (p_company_id, p_file_name, p_total_rows, v_user_id)
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.create_cost_import_batch(uuid, text, int) from public, anon;
grant execute on function public.create_cost_import_batch(uuid, text, int) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Generic sales importer: folio, payment status and payment date
-- ---------------------------------------------------------------------
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
      returning * into v_document;

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
$$;

revoke execute on function public.import_sales_rows_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_sales_rows_batch(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
