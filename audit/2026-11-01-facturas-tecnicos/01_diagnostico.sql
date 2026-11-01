-- Facturas y boletas de técnicos cargadas como gasto de proveedor, y repartos
-- hechos con el total en vez del neto. Solo SELECT: se corre en prod y en dev.
-- Una sola sentencia para poder correrla con `supabase db query`.
-- Cada fila es un chequeo: `cantidad` y hasta 50 ejemplos en `detalle`.
with
technician_documents as (
  select d.id, d.company_id, ts.personnel_id, p.name as tecnico, s.name as proveedor, s.tax_id as rut,
         d.source_document_type as tipo, d.document_number as numero, d.document_date as fecha,
         d.net_amount as neto, d.tax_amount as iva, d.total_amount as total, d.classification as clasificacion, d.project_id,
         (select count(*) from public.cost_allocations a where a.cost_document_id = d.id) as filas_reparto,
         (select count(*) from public.cost_service_allocations a where a.cost_document_id = d.id and a.status = 'confirmed') as filas_servicios,
         (select coalesce(sum(l.cost_amount), 0) from public.technician_charge_documents l where l.cost_document_id = d.id) as aplicado
  from public.cost_documents d
  join public.technician_suppliers ts on ts.supplier_id = d.supplier_id
  join public.personnel p on p.id = ts.personnel_id
  join public.suppliers s on s.id = d.supplier_id
  where d.document_type = 'invoice'
    and d.source_document_type in ('FAC-EL', 'FAC-EE', 'BOL-HE', 'BOL-TE')
),
as_supplier_cost as (
  select * from technician_documents where aplicado = 0 and (clasificacion <> 'general' or project_id is not null or filas_reparto > 0 or filas_servicios > 0)
),
unassigned as (
  select * from technician_documents where aplicado = 0 and clasificacion = 'general' and project_id is null and filas_reparto = 0 and filas_servicios = 0
),
split_on_total as (
  select d.id, d.source_document_type as tipo, d.document_number as numero, d.document_date as fecha, s.name as proveedor,
         d.net_amount as neto, d.total_amount as total, sum(a.amount) as suma_importes,
         jsonb_agg(jsonb_build_object('destino', coalesce(pr.name, cl.name, ba.name), 'importe', a.amount) order by a.position) as filas
  from public.cost_allocations a
  join public.cost_documents d on d.id = a.cost_document_id
  left join public.suppliers s on s.id = d.supplier_id
  left join public.projects pr on pr.id = a.project_id
  left join public.clients cl on cl.id = a.client_id
  left join public.business_areas ba on ba.id = a.business_area_id
  where a.method = 'fixed_amount' and d.total_amount <> d.net_amount
  group by d.id, s.name
  having abs(sum(a.amount) + coalesce((select sum(x.amount) from public.cost_service_allocations x where x.cost_document_id = d.id and x.status = 'confirmed'), 0) - d.total_amount) <= 1
),
doubled as (
  select dx.id, dx.tecnico, dx.tipo, dx.numero, dx.neto, pr.name as trabajo, c.net_amount as costo_del_cargo, a.amount as importe_reparto
  from as_supplier_cost dx
  join public.cost_allocations a on a.cost_document_id = dx.id
  join public.projects pr on pr.id = a.project_id
  join public.technician_charges c on c.personnel_id = dx.personnel_id and c.project_id = a.project_id
),
fac_257 as (
  select dx.* from technician_documents dx where dx.tipo = 'FAC-EL' and dx.numero = '257'
),
technicians_without_rut as (
  select p.id, p.name, p.default_backing, (select count(*) from public.technician_charges c where c.personnel_id = p.id) as cargos
  from public.personnel p
  where p.type = 'contractor' and p.active
    and not exists (select 1 from public.technician_suppliers ts where ts.personnel_id = p.id)
    and exists (select 1 from public.technician_charges c where c.personnel_id = p.id and c.backing in ('factura', 'boleta'))
)
select chequeo, accion, cantidad, detalle from (
  select 1 as orden, 'T1 documentos de técnicos asignados o repartidos como gasto de proveedor' as chequeo, 'REVISAR' as accion, (select count(*) from as_supplier_cost) as cantidad, (select jsonb_agg(x) from (select * from as_supplier_cost order by fecha limit 50) x) as detalle
  union all select 2, 'T2 documentos de técnicos sin vincular ni asignar (quedan como costo general)', 'INFO', (select count(*) from unassigned), (select jsonb_agg(x) from (select tecnico, proveedor, tipo, numero, fecha, neto from unassigned order by fecha limit 50) x)
  union all select 3, 'T3 trabajos con el costo contado dos veces: tienen cargo del técnico y además una parte del reparto', 'REVISAR', (select count(*) from doubled), (select jsonb_agg(x) from (select * from doubled limit 50) x)
  union all select 4, 'R1 repartos con importes que suman el total con IVA en vez del neto', 'LA MIGRACION LOS CONVIERTE', (select count(*) from split_on_total), (select jsonb_agg(x) from (select * from split_on_total order by fecha limit 50) x)
  union all select 5, 'F257 cómo está la FAC-EL 257', 'VER 02_correccion_fac257.sql', (select count(*) from fac_257), (select jsonb_agg(x) from (select * from fac_257) x)
  union all select 6, 'P1 técnicos con cargos de factura o boleta y sin RUT vinculado: sus documentos no se reconocen', 'INFO', (select count(*) from technicians_without_rut), (select jsonb_agg(x) from (select * from technicians_without_rut limit 50) x)
) checks
order by orden
