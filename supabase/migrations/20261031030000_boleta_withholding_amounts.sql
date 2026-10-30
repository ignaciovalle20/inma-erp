-- Boletas de honorarios: bruto, retención and líquido stored apart.
--
-- Checked against the Nubox purchases export (raw_data of each import row):
-- its "Neto" is the bruto and its "Total" the líquido, and the importer was
-- already storing net_amount = bruto (0 of the boletas in dev and prod differ).
-- What was missing is the other two: total_amount holds the bruto too (the
-- cost is the whole gross), so the retención and the líquido only existed in
-- raw_data, and no screen could put the líquido next to what is paid.
--
-- Now:
--   * cost_documents.withholding_amount: the retención, from the file's own
--     Total when it has one (a boleta may have no retención at all), else by
--     the rate of the document's year.
--   * cost_documents.liquid_amount: generated, bruto - retención, for boletas.
--   * boleta_withholding_rates also has 2020-2024 (Ley 21.133): a boleta from
--     2024 had no rate at all. The rate lives only in this table, by year.
--
-- net_amount and total_amount do not change, so no cost, report or link moves.
-- Idempotent: the backfill only sets what differs.

insert into public.boleta_withholding_rates (year, rate) values
  (2020, 0.1075),
  (2021, 0.115),
  (2022, 0.1225),
  (2023, 0.13),
  (2024, 0.1375)
on conflict (year) do nothing;

alter table public.cost_documents
  add column if not exists withholding_amount numeric not null default 0
    check (withholding_amount >= 0);

alter table public.cost_documents
  add column if not exists liquid_amount numeric
    generated always as (
      case when source_document_type in ('BOL-HE', 'BOL-TE') then net_amount - withholding_amount end
    ) stored;

comment on column public.cost_documents.withholding_amount is
  'Retención of a boleta de honorarios (paid by INMA to the SII). net_amount and total_amount are its bruto.';
comment on column public.cost_documents.liquid_amount is
  'Líquido of a boleta de honorarios: what the technician is paid (bruto - retención). Null for any other document.';

-- ---------------------------------------------------------------------
-- The boletas already imported
-- ---------------------------------------------------------------------
alter table public.cost_documents disable trigger cost_documents_set_updated_at;

with computed as (
  select d.id,
         case
           when coalesce(r.raw_data->>'Total', '') ~ '^[0-9]+$'
             then greatest(d.net_amount - (r.raw_data->>'Total')::numeric, 0)
           else round(d.net_amount * coalesce(
             (select w.rate from public.boleta_withholding_rates w
              where w.year <= extract(year from d.document_date)::integer
              order by w.year desc limit 1),
             0
           ))
         end as withholding
  from public.cost_documents d
  left join public.cost_import_rows r on r.id = d.import_row_id
  where d.source_document_type in ('BOL-HE', 'BOL-TE')
)
update public.cost_documents d
set withholding_amount = c.withholding
from computed c
where c.id = d.id and d.withholding_amount is distinct from c.withholding;

alter table public.cost_documents enable trigger cost_documents_set_updated_at;

-- ---------------------------------------------------------------------
-- The retención is a financial field: same as 20261026010000, plus it.
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
    or new.withholding_amount is distinct from old.withholding_amount
    or new.document_type is distinct from old.document_type
  ) then
    raise exception 'cost documents can only have their recognized period, trabajo assignment, or a provisional amount confirmed -- not these financial fields otherwise';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- import_cost_rows_batch: same as 20261031010000, storing the retención.
-- A row may bring withholding_amount (Neto - Total of the file); a boleta
-- without it is computed with the rate of its year.
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
  v_withholding numeric;
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
      v_withholding := nullif(v_row->>'withholding_amount', '')::numeric;
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
      elsif v_withholding < 0 or v_withholding > v_amount then
        v_error_message := 'Retención inválida (' || v_withholding::text || '): debe estar entre 0 y el bruto';
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

      -- Only a boleta has a retención. Without one in the row, its year's rate.
      if coalesce(v_source_document_type, '') in ('BOL-HE', 'BOL-TE') then
        if v_withholding is null then
          v_withholding := round(v_amount * public.boleta_withholding_rate(v_document_date));
        end if;
      else
        v_withholding := 0;
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
          withholding_amount = v_withholding,
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
        withholding_amount,
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
        v_withholding,
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
