-- Fase B: estado provisorio/confirmado + comprobante (foto) para
-- costos cargados desde el flujo rápido (Fase A,
-- 20260915030000_quick_cost_entry.sql).
--
-- `status` defaults to 'confirmed' -- every cost entered through the
-- full form (`create_cost_document`) already has a real line/total the
-- user typed deliberately, so it keeps behaving exactly as before.
-- Only `create_quick_cost_document` (the "+ Agregar gasto" flow, where
-- the amount is often an eyeballed estimate from the field) sets
-- 'provisional'. There's no RPC to move a document from provisional to
-- confirmed yet -- that's Fase D's job (linking an imported purchase
-- invoice to the manual entry it backs), so a provisional cost simply
-- displays as such for now.
--
-- Receipts: a private Storage bucket + a join table, since one cost
-- document can end up with zero or more photos (a scanned invoice plus
-- a handwritten note, say). The object path convention is
-- `{company_id}/{cost_document_id}/{filename}` -- storage.objects has
-- no company_id column of its own, so the RLS policies below extract it
-- from the path via storage.foldername(), the same technique Supabase's
-- own docs use for multi-tenant buckets.

alter table public.cost_documents
  add column status text not null default 'confirmed' check (
    status in ('provisional', 'confirmed')
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
    status,
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
    'provisional',
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

-- ---------------------------------------------------------------------
-- Storage bucket for receipt photos.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('cost-receipts', 'cost-receipts', false)
on conflict (id) do nothing;

create policy "Members can view their company's cost receipts"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'cost-receipts'
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = (storage.foldername(name))[1]::uuid
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can upload cost receipts for their company"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'cost-receipts'
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = (storage.foldername(name))[1]::uuid
        and cm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------
-- cost_document_attachments: one row per uploaded receipt file.
-- ---------------------------------------------------------------------
create table public.cost_document_attachments (
  id uuid primary key default gen_random_uuid(),
  cost_document_id uuid not null references public.cost_documents (id),
  storage_path text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);

create index cost_document_attachments_cost_document_id_idx
  on public.cost_document_attachments (cost_document_id);

alter table public.cost_document_attachments enable row level security;

create policy "Members can view their company's cost document attachments"
  on public.cost_document_attachments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_document_attachments.cost_document_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost document attachments for their company"
  on public.cost_document_attachments
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.cost_documents cd
      join public.company_memberships cm on cm.company_id = cd.company_id
      where cd.id = cost_document_attachments.cost_document_id
        and cm.user_id = auth.uid()
    )
  );
