-- set_sales_allocations (20261016010000) replaces every allocation of a
-- document from the invoice editor: it now keeps each row's
-- suggestion_reason (20261017010000), so saving the editor never loses why
-- a suggestion was made. Same checks as before.
create or replace function public.set_sales_allocations(
  p_sales_document_id uuid,
  p_allocations jsonb
)
returns setof public.sales_allocations
language plpgsql
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_doc record;
  v_item jsonb;
  v_amount numeric;
  v_total numeric := 0;
  v_type text;
  v_status text;
  v_reason text;
  v_tolerance numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required to allocate a sales document';
  end if;

  select id, company_id, net_amount, currency, document_type, voided, annulled_by_document_id
  into v_doc
  from public.sales_documents
  where id = p_sales_document_id
  for update;

  if v_doc.id is null then
    raise exception 'Sales document not found';
  end if;

  if v_doc.document_type = 'credit_note' or v_doc.voided or v_doc.annulled_by_document_id is not null then
    raise exception 'This document cannot be allocated';
  end if;

  if jsonb_typeof(coalesce(p_allocations, '[]'::jsonb)) <> 'array' then
    raise exception 'Allocations must be a list';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_amount := (v_item ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Every allocation needs an amount greater than zero';
    end if;
    v_type := v_item ->> 'target_type';
    if v_type not in ('period', 'quote') or nullif(v_item ->> 'target_id', '') is null then
      raise exception 'Every allocation needs a destination';
    end if;
    v_total := v_total + v_amount;
  end loop;

  v_tolerance := case when v_doc.currency = 'CLP' then 0.5 else 0.005 end;
  if v_total > v_doc.net_amount + v_tolerance then
    raise exception 'The allocations (%) exceed the net amount of the document (%)', v_total, v_doc.net_amount;
  end if;

  delete from public.sales_allocations where sales_document_id = p_sales_document_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_type := v_item ->> 'target_type';
    v_status := coalesce(nullif(v_item ->> 'status', ''), 'confirmed');
    if v_status not in ('suggested', 'confirmed') then
      raise exception 'Unknown allocation status %', v_status;
    end if;
    v_reason := nullif(v_item ->> 'suggestion_reason', '');

    insert into public.sales_allocations (
      company_id, sales_document_id, recurring_service_period_id, project_quote_id,
      amount, status, notes, suggestion_reason, created_by, updated_by
    )
    values (
      v_doc.company_id,
      p_sales_document_id,
      case when v_type = 'period' then (v_item ->> 'target_id')::uuid end,
      case when v_type = 'quote' then (v_item ->> 'target_id')::uuid end,
      (v_item ->> 'amount')::numeric,
      v_status,
      nullif(btrim(coalesce(v_item ->> 'notes', '')), ''),
      v_reason,
      v_user_id,
      v_user_id
    );
  end loop;

  -- A document left without any quote allocation leaves its job.
  perform public.sync_sales_document_project(p_sales_document_id);

  return query
    select * from public.sales_allocations where sales_document_id = p_sales_document_id;
end;
$$;

revoke execute on function public.set_sales_allocations(uuid, jsonb) from public, anon;
grant execute on function public.set_sales_allocations(uuid, jsonb) to authenticated, service_role;
