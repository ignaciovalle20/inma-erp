-- Limpieza de lo que marca 01_diagnostico.sql con accion = LIMPIA (puntos 9 y 11).
-- Idempotente y en una sola transacción: correrlo dos veces no cambia nada más.
-- APLICADO EN DEV el 2026-10-30. EN PROD NO SE EJECUTÓ: ver README.md antes de correrlo.
--
--   L1. Documentos importados con Estado anulado/rechazado/reclamado en su archivo
--       (hoy el importador ya los rechaza; estos entraron antes). Son costo que no
--       existe. Se borran con sus líneas; la fila de importación queda como historial.
--       Si el documento ya tiene asignación, vínculo a cargos o adjuntos NO se toca:
--       queda listado en el reporte para revisarlo a mano.
--   L2. cost_import_rows en 'imported' sin documento ni marca de borrado: pasan a 'error'.
--   L3. Sugerencias de técnico pendientes cuyo documento o cargos ya no aplican: se borran.
--
-- No fusiona documentos duplicados (D1, D2, D3): al 2026-10-30 hay 0 en dev y en prod.

begin;

drop table if exists pg_temp.limpieza_reporte;
create temp table limpieza_reporte (paso text, accion text, id uuid, detalle jsonb);

-- L1 -----------------------------------------------------------------
drop table if exists pg_temp.void_documents;
create temp table void_documents as
select d.*, r.id as fila_id, r.raw_data->>'Estado' as estado_archivo,
       (
         d.classification <> 'general'
         or d.project_id is not null
         or exists (select 1 from public.cost_allocations a where a.cost_document_id = d.id)
         or exists (select 1 from public.cost_service_allocations a where a.cost_document_id = d.id and a.status = 'confirmed')
         or exists (select 1 from public.technician_charge_documents l where l.cost_document_id = d.id)
         or exists (select 1 from public.technician_charges c where c.cost_document_id = d.id)
         or exists (select 1 from public.cost_document_attachments a where a.cost_document_id = d.id)
       ) as en_uso
from public.cost_documents d
join public.cost_import_rows r on r.id = d.import_row_id
where r.raw_data->>'Estado' ~* '^(anulad|rechazad|reclamad)';

insert into limpieza_reporte
select 'L1', case when en_uso then 'REVISAR A MANO (en uso, no se toca)' else 'borrado' end, id,
       jsonb_build_object('tipo', source_document_type, 'numero', document_number, 'fecha', document_date, 'neto', net_amount, 'total', total_amount, 'estado', estado_archivo)
from void_documents;

update public.cost_import_rows r
set cost_document_id = null,
    deleted_at = now(),
    deleted_supplier_id = v.supplier_id,
    deleted_document_date = v.document_date,
    deleted_total_amount = v.total_amount,
    deleted_source_document_type = v.source_document_type,
    deleted_document_number = v.document_number
from void_documents v
where not v.en_uso and r.id = v.fila_id;

update public.cost_documents d
set duplicate_of_cost_document_id = null
where d.duplicate_of_cost_document_id in (select id from void_documents where not en_uso);

delete from public.cost_lines l where l.cost_document_id in (select id from void_documents where not en_uso);
delete from public.cost_service_allocations a where a.cost_document_id in (select id from void_documents where not en_uso);
delete from public.cost_documents d where d.id in (select id from void_documents where not en_uso);

-- L2 -----------------------------------------------------------------
with changed as (
  update public.cost_import_rows r
  set status = 'error', error_message = 'Sin documento: fila marcada por la limpieza del 2026-10-30'
  where r.status = 'imported' and r.cost_document_id is null and r.deleted_at is null
  returning r.id, r.import_batch_id, r.row_number
)
insert into limpieza_reporte
select 'L2', 'fila pasada a error', id, jsonb_build_object('lote', import_batch_id, 'fila', row_number) from changed;

-- L3 -----------------------------------------------------------------
with removed as (
  delete from public.technician_document_suggestions s
  where s.status = 'pending'
    and (
      exists (select 1 from public.technician_charge_documents l where l.cost_document_id = s.cost_document_id)
      or exists (select 1 from unnest(s.charge_ids) c(id) where not exists (select 1 from public.technician_charges t where t.id = c.id))
      or exists (select 1 from unnest(s.charge_ids) c(id) where exists (select 1 from public.technician_charge_documents l where l.charge_id = c.id))
    )
  returning s.id, s.cost_document_id
)
insert into limpieza_reporte
select 'L3', 'sugerencia borrada', id, jsonb_build_object('documento', cost_document_id) from removed;

commit;

select paso, accion, id, detalle from limpieza_reporte order by paso, id;
