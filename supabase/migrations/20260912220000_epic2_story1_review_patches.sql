-- Epic 2, Story 2.1 review patch: harden create_sales_document() and
-- sales_documents.currency.
--
-- 1. create_sales_document() accepted a negative p_tax_amount and lines
--    with a zero/negative amount -- neither was rejected before the
--    row(s) were inserted, unlike the "at least one line" and numeric
--    type checks that already existed.
-- 2. sales_documents.currency had no check constraint, unlike
--    companies.currency (CLP/UYU/USD) -- a raw authenticated insert
--    could set any string.

create or replace function public.create_sales_document(
  p_company_id uuid,
  p_client_id uuid,
  p_document_type text,
  p_document_date date,
  p_currency text,
  p_tax_amount numeric,
  p_lines jsonb
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

alter table public.sales_documents
  add constraint sales_documents_currency_check
  check (currency in ('CLP', 'UYU', 'USD'));
