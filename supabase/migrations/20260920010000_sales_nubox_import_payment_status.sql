-- Nubox sales import, payment status and credit-note pairing
-- (docs/cambios-flujo-v2.md, section 4.2).
--
-- Nubox exports the last N documents, not one month, so uploading
-- documents the ERP already has is the normal case, not an error. The
-- existing importer (import_sales_rows_batch) treats "already there" as
-- a duplicate and only knows client+date+total; here a document is
-- identified by company + type + folio, an existing one gets its cobro
-- (payment status) refreshed, and credit notes (N/C) annul the invoice
-- they correct so neither is counted twice.
--
-- Everything below is additive: existing sales, the generic CSV importer
-- and every report keep working unchanged.

-- ---------------------------------------------------------------------
-- sales_documents: folio, cobro and N/C links
-- ---------------------------------------------------------------------
-- payment_status is nullable on purpose: sales that pre-date this
-- migration have no cobro data, and "unknown" must not be shown as
-- "pending". `pendiente` is only for sales without an invoice (no due
-- date), marked by hand.
alter table public.sales_documents
  add column document_number text,
  add column due_date date,
  add column payment_status text,
  add column payment_status_updated_at timestamptz,
  add column paid_at date,
  add column payment_method text,
  add column nubox_send_number text,
  add column other_taxes numeric not null default 0,
  add column annulled_by_document_id uuid references public.sales_documents (id),
  add column annuls_document_id uuid references public.sales_documents (id),
  add constraint sales_documents_payment_status_check check (
    payment_status is null
    or payment_status in ('pagado', 'por_vencer', 'vencido', 'no_aplica', 'pendiente')
  ),
  add constraint sales_documents_other_taxes_check check (other_taxes >= 0),
  add constraint sales_documents_annulment_direction_check check (
    not (annulled_by_document_id is not null and annuls_document_id is not null)
  );

-- The real duplicate rule for documents that carry a folio. The old
-- client+date+total heuristic stays only for manual sales without one.
create unique index sales_documents_company_type_number_key
  on public.sales_documents (company_id, document_type, document_number)
  where document_number is not null;

create index if not exists sales_documents_project_id_idx
  on public.sales_documents (project_id);
create index sales_documents_annulled_by_idx
  on public.sales_documents (annulled_by_document_id)
  where annulled_by_document_id is not null;
create index sales_documents_annuls_idx
  on public.sales_documents (annuls_document_id)
  where annuls_document_id is not null;

-- ---------------------------------------------------------------------
-- Cross-checks for the N/C <-> invoice link. A plain FK can't check
-- company/client equality or document types, and RLS only verifies
-- membership, so this is a trigger like sales_documents_validate_company_refs.
-- ---------------------------------------------------------------------
create or replace function public.sales_documents_validate_annulment_refs()
returns trigger
language plpgsql
as $$
declare
  v_other public.sales_documents;
begin
  if new.annuls_document_id is not null then
    -- This row is the credit note; the other side must be an invoice.
    select * into v_other from public.sales_documents where id = new.annuls_document_id;

    if v_other.id is null
       or new.document_type <> 'credit_note'
       or v_other.document_type <> 'invoice'
       or v_other.company_id <> new.company_id
       or v_other.client_id <> new.client_id then
      raise exception 'A credit note can only annul an invoice of the same company and client';
    end if;
  end if;

  if new.annulled_by_document_id is not null then
    -- This row is the invoice; the other side must be a credit note.
    select * into v_other from public.sales_documents where id = new.annulled_by_document_id;

    if v_other.id is null
       or new.document_type <> 'invoice'
       or v_other.document_type <> 'credit_note'
       or v_other.company_id <> new.company_id
       or v_other.client_id <> new.client_id then
      raise exception 'An invoice can only be annulled by a credit note of the same company and client';
    end if;
  end if;

  return new;
end;
$$;

create trigger sales_documents_validate_annulment_refs
  before insert or update on public.sales_documents
  for each row
  execute function public.sales_documents_validate_annulment_refs();

-- ---------------------------------------------------------------------
-- import_batches / import_rows: outcomes of an upsert-style import
-- ---------------------------------------------------------------------
alter table public.import_batches
  add column updated_rows int not null default 0,
  add column unchanged_rows int not null default 0,
  add column review_rows int not null default 0,
  add column oldest_document_date date;

alter table public.import_rows
  drop constraint import_rows_status_check;

alter table public.import_rows
  add constraint import_rows_status_check
  check (status in ('imported', 'error', 'duplicate', 'updated', 'unchanged', 'review'));

