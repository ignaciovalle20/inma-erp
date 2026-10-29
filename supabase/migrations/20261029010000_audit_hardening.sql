-- Audit 2026-10 (audit/INFORME_AUDITORIA.md). Additive hardening only: no
-- data changes, no change to how any amount is computed.

-- 1. The SECURITY DEFINER functions the anon key could still call (H25 of
-- docs/auditoria-dev-2026-09-23.md). Each checks auth.uid() inside, so this
-- closes a door that was locked anyway. Same pattern as 20260922080000:
-- Supabase grants EXECUTE to anon explicitly, so only anon is revoked;
-- authenticated keeps it (the app calls them with the user's client).
revoke execute on function public.update_technician_charge(uuid, text, date, numeric, boolean, numeric) from anon;
revoke execute on function public.seed_default_business_areas() from anon;
revoke execute on function public.create_company(text, text, text, text) from anon;
revoke execute on function public.update_import_batch_counts(uuid) from anon;
revoke execute on function public.update_cost_import_batch_counts(uuid) from anon;
revoke execute on function public.delete_technician_charge(uuid) from anon;

-- 2. A payment must always add up to its applications. The constraint
-- triggers only ran on INSERT, so deleting an application (service role,
-- SQL editor) could leave a payment applied to nothing: prod has one
-- (technician_payments 67448a9a, 40.000 with no applications). Also check on
-- DELETE of an application; a payment deleted with its applications
-- (ON DELETE CASCADE) is skipped (`not found`). Its own function: the
-- existing one reads NEW, which a DELETE does not have.
create or replace function public.technician_payment_check_balanced_on_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_amount numeric;
  v_applied numeric;
begin
  select amount into v_amount from public.technician_payments where id = old.payment_id;
  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0) into v_applied
  from public.technician_payment_applications
  where payment_id = old.payment_id;

  if v_applied <> v_amount then
    raise exception 'The applications of a payment (%) must add up to its amount (%)', v_applied, v_amount;
  end if;

  return null;
end;
$$;

revoke execute on function public.technician_payment_check_balanced_on_delete() from anon;

create constraint trigger technician_payment_applications_balanced_on_delete
after delete on public.technician_payment_applications
deferrable initially deferred
for each row execute function public.technician_payment_check_balanced_on_delete();

-- 3. client_aliases had no same-company check (every other company-scoped
-- table with a client_id has one): an alias of company A could point at a
-- client of company B. Nothing downstream would accept that client
-- (sales_documents_validate_company_refs), but the alias row itself is wrong.
create or replace function public.client_aliases_validate_company_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.clients c
    where c.id = new.client_id and c.company_id = new.company_id
  ) then
    raise exception 'client_id must belong to the same company as the alias';
  end if;
  return new;
end;
$$;

create trigger client_aliases_validate_company_refs
before insert or update of client_id, company_id on public.client_aliases
for each row execute function public.client_aliases_validate_company_refs();

revoke execute on function public.client_aliases_validate_company_refs() from anon;

-- 4. Foreign keys used in joins and lookups with no index whose first column
-- is the FK column (audit columns created_by/updated_by left out on purpose).
create index if not exists recurring_service_occurrences_sales_document_id_idx
  on public.recurring_service_occurrences (sales_document_id) where sales_document_id is not null;
create index if not exists sales_documents_business_area_id_idx
  on public.sales_documents (business_area_id) where business_area_id is not null;
create index if not exists sales_documents_import_row_id_idx
  on public.sales_documents (import_row_id) where import_row_id is not null;
create index if not exists sales_documents_duplicate_of_idx
  on public.sales_documents (duplicate_of_sales_document_id) where duplicate_of_sales_document_id is not null;
create index if not exists cost_documents_import_row_id_idx
  on public.cost_documents (import_row_id) where import_row_id is not null;
create index if not exists cost_documents_duplicate_of_idx
  on public.cost_documents (duplicate_of_cost_document_id) where duplicate_of_cost_document_id is not null;
create index if not exists import_rows_sales_document_id_idx
  on public.import_rows (sales_document_id) where sales_document_id is not null;
create index if not exists cost_import_rows_cost_document_id_idx
  on public.cost_import_rows (cost_document_id) where cost_document_id is not null;
create index if not exists recurring_services_business_area_id_idx
  on public.recurring_services (business_area_id) where business_area_id is not null;
create index if not exists recurring_service_cost_pools_supplier_id_idx
  on public.recurring_service_cost_pools (supplier_id) where supplier_id is not null;
create index if not exists recurring_service_occurrence_bulk_changes_occurrence_id_idx
  on public.recurring_service_occurrence_bulk_changes (occurrence_id);
create index if not exists technician_document_suggestions_personnel_id_idx
  on public.technician_document_suggestions (personnel_id);
create index if not exists mcp_pending_drafts_company_id_idx
  on public.mcp_pending_drafts (company_id);
create index if not exists company_memberships_company_id_idx
  on public.company_memberships (company_id);
