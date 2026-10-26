-- Antes de aplicar 20261026010000_technician_backing_documents en prod: qué va a hacer el backfill.
-- Solo lectura; usa columnas que existen ANTES de la migración (payment_document, no default_backing).
--
--   supabase db query --linked --project-ref <ref> -f docs/verificacion-tecnicos-prod-precheck.sql --output-format json > precheck.json
--
-- Devuelve:
--   charges_by_backing   cargos de Chile por el respaldo que van a tomar y el estado que van a quedar
--   reset_to_pending     cargos con factura/boleta marcados "recibida" a mano que pasan a "pendiente"
--   boleta_with_vat      cargos de técnicos con boleta cargados con IVA incluido (pasan a factura)
--   supplier_links       proveedores que se van a vincular a un técnico por RUT
--   ambiguous_suppliers  proveedores cuyo RUT coincide con más de un técnico (NO se vinculan)
with chile as (
  select id from public.companies
  where upper(btrim(coalesce(country, ''))) in ('CL', 'CHILE')
    and name not like 'QA-%' and name not like 'zz-test-e2e-%' and name not like 'TEST\_%'
),
norm as (
  select p.*, nullif(upper(regexp_replace(coalesce(p.tax_id, ''), '[^0-9A-Za-z]', '', 'g')), '') as rut,
         case p.payment_document when 'factura' then 'factura' when 'boleta_honorarios' then 'boleta' else 'none' end as backing
  from public.personnel p
  where p.type = 'contractor' and p.company_id in (select id from chile)
),
charges as (
  select tc.id, tc.document_status, tc.amount, tc.net_amount,
         case when n.backing = 'boleta' and tc.net_amount < tc.amount then 'factura' else n.backing end as new_backing,
         n.backing as usual_backing
  from public.technician_charges tc
  join norm n on n.id = tc.personnel_id
),
supplier_matches as (
  select s.id as supplier_id, s.name as supplier, s.tax_id, n.id as personnel_id, n.name as technician
  from public.suppliers s
  join norm n on n.company_id = s.company_id
    and n.rut = nullif(upper(regexp_replace(coalesce(s.tax_id, ''), '[^0-9A-Za-z]', '', 'g')), '')
  where n.rut is not null
)
select jsonb_build_object(
  'charges_by_backing', (
    select coalesce(jsonb_agg(x), '[]') from (
      select new_backing as backing,
             case when new_backing = 'none' then 'no_aplica' else 'pendiente' end as new_status,
             count(*) as charges, sum(amount) as a_pagar, sum(net_amount) as costo
      from charges group by new_backing
    ) x
  ),
  'reset_to_pending', (select count(*) from charges where new_backing <> 'none' and document_status = 'recibida'),
  'boleta_with_vat', (select count(*) from charges where usual_backing = 'boleta' and new_backing = 'factura'),
  'supplier_links', (
    select coalesce(jsonb_agg(x), '[]') from (
      select supplier, tax_id, technician from supplier_matches
      where supplier_id in (select supplier_id from supplier_matches group by supplier_id having count(*) = 1)
    ) x
  ),
  'ambiguous_suppliers', (
    select coalesce(jsonb_agg(x), '[]') from (
      select supplier, tax_id, string_agg(technician, ', ') as technicians
      from supplier_matches group by supplier_id, supplier, tax_id having count(*) > 1
    ) x
  )
) as precheck;
