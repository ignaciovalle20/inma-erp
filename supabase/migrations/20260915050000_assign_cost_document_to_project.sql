-- Fase C/D follow-up: "Asignar a un trabajo" for an already-existing
-- `general` (unassigned) cost document -- the one-click counterpart to
-- "Dividir costo" (which already works via cost_allocations). Needed
-- for Fase D: an imported purchase invoice always lands as `general`/
-- unassigned (the CSV has no Trabajo column), and the user then either
-- assigns it whole to one project (this RPC) or splits it
-- (set_cost_allocations, unchanged).
--
-- cost_documents already has an UPDATE RLS policy (from Story 6.6,
-- "Members can update their company's cost documents") -- nothing new
-- needed there. What Story 6.6 also added is
-- cost_documents_protect_financial_fields, a BEFORE UPDATE trigger that
-- rejected any change to classification/project_id (among other
-- columns) as a "financial field", on the assumption that the period-
-- reassignment RPCs were the only legitimate UPDATE path.
--
-- Two Fase D/C needs loosen this trigger, each narrowly:
--
-- 1. classification/project_id may now change freely -- this is what
--    assign_cost_document_to_project (below) does, and reassigning a
--    cost's trabajo doesn't corrupt any total, unlike an amount change.
--
-- 2. supplier_id/document_date/currency/net_amount/tax_amount/
--    total_amount may change, but ONLY as part of a
--    status: 'provisional' -> 'confirmed' transition -- that's exactly
--    what "vincular a un gasto existente" during purchase-invoice
--    import does (see import_cost_rows_batch, next migration):
--    overwriting a field-guessed provisional amount with the real
--    invoice's figures instead of creating a duplicate document.
--    Outside of that specific transition these columns stay protected,
--    same as before.
--
-- company_id/created_at/created_by remain unconditionally immutable.
create or replace function public.cost_documents_protect_financial_fields()
returns trigger
language plpgsql
as $$
declare
  v_confirming_provisional boolean := (old.status = 'provisional' and new.status = 'confirmed');
begin
  if new.company_id is distinct from old.company_id
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by
  then
    raise exception 'cost documents can never have their company or creation record changed';
  end if;

  if not v_confirming_provisional and (
    new.supplier_id is distinct from old.supplier_id
    or new.document_date is distinct from old.document_date
    or new.currency is distinct from old.currency
    or new.net_amount is distinct from old.net_amount
    or new.tax_amount is distinct from old.tax_amount
    or new.total_amount is distinct from old.total_amount
  ) then
    raise exception 'cost documents can only have their recognized period, trabajo assignment, or a provisional amount confirmed -- not these financial fields otherwise';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- assign_cost_document_to_project: converts a `general`, unallocated
-- cost document into a `direct` one imputed to a single project. Not
-- security definer -- the existing UPDATE policy already authorizes
-- this for any company member; the function's only job is the business
-- rule (general + not already allocated) plus the existing
-- cross-company trigger validation on project_id, which already fires
-- on UPDATE (cost_documents_validate_company_refs, Story 3.1).
-- ---------------------------------------------------------------------
create or replace function public.assign_cost_document_to_project(
  p_cost_document_id uuid,
  p_project_id uuid
)
returns public.cost_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_classification text;
  v_allocation_count int;
  v_document public.cost_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to assign a cost document';
  end if;

  if p_project_id is null then
    raise exception 'A project is required';
  end if;

  select classification into v_classification
  from public.cost_documents
  where id = p_cost_document_id;

  if v_classification is null then
    raise exception 'Cost document not found';
  end if;

  if v_classification <> 'general' then
    raise exception 'Only an unassigned (general) cost document can be assigned to a single project -- it is already direct';
  end if;

  select count(*) into v_allocation_count
  from public.cost_allocations
  where cost_document_id = p_cost_document_id;

  if v_allocation_count > 0 then
    raise exception 'This cost document is already split across allocations -- remove them first';
  end if;

  update public.cost_documents
  set classification = 'direct', project_id = p_project_id
  where id = p_cost_document_id
  returning * into v_document;

  if v_document is null then
    raise exception 'You do not have permission to assign this cost document';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.assign_cost_document_to_project(uuid, uuid) from public;
grant execute on function public.assign_cost_document_to_project(uuid, uuid) to authenticated;
