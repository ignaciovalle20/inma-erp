-- Epic 2, Story 2.2: Edit & Correct Sales Documents with Audit Trail
--
-- Adds voiding (voided/voided_at/voided_by) plus the UPDATE RLS policy
-- and RPCs needed to correct a sales document after creation:
--
-- * update_sales_document(): mirrors create_sales_document's atomic,
--   server-computed pattern -- recomputes net_amount/total_amount from
--   the replacement lines, rejects an empty/invalid line set and a
--   negative tax amount, and refuses outright if the document is
--   already voided. Lines are replaced wholesale (delete + reinsert),
--   never partially patched, per the story's Boundaries.
-- * void_sales_document(): sets voided/voided_at/voided_by, refuses if
--   already voided. Rows are never deleted -- this is the only
--   supported "removal" path.
--
-- created_at/created_by are never touched by either RPC -- immutable
-- on edit per the story's Boundaries. The existing
-- sales_documents_validate_company_refs() trigger already fires on
-- `before insert or update` (Story 2.1), so a tampered client_id on
-- edit is rejected with no changes needed there.
--
-- Neither RPC is security definer, same reasoning as
-- create_sales_document: the caller already has RLS-authorized
-- UPDATE/DELETE/INSERT rights on both tables once the policies below
-- exist, so the RPC's only job is atomicity + server-side computation.

-- ---------------------------------------------------------------------
-- Void columns
-- ---------------------------------------------------------------------
alter table public.sales_documents
  add column voided boolean not null default false,
  add column voided_at timestamptz,
  add column voided_by uuid references auth.users (id);

-- ---------------------------------------------------------------------
-- UPDATE RLS policy -- same "any company member" shape as clients'.
-- Needed both for update_sales_document()/void_sales_document() (not
-- security definer, so they rely on the caller's own RLS grant) and to
-- allow the trigger's `before ... update` path to run at all.
-- ---------------------------------------------------------------------
create policy "Members can update their company's sales documents"
  on public.sales_documents
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_documents.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_documents.company_id
        and cm.user_id = auth.uid()
    )
  );

-- sales_lines needs its own DELETE/UPDATE policies -- create_sales_document
-- only ever inserted lines, so DELETE was never granted. update_sales_document
-- deletes all existing lines and reinserts the replacement set, so DELETE is
-- required; UPDATE is added for parity even though the RPC does not use it
-- (delete + reinsert, never a partial patch, per the story's Boundaries).
create policy "Members can delete their company's sales lines"
  on public.sales_lines
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.sales_documents sd
      join public.company_memberships cm on cm.company_id = sd.company_id
      where sd.id = sales_lines.sales_document_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's sales lines"
  on public.sales_lines
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.sales_documents sd
      join public.company_memberships cm on cm.company_id = sd.company_id
      where sd.id = sales_lines.sales_document_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.sales_documents sd
      join public.company_memberships cm on cm.company_id = sd.company_id
      where sd.id = sales_lines.sales_document_id
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- update_sales_document: replaces a document's lines atomically and
-- recomputes net_amount/total_amount server-side, same validation as
-- create_sales_document. Refuses if the document is already voided.
--
-- p_lines is a jsonb array of {description?: text, amount: numeric},
-- same shape as create_sales_document.
-- ---------------------------------------------------------------------
create or replace function public.update_sales_document(
  p_sales_document_id uuid,
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

revoke execute on function public.update_sales_document(uuid, uuid, text, date, text, numeric, jsonb) from public;
grant execute on function public.update_sales_document(uuid, uuid, text, date, text, numeric, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- void_sales_document: marks a document voided instead of deleting it.
-- Refuses if already voided. Rows/lines are left untouched otherwise.
-- ---------------------------------------------------------------------
create or replace function public.void_sales_document(
  p_sales_document_id uuid
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.sales_documents;
  v_existing_voided boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required to void a sales document';
  end if;

  select voided into v_existing_voided
  from public.sales_documents
  where id = p_sales_document_id;

  if v_existing_voided is null then
    raise exception 'Sales document not found';
  end if;

  if v_existing_voided then
    raise exception 'This sales document is already voided';
  end if;

  update public.sales_documents
  set
    voided = true,
    voided_at = now(),
    voided_by = v_user_id,
    updated_by = v_user_id
  where id = p_sales_document_id
  returning * into v_document;

  if v_document is null then
    raise exception 'You do not have permission to void this sales document';
  end if;

  return v_document;
end;
$$;

revoke execute on function public.void_sales_document(uuid) from public;
grant execute on function public.void_sales_document(uuid) to authenticated;