-- import_batches has no UPDATE policy (nothing but this function ever
-- changes a batch after creation), hence security definer + the same
-- membership re-check as before. oldest_document_date is what the
-- pendientes screen uses to tell which unpaid invoices fell out of the
-- last file and need a manual cobro check.
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
    ),
    updated_rows = (
      select count(*) from public.import_rows
      where import_batch_id = p_import_batch_id and status = 'updated'
    ),
    unchanged_rows = (
      select count(*) from public.import_rows
      where import_batch_id = p_import_batch_id and status = 'unchanged'
    ),
    review_rows = (
      select count(*) from public.import_rows
      where import_batch_id = p_import_batch_id and status = 'review'
    ),
    -- Only documents that carry a folio (the Nubox import): the generic
    -- importer's rows must not set the reference date.
    oldest_document_date = (
      select min(sd.document_date)
      from public.import_rows ir
      join public.sales_documents sd on sd.id = ir.sales_document_id
      where ir.import_batch_id = p_import_batch_id
        and sd.document_number is not null
    )
  where id = p_import_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke execute on function public.update_import_batch_counts(uuid) from public;
grant execute on function public.update_import_batch_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- pair_credit_note / unpair_credit_note
-- ---------------------------------------------------------------------
-- Pairing marks BOTH documents voided, so every report and listing that
-- already filters voided=false (reporting.ts) excludes the pair with no
-- other change, and update_sales_document refuses to edit them. The
-- links (annuls_document_id / annulled_by_document_id) say why, so the
-- UI can show "Anulada por N/C 358" instead of a generic "Anulado" and
-- so unpairing can restore exactly what pairing did.
--
-- Not security definer: the caller needs the ordinary UPDATE right on
-- sales_documents through company membership.
create or replace function public.pair_credit_note(
  p_credit_note_id uuid,
  p_invoice_id uuid
)
returns void
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_nc public.sales_documents;
  v_inv public.sales_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to pair a credit note';
  end if;

  select * into v_nc from public.sales_documents where id = p_credit_note_id;
  select * into v_inv from public.sales_documents where id = p_invoice_id;

  if v_nc.id is null or v_inv.id is null then
    raise exception 'Credit note or invoice not found';
  end if;

  if v_nc.document_type <> 'credit_note' or v_inv.document_type <> 'invoice' then
    raise exception 'Pair a credit note with an invoice';
  end if;

  if v_nc.company_id <> v_inv.company_id or v_nc.client_id <> v_inv.client_id then
    raise exception 'The credit note and the invoice must belong to the same client';
  end if;

  if v_nc.net_amount <> v_inv.net_amount then
    raise exception 'The credit note net amount (%) does not match the invoice (%)',
      v_nc.net_amount, v_inv.net_amount;
  end if;

  if v_inv.document_date > v_nc.document_date then
    raise exception 'The invoice must not be later than the credit note';
  end if;

  if v_nc.annuls_document_id is not null then
    raise exception 'The credit note is already paired';
  end if;

  if v_inv.annulled_by_document_id is not null or v_inv.voided then
    raise exception 'The invoice is already annulled';
  end if;

  update public.sales_documents
  set annulled_by_document_id = v_nc.id,
      voided = true,
      voided_at = now(),
      voided_by = v_user_id
  where id = v_inv.id;

  update public.sales_documents
  set annuls_document_id = v_inv.id,
      voided = true,
      voided_at = now(),
      voided_by = v_user_id
  where id = v_nc.id;
end;
$$;

revoke execute on function public.pair_credit_note(uuid, uuid) from public;
grant execute on function public.pair_credit_note(uuid, uuid) to authenticated;

create or replace function public.unpair_credit_note(p_credit_note_id uuid)
returns void
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_nc public.sales_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to unpair a credit note';
  end if;

  select * into v_nc from public.sales_documents where id = p_credit_note_id;

  if v_nc.id is null or v_nc.annuls_document_id is null then
    raise exception 'The credit note is not paired';
  end if;

  update public.sales_documents
  set annulled_by_document_id = null,
      voided = false,
      voided_at = null,
      voided_by = null
  where id = v_nc.annuls_document_id;

  update public.sales_documents
  set annuls_document_id = null,
      voided = false,
      voided_at = null,
      voided_by = null
  where id = v_nc.id;
end;
$$;

