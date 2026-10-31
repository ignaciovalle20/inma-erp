-- Después de 20261031030000: cada boleta con su bruto, retención y líquido guardados,
-- contra lo que dice su archivo. `cuadra_archivo` debe dar true en todas. Solo SELECT.
select s.name as proveedor, d.source_document_type as tipo, d.document_number as numero, d.document_date as fecha,
       d.net_amount as bruto, d.withholding_amount as retencion, d.liquid_amount as liquido, d.total_amount as total_costo,
       (r.raw_data->>'Neto')::numeric as neto_archivo, (r.raw_data->>'Total')::numeric as total_archivo,
       d.net_amount = (r.raw_data->>'Neto')::numeric and d.liquid_amount = (r.raw_data->>'Total')::numeric as cuadra_archivo
from public.cost_documents d
join public.suppliers s on s.id = d.supplier_id
left join public.cost_import_rows r on r.id = d.import_row_id
where d.source_document_type in ('BOL-HE', 'BOL-TE')
order by d.document_date, d.document_number
