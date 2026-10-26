-- Purchase invoices import (/companies/{id}/costs/import): exempt amounts,
-- credit notes and document numbers.
--
-- The Nubox purchases export (Fecha emisión, Tipo documento, Nº documento,
-- RUT proveedor, Proveedor, Neto, Exento, IVA, Otros impuestos, Total,
-- Estado...) went in with the Neto column alone as the net. That left out:
--
-- 1. Exempt documents. A factura exenta (FAC-EE) or a 100% exempt credit
--    note has Neto 0 and everything in Exento, so the row failed with
--    "Invalid or missing amount" (170 rows, $34.338.246 in the file that
--    found it). And a partly exempt invoice went in without its exempt part.
--    The net is now Neto + Exento, the rule of the Nubox sales import
--    (web/src/lib/nubox.ts, docs/cambios-flujo-v2.md 4.2); IVA and Otros
--    impuestos go apart.
-- 2. Credit notes. An N/C-EL went in as one more positive cost: it added
--    what it should subtract. A credit note is now stored with negative
--    amounts (net, exempt, IVA, other taxes, total and its line), so every
--    report that adds net_amount subtracts it with no change; document_type
--    says what it is.
-- 3. Document numbers. Duplicates were detected by supplier + date + total
--    only, so two different invoices of the same supplier, day and amount
--    (or an invoice and its own credit note) were taken as one: all 37
--    "duplicates" of that file were distinct documents. A row that has a
--    document number is now the same document as one of the same supplier,
--    type code and number; supplier + date + total stays for rows (or stored
--    documents) without a number, like a generic CSV or a manual expense.
-- 4. Otros impuestos (ILA, impuesto específico...) were not part of the
--    stored total. total_amount is now net + IVA + other taxes.
--
-- The row's amounts are read and checked by the app first
-- (web/src/lib/purchaseImport.ts: Neto + Exento + IVA + Otros = Total, by
-- document type); import_cost_rows_batch re-checks what it can and applies
-- the sign. It receives positive amounts plus document_type.
--
-- Already imported Nubox rows are corrected below (backfill), so a
-- re-import of the same file finds them as duplicates and the reports stop
-- adding credit notes and dropping exempt amounts.

-- ---------------------------------------------------------------------
-- cost_documents: type, number, exempt part and other taxes
-- ---------------------------------------------------------------------
alter table public.cost_documents
  add column document_type text not null default 'invoice'
    check (document_type in ('invoice', 'credit_note')),
  add column source_document_type text,
  add column document_number text,
  add column exempt_amount numeric not null default 0,
  add column other_taxes numeric not null default 0;

comment on column public.cost_documents.document_type is
  'invoice or credit_note. A credit note has every amount negative, so sums of net_amount subtract it.';
comment on column public.cost_documents.source_document_type is
  'The type code of the imported file (Nubox: FAC-EL, FAC-EE, N/C-EL...), null for manual documents.';
comment on column public.cost_documents.document_number is
  'The document number (folio) of the imported file; with supplier and source_document_type it identifies the document.';
comment on column public.cost_documents.exempt_amount is
  'The exempt part of net_amount (Nubox "Exento"); same sign as net_amount.';
comment on column public.cost_documents.other_taxes is
  'Taxes other than IVA (Nubox "Otros impuestos"), part of total_amount; same sign as net_amount.';

-- Not validated against existing rows: every row has document_type
-- 'invoice' until the backfill below, and nothing before this migration
-- could store a negative amount.
alter table public.cost_documents
  add constraint cost_documents_document_type_sign_check check (
    (document_type = 'invoice' and net_amount >= 0 and total_amount >= 0)
    or (document_type = 'credit_note' and net_amount <= 0 and total_amount <= 0)
  ) not valid;

create index cost_documents_document_number_idx
  on public.cost_documents (company_id, supplier_id, document_number)
  where document_number is not null;

-- The deleted document's number, for the "deleted before" skip.
alter table public.cost_import_rows
  add column deleted_source_document_type text,
  add column deleted_document_number text;

-- ---------------------------------------------------------------------
-- cost_documents_protect_financial_fields: same as 20260921020000, plus
-- the new financial fields.
-- ---------------------------------------------------------------------
create or replace function public.cost_documents_protect_financial_fields()
returns trigger
language plpgsql
as $$
declare
  v_confirming_provisional boolean := (old.status = 'provisional' and new.status = 'confirmed');
  v_editing_technician_charge boolean :=
    coalesce(current_setting('inma.technician_charge_edit', true), '') = old.id::text
    and exists (
      select 1
      from public.technician_charges tc
      where tc.cost_document_id = old.id
    );
begin
  if new.company_id is distinct from old.company_id
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by
  then
    raise exception 'cost documents can never have their company or creation record changed';
  end if;

  if not v_confirming_provisional and not v_editing_technician_charge and (
    new.supplier_id is distinct from old.supplier_id
    or new.document_date is distinct from old.document_date
    or new.currency is distinct from old.currency
    or new.net_amount is distinct from old.net_amount
    or new.tax_amount is distinct from old.tax_amount
    or new.total_amount is distinct from old.total_amount
    or new.exempt_amount is distinct from old.exempt_amount
    or new.other_taxes is distinct from old.other_taxes
    or new.document_type is distinct from old.document_type
  ) then
    raise exception 'cost documents can only have their recognized period, trabajo assignment, or a provisional amount confirmed -- not these financial fields otherwise';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Backfill: documents already imported from the Nubox purchases export
