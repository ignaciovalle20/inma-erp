-- sales_documents.import_row_id -> import_rows(id) WITHOUT on delete cascade,
-- as 20260913050000_epic4_story1_import_sales.sql created it.
--
-- In prod this FK had been recreated by hand with ON DELETE CASCADE (found by
-- the UY 2026 import, docs/import-uy-2026-2026-10-13.md), so dev and prod
-- disagreed: deleting an import row deleted the sales document it created.
-- Recreated here without cascade so every environment matches the
-- migrations. Idempotent: drop if exists + add, no data change (every
-- existing value already references a row).

alter table public.sales_documents
  drop constraint if exists sales_documents_import_row_id_fkey;

alter table public.sales_documents
  add constraint sales_documents_import_row_id_fkey
  foreign key (import_row_id) references public.import_rows (id);
