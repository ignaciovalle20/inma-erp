-- Quick cost entry: "+ Agregar gasto" from a project's ("Trabajo")
-- detail page. Adds an optional `category` column to `cost_documents`
-- (mirrors `classification`'s check-constraint shape) plus
-- `create_quick_cost_document()`, a one-line-implied version of
-- `create_cost_document()` for the mobile-first flow: amount + category
-- are the only required fields, always `classification='direct'` (the
-- expense always belongs to the project it was entered from), no
-- supplier, no tax breakdown.
--
-- `category` is nullable -- the existing full form
-- (costs/new, `create_cost_document`) doesn't collect it and keeps
-- working unchanged; only rows created via the quick-entry RPC populate
-- it.
--
-- Cross-company validation for `p_project_id` is already covered by the
-- existing `cost_documents_validate_company_refs` BEFORE INSERT trigger
-- (Story 3.1) -- it fires regardless of which function performs the
-- insert, so it isn't duplicated here.

alter table public.cost_documents
  add column category text check (
    category in ('equipment', 'materials', 'transport', 'labor', 'other')
  );

create or replace function public.create_quick_cost_document(
  p_company_id uuid,
  p_project_id uuid,
  p_amount numeric,
  p_category text,
  p_description text,
  p_document_date date,
  p_currency text
)
returns public.cost_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a cost document';
  end if;

  if p_project_id is null then
    raise exception 'A quick expense needs a project';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  if p_category is null or p_category not in ('equipment', 'materials', 'transport', 'labor', 'other') then
    raise exception 'A valid category is required';
  end if;

  insert into public.cost_documents (
    company_id,
    supplier_id,
    project_id,
    classification,
    category,
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
    null,
    p_project_id,
    'direct',
    p_category,
    p_document_date,
    p_currency,
    p_amount,
    0,
    p_amount,
    v_user_id,
    v_user_id
  )
  returning * into v_document;

  insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
  values (v_document.id, nullif(p_description, ''), p_amount, v_user_id, v_user_id);

  return v_document;
end;
$$;

revoke execute on function public.create_quick_cost_document(uuid, uuid, numeric, text, text, date, text) from public;
grant execute on function public.create_quick_cost_document(uuid, uuid, numeric, text, text, date, text) to authenticated;
