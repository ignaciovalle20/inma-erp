-- Diagnóstico de documentos duplicados y registros huérfanos (puntos 9 y 11).
-- Solo SELECT: no modifica nada. Una sola sentencia, sin punto y coma interno,
-- para poder correrla con `supabase db query` (ver README.md).
-- Cada fila es un chequeo: `cantidad` y hasta 50 ejemplos en `detalle`.
-- `accion`: LIMPIA = lo corrige 02_limpieza.sql; INFO = no se toca (ver README.md).
with
duplicate_costs as (
  select d.company_id,
         coalesce(public.normalize_tax_id(s.tax_id), d.supplier_id::text) as emisor,
         d.source_document_type, d.document_number,
         count(*) as documentos,
         jsonb_agg(jsonb_build_object('id', d.id, 'fecha', d.document_date, 'total', d.total_amount, 'proveedor', s.name, 'forzado', d.duplicate_override, 'clasificacion', d.classification, 'creado', d.created_at) order by d.created_at) as filas
  from public.cost_documents d
  left join public.suppliers s on s.id = d.supplier_id
  where d.document_number is not null
  group by 1, 2, 3, 4
  having count(*) > 1
),
duplicate_sales as (
  select company_id, document_type, document_number, count(*) as documentos, jsonb_agg(id) as ids
  from public.sales_documents
  where document_number is not null
  group by 1, 2, 3
  having count(*) > 1
),
duplicate_suppliers as (
  select s.company_id, public.normalize_tax_id(s.tax_id) as rut, count(*) as proveedores,
         jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.name, 'tax_id', s.tax_id, 'documentos', (select count(*) from public.cost_documents d where d.supplier_id = s.id))) as filas
  from public.suppliers s
  where public.normalize_tax_id(s.tax_id) is not null
  group by 1, 2
  having count(*) > 1
),
imported_without_document as (
  select r.id, r.import_batch_id, r.row_number, r.raw_data->>'Tipo documento' as tipo, r.raw_data->>'Nº documento' as numero
  from public.cost_import_rows r
  where r.status = 'imported' and r.cost_document_id is null and r.deleted_at is null
),
deleted_marks as (
  select r.id, r.deleted_at, r.deleted_source_document_type as tipo, r.deleted_document_number as numero, r.deleted_total_amount as total,
         exists (
           select 1 from public.cost_documents d
           where d.supplier_id = r.deleted_supplier_id
             and d.document_number = r.deleted_document_number
             and coalesce(d.source_document_type, '') = coalesce(r.deleted_source_document_type, '')
         ) as reimportado
  from public.cost_import_rows r
  where r.deleted_at is not null
),
row_points_elsewhere as (
  select r.id, r.cost_document_id, d.import_row_id
  from public.cost_import_rows r
  join public.cost_documents d on d.id = r.cost_document_id
  where d.import_row_id is distinct from r.id
),
document_points_elsewhere as (
  select d.id, d.import_row_id, r.cost_document_id
  from public.cost_documents d
  join public.cost_import_rows r on r.id = d.import_row_id
  where r.cost_document_id is distinct from d.id
),
import_without_row as (
  select d.id, d.document_date, d.source_document_type, d.document_number, d.total_amount
  from public.cost_documents d
  where d.source = 'import' and d.import_row_id is null
),
documents_without_lines as (
  select d.id, d.document_date, d.source_document_type, d.document_number, d.total_amount, d.source
  from public.cost_documents d
  where not exists (select 1 from public.cost_lines l where l.cost_document_id = d.id)
),
dangling_override as (
  select d.id, d.source_document_type, d.document_number
  from public.cost_documents d
  where d.duplicate_override and d.duplicate_of_cost_document_id is null
),
stale_suggestions as (
  select s.id, s.status, s.cost_document_id,
         exists (select 1 from public.technician_charge_documents l where l.cost_document_id = s.cost_document_id) as documento_vinculado,
         (select count(*) from unnest(s.charge_ids) c(id) where not exists (select 1 from public.technician_charges t where t.id = c.id)) as cargos_inexistentes,
         (select count(*) from unnest(s.charge_ids) c(id) where exists (select 1 from public.technician_charge_documents l where l.charge_id = c.id)) as cargos_ya_vinculados
  from public.technician_document_suggestions s
),
storage_without_row as (
  select o.name, o.created_at
  from storage.objects o
  where o.bucket_id = 'cost-receipts'
    and not exists (select 1 from public.cost_document_attachments a where a.storage_path = o.name)
),
row_without_storage as (
  select a.id, a.cost_document_id, a.storage_path
  from public.cost_document_attachments a
  where not exists (select 1 from storage.objects o where o.bucket_id = 'cost-receipts' and o.name = a.storage_path)
),
stale_confirmations as (
  select c.id, c.project_id, c.period
  from public.project_cost_confirmations c
  where exists (
    select 1 from public.cost_documents d
    where d.project_id = c.project_id
      and coalesce(d.recognized_period, date_trunc('month', d.document_date)::date) = c.period
  )
),
sales_rows_without_document as (
  select r.id, r.import_batch_id, r.row_number
  from public.import_rows r
  where r.status = 'imported' and r.sales_document_id is null
),
void_documents as (
  select d.id, d.company_id, s.name as proveedor, d.source_document_type as tipo, d.document_number as numero, d.document_date as fecha,
         d.net_amount as neto, d.total_amount as total, r.raw_data->>'Estado' as estado, d.classification as clasificacion, d.project_id,
         (select count(*) from public.cost_allocations a where a.cost_document_id = d.id) as asignaciones,
         (select count(*) from public.cost_service_allocations a where a.cost_document_id = d.id) as a_servicios,
         (select count(*) from public.technician_charge_documents l where l.cost_document_id = d.id) as cargos_vinculados
  from public.cost_documents d
  join public.cost_import_rows r on r.id = d.import_row_id
  left join public.suppliers s on s.id = d.supplier_id
  where r.raw_data->>'Estado' ~* '^(anulad|rechazad|reclamad)'
)
select chequeo, accion, cantidad, detalle from (
  select 1 as orden, 'D1 documentos de costo duplicados (emisor/RUT + tipo + folio)' as chequeo, 'INFO' as accion, (select count(*) from duplicate_costs) as cantidad, (select jsonb_agg(x) from (select * from duplicate_costs limit 50) x) as detalle
  union all select 2, 'D2 documentos de venta duplicados (empresa + tipo + folio)', 'INFO', (select count(*) from duplicate_sales), (select jsonb_agg(x) from (select * from duplicate_sales limit 50) x)
  union all select 3, 'D3 proveedores con el mismo RUT (esconden duplicados)', 'INFO', (select count(*) from duplicate_suppliers), (select jsonb_agg(x) from (select * from duplicate_suppliers limit 50) x)
  union all select 4, 'H1 cost_import_rows imported sin documento ni marca de borrado', 'LIMPIA', (select count(*) from imported_without_document), (select jsonb_agg(x) from (select * from imported_without_document limit 50) x)
  union all select 5, 'H2 cost_import_rows con marca de borrado (ya no bloquean importar)', 'INFO', (select count(*) from deleted_marks), (select jsonb_agg(x) from (select * from deleted_marks limit 50) x)
  union all select 6, 'H3 cost_import_rows que apunta a un documento que apunta a otra fila', 'INFO', (select count(*) from row_points_elsewhere), (select jsonb_agg(x) from (select * from row_points_elsewhere limit 50) x)
  union all select 7, 'H4 cost_documents que apunta a una fila que apunta a otro documento', 'INFO', (select count(*) from document_points_elsewhere), (select jsonb_agg(x) from (select * from document_points_elsewhere limit 50) x)
  union all select 8, 'H5 cost_documents source=import sin fila de importación', 'INFO', (select count(*) from import_without_row), (select jsonb_agg(x) from (select * from import_without_row limit 50) x)
  union all select 9, 'H6 cost_documents sin cost_lines', 'INFO', (select count(*) from documents_without_lines), (select jsonb_agg(x) from (select * from documents_without_lines limit 50) x)
  union all select 10, 'H7 cost_documents forzado como duplicado cuyo original ya no existe', 'INFO', (select count(*) from dangling_override), (select jsonb_agg(x) from (select * from dangling_override limit 50) x)
  union all select 11, 'H8 sugerencias de técnico vencidas (documento o cargos ya no aplican)', 'LIMPIA', (select count(*) from stale_suggestions where status = 'pending' and (documento_vinculado or cargos_inexistentes > 0 or cargos_ya_vinculados > 0)), (select jsonb_agg(x) from (select * from stale_suggestions where status = 'pending' and (documento_vinculado or cargos_inexistentes > 0 or cargos_ya_vinculados > 0) limit 50) x)
  union all select 12, 'H9 archivos en Storage cost-receipts sin fila de adjunto', 'INFO', (select count(*) from storage_without_row), (select jsonb_agg(x) from (select * from storage_without_row limit 50) x)
  union all select 13, 'H10 adjuntos sin archivo en Storage', 'INFO', (select count(*) from row_without_storage), (select jsonb_agg(x) from (select * from row_without_storage limit 50) x)
  union all select 14, 'H11 project_cost_confirmations de un mes que ya tiene costos directos', 'INFO', (select count(*) from stale_confirmations), (select jsonb_agg(x) from (select * from stale_confirmations limit 50) x)
  union all select 15, 'H12 import_rows (ventas) imported sin documento', 'INFO', (select count(*) from sales_rows_without_document), (select jsonb_agg(x) from (select * from sales_rows_without_document limit 50) x)
  union all select 16, 'A1 documentos importados con Estado anulado/rechazado/reclamado en el archivo', 'LIMPIA', (select count(*) from void_documents), (select jsonb_agg(x) from (select * from void_documents limit 50) x)
) checks
order by orden