revoke execute on function public.unpair_credit_note(uuid) from public;
grant execute on function public.unpair_credit_note(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- import_nubox_documents_batch
-- ---------------------------------------------------------------------
-- Same shape as import_sales_rows_batch (one round trip, one savepoint
-- per row so a bad row never loses the rest of the file), but:
--   * the document is identified by company + type + folio;
--   * the database itself decides create / update / unchanged / review,
--     so the app's preview can never make it create a duplicate;
--   * real error text is kept per row (never a generic "unexpected
--     error") because the UI shows it on screen.
--
-- Each element of p_rows:
--   row_number, raw_data, document_type ('invoice'|'credit_note'),
--   document_number, client_id, document_date, due_date, currency,
--   net_amount (neto + exento), tax_amount, other_taxes, total_amount,
--   payment_status, nubox_send_number,
--   project_id (optional, new invoices only),
--   pair_with_document_number (optional, credit notes: folio of the
--   invoice to annul; it may already be in the database or be created
--   earlier in this same batch).
--
-- Existing document outcomes:
--   client, net or total differ  -> 'review' (never touched)
--   payment_status / due_date differ -> 'updated' (only those + timestamp)
--   nothing differs -> 'unchanged'
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

        if v_existing.id is null then
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

-- ---------------------------------------------------------------------
-- link_sales_document_to_project
-- ---------------------------------------------------------------------
-- The area of the sale is taken from the job (docs 4.2: "el área de la
-- factura se toma del trabajo"). The existing
-- sales_documents_validate_company_refs trigger already requires the
-- project to belong to the same company and client.
create or replace function public.link_sales_document_to_project(
  p_sales_document_id uuid,
  p_project_id uuid
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
  v_project public.projects;
begin
  if v_user_id is null then
    raise exception 'Authentication required to link a sales document';
  end if;

  select * into v_document from public.sales_documents where id = p_sales_document_id;

  if v_document.id is null then
    raise exception 'Sales document not found';
  end if;

  if v_document.voided then
    raise exception 'A voided or annulled document cannot be linked to a job';
  end if;

  if p_project_id is null then
    update public.sales_documents
    set project_id = null, updated_by = v_user_id
    where id = v_document.id
    returning * into v_document;

    return v_document;
  end if;

  select * into v_project from public.projects where id = p_project_id;

  if v_project.id is null or v_project.company_id <> v_document.company_id then
    raise exception 'The job does not belong to this company';
  end if;

  update public.sales_documents
  set project_id = v_project.id,
      business_area_id = v_project.business_area_id,
      updated_by = v_user_id
  where id = v_document.id
  returning * into v_document;

  return v_document;
end;
$$;

revoke execute on function public.link_sales_document_to_project(uuid, uuid) from public;
grant execute on function public.link_sales_document_to_project(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Manual cobro: sales without an invoice, and old unpaid invoices that
-- fell out of the last Nubox file.
-- ---------------------------------------------------------------------
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

  if p_paid_at is null then
    raise exception 'The payment date is required';
  end if;

  update public.sales_documents
  set payment_status = 'pagado',
      paid_at = p_paid_at,
      payment_method = nullif(btrim(coalesce(p_payment_method, '')), ''),
      payment_status_updated_at = now(),
      updated_by = v_user_id
  where id = p_sales_document_id
    and voided = false
    and document_type in ('invoice', 'manual')
  returning * into v_document;

  if v_document.id is null then
    raise exception 'Sales document not found or cannot be marked as paid';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.mark_sales_document_paid(uuid, date, text) from public;
grant execute on function public.mark_sales_document_paid(uuid, date, text) to authenticated;

-- Undo for a manual sale marked paid by mistake. Only manual sales:
-- an invoice's cobro comes from Nubox, not from this button.
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
    raise exception 'Authentication required to mark a sale as pending';
  end if;

  update public.sales_documents
  set payment_status = 'pendiente',
      paid_at = null,
      payment_method = null,
      payment_status_updated_at = now(),
      updated_by = v_user_id
  where id = p_sales_document_id
    and voided = false
    and document_type = 'manual'
  returning * into v_document;

  if v_document.id is null then
    raise exception 'Only a manual sale can go back to pending';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.mark_sales_document_pending(uuid) from public;
grant execute on function public.mark_sales_document_pending(uuid) to authenticated;

-- "Registrar venta sin factura" from a job: client and area come from the
-- job, no folio, cobro starts as 'pendiente'.
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
    'pendiente', now(),
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

revoke execute on function public.create_manual_sale_without_invoice(uuid, uuid, date, numeric, numeric, text) from public;
grant execute on function public.create_manual_sale_without_invoice(uuid, uuid, date, numeric, numeric, text) to authenticated;
