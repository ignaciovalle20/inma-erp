-- Verificación de datos para la migración 20261026010000_technician_backing_documents
-- (técnicos: respaldo de cargos y vínculo con facturas y boletas).
--
-- Una sola consulta de solo lectura que devuelve un JSON con:
--   charges          cada cargo: montos, lo pagado y su costo (propio o vinculado)
--   payments         total pagado por técnico
--   months           costos por empresa y mes de 2026 (neto, por período efectivo)
--   projects         costo de cada trabajo en 2026 (directos + parte de los repartos, en neto)
--   fingerprint      cantidad y md5 de las tablas de costos y técnicos
--
-- Uso (antes y después de aplicar la migración; guardar las dos salidas y compararlas):
--   supabase db query --linked --project-ref <ref> -f docs/verificacion-tecnicos-prod.sql --output-format json > antes.json
--   ... aplicar la migración ...
--   supabase db query --linked --project-ref <ref> -f docs/verificacion-tecnicos-prod.sql --output-format json > despues.json
--
-- Qué tiene que dar igual antes y después:
--   charges[*].amount, net_amount, paid, own_net, own_total (por id); payments; months; projects.
-- Qué cambia a propósito (columnas que no se comparan):
--   charges[*].backing y document_status (backfill), y el md5 de technician_charges / personnel
--   (columnas nuevas). cost_documents, cost_lines, cost_allocations y los pagos no cambian.
--
-- Funciona antes de la migración (no usa columnas nuevas: backing y document_status se leen
-- de to_jsonb(), que devuelve null si la columna no existe) y después.
-- Las empresas de prueba (nombre "QA-%", "zz-test-e2e-%", "TEST_%") quedan afuera.
with real_companies as (
  select id
  from public.companies
  where name not like 'QA-%' and name not like 'zz-test-e2e-%' and name not like 'TEST\_%'
),
paid as (
  select a.charge_id, sum(a.amount) as paid
  from public.technician_payment_applications a
  group by a.charge_id
),
charges as (
  select
    tc.id,
    tc.company_id,
    tc.personnel_id,
    tc.project_id,
    tc.charge_date,
    tc.amount,
    tc.net_amount,
    to_jsonb(tc) ->> 'backing' as backing,
    tc.document_status,
    coalesce(p.paid, 0) as paid,
    cd.net_amount as own_net,
    cd.total_amount as own_total
  from public.technician_charges tc
  join real_companies rc on rc.id = tc.company_id
  left join paid p on p.charge_id = tc.id
  left join public.cost_documents cd on cd.id = tc.cost_document_id
),
documents as (
  select
    cd.*,
    to_char(coalesce(cd.recognized_period, cd.document_date), 'YYYY-MM') as month
  from public.cost_documents cd
  join real_companies rc on rc.id = cd.company_id
),
months as (
  select company_id, month, sum(net_amount) as net, count(*) as documents
  from documents
  where month like '2026-%'
  group by company_id, month
),
project_costs as (
  select project_id, sum(net) as net
  from (
    select d.project_id, d.net_amount as net
    from documents d
    where d.classification = 'direct' and d.month like '2026-%'
    union all
    select
      ca.project_id,
      case
        when d.total_amount = 0 then 0
        else (case when ca.method = 'percentage' then round(d.total_amount * ca.percentage / 100, 2) else ca.amount end)
          * d.net_amount / d.total_amount
      end
    from public.cost_allocations ca
    join documents d on d.id = ca.cost_document_id
    where ca.project_id is not null and d.month like '2026-%'
  ) parts
  group by project_id
),
payments as (
  select tp.personnel_id, count(*) as payments, sum(tp.amount) as amount
  from public.technician_payments tp
  join real_companies rc on rc.id = tp.company_id
  group by tp.personnel_id
)
select jsonb_build_object(
  'taken_at', now(),
  'charges', (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from charges c),
  'payments', (select coalesce(jsonb_agg(to_jsonb(p) order by p.personnel_id), '[]') from payments p),
  'months', (select coalesce(jsonb_agg(to_jsonb(m) order by m.company_id, m.month), '[]') from months m),
  'projects', (select coalesce(jsonb_agg(jsonb_build_object('project_id', pc.project_id, 'net', round(pc.net, 2)) order by pc.project_id), '[]') from project_costs pc),
  'fingerprint', jsonb_build_object(
    'cost_documents', (select jsonb_build_object('n', count(*), 'md5', md5(coalesce(string_agg(x::text, '|' order by x.id), ''))) from (select cd.id, cd.company_id, cd.supplier_id, cd.project_id, cd.classification, cd.document_date, cd.recognized_period, cd.net_amount, cd.tax_amount, cd.total_amount from documents cd) x),
    'cost_lines', (select jsonb_build_object('n', count(*), 'md5', md5(coalesce(string_agg(x::text, '|' order by x.id), ''))) from (select l.id, l.cost_document_id, l.amount from public.cost_lines l join documents d on d.id = l.cost_document_id) x),
    'cost_allocations', (select jsonb_build_object('n', count(*), 'md5', md5(coalesce(string_agg(x::text, '|' order by x.id), ''))) from (select a.id, a.cost_document_id, a.project_id, a.client_id, a.business_area_id, a.method, a.percentage, a.amount from public.cost_allocations a join documents d on d.id = a.cost_document_id) x),
    'cost_service_allocations', (select jsonb_build_object('n', count(*), 'md5', md5(coalesce(string_agg(x::text, '|' order by x.id), ''))) from (select a.id, a.cost_document_id, a.cost_period_id, a.amount, a.status from public.cost_service_allocations a join documents d on d.id = a.cost_document_id) x),
    'technician_payment_applications', (select jsonb_build_object('n', count(*), 'md5', md5(coalesce(string_agg(x::text, '|' order by x.id), ''))) from (select a.id, a.payment_id, a.charge_id, a.amount from public.technician_payment_applications a join real_companies rc on rc.id = a.company_id) x)
  )
) as verification;
