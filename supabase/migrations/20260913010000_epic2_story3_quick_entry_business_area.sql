-- Epic 2, Story 2.3: Fast Manual Entry Flow for Uruguay
--
-- Adds an optional `business_area_id` to `sales_documents` for the new
-- quick-entry flow (one area per document, matching the "single amount"
-- simplicity of that form). Nullable at the schema level and defaulted
-- to null in both RPCs so the existing full `sales/new` form (which
-- never passes it) keeps working unchanged -- see Story 2.3's Design
-- Notes.
--
-- Cross-company validation for business_area_id reuses the same
-- BEFORE INSERT OR UPDATE trigger pattern already used for client_id
-- (sales_documents_validate_company_refs, Story 2.1): a plain FK can't
-- cross-check company_id equality, and RLS only verifies membership in
-- the submitted company_id, not that the referenced business area
-- belongs to it.

-- ---------------------------------------------------------------------
-- business_area_id column
-- ---------------------------------------------------------------------
alter table public.sales_documents
  add column business_area_id uuid references public.business_areas (id);

-- ---------------------------------------------------------------------
-- Extend the existing cross-company validation trigger function to
-- also check business_area_id when it's non-null.
-- ---------------------------------------------------------------------
create or replace function public.sales_documents_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  client_company_id uuid;
  area_company_id uuid;
begin
  select company_id into client_company_id
  from public.clients
  where id = new.client_id;

  if client_company_id is null or client_company_id <> new.company_id then
    raise exception 'client_id must belong to the same company as the sales document';
  end if;

  if new.business_area_id is not null then
    select company_id into area_company_id
    from public.business_areas
    where id = new.business_area_id;

    if area_company_id is null or area_company_id <> new.company_id then
      raise exception 'business_area_id must belong to the same company as the sales document';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- create_sales_document: add p_business_area_id, defaulting to null so
-- the full form's existing call (which doesn't pass it) is unaffected.
-- ---------------------------------------------------------------------
create or replace function public.create_sales_document(
  p_company_id uuid,
  p_client_id uuid,
  p_document_type text,
  p_document_date date,
  p_currency text,
  p_tax_amount numeric,
  p_lines jsonb,
  p_business_area_id uuid default null
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
  v_net_amount numeric := 0;
  v_tax_amount numeric := coalesce(p_tax_amount, 0);
  v_line jsonb;
  v_line_amount numeric;
  v_line_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a sales document';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A sales document needs at least one line';
  end if;

  if v_tax_amount < 0 then
    raise exception 'tax_amount must be non-negative';
  end if;

  -- Validate and sum lines up front, before inserting anything.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line -> 'amount') is null or jsonb_typeof(v_line -> 'amount') <> 'number' then
      raise exception 'Each sales line needs a numeric amount';
    end if;

    v_line_amount := (v_line ->> 'amount')::numeric;

    if v_line_amount <= 0 then
      raise exception 'Line amount must be greater than zero';
    end if;

    v_net_amount := v_net_amount + v_line_amount;
    v_line_count := v_line_count + 1;
  end loop;

  if v_line_count = 0 then
    raise exception 'A sales document needs at least one line';
  end if;

  insert into public.sales_documents (
    company_id,
    client_id,
    document_type,
    document_date,
    currency,
    net_amount,
    tax_amount,
    total_amount,
    business_area_id,
    created_by,
    updated_by
  )
  values (
    p_company_id,
    p_client_id,
    p_document_type,
    p_document_date,
    p_currency,
    v_net_amount,
    v_tax_amount,
    v_net_amount + v_tax_amount,
    p_business_area_id,
    v_user_id,
    v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (sales_document_id, description, amount, created_by, updated_by)
  select
    v_document.id,
    nullif(line ->> 'description', ''),
    (line ->> 'amount')::numeric,
    v_user_id,
    v_user_id
  from jsonb_array_elements(p_lines) as line;

  return v_document;
end;
$$;

-- The old 7-arg signature is replaced by the 8-arg one above (an added
-- trailing default parameter changes the function's identity for
-- overload-resolution purposes), so drop it explicitly before granting
-- on the new signature -- otherwise both signatures would coexist.
drop function if exists public.create_sales_document(uuid, uuid, text, date, text, numeric, jsonb);

revoke execute on function public.create_sales_document(uuid, uuid, text, date, text, numeric, jsonb, uuid) from public;
grant execute on function public.create_sales_document(uuid, uuid, text, date, text, numeric, jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- update_sales_document: same extension, for consistency (nullable, no
-- behavior change if omitted).
-- ---------------------------------------------------------------------
create or replace function public.update_sales_document(
  p_sales_document_id uuid,
  p_client_id uuid,
  p_document_type text,
  p_document_date date,
  p_currency text,
  p_tax_amount numeric,
  p_lines jsonb,
  p_business_area_id uuid default null
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
  v_existing_voided boolean;
  v_net_amount numeric := 0;
  v_tax_amount numeric := coalesce(p_tax_amount, 0);
  v_line jsonb;
  v_line_amount numeric;
  v_line_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required to update a sales document';
  end if;

  select voided into v_existing_voided
  from public.sales_documents
  where id = p_sales_document_id;

  if v_existing_voided is null then
    raise exception 'Sales document not found';
  end if;

  if v_existing_voided then
    raise exception 'A voided sales document cannot be edited';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A sales document needs at least one line';
  end if;

  if v_tax_amount < 0 then
    raise exception 'tax_amount must be non-negative';
  end if;

  -- Validate and sum lines up front, before touching any row.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line -> 'amount') is null or jsonb_typeof(v_line -> 'amount') <> 'number' then
      raise exception 'Each sales line needs a numeric amount';
    end if;

    v_line_amount := (v_line ->> 'amount')::numeric;

    if v_line_amount <= 0 then
      raise exception 'Line amount must be greater than zero';
    end if;

    v_net_amount := v_net_amount + v_line_amount;
    v_line_count := v_line_count + 1;
  end loop;

  if v_line_count = 0 then
    raise exception 'A sales document needs at least one line';
  end if;

  update public.sales_documents
  set
    client_id = p_client_id,
    document_type = p_document_type,
    document_date = p_document_date,
    currency = p_currency,
    net_amount = v_net_amount,
    tax_amount = v_tax_amount,
    total_amount = v_net_amount + v_tax_amount,
    -- Preserve the existing business_area_id when the caller doesn't
    -- pass one (the full edit form never does) -- p_business_area_id
    -- is additive-only here, never a way to clear the field, so a
    -- quick-entry document's area survives being edited from the full
    -- form.
    business_area_id = coalesce(p_business_area_id, business_area_id),
    updated_by = v_user_id
  where id = p_sales_document_id
  returning * into v_document;

  if v_document is null then
    raise exception 'You do not have permission to edit this sales document';
  end if;

  delete from public.sales_lines
  where sales_document_id = p_sales_document_id;

  insert into public.sales_lines (sales_document_id, description, amount, created_by, updated_by)
  select
    p_sales_document_id,
    nullif(line ->> 'description', ''),
    (line ->> 'amount')::numeric,
    v_user_id,
    v_user_id
  from jsonb_array_elements(p_lines) as line;

  return v_document;
end;
$$;

drop function if exists public.update_sales_document(uuid, uuid, text, date, text, numeric, jsonb);

revoke execute on function public.update_sales_document(uuid, uuid, text, date, text, numeric, jsonb, uuid) from public;
grant execute on function public.update_sales_document(uuid, uuid, text, date, text, numeric, jsonb, uuid) to authenticated;
