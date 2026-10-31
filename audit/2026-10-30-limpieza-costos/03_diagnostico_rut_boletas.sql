-- Diagnóstico de RUT de técnicos y montos de boletas (puntos 10 y 11).
-- Solo SELECT. La fórmula de `canon` es la de normalize_tax_id desde 20261031020000
-- (sin puntos ni espacios, guion antes del DV, DV en mayúscula, sin ceros a la izquierda).
with
canon as (
  select raw, compact,
         case when compact ~ '^[0-9]+[0-9K]$'
              and length(regexp_replace(left(compact, -1), '^0+', '')) between 6 and 9
           then regexp_replace(left(compact, -1), '^0+', '') || '-' || right(compact, 1)
         end as rut
  from (
    select distinct tax_id as raw, upper(regexp_replace(tax_id, '[^0-9A-Za-z]', '', 'g')) as compact
    from (select tax_id from public.personnel union select tax_id from public.suppliers) t
    where tax_id is not null
  ) v
),
chile as (
  select id from public.companies where upper(btrim(coalesce(country, ''))) in ('CL', 'CHILE')
),
personnel_changes as (
  select p.id, p.name, p.tax_id, c.rut
  from public.personnel p
  join chile on chile.id = p.company_id
  join canon c on c.raw = p.tax_id
  where c.rut is not null and p.tax_id is distinct from c.rut
),
supplier_changes as (
  select s.id, s.name, s.tax_id, c.rut
  from public.suppliers s
  join chile on chile.id = s.company_id
  join canon c on c.raw = s.tax_id
  where c.rut is not null and s.tax_id is distinct from c.rut
),
not_a_rut as (
  select 'proveedor' as tipo, s.id, s.name, s.tax_id
  from public.suppliers s join chile on chile.id = s.company_id join canon c on c.raw = s.tax_id
  where c.rut is null
  union all
  select 'tecnico', p.id, p.name, p.tax_id
  from public.personnel p join chile on chile.id = p.company_id join canon c on c.raw = p.tax_id
  where c.rut is null and p.type = 'contractor'
),
missing_links as (
  select p.id as personnel_id, p.name as tecnico, p.tax_id as rut_ficha, s.id as supplier_id, s.name as proveedor, s.tax_id as rut_proveedor,
         (select count(*) from public.cost_documents d where d.supplier_id = s.id) as documentos
  from public.personnel p
  join chile on chile.id = p.company_id
  join canon cp on cp.raw = p.tax_id
  join public.suppliers s on s.company_id = p.company_id
  join canon cs on cs.raw = s.tax_id
  where p.type = 'contractor'
    and coalesce(cp.rut, cp.compact) = coalesce(cs.rut, cs.compact)
    and not exists (select 1 from public.technician_suppliers ts where ts.supplier_id = s.id)
),
ambiguous as (
  select p.company_id, coalesce(c.rut, c.compact) as rut, jsonb_agg(p.name) as tecnicos
  from public.personnel p
  join chile on chile.id = p.company_id
  join canon c on c.raw = p.tax_id
  where p.type = 'contractor'
  group by 1, 2
  having count(*) > 1
),
boletas as (
  select d.id, s.name as proveedor, d.source_document_type as tipo, d.document_number as numero, d.document_date as fecha,
         d.net_amount as neto_guardado, d.total_amount as total_guardado,
         nullif(r.raw_data->>'Neto', '')::numeric as neto_archivo,
         nullif(r.raw_data->>'Total', '')::numeric as total_archivo,
         (select w.rate from public.boleta_withholding_rates w where w.year <= extract(year from d.document_date)::int order by w.year desc limit 1) as tasa_tabla,
         r.raw_data->>'Estado' as estado
  from public.cost_documents d
  join public.suppliers s on s.id = d.supplier_id
  left join public.cost_import_rows r on r.id = d.import_row_id
  where d.source_document_type in ('BOL-HE', 'BOL-TE')
),
boletas_calculadas as (
  select *, neto_archivo - total_archivo as retencion_archivo,
         round((neto_archivo - total_archivo) / nullif(neto_archivo, 0), 4) as tasa_archivo
  from boletas
)
select chequeo, cantidad, detalle from (
  select 1 as orden, 'R1 RUT de técnicos que cambian de formato al normalizar' as chequeo, (select count(*) from personnel_changes) as cantidad, (select jsonb_agg(x) from personnel_changes x) as detalle
  union all select 2, 'R2 RUT de proveedores que cambian de formato al normalizar', (select count(*) from supplier_changes), (select jsonb_agg(x) from (select * from supplier_changes limit 50) x)
  union all select 3, 'R3 valores que no son un RUT (quedan como están)', (select count(*) from not_a_rut), (select jsonb_agg(x) from (select * from not_a_rut limit 50) x)
  union all select 4, 'R4 técnico con RUT en la ficha y proveedor con ese RUT, sin vincular', (select count(*) from missing_links), (select jsonb_agg(x) from missing_links x)
  union all select 5, 'R5 un mismo RUT en más de un técnico (no se vincula solo)', (select count(*) from ambiguous), (select jsonb_agg(x) from ambiguous x)
  union all select 6, 'B1 boletas importadas: neto guardado distinto del Neto del archivo', (select count(*) from boletas_calculadas where neto_guardado <> neto_archivo), (select jsonb_agg(x) from (select * from boletas_calculadas where neto_guardado <> neto_archivo) x)
  union all select 7, 'B2 boletas sin fila de importación (sin archivo para contrastar)', (select count(*) from boletas_calculadas where neto_archivo is null), (select jsonb_agg(x) from (select * from boletas_calculadas where neto_archivo is null) x)
  union all select 8, 'B3 boletas cuya retención del archivo no es la tasa de su año (±0,1 punto) o sin tasa en la tabla', (select count(*) from boletas_calculadas where tasa_tabla is null or abs(tasa_archivo - tasa_tabla) > 0.001), (select jsonb_agg(x) from (select id, proveedor, tipo, numero, fecha, neto_archivo, total_archivo, tasa_archivo, tasa_tabla from boletas_calculadas where tasa_tabla is null or abs(tasa_archivo - tasa_tabla) > 0.001 order by fecha) x)
  union all select 9, 'B4 todas las boletas con bruto, retención y líquido según el archivo', (select count(*) from boletas_calculadas), (select jsonb_agg(x) from (select proveedor, tipo, numero, fecha, neto_archivo as bruto, retencion_archivo as retencion, total_archivo as liquido, tasa_archivo as tasa, estado from boletas_calculadas order by fecha) x)
) checks
order by orden