-- ---------------------------------------------------------------------
-- Only rows with every Nubox column, and only documents that were imported
-- with the default mapping (net = Neto, IVA = IVA) and still have their one
-- import line and no allocations: anything else keeps its amounts (and is
-- counted in the notice) so nothing allocated or edited is rewritten.
create temporary table nubox_cost_backfill on commit drop as
with source as (
  select
    cd.id,
    cd.net_amount,
    cd.tax_amount,
    cd.total_amount,
    upper(btrim(r.raw_data->>'Tipo documento')) as code,
    nullif(btrim(r.raw_data->>'Nº documento'), '') as number,
    case when btrim(r.raw_data->>'Neto') ~ '^\d+$' then btrim(r.raw_data->>'Neto')::numeric end as neto,
    case when btrim(r.raw_data->>'Exento') ~ '^\d+$' then btrim(r.raw_data->>'Exento')::numeric end as exento,
    case when btrim(r.raw_data->>'IVA') ~ '^\d+$' then btrim(r.raw_data->>'IVA')::numeric end as iva,
    case when btrim(r.raw_data->>'Otros impuestos') ~ '^\d+$' then btrim(r.raw_data->>'Otros impuestos')::numeric end as otros,
    case when btrim(r.raw_data->>'Total') ~ '^\d+$' then btrim(r.raw_data->>'Total')::numeric end as total,
    (select count(*) from public.cost_lines l where l.cost_document_id = cd.id) as line_count,
    (select min(l.amount) from public.cost_lines l where l.cost_document_id = cd.id) as line_amount,
    exists (select 1 from public.cost_allocations a where a.cost_document_id = cd.id)
      or exists (select 1 from public.cost_service_allocations a where a.cost_document_id = cd.id) as allocated
  from public.cost_documents cd
  join public.cost_import_rows r on r.id = cd.import_row_id
  where cd.source = 'import'
    and r.raw_data ?& array['Tipo documento', 'Nº documento', 'Neto', 'Exento', 'IVA', 'Otros impuestos', 'Total']
),
computed as (
  select
    s.*,
    case when s.code like 'N/C-%' then 'credit_note' else 'invoice' end as new_type,
    case when s.code like 'N/C-%' then -1 else 1 end as sign,
    -- Otros impuestos counts only when the row adds up with it: some fuel
    -- invoices carry a 1 there and a total that matches nothing.
    case
      when abs(s.neto + s.exento + s.iva + s.otros - s.total) <= 1 then s.otros
      else 0
    end as other
  from source s
)
select
  c.id,
  c.code,
  c.number,
  c.new_type,
  c.sign * (c.neto + c.exento) as new_net,
  c.sign * c.exento as new_exempt,
  c.sign * c.iva as new_tax,
  c.sign * c.other as new_other,
  c.sign * (c.neto + c.exento + c.iva + c.other) as new_total,
  -- Amounts are rewritten only where the document is still the plain import.
  c.neto is not null and c.exento is not null and c.iva is not null and c.otros is not null and c.total is not null
    and c.net_amount = c.neto and c.tax_amount = c.iva
    and c.line_count = 1 and c.line_amount = c.net_amount
    and not c.allocated as rewritable,
  c.net_amount is distinct from c.sign * (c.neto + c.exento)
    or c.tax_amount is distinct from c.sign * c.iva
    or c.total_amount is distinct from c.sign * (c.neto + c.exento + c.iva + c.other) as amounts_change
from computed c;

alter table public.cost_documents disable trigger cost_documents_protect_financial_fields;
alter table public.cost_documents disable trigger cost_documents_set_updated_at;

-- Type code and number for every imported Nubox document.
update public.cost_documents cd
set source_document_type = b.code,
    document_number = b.number
from nubox_cost_backfill b
where b.id = cd.id;

-- Amounts (and the credit note's type) where the document is still the plain import.
update public.cost_documents cd
set document_type = b.new_type,
    net_amount = b.new_net,
    exempt_amount = b.new_exempt,
    tax_amount = b.new_tax,
    other_taxes = b.new_other,
    total_amount = b.new_total,
    updated_at = now()
from nubox_cost_backfill b
where b.id = cd.id
  and b.rewritable;

update public.cost_lines l
set amount = b.new_net
from nubox_cost_backfill b
where b.id = l.cost_document_id
  and b.rewritable
  and b.amounts_change;

alter table public.cost_documents enable trigger cost_documents_set_updated_at;
alter table public.cost_documents enable trigger cost_documents_protect_financial_fields;

do $$
declare
  v_rewritten int;
  v_skipped int;
begin
  select count(*) filter (where rewritable and amounts_change),
         count(*) filter (where not rewritable and amounts_change)
  into v_rewritten, v_skipped
  from nubox_cost_backfill;
  raise notice 'Nubox purchase documents: % corrected, % left as they are (edited or allocated: review by hand)',
    v_rewritten, v_skipped;
end;
$$;

-- The number of Nubox rows whose document was deleted.
update public.cost_import_rows r
set deleted_source_document_type = upper(btrim(r.raw_data->>'Tipo documento')),
    deleted_document_number = nullif(btrim(r.raw_data->>'Nº documento'), '')
where r.deleted_at is not null
  and r.raw_data ?& array['Tipo documento', 'Nº documento'];

-- ---------------------------------------------------------------------
-- delete_cost_document: same as 20261024020000, plus the document's type
-- code and number on the import row it leaves behind.
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
      deleted_total_amount = v_document.total_amount,
      deleted_source_document_type = v_document.source_document_type,
      deleted_document_number = v_document.document_number
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
-- import_cost_rows_batch: same as 20261024020000, plus
-- * exempt_amount and other_taxes (amount is already Neto + Exento),
-- * document_type: a credit note is stored with every amount negative,
-- * source_document_type + document_number: the duplicate and "deleted
--   before" checks match on them when the row has a number.
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
