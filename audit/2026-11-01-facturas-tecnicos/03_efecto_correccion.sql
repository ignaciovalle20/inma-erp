-- Qué costo tienen los 4 trabajos y el documento: antes y después de la corrección,
-- para comparar. Solo SELECT, en una sola sentencia.
with fac as (
  select d.* from public.cost_documents d
  where d.source_document_type = 'FAC-EL' and d.document_number = '257' and d.net_amount = 2147053
),
projects as (
  select p.id, p.name from public.projects p
  join fac on fac.company_id = p.company_id
  where p.name in ('Redes en colegios del interior', 'STARLINK La Ligua', 'Tintas Wind', 'Control de acceso HIK')
)
select
  (select jsonb_agg(jsonb_build_object(
      'clasificacion', f.classification,
      'neto', f.net_amount,
      'aplicado_a_cargos', public.technician_linked_amount(f),
      'queda_como_costo_general', f.net_amount - public.technician_linked_amount(f) - coalesce((select sum(a.amount) from public.cost_allocations a where a.cost_document_id = f.id), 0)
    )) from fac f) as documento,
  (select jsonb_agg(jsonb_build_object(
      'trabajo', p.name,
      'parte_del_reparto', coalesce((select sum(a.amount) from public.cost_allocations a join fac on fac.id = a.cost_document_id where a.project_id = p.id), 0),
      'aplicado_en_cargos', coalesce((select sum(l.cost_amount) from public.technician_charge_documents l join fac on fac.id = l.cost_document_id join public.technician_charges c on c.id = l.charge_id where c.project_id = p.id), 0)
    ) order by p.name) from projects p) as trabajos
