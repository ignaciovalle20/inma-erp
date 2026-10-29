-- ROLLBACK of 20261029010000_audit_hardening. NOT executed: run only if the
-- migration itself is shown to break prod, and only after review.
-- Undoes exactly what the migration added (it changed no data), then removes
-- the migration from the history so `db push` would re-apply it later.
-- Ends in ROLLBACK on purpose: change it to COMMIT to really apply it.

begin;

-- 4. Indexes
drop index if exists public.recurring_service_occurrences_sales_document_id_idx;
drop index if exists public.sales_documents_business_area_id_idx;
drop index if exists public.sales_documents_import_row_id_idx;
drop index if exists public.sales_documents_duplicate_of_idx;
drop index if exists public.cost_documents_import_row_id_idx;
drop index if exists public.cost_documents_duplicate_of_idx;
drop index if exists public.import_rows_sales_document_id_idx;
drop index if exists public.cost_import_rows_cost_document_id_idx;
drop index if exists public.recurring_services_business_area_id_idx;
drop index if exists public.recurring_service_cost_pools_supplier_id_idx;
drop index if exists public.recurring_service_occurrence_bulk_changes_occurrence_id_idx;
drop index if exists public.technician_document_suggestions_personnel_id_idx;
drop index if exists public.mcp_pending_drafts_company_id_idx;
drop index if exists public.company_memberships_company_id_idx;

-- 3. Same-company check on client_aliases
drop trigger if exists client_aliases_validate_company_refs on public.client_aliases;
drop function if exists public.client_aliases_validate_company_refs();

-- 2. Balance check on deleting a payment application
drop trigger if exists technician_payment_applications_balanced_on_delete on public.technician_payment_applications;
drop function if exists public.technician_payment_check_balanced_on_delete();

-- 1. Give anon back EXECUTE (the state before; every function checks auth.uid())
grant execute on function public.update_technician_charge(uuid, text, date, numeric, boolean, numeric) to anon;
grant execute on function public.seed_default_business_areas() to anon;
grant execute on function public.create_company(text, text, text, text) to anon;
grant execute on function public.update_import_batch_counts(uuid) to anon;
grant execute on function public.update_cost_import_batch_counts(uuid) to anon;
grant execute on function public.delete_technician_charge(uuid) to anon;

delete from supabase_migrations.schema_migrations where version = '20261029010000';

rollback;
