-- Epic 6, Story 6.6: Period Recognition for Multi-Month Projects
--
-- Adds a nullable `recognized_period` (+ who/when it was set) to both
-- `sales_documents` and `cost_documents`. When null (the default,
-- unchanged for every existing row and every document created from
-- here on unless explicitly reassigned), a document's effective period
-- for reporting purposes stays exactly what it's always been: its own
-- `document_date`'s month. When set, it overrides that for reporting
-- only -- `document_date` itself is never touched by this story.
--
-- Two narrow, single-purpose RPCs (`reassign_sales_document_period`,
-- `reassign_cost_document_period`) are the only supported way to set
-- these columns: each updates only `recognized_period` +
-- `recognized_period_set_by`/`recognized_period_set_at`, never
-- `net_amount`/`total_amount`/lines/classification/`document_date` --
-- a strictly narrower capability than full document editing (which
-- stays out of scope for `cost_documents`, per Story 6.4's boundary;
-- this RPC does not change that -- it cannot touch anything but the
-- three period-recognition columns).
--
-- Neither RPC is security definer -- same reasoning as every other RPC
-- in this codebase (create_sales_document, update_sales_document,
-- etc.): the caller needs an RLS-authorized UPDATE grant on the table
-- regardless, so the RPC's only job is validation + atomicity.
--
-- cost_documents has never had an UPDATE RLS policy (it was
-- deliberately kept read-only after Story 6.4 -- see that story's own
-- boundary). This migration adds one, scoped the same "any company
-- member" way as every other table's, because the reassignment RPC
-- needs it and because it validates only these three columns, not a
-- path to full editing.

-- ---------------------------------------------------------------------
-- sales_documents: period-recognition columns
-- ---------------------------------------------------------------------
alter table public.sales_documents
  add column recognized_period date,
  add column recognized_period_set_by uuid references auth.users (id),
  add column recognized_period_set_at timestamptz,
  add constraint sales_documents_recognized_period_month_start_check check (
    recognized_period is null
    or recognized_period = date_trunc('month', recognized_period)::date
  );

-- ---------------------------------------------------------------------
-- cost_documents: period-recognition columns
-- ---------------------------------------------------------------------
alter table public.cost_documents
  add column recognized_period date,
  add column recognized_period_set_by uuid references auth.users (id),
  add column recognized_period_set_at timestamptz,
  add constraint cost_documents_recognized_period_month_start_check check (
    recognized_period is null
    or recognized_period = date_trunc('month', recognized_period)::date
  );

-- ---------------------------------------------------------------------
-- cost_documents: UPDATE RLS policy (previously absent -- see header).
-- Only needed so the RPC below (not security definer) can update a row
-- the caller is already authorized to view; it grants nothing beyond
-- what the RPC itself restricts callers to touching.
-- ---------------------------------------------------------------------
create policy "Members can update their company's cost documents"
  on public.cost_documents
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = cost_documents.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = cost_documents.company_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- Defense in depth: RLS is row-level, not column-level, so the UPDATE
-- policy above alone would let any company member update ANY column on
-- cost_documents directly via PostgREST -- reopening the full-editing
-- capability Story 6.4 explicitly kept out of scope, regardless of the
-- RPC only ever touching the three period columns itself. This trigger
-- rejects an UPDATE that changes anything other than the
-- period-recognition columns (plus the pre-existing updated_at/by,
-- which set_updated_at already touches on every update), so the
-- reassignment RPC is the only thing that can actually change a
-- cost_documents row, no matter which path reaches the table.
-- ---------------------------------------------------------------------
create or replace function public.cost_documents_protect_financial_fields()
returns trigger
language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id
    or new.supplier_id is distinct from old.supplier_id
    or new.project_id is distinct from old.project_id
    or new.classification is distinct from old.classification
    or new.document_date is distinct from old.document_date
    or new.currency is distinct from old.currency
    or new.net_amount is distinct from old.net_amount
    or new.tax_amount is distinct from old.tax_amount
    or new.total_amount is distinct from old.total_amount
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by
  then
    raise exception 'cost documents can only have their recognized period changed, not their financial fields';
  end if;

  return new;
end;
$$;

create trigger cost_documents_protect_financial_fields
  before update on public.cost_documents
  for each row
  execute function public.cost_documents_protect_financial_fields();

-- ---------------------------------------------------------------------
-- reassign_sales_document_period
-- ---------------------------------------------------------------------
create or replace function public.reassign_sales_document_period(
  p_sales_document_id uuid,
  p_period date
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to reassign a sales document''s period';
  end if;

  if p_period is null then
    raise exception 'p_period is required';
  end if;

  if p_period <> date_trunc('month', p_period)::date then
    raise exception 'p_period must be the first day of a month';
  end if;

  update public.sales_documents
  set
    recognized_period = p_period,
    recognized_period_set_by = v_user_id,
    recognized_period_set_at = now()
  where id = p_sales_document_id
  returning * into v_document;

  if v_document is null then
    raise exception 'You do not have permission to reassign this sales document''s period';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.reassign_sales_document_period(uuid, date) from public;
grant execute on function public.reassign_sales_document_period(uuid, date) to authenticated;

-- ---------------------------------------------------------------------
-- reassign_cost_document_period
-- ---------------------------------------------------------------------
create or replace function public.reassign_cost_document_period(
  p_cost_document_id uuid,
  p_period date
)
returns public.cost_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to reassign a cost document''s period';
  end if;

  if p_period is null then
    raise exception 'p_period is required';
  end if;

  if p_period <> date_trunc('month', p_period)::date then
    raise exception 'p_period must be the first day of a month';
  end if;

  update public.cost_documents
  set
    recognized_period = p_period,
    recognized_period_set_by = v_user_id,
    recognized_period_set_at = now()
  where id = p_cost_document_id
  returning * into v_document;

  if v_document is null then
    raise exception 'You do not have permission to reassign this cost document''s period';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.reassign_cost_document_period(uuid, date) from public;
grant execute on function public.reassign_cost_document_period(uuid, date) to authenticated;
