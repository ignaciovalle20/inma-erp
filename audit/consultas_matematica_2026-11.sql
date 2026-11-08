-- Auditoría matemática 2026-11: consultas de solo lectura.
--
-- Todas son SELECT/WITH. Se corrieron en prod (jxkfpkgyvjiyufmfxsfp) con
--   supabase db query --remote=<ref> --read-only -f <archivo>
-- (transacción READ ONLY), una por bloque. Cada bloque empieza con
-- "-- @check <ID>" y devuelve las filas problemáticas (0 filas = sano), salvo
-- los bloques "-- @recalc", que devuelven totales para la conciliación.
--
-- Tolerancias: CLP 0 (pesos enteros); USD/UYU 0,005 salvo que se diga otra cosa.
-- Resultado de la corrida: audit/INFORME_MATEMATICA_2026-11.md, §3 y §4.

-- =====================================================================
-- 1. Documentos de venta
-- =====================================================================

-- @check V01_ventas_neto_iva_total
-- neto + IVA + otros impuestos = total.
select c.name as empresa, s.id, s.document_type, s.document_number, s.document_date, s.currency,
       s.net_amount, s.tax_amount, s.other_taxes, s.total_amount,
       s.net_amount + s.tax_amount + coalesce(s.other_taxes, 0) - s.total_amount as diferencia
from sales_documents s
join companies c on c.id = s.company_id
where abs(s.net_amount + s.tax_amount + coalesce(s.other_taxes, 0) - s.total_amount)
      > case when s.currency = 'CLP' then 0 else 0.005 end
order by abs(s.net_amount + s.tax_amount + coalesce(s.other_taxes, 0) - s.total_amount) desc;

-- @check V02_ventas_lineas_vs_neto
-- La suma de las líneas = neto del documento.
with l as (select sales_document_id, sum(amount) as lineas, count(*) as n from sales_lines group by 1)
select c.name as empresa, s.id, s.document_type, s.document_number, s.document_date, s.currency, s.voided,
       s.net_amount, coalesce(l.lineas, 0) as lineas, coalesce(l.n, 0) as n_lineas,
       s.net_amount - coalesce(l.lineas, 0) as diferencia
from sales_documents s
join companies c on c.id = s.company_id
left join l on l.sales_document_id = s.id
where abs(s.net_amount - coalesce(l.lineas, 0)) > case when s.currency = 'CLP' then 0 else 0.005 end
order by abs(s.net_amount - coalesce(l.lineas, 0)) desc;

-- @check V03_ventas_decimales
-- CLP sin decimales; USD/UYU con 2 como máximo (documento y líneas).
select c.name as empresa, s.id, s.document_number, s.currency, s.net_amount, s.tax_amount, s.total_amount
from sales_documents s
join companies c on c.id = s.company_id
where (s.currency = 'CLP' and (s.net_amount <> trunc(s.net_amount) or s.tax_amount <> trunc(s.tax_amount) or s.total_amount <> trunc(s.total_amount)))
   or (s.currency <> 'CLP' and (s.net_amount <> round(s.net_amount, 2) or s.tax_amount <> round(s.tax_amount, 2) or s.total_amount <> round(s.total_amount, 2)))
   or exists (
     select 1 from sales_lines l where l.sales_document_id = s.id
       and l.amount <> round(l.amount, case when s.currency = 'CLP' then 0 else 2 end));

-- @check V04_ventas_iva_vs_tasa
-- IVA de cada factura contra neto x tasa (Chile 19 %; Uruguay 22 % básica o 10 % mínima).
-- Tolerancia: 1 peso / 0,01 por documento (redondeo por línea en el origen).
select c.name as empresa, s.id, s.document_type, s.document_number, s.document_date, s.currency,
       s.net_amount, s.tax_amount,
       round(s.tax_amount / nullif(s.net_amount, 0), 4) as tasa_efectiva
from sales_documents s
join companies c on c.id = s.company_id
where not s.voided and s.document_type <> 'manual' and s.tax_amount <> 0
  and not (
    (c.country = 'CL' and abs(s.tax_amount - round(s.net_amount * 0.19)) <= 1)
    or (c.country = 'UY' and (abs(s.tax_amount - round(s.net_amount * 0.22, 2)) <= 0.01
                              or abs(s.tax_amount - round(s.net_amount * 0.10, 2)) <= 0.01))
  )
order by s.document_date;

-- @check V05_ventas_moneda_incoherente
-- Chile solo CLP; Uruguay USD o UYU. Ventas, costos, ciclos, períodos de costo y pools.
select 'venta' as tabla, c.name as empresa, s.id, s.currency from sales_documents s join companies c on c.id = s.company_id
 where (c.country = 'CL' and s.currency <> 'CLP') or (c.country = 'UY' and s.currency not in ('USD', 'UYU'))
union all
select 'costo', c.name, d.id, d.currency from cost_documents d join companies c on c.id = d.company_id
 where (c.country = 'CL' and d.currency <> 'CLP') or (c.country = 'UY' and d.currency not in ('USD', 'UYU'))
union all
select 'ciclo', c.name, o.id, o.currency from recurring_service_occurrences o join recurring_services rs on rs.id = o.recurring_service_id join companies c on c.id = rs.company_id
 where (c.country = 'CL' and o.currency <> 'CLP') or (c.country = 'UY' and o.currency not in ('USD', 'UYU')) or o.currency <> rs.currency
union all
select 'periodo_costo', c.name, p.id, p.currency from recurring_service_cost_periods p join companies c on c.id = p.company_id
 where (c.country = 'CL' and p.currency <> 'CLP') or (c.country = 'UY' and p.currency not in ('USD', 'UYU'))
union all
select 'pool', c.name, p.id, p.currency from recurring_service_cost_pools p join companies c on c.id = p.company_id
 where (c.country = 'CL' and p.currency <> 'CLP') or (c.country = 'UY' and p.currency not in ('USD', 'UYU'))
union all
select 'personal', c.name, pc.id, pc.currency from personnel_costs pc join personnel pe on pe.id = pc.personnel_id join companies c on c.id = pe.company_id
 where (c.country = 'CL' and pc.currency <> 'CLP') or (c.country = 'UY' and pc.currency not in ('USD', 'UYU'));

-- @check V06_ventas_signos
-- Montos guardados positivos en ventas (la N/C resta al leer); ninguna negativa.
select c.name as empresa, s.id, s.document_type, s.document_number, s.net_amount, s.tax_amount, s.total_amount
from sales_documents s join companies c on c.id = s.company_id
where s.net_amount < 0 or s.tax_amount < 0 or s.total_amount < 0
   or exists (select 1 from sales_lines l where l.sales_document_id = s.id and l.amount < 0);

-- @check V07_notas_de_credito_venta
-- Todas las N/C de venta: a qué anulan, si superan al documento anulado y si
-- quedan sin área ni trabajo (en ese caso no aparecen en la rentabilidad por área).
select c.name as empresa, s.id, s.document_number, s.document_date, s.currency, s.net_amount, s.voided,
       s.annuls_document_id, a.document_number as anula_a, a.net_amount as neto_anulado, a.voided as anulado_voided,
       s.business_area_id is null and s.project_id is null as sin_area_ni_trabajo,
       a.net_amount is not null and s.net_amount > a.net_amount as supera_al_anulado
from sales_documents s
join companies c on c.id = s.company_id
left join sales_documents a on a.id = s.annuls_document_id
where s.document_type = 'credit_note'
order by s.document_date;

-- @check V08_tasa_guardada_desactualizada
-- Documentos en otra moneda que la de su empresa sin tasa, o con la tasa de un
-- mes anterior (fallback "el más cercano anterior") cuando hoy ya existe el
-- snapshot de su propio mes. diferencia_local = lo que cambiaría el monto en
-- moneda local con la tasa del mes.
with docs as (
  select 'venta' as tabla, s.id, s.company_id, s.document_number, s.document_date, s.currency,
         case when s.document_type = 'credit_note' then -s.net_amount else s.net_amount end as neto,
         s.exchange_rate, s.exchange_rate_period, s.voided
  from sales_documents s
  union all
  select 'costo', d.id, d.company_id, d.document_number, d.document_date, d.currency, d.net_amount,
         d.exchange_rate, d.exchange_rate_period, false
  from cost_documents d
), r as (
  select x.*, c.name as empresa, c.currency as moneda_empresa,
         (select s.ars_per_unit / s.ars_per_usd from exchange_rate_snapshots s
           where s.currency = c.currency and s.period = date_trunc('month', x.document_date)::date) as usd_por_local_mes,
         (select s.ars_per_unit / s.ars_per_usd from exchange_rate_snapshots s
           where s.currency = x.currency and s.period = date_trunc('month', x.document_date)::date) as usd_por_doc_mes
  from docs x join companies c on c.id = x.company_id
  where x.currency <> c.currency and not x.voided
)
select empresa, tabla, id, document_number, document_date, currency, neto, exchange_rate, exchange_rate_period,
       case when currency = 'USD' then 1 else usd_por_doc_mes end / nullif(usd_por_local_mes, 0) as tasa_del_mes,
       round(neto * (case when currency = 'USD' then 1 else usd_por_doc_mes end / nullif(usd_por_local_mes, 0) - exchange_rate), 2) as diferencia_local
from r
where exchange_rate is null
   or (exchange_rate_period is distinct from date_trunc('month', document_date)::date
       and usd_por_local_mes is not null
       and (currency = 'USD' or usd_por_doc_mes is not null))
order by document_date;

-- @check V09_tasa_igual_moneda
-- Documento en la moneda de su empresa: la tasa guardada tiene que ser 1.
select 'venta' as tabla, s.id, s.currency, s.exchange_rate from sales_documents s join companies c on c.id = s.company_id
 where s.currency = c.currency and s.exchange_rate is distinct from 1
union all
select 'costo', d.id, d.currency, d.exchange_rate from cost_documents d join companies c on c.id = d.company_id
 where d.currency = c.currency and d.exchange_rate is distinct from 1;

-- @check V10_asignaciones_venta_exceden
-- Asignaciones (confirmadas o sugeridas) que superan el neto del documento.
select c.name as empresa, s.id, s.document_number, s.currency, s.net_amount,
       sum(a.amount) filter (where a.status = 'confirmed') as confirmadas,
       sum(a.amount) as todas,
       sum(a.amount) filter (where a.status = 'confirmed') - s.net_amount as exceso_confirmadas
from sales_allocations a
join sales_documents s on s.id = a.sales_document_id
join companies c on c.id = s.company_id
group by c.name, s.id, s.document_number, s.currency, s.net_amount
having sum(a.amount) > s.net_amount + case when s.currency = 'CLP' then 0.5 else 0.005 end;

-- @check V11_asignaciones_en_anuladas
-- Asignaciones confirmadas a documentos anulados (voided o con N/C que los anula):
-- siguen sumando como facturado del período / de la cotización.
select c.name as empresa, s.id, s.document_number, s.document_date, s.net_amount, s.voided,
       s.annulled_by_document_id, a.status, a.amount,
       a.recurring_service_period_id, a.project_quote_id
from sales_allocations a
join sales_documents s on s.id = a.sales_document_id
join companies c on c.id = s.company_id
where s.voided or s.annulled_by_document_id is not null;

-- @check V12_asignacion_moneda_distinta
-- Factura asignada a un período de otra moneda: no suma al facturado del período
-- (recurring_service_period_summary solo suma la misma moneda) pero sí lo marca facturado.
select c.name as empresa, s.document_number, s.currency as moneda_factura, o.currency as moneda_periodo,
       a.amount, a.status, rs.name as servicio, o.period
from sales_allocations a
join sales_documents s on s.id = a.sales_document_id
join recurring_service_occurrences o on o.id = a.recurring_service_period_id
join recurring_services rs on rs.id = o.recurring_service_id
join companies c on c.id = s.company_id
where s.currency <> o.currency;

-- =====================================================================
-- 2. Documentos de costo
-- =====================================================================

-- @check C01_costos_neto_iva_total
-- neto (incluye exento) + IVA + otros = total, con el signo de la N/C.
select c.name as empresa, d.id, d.document_type, d.source_document_type, d.document_number, d.document_date, d.currency,
       d.net_amount, d.exempt_amount, d.tax_amount, d.other_taxes, d.total_amount, d.withholding_amount, d.liquid_amount,
       d.net_amount + d.tax_amount + coalesce(d.other_taxes, 0) - d.total_amount as diferencia
from cost_documents d
join companies c on c.id = d.company_id
where abs(d.net_amount + d.tax_amount + coalesce(d.other_taxes, 0) - d.total_amount)
      > case when d.currency = 'CLP' then 0 else 0.005 end
order by abs(d.net_amount + d.tax_amount + coalesce(d.other_taxes, 0) - d.total_amount) desc;

-- @check C02_costos_lineas_vs_neto
-- Documentos con líneas cuya suma no es el neto.
with l as (select cost_document_id, sum(amount) as lineas, count(*) as n from cost_lines group by 1)
select c.name as empresa, d.id, d.document_type, d.document_number, d.document_date, d.currency,
       d.net_amount, l.lineas, l.n, d.net_amount - l.lineas as diferencia
from cost_documents d
join companies c on c.id = d.company_id
join l on l.cost_document_id = d.id
where abs(d.net_amount - l.lineas) > case when d.currency = 'CLP' then 0 else 0.005 end;

-- @check C03_costos_decimales
select c.name as empresa, d.id, d.document_number, d.currency, d.net_amount, d.tax_amount, d.total_amount
from cost_documents d join companies c on c.id = d.company_id
where (d.currency = 'CLP' and (d.net_amount <> trunc(d.net_amount) or d.tax_amount <> trunc(d.tax_amount) or d.total_amount <> trunc(d.total_amount)))
   or (d.currency <> 'CLP' and (d.net_amount <> round(d.net_amount, 2) or d.tax_amount <> round(d.tax_amount, 2) or d.total_amount <> round(d.total_amount, 2)));

-- @check C04_costos_signos
-- N/C negativa (CHECK), factura/boleta positiva.
select c.name as empresa, d.id, d.document_type, d.source_document_type, d.document_number, d.net_amount, d.total_amount
from cost_documents d join companies c on c.id = d.company_id
where (d.document_type = 'credit_note' and (d.net_amount > 0 or d.total_amount > 0))
   or (d.document_type <> 'credit_note' and (d.net_amount < 0 or d.total_amount < 0))
   or (d.source_document_type ilike 'N/C%' and d.document_type <> 'credit_note');

-- @check C05_costos_iva_vs_tasa
-- IVA de las facturas de compra contra neto gravado x tasa (neto - exento).
select c.name as empresa, d.id, d.source_document_type, d.document_number, d.document_date, d.currency,
       d.net_amount, d.exempt_amount, d.tax_amount,
       round(d.tax_amount / nullif(d.net_amount - coalesce(d.exempt_amount, 0), 0), 4) as tasa_efectiva
from cost_documents d
join companies c on c.id = d.company_id
where d.tax_amount <> 0
  and not (
    (c.country = 'CL' and abs(abs(d.tax_amount) - round(abs(d.net_amount - coalesce(d.exempt_amount, 0)) * 0.19)) <= 1)
    or (c.country = 'UY' and (abs(abs(d.tax_amount) - round(abs(d.net_amount - coalesce(d.exempt_amount, 0)) * 0.22, 2)) <= 0.01
                              or abs(abs(d.tax_amount) - round(abs(d.net_amount - coalesce(d.exempt_amount, 0)) * 0.10, 2)) <= 0.01))
  )
order by d.document_date;

-- @check C06_boletas_retencion
-- Boletas de honorarios (BOL-HE/BOL-TE o con retención): retención = round(bruto x tasa del año),
-- líquido = bruto - retención. Bruto = net_amount.
select c.name as empresa, d.id, d.source_document_type, d.document_number, d.document_date,
       d.net_amount as bruto, d.withholding_amount as retencion, d.liquid_amount as liquido, d.total_amount,
       r.rate as tasa_del_anio,
       round(d.net_amount * r.rate) as retencion_esperada,
       d.net_amount - round(d.net_amount * r.rate) as liquido_esperado
from cost_documents d
join companies c on c.id = d.company_id
left join lateral (
  select rate from boleta_withholding_rates w
  where w.year <= extract(year from d.document_date) order by w.year desc limit 1
) r on true
where (upper(coalesce(d.source_document_type, '')) in ('BOL-HE', 'BOL-TE') or coalesce(d.withholding_amount, 0) <> 0 or d.liquid_amount is not null)
  and (d.withholding_amount is null or d.liquid_amount is null
       or abs(d.withholding_amount - round(d.net_amount * r.rate)) > 1
       or d.liquid_amount <> d.net_amount - d.withholding_amount);

-- @check C07_repartos_costo
-- cost_allocations por documento: % que no suman 100; montos fijos que no suman el neto.
select c.name as empresa, d.id, d.document_number, d.document_date, d.currency, d.net_amount, d.total_amount,
       string_agg(distinct a.method, ',') as metodos,
       sum(a.percentage) filter (where a.method = 'percentage') as suma_pct,
       sum(a.amount) filter (where a.method <> 'percentage') as suma_montos,
       count(*) as n
from cost_allocations a
join cost_documents d on d.id = a.cost_document_id
join companies c on c.id = d.company_id
group by c.name, d.id, d.document_number, d.document_date, d.currency, d.net_amount, d.total_amount
having (count(*) filter (where a.method = 'percentage') = count(*) and abs(sum(a.percentage) - 100) > 0.0001)
    or (count(*) filter (where a.method <> 'percentage') = count(*)
        and abs(sum(a.amount) - d.net_amount) > case when d.currency = 'CLP' then 0 else 0.005 end)
    or (count(*) filter (where a.method = 'percentage') between 1 and count(*) - 1);

-- @check C08_asignaciones_servicio_exceden
-- cost_service_allocations confirmadas que superan el neto (y su bruto).
select c.name as empresa, d.id, d.document_number, d.currency, d.net_amount,
       sum(a.amount) filter (where a.status = 'confirmed') as asignado,
       sum(a.amount) filter (where a.status = 'confirmed') - d.net_amount as exceso
from cost_service_allocations a
join cost_documents d on d.id = a.cost_document_id
join companies c on c.id = d.company_id
group by c.name, d.id, d.document_number, d.currency, d.net_amount
having coalesce(sum(a.amount) filter (where a.status = 'confirmed'), 0) > d.net_amount + case when d.currency = 'CLP' then 0.5 else 0.005 end;

-- @check C09_vinculo_tecnico_excede_neto
-- Factura/boleta vinculada a cargos por más que su neto: su resto como gasto general queda negativo.
select c.name as empresa, d.id, d.source_document_type, d.document_number, d.document_date, d.classification, d.project_id,
       d.net_amount, sum(l.cost_amount) as vinculado, d.net_amount - sum(l.cost_amount) as resto_general
from technician_charge_documents l
join cost_documents d on d.id = l.cost_document_id
join companies c on c.id = d.company_id
group by c.name, d.id, d.source_document_type, d.document_number, d.document_date, d.classification, d.project_id, d.net_amount
having sum(l.cost_amount) > d.net_amount or d.classification <> 'general' or d.project_id is not null
    or exists (select 1 from cost_allocations ca where ca.cost_document_id = d.id);

-- @check C10_cubiertos_por_pool
-- Documentos que ningún reporte suma porque los cubre el pool de licencias MS, contra el total del pool.
-- Misma regla que covered_by_cost_pool_id (20261020010000), escrita en línea: el rol de solo
-- lectura no tiene EXECUTE sobre esa función. Área MS = is_ms_licenses_area.
with ms_area as (
  select a.id from business_areas a
  where lower(btrim(a.name)) in ('microsoft 365', 'licencias ms', 'licencias microsoft')
     or exists (select 1 from recurring_services s where s.business_area_id = a.id and s.company_id = a.company_id and s.service_type = 'ms_licenses')
)
select c.name as empresa, d.id, s.name as proveedor, d.source_document_type, d.document_number, d.document_date,
       d.net_amount, d.total_amount, p.period as periodo_pool, p.total_expense_amount as total_pool,
       sum(d.net_amount) over (partition by p.id) as suma_netos_cubiertos
from cost_documents d
join companies c on c.id = d.company_id
left join suppliers s on s.id = d.supplier_id
join recurring_service_cost_pools p
  on p.company_id = d.company_id and p.service_type = 'ms_licenses'
 and p.period = coalesce(d.recognized_period, date_trunc('month', d.document_date)::date)
where not exists (select 1 from cost_service_allocations a where a.cost_document_id = d.id and a.status = 'confirmed')
  and not exists (select 1 from projects pr where pr.id = d.project_id and pr.business_area_id not in (select id from ms_area))
  and not exists (
    select 1 from cost_allocations ca left join projects pr on pr.id = ca.project_id
    where ca.cost_document_id = d.id
      and ((ca.business_area_id is not null and ca.business_area_id not in (select id from ms_area))
        or (ca.project_id is not null and pr.business_area_id not in (select id from ms_area))))
  and ((p.supplier_id is not null and p.supplier_id = d.supplier_id)
    or exists (select 1 from projects pr where pr.id = d.project_id and pr.business_area_id in (select id from ms_area))
    or exists (select 1 from cost_allocations ca left join projects pr on pr.id = ca.project_id
               where ca.cost_document_id = d.id
                 and (ca.business_area_id in (select id from ms_area) or pr.business_area_id in (select id from ms_area))));

-- @check C11_proveedor_ms_sin_pool
-- Facturas del proveedor de licencias (el del pool de algún mes) en meses SIN pool:
-- esos meses el costo MS entra como gasto general y los servicios MS quedan con costo 0.
with prov as (select distinct company_id, supplier_id from recurring_service_cost_pools where supplier_id is not null)
select c.name as empresa, s.name as proveedor, date_trunc('month', coalesce(d.recognized_period, d.document_date))::date as mes,
       count(*) as documentos, sum(d.net_amount) as neto,
       bool_or(d.classification = 'direct') as alguno_directo
from cost_documents d
join prov on prov.company_id = d.company_id and prov.supplier_id = d.supplier_id
join companies c on c.id = d.company_id
join suppliers s on s.id = d.supplier_id
where not exists (
  select 1 from recurring_service_cost_pools p
  where p.company_id = d.company_id and p.service_type = 'ms_licenses'
    and p.period = date_trunc('month', coalesce(d.recognized_period, d.document_date))::date)
  and d.document_date >= '2026-01-01'
group by 1, 2, 3
order by 3;

-- =====================================================================
-- 3. Técnicos
-- =====================================================================

-- @check T01_formula_cargo
-- Neto del cargo según su respaldo:
--   sin respaldo (Chile 'none' o Uruguay null): neto = monto, sin IVA incluido.
--   factura: neto = round(total / 1,19) o total = neto + round(neto x 19 %).
--   boleta: bruto = round(líquido / (1 - tasa)) o líquido = bruto - round(bruto x tasa), tasa del año.
select c.name as empresa, t.id, p.name as tecnico, t.charge_date, t.backing, t.entered_as, t.vat_included, t.vat_rate,
       t.withholding_rate, t.amount as a_pagar, t.net_amount as costo,
       r.rate as tasa_boleta_anio
from technician_charges t
join companies c on c.id = t.company_id
join personnel p on p.id = t.personnel_id
left join lateral (
  select rate from boleta_withholding_rates w where w.year <= extract(year from t.charge_date) order by w.year desc limit 1
) r on true
where (coalesce(t.backing, 'none') = 'none' and (t.amount <> t.net_amount or t.vat_included))
   or (t.backing = 'factura' and not (t.net_amount = round(t.amount / 1.19) or t.amount = t.net_amount + round(t.net_amount * 0.19)))
   or (t.backing = 'boleta' and (t.withholding_rate is distinct from r.rate
        or not (t.net_amount = round(t.amount / (1 - r.rate)) or t.amount = t.net_amount - round(t.net_amount * r.rate))));

-- @check T02_cargo_vs_su_costo
-- Cada cargo tiene su propio documento de costo directo, del mismo trabajo, con su neto
-- y su total (a pagar; bruto en boleta) y en el mes del cargo.
select c.name as empresa, t.id, t.charge_date, d.document_date, t.backing, t.amount, t.net_amount,
       d.net_amount as doc_neto, d.total_amount as doc_total, d.classification, d.currency,
       t.project_id = d.project_id as mismo_trabajo
from technician_charges t
join companies c on c.id = t.company_id
left join cost_documents d on d.id = t.cost_document_id
where d.id is null or d.classification <> 'direct' or d.project_id is distinct from t.project_id
   or d.net_amount <> t.net_amount
   or d.total_amount <> case when t.backing = 'boleta' then t.net_amount else t.amount end
   or date_trunc('month', d.document_date) <> date_trunc('month', t.charge_date)
   or d.currency <> c.currency;

-- @check T03_pago_vs_aplicaciones
-- Un pago = la suma de sus aplicaciones.
select c.name as empresa, pa.id, pe.name as tecnico, pa.payment_date, pa.amount,
       coalesce(sum(a.amount), 0) as aplicado, pa.amount - coalesce(sum(a.amount), 0) as sin_aplicar
from technician_payments pa
join companies c on c.id = pa.company_id
join personnel pe on pe.id = pa.personnel_id
left join technician_payment_applications a on a.payment_id = pa.id
group by c.name, pa.id, pe.name, pa.payment_date, pa.amount
having pa.amount <> coalesce(sum(a.amount), 0);

-- @check T04_cargo_sobrepagado
-- Lo pagado a un cargo no supera lo que se le debe (a pagar).
select c.name as empresa, t.id, pe.name as tecnico, t.charge_date, t.amount as a_pagar,
       sum(a.amount) as pagado, sum(a.amount) - t.amount as exceso
from technician_charges t
join companies c on c.id = t.company_id
join personnel pe on pe.id = t.personnel_id
join technician_payment_applications a on a.charge_id = t.id
group by c.name, t.id, pe.name, t.charge_date, t.amount
having sum(a.amount) > t.amount;

-- @check T05_vinculos_por_cargo
-- Lo aplicado de documentos a un cargo no supera su costo; 'recibida' = cubierto completo.
select c.name as empresa, t.id, pe.name as tecnico, t.charge_date, t.backing, t.document_status, t.net_amount as costo,
       coalesce(sum(l.cost_amount), 0) as aplicado
from technician_charges t
join companies c on c.id = t.company_id
join personnel pe on pe.id = t.personnel_id
left join technician_charge_documents l on l.charge_id = t.id
group by c.name, t.id, pe.name, t.charge_date, t.backing, t.document_status, t.net_amount
having coalesce(sum(l.cost_amount), 0) > t.net_amount
    or (t.backing in ('factura', 'boleta') and (t.document_status = 'recibida') <> (coalesce(sum(l.cost_amount), 0) >= t.net_amount))
    or (coalesce(t.backing, 'none') = 'none' and count(l.id) > 0);

-- @check T06_cargos_sin_documento_ni_pago
-- Cargos con respaldo que siguen sin documento y sin ningún pago (seguimiento).
select c.name as empresa, t.id, pe.name as tecnico, t.charge_date, t.backing, t.document_status, t.amount as a_pagar,
       t.net_amount as costo, current_date - t.charge_date as dias
from technician_charges t
join companies c on c.id = t.company_id
join personnel pe on pe.id = t.personnel_id
where t.document_status = 'pendiente'
  and not exists (select 1 from technician_payment_applications a where a.charge_id = t.id)
order by t.charge_date;

-- @recalc T07_saldo_por_tecnico
-- Cuenta corriente: debe = Σ a pagar de sus cargos; pagado = Σ aplicaciones; saldo = debe - pagado.
select c.name as empresa, pe.name as tecnico, pe.active,
       count(distinct t.id) as cargos,
       coalesce(sum(t.amount), 0) as debe,
       coalesce((select sum(a.amount) from technician_payment_applications a join technician_charges t2 on t2.id = a.charge_id where t2.personnel_id = pe.id), 0) as pagado_aplicado,
       coalesce((select sum(pa.amount) from technician_payments pa where pa.personnel_id = pe.id), 0) as pagos,
       coalesce(sum(t.amount), 0)
         - coalesce((select sum(a.amount) from technician_payment_applications a join technician_charges t2 on t2.id = a.charge_id where t2.personnel_id = pe.id), 0) as saldo
from personnel pe
join companies c on c.id = pe.company_id
left join technician_charges t on t.personnel_id = pe.id
where pe.type = 'contractor'
group by c.name, pe.id, pe.name, pe.active
order by c.name, pe.name;

-- =====================================================================
-- 4. Servicios recurrentes
-- =====================================================================

-- @check R01_periodos_faltantes
-- Servicios activos: meses (mensuales) sin ciclo entre el inicio y el mes actual.
with svc as (
  select rs.*, c.name as empresa from recurring_services rs join companies c on c.id = rs.company_id
  where rs.active and rs.status = 'active' and rs.periodicity = 'monthly'
)
select svc.empresa, svc.name, svc.start_date, m::date as mes_sin_ciclo
from svc
cross join lateral generate_series(
  greatest(date_trunc('month', svc.start_date), date '2026-01-01'),
  least(date_trunc('month', coalesce(svc.end_date, current_date)), date_trunc('month', current_date)),
  interval '1 month') m
where not exists (
  select 1 from recurring_service_occurrences o
  where o.recurring_service_id = svc.id and date_trunc('month', o.period) = m)
order by 1, 2, 4;

-- @check R01b_detalle_servicios_sin_ciclo_del_mes
-- Por qué falta el ciclo del mes actual: día de vencimiento, último ciclo y modo de facturación.
select c.name as empresa, rs.name, rs.periodicity, rs.invoicing_mode, rs.due_day, rs.start_date, rs.status, rs.active,
       (select max(o.period) from recurring_service_occurrences o where o.recurring_service_id = rs.id) as ultimo_ciclo,
       (select max(o.invoice_due_date) from recurring_service_occurrences o where o.recurring_service_id = rs.id) as ultimo_vencimiento,
       (select count(*) from recurring_service_occurrences o where o.recurring_service_id = rs.id and o.period >= date_trunc('month', current_date)) as ciclos_desde_este_mes
from recurring_services rs
join companies c on c.id = rs.company_id
where rs.active and rs.status = 'active' and rs.periodicity = 'monthly'
order by 1, 2;

-- @check R02_periodo_facturado_vs_esperado
-- Períodos con facturas confirmadas cuyo facturado (misma moneda) difiere del esperado,
-- y su estado: "paid" con facturado < esperado oculta una deuda parcial.
select c.name as empresa, rs.name as servicio, rs.periodicity, s.period, s.currency, s.expected_amount, s.billed_amount,
       s.difference, s.billing_status, s.unpaid_amount, s.confirmed_count
from recurring_service_period_summary s
join recurring_services rs on rs.id = s.recurring_service_id
join companies c on c.id = s.company_id
where s.confirmed_count > 0
  and abs(s.difference) > case when s.currency = 'CLP' then 1 else 0.01 end
order by c.name, rs.name, s.period;

-- @check R03_estado_sin_respaldo
-- Ciclo facturado/cobrado sin factura (ni asignación ni el vínculo viejo), en servicios que exigen factura.
select c.name as empresa, rs.name as servicio, o.period, o.status, o.amount, o.currency, o.invoiced_at, o.collected_at
from recurring_service_occurrences o
join recurring_services rs on rs.id = o.recurring_service_id
join companies c on c.id = rs.company_id
where o.status in ('invoiced', 'collected') and rs.requires_invoice
  and o.sales_document_id is null
  and not exists (select 1 from sales_allocations a where a.recurring_service_period_id = o.id and a.status = 'confirmed')
order by 1, 2, 3;

-- @check R04_anuales
-- Servicios anuales: un ciclo por aniversario (más de uno por año = venta repartida o duplicada).
select c.name as empresa, rs.name as servicio, rs.reference_amount, extract(year from o.period)::int as anio,
       count(*) as ciclos, sum(o.amount) as monto
from recurring_services rs
join companies c on c.id = rs.company_id
join recurring_service_occurrences o on o.recurring_service_id = rs.id and o.status <> 'void'
where rs.periodicity = 'annual'
group by 1, 2, 3, 4
having count(*) > 1;

-- @check R05_pool_ms
-- Reparto de la factura de licencias MS: suma exacta, ciclos del período sin parte, partes a ciclos anulados,
-- y la parte de cada uno contra la proporción que daría hoy (facturado, si no el esperado).
-- recurring_service_period_billed_amount escrita en línea (sin EXECUTE para el rol de solo lectura).
with p as (
  select p.*, c.name as empresa from recurring_service_cost_pools p join companies c on c.id = p.company_id
), billed as (
  select a.recurring_service_period_id as occurrence_id, sum(a.amount) as facturado
  from sales_allocations a
  join sales_documents sd on sd.id = a.sales_document_id
  join recurring_service_occurrences o on o.id = a.recurring_service_period_id
  where a.status = 'confirmed' and sd.currency = o.currency
  group by 1
), cohort as (
  select p.id as pool_id, o.id as occurrence_id, rs.name as servicio, rs.client_id, o.status, o.amount as esperado,
         coalesce(b.facturado, 0) as facturado,
         greatest(coalesce(nullif(coalesce(b.facturado, 0), 0), o.amount), 0) as peso
  from p
  join recurring_services rs on rs.company_id = p.company_id and rs.service_type = p.service_type
  join recurring_service_occurrences o on o.recurring_service_id = rs.id and o.period = p.period and o.currency = p.currency
  left join billed b on b.occurrence_id = o.id
)
select p.empresa, p.period, p.total_expense_amount as total_pool, x.servicio, x.status, x.esperado, x.facturado, x.peso,
       a.allocated_amount as parte_guardada,
       round(p.total_expense_amount * x.peso / nullif(sum(x.peso) filter (where x.status <> 'void') over (partition by p.id), 0), 2) as parte_proporcional_hoy,
       sum(a.allocated_amount) over (partition by p.id) as suma_partes
from p
left join cohort x on x.pool_id = p.id
left join recurring_service_cost_allocations a on a.cost_pool_id = p.id and a.occurrence_id = x.occurrence_id
order by p.period, x.servicio;

-- @check R06_periodos_costo
-- Períodos de costo: facturas confirmadas contra el costo esperado (fijo) del período.
select c.name as empresa, rs.name as servicio, s.period, s.currency, s.expected_amount, s.invoiced_amount, s.cost_status,
       s.invoiced_amount - s.expected_amount as diferencia
from recurring_service_cost_period_summary s
join recurring_services rs on rs.id = s.recurring_service_id
join companies c on c.id = s.company_id
where s.confirmed_count > 0
  and abs(s.invoiced_amount - s.expected_amount) > case when s.currency = 'CLP' then 1 else 0.01 end
order by 1, 2, 3;

-- @check R08_ciclo_a_mano_con_factura_suelta
-- Ciclos marcados facturados/cobrados sin factura (el reporte suma su monto como venta) cuyo
-- cliente tiene una factura sin asignar entre el período y 60 días después: si es la factura de
-- ese ciclo, la venta se cuenta dos veces.
select c.name as empresa, rs.name as servicio, o.period, o.status, o.amount, o.invoiced_at, o.collected_at,
       s.document_number, s.document_date, s.net_amount
from recurring_service_occurrences o
join recurring_services rs on rs.id = o.recurring_service_id
join companies c on c.id = rs.company_id
join sales_documents s on s.client_id = rs.client_id and s.company_id = rs.company_id
  and not s.voided and s.document_type <> 'credit_note'
  and s.document_date between o.period and o.period + 90
  and not exists (select 1 from sales_allocations a where a.sales_document_id = s.id and a.status = 'confirmed')
where o.status in ('invoiced', 'collected')
  and o.sales_document_id is null
  and not exists (select 1 from sales_allocations a where a.recurring_service_period_id = o.id and a.status = 'confirmed')
order by 1, 2, 3;

-- @check R09_costo_esperado_con_factura_sin_asignar
-- Períodos de costo sin factura confirmada (el reporte suma el costo esperado) cuyo proveedor
-- tiene facturas de ese mes con neto sin asignar a servicios (el reporte las suma como gasto
-- general): si una es la del período, el costo se cuenta dos veces.
with periodos as (
  select cp.id, cp.company_id, cp.period, cp.expected_amount, cp.currency, rs.name as servicio, rs.supplier_id
  from recurring_service_cost_periods cp
  join recurring_services rs on rs.id = cp.recurring_service_id and not rs.uses_cost_pool
  where rs.supplier_id is not null
    and not exists (select 1 from cost_service_allocations a where a.cost_period_id = cp.id and a.status = 'confirmed')
), docs as (
  select d.id, d.company_id, d.supplier_id, d.document_number, d.document_date, d.document_type, d.net_amount,
         d.net_amount - coalesce((select sum(a.amount) from cost_service_allocations a where a.cost_document_id = d.id and a.status = 'confirmed'), 0) as sin_asignar,
         (select count(*) from cost_service_allocations a where a.cost_document_id = d.id and a.status = 'suggested') as sugeridas
  from cost_documents d
  where d.classification = 'general' and d.project_id is null
)
select c.name as empresa, s.name as proveedor, p.servicio, p.period, p.expected_amount,
       count(d.id) as facturas_del_mes, sum(d.sin_asignar) as neto_sin_asignar, sum(d.sugeridas) as sugerencias_pendientes,
       string_agg(d.document_number || ' (' || d.sin_asignar || ')', ', ' order by d.document_date) as documentos
from periodos p
join companies c on c.id = p.company_id
join suppliers s on s.id = p.supplier_id
join docs d on d.company_id = p.company_id and d.supplier_id = p.supplier_id
  and date_trunc('month', d.document_date) = date_trunc('month', p.period) and d.sin_asignar <> 0
where p.period >= '2026-01-01'
group by c.name, s.name, p.servicio, p.period, p.expected_amount
order by 1, 2, 4, 3;

-- @check R07_ciclo_facturado_anulado
-- Ciclos cuyo único respaldo es una factura anulada: el reporte toma el monto del ciclo o nada.
select c.name as empresa, rs.name as servicio, o.period, o.status, o.amount, s.document_number, s.voided, s.annulled_by_document_id
from recurring_service_occurrences o
join recurring_services rs on rs.id = o.recurring_service_id
join companies c on c.id = rs.company_id
join sales_documents s on s.id = o.sales_document_id
where s.voided or s.annulled_by_document_id is not null;

-- =====================================================================
-- 5. Tipo de cambio
-- =====================================================================

-- @check X01_meses_sin_tasa
-- Meses con documentos (2025-12 en adelante) sin snapshot propio de la moneda local o del documento.
with meses as (
  select distinct c.currency as moneda_local, s.currency, date_trunc('month', s.document_date)::date as mes
  from sales_documents s join companies c on c.id = s.company_id where s.document_date >= '2025-12-01'
  union
  select distinct c.currency, d.currency, date_trunc('month', d.document_date)::date
  from cost_documents d join companies c on c.id = d.company_id where d.document_date >= '2025-12-01'
)
select m.*,
       exists (select 1 from exchange_rate_snapshots s where s.currency = m.moneda_local and s.period = m.mes) as hay_local,
       m.currency = 'USD' or exists (select 1 from exchange_rate_snapshots s where s.currency = m.currency and s.period = m.mes) as hay_doc
from meses m
where not exists (select 1 from exchange_rate_snapshots s where s.currency = m.moneda_local and s.period = m.mes)
   or (m.currency <> 'USD' and not exists (select 1 from exchange_rate_snapshots s where s.currency = m.currency and s.period = m.mes))
order by m.mes;

-- =====================================================================
-- 6. Trabajos (cotizaciones)
-- =====================================================================

-- @check P01_facturado_vs_cotizado
-- Cotizaciones: facturado (asignaciones confirmadas; las de otra moneda que la del trabajo,
-- contadas aparte porque la vista las convierte con exchange_rate_on) contra el cotizado.
-- La vista project_quote_billing_summary no se puede leer con el rol de solo lectura
-- (EXECUTE de exchange_rate_on); esto replica su suma.
select c.name as empresa, pr.name as trabajo, pr.currency, q.quote_number,
       coalesce(q.quoted_amount, pr.quoted_amount) as cotizado,
       sum(a.amount) filter (where a.status = 'confirmed' and sd.currency = pr.currency) as facturado_misma_moneda,
       count(*) filter (where a.status = 'confirmed' and sd.currency <> pr.currency) as facturas_otra_moneda,
       sum(a.amount * sd.exchange_rate) filter (where a.status = 'confirmed' and sd.currency <> pr.currency and pr.currency = c.currency) as otra_moneda_convertida
from project_quotes q
join projects pr on pr.id = q.project_id
join companies c on c.id = pr.company_id
left join sales_allocations a on a.project_quote_id = q.id
left join sales_documents sd on sd.id = a.sales_document_id
group by c.name, pr.name, pr.currency, q.id, q.quote_number, q.quoted_amount, pr.quoted_amount
having coalesce(sum(a.amount) filter (where a.status = 'confirmed'), 0) > coalesce(q.quoted_amount, pr.quoted_amount, 0) + 1
    or count(*) filter (where a.status = 'confirmed' and sd.currency <> pr.currency) > 0;

-- @check P02_trabajo_facturas_sin_asignar
-- Ventas con project_id pero sin asignación confirmada a una cotización: el reporte las pone enteras en el trabajo.
select c.name as empresa, pr.name as trabajo, s.document_number, s.document_type, s.document_date, s.net_amount
from sales_documents s
join projects pr on pr.id = s.project_id
join companies c on c.id = s.company_id
where not s.voided and s.document_type <> 'credit_note'
  and not exists (select 1 from sales_allocations a where a.sales_document_id = s.id and a.status = 'confirmed');

-- =====================================================================
-- 7. Conciliación 2026 (bloques @recalc)
-- =====================================================================

-- @recalc RC1_resultado_mensual_sistema
-- Réplica en SQL de computeMonthlyResult / getMonthlySeries (web/src/lib/reporting.ts),
-- regla por regla, por empresa y mes de 2026: ventas netas (N/C restan), costos directos
-- y generales (neto - asignado a servicios - vinculado a cargos de técnico; sin los
-- cubiertos por el pool MS), personal, ingresos de ciclos recurrentes sin factura y
-- costos de servicios (partes del pool en ciclos facturados/cobrados + períodos de costo).
-- Cada monto en moneda local con la tasa guardada en su documento, y en USD con la
-- snapshot de su fecha (la del mes o la anterior más cercana). Validada contra el código
-- real en dev (ver informe §3.1).
with
co as (select id, name, currency from companies where country in ('CL', 'UY')),
snap as (select currency, period, ars_per_unit / ars_per_usd as upu from exchange_rate_snapshots where ars_per_usd > 0 and ars_per_unit > 0),
ms_area as (
  select a.id from business_areas a
  where lower(btrim(a.name)) in ('microsoft 365', 'licencias ms', 'licencias microsoft')
     or exists (select 1 from recurring_services s where s.business_area_id = a.id and s.company_id = a.company_id and s.service_type = 'ms_licenses')
),
covered as (
  select d.id
  from cost_documents d
  join recurring_service_cost_pools p
    on p.company_id = d.company_id and p.service_type = 'ms_licenses'
   and p.period = coalesce(d.recognized_period, date_trunc('month', d.document_date)::date)
  where not exists (select 1 from cost_service_allocations a where a.cost_document_id = d.id and a.status = 'confirmed')
    and not exists (select 1 from projects pr where pr.id = d.project_id and pr.business_area_id not in (select id from ms_area))
    and not exists (
      select 1 from cost_allocations ca left join projects pr on pr.id = ca.project_id
      where ca.cost_document_id = d.id
        and ((ca.business_area_id is not null and ca.business_area_id not in (select id from ms_area))
          or (ca.project_id is not null and pr.business_area_id not in (select id from ms_area))))
    and ((p.supplier_id is not null and p.supplier_id = d.supplier_id)
      or exists (select 1 from projects pr where pr.id = d.project_id and pr.business_area_id in (select id from ms_area))
      or exists (select 1 from cost_allocations ca left join projects pr on pr.id = ca.project_id
                 where ca.cost_document_id = d.id
                   and (ca.business_area_id in (select id from ms_area) or pr.business_area_id in (select id from ms_area))))
),
cyc as (
  select rs.company_id, o.id, rs.uses_cost_pool, o.amount, o.currency, o.exchange_rate,
         (select min(coalesce(sd.recognized_period, sd.document_date)) from sales_allocations a join sales_documents sd on sd.id = a.sales_document_id
           where a.recurring_service_period_id = o.id and a.status = 'confirmed' and not sd.voided) as fecha_asignada,
         (select coalesce(ld.recognized_period, ld.document_date) from sales_documents ld where ld.id = o.sales_document_id) as fecha_legacy,
         o.invoiced_at, o.invoice_due_date, o.period
  from recurring_service_occurrences o join recurring_services rs on rs.id = o.recurring_service_id
  where o.status in ('invoiced', 'collected')
),
items as (
  select s.company_id, 'ventas' as kind, date_trunc('month', coalesce(s.recognized_period, s.document_date))::date as mes,
         s.currency, s.document_date as fecha, s.exchange_rate as tasa,
         case when s.document_type = 'credit_note' then -s.net_amount else s.net_amount end as monto
  from sales_documents s where not s.voided
  union all
  select d.company_id, case when d.classification = 'direct' then 'directos' else 'generales' end,
         date_trunc('month', coalesce(d.recognized_period, d.document_date))::date, d.currency, d.document_date, d.exchange_rate,
         d.net_amount
           - coalesce((select sum(a.amount) from cost_service_allocations a where a.cost_document_id = d.id and a.status = 'confirmed'), 0)
           - coalesce((select sum(l.cost_amount) from technician_charge_documents l where l.cost_document_id = d.id), 0)
  from cost_documents d where d.id not in (select id from covered)
  union all
  select pe.company_id, 'personal', pc.period, pc.currency, pc.period, null, pc.amount
  from personnel_costs pc join personnel pe on pe.id = pc.personnel_id
  union all
  select c.company_id, 'ingreso_recurrente',
         date_trunc('month', coalesce(c.fecha_asignada, c.fecha_legacy, c.invoiced_at, c.invoice_due_date, c.period))::date,
         c.currency, coalesce(c.fecha_asignada, c.fecha_legacy, c.invoiced_at, c.invoice_due_date, c.period), c.exchange_rate,
         case when c.fecha_asignada is not null or c.fecha_legacy is not null then 0 else c.amount end
  from cyc c
  union all
  select c.company_id, 'costo_pool',
         date_trunc('month', coalesce(c.fecha_asignada, c.fecha_legacy, c.invoiced_at, c.invoice_due_date, c.period))::date,
         a.currency, coalesce(c.fecha_asignada, c.fecha_legacy, c.invoiced_at, c.invoice_due_date, c.period), p.exchange_rate, a.allocated_amount
  from cyc c
  join recurring_service_cost_allocations a on a.occurrence_id = c.id
  join recurring_service_cost_pools p on p.id = a.cost_pool_id
  where c.uses_cost_pool
  union all
  select cp.company_id, 'costo_periodo', date_trunc('month', cp.period)::date,
         coalesce(d.currency, cp.currency), coalesce(d.document_date, cp.period),
         case when d.id is null then cp.exchange_rate else d.exchange_rate end,
         coalesce(a.amount, cp.expected_amount)
  from recurring_service_cost_periods cp
  join recurring_services rs on rs.id = cp.recurring_service_id and not rs.uses_cost_pool
  left join cost_service_allocations a on a.cost_period_id = cp.id and a.status = 'confirmed'
  left join cost_documents d on d.id = a.cost_document_id
),
conv as (
  select i.*, co.name as empresa, co.currency as moneda_local,
         case when i.currency = co.currency then i.monto
              when i.tasa is not null then i.monto * i.tasa
              else i.monto * (case when i.currency = 'USD' then 1 else (select upu from snap s where s.currency = i.currency and s.period <= date_trunc('month', i.fecha) order by s.period desc limit 1) end)
                   / (select upu from snap s where s.currency = co.currency and s.period <= date_trunc('month', i.fecha) order by s.period desc limit 1)
         end as local,
         i.monto * (case when i.currency = 'USD' then 1 else (select upu from snap s where s.currency = i.currency and s.period <= date_trunc('month', i.fecha) order by s.period desc limit 1) end) as usd
  from items i join co on co.id = i.company_id
  where i.mes >= '2026-01-01' and i.mes < '2026-12-01' and i.monto <> 0
)
select empresa, moneda_local, mes,
       round(sum(local) filter (where kind in ('ventas', 'ingreso_recurrente')), 2) as ventas_netas,
       round(sum(local) filter (where kind = 'ingreso_recurrente'), 2) as de_ellas_recurrentes,
       round(sum(local) filter (where kind in ('directos', 'costo_pool', 'costo_periodo')), 2) as costos_directos,
       round(sum(local) filter (where kind in ('costo_pool', 'costo_periodo')), 2) as de_ellos_recurrentes,
       round(sum(local) filter (where kind in ('generales', 'personal')), 2) as costos_generales,
       round(coalesce(sum(local) filter (where kind in ('ventas', 'ingreso_recurrente')), 0)
           - coalesce(sum(local) filter (where kind in ('directos', 'costo_pool', 'costo_periodo', 'generales', 'personal')), 0), 2) as resultado_operativo,
       round(coalesce(sum(usd) filter (where kind in ('ventas', 'ingreso_recurrente')), 0)
           - coalesce(sum(usd) filter (where kind in ('directos', 'costo_pool', 'costo_periodo', 'generales', 'personal')), 0), 2) as resultado_operativo_usd,
       bool_and(usd is not null) as usd_completo,
       bool_and(local is not null) as local_completo
from conv
group by empresa, moneda_local, mes
order by empresa, mes;

-- @recalc RC4_rentabilidad_por_trabajo_2026
-- Réplica de getProfitabilityBreakdown por trabajo, sumando los 11 meses de 2026: ingresos =
-- partes de cada venta (asignación confirmada a una cotización del trabajo; sin asignaciones o
-- N/C, el project_id del documento; N/C con signo -), costos = documentos directos del trabajo
-- (neto, sin los cubiertos por el pool) + repartos de costo al trabajo (parte del neto) +
-- personal imputado. En moneda local con la tasa de cada documento.
with co as (select id, name, currency from companies where country in ('CL', 'UY')),
alloc as (
  select a.sales_document_id, sum(a.amount) as asignado
  from sales_allocations a where a.status = 'confirmed' group by 1
),
rev as (
  -- con asignaciones: cada asignación a una cotización es del trabajo de la cotización
  select q.project_id, s.company_id, date_trunc('month', coalesce(s.recognized_period, s.document_date))::date as mes,
         a.amount * case when s.currency = co.currency then 1 else s.exchange_rate end as local
  from sales_allocations a
  join sales_documents s on s.id = a.sales_document_id and not s.voided and s.document_type <> 'credit_note'
  join project_quotes q on q.id = a.project_quote_id
  join co on co.id = s.company_id
  where a.status = 'confirmed'
  union all
  -- sin asignaciones (o N/C): entero en su project_id
  select s.project_id, s.company_id, date_trunc('month', coalesce(s.recognized_period, s.document_date))::date,
         (case when s.document_type = 'credit_note' then -s.net_amount else s.net_amount end)
           * case when s.currency = co.currency then 1 else s.exchange_rate end
  from sales_documents s join co on co.id = s.company_id
  where not s.voided and s.project_id is not null
    and (s.document_type = 'credit_note' or not exists (select 1 from alloc where alloc.sales_document_id = s.id))
),
cost as (
  select d.project_id, d.company_id, date_trunc('month', coalesce(d.recognized_period, d.document_date))::date as mes,
         d.net_amount * case when d.currency = co.currency then 1 else d.exchange_rate end as local
  from cost_documents d join co on co.id = d.company_id
  where d.classification = 'direct' and d.project_id is not null
    and not exists (
      select 1 from recurring_service_cost_pools p
      where p.company_id = d.company_id and p.service_type = 'ms_licenses'
        and p.period = coalesce(d.recognized_period, date_trunc('month', d.document_date)::date)
        and p.supplier_id = d.supplier_id)
  union all
  select ca.project_id, d.company_id, date_trunc('month', coalesce(d.recognized_period, d.document_date))::date,
         (case when ca.method = 'percentage' then d.net_amount * ca.percentage / 100 else ca.amount end)
           * case when d.currency = co.currency then 1 else d.exchange_rate end
  from cost_allocations ca join cost_documents d on d.id = ca.cost_document_id join co on co.id = d.company_id
  where ca.project_id is not null
  union all
  select w.project_id, pe.company_id, pc.period, w.amount
  from work_allocations w join personnel_costs pc on pc.id = w.personnel_cost_id join personnel pe on pe.id = pc.personnel_id
)
select co.name as empresa, pr.name as trabajo, pr.currency as moneda_trabajo,
       round(coalesce((select sum(local) from rev r where r.project_id = pr.id and r.mes between '2026-01-01' and '2026-11-01'), 0), 2) as ingresos_2026,
       round(coalesce((select sum(local) from cost c where c.project_id = pr.id and c.mes between '2026-01-01' and '2026-11-01'), 0), 2) as costos_2026,
       round(coalesce((select sum(local) from rev r where r.project_id = pr.id), 0), 2) as ingresos_acumulados,
       round(coalesce((select sum(local) from cost c where c.project_id = pr.id), 0), 2) as costos_acumulados
from projects pr join co on co.id = pr.company_id
order by 1, 2;

-- @recalc RC2_contabilidad_independiente
-- Recomputación independiente, desde las LÍNEAS de cada documento (sin las reglas de la app):
-- ventas = Σ líneas de los documentos no anulados (N/C con signo -); costos = Σ líneas
-- (o el neto cuando el documento no tiene líneas) de TODOS los documentos de costo; personal.
-- En moneda local con la tasa guardada. Con RC3 explica cada diferencia con RC1.
with co as (select id, name, currency from companies where country in ('CL', 'UY')),
sl as (select sales_document_id, sum(amount) as lineas from sales_lines group by 1),
cl as (select cost_document_id, sum(amount) as lineas from cost_lines group by 1),
x as (
  select s.company_id, date_trunc('month', coalesce(s.recognized_period, s.document_date))::date as mes, 'ventas' as kind,
         (case when s.document_type = 'credit_note' then -1 else 1 end) * coalesce(sl.lineas, 0)
           * case when s.currency = co.currency then 1 else s.exchange_rate end as local
  from sales_documents s join co on co.id = s.company_id left join sl on sl.sales_document_id = s.id
  where not s.voided
  union all
  select d.company_id, date_trunc('month', coalesce(d.recognized_period, d.document_date))::date, 'costos',
         coalesce(cl.lineas, d.net_amount) * case when d.currency = co.currency then 1 else d.exchange_rate end
  from cost_documents d join co on co.id = d.company_id left join cl on cl.cost_document_id = d.id
  union all
  select pe.company_id, pc.period, 'personal', pc.amount
  from personnel_costs pc join personnel pe on pe.id = pc.personnel_id
)
select co.name as empresa, x.mes,
       round(sum(local) filter (where kind = 'ventas'), 2) as ventas_lineas,
       round(sum(local) filter (where kind = 'costos'), 2) as costos_documentos,
       round(sum(local) filter (where kind = 'personal'), 2) as personal
from x join co on co.id = x.company_id
where x.mes >= '2026-01-01' and x.mes < '2026-12-01'
group by co.name, x.mes
order by 1, 2;

-- @recalc RC3_partidas_conciliatorias
-- Lo que separa RC2 (todo documento, tal cual) de RC1 (reglas de la app), por empresa y mes:
--   cubierto_pool: neto de facturas del proveedor MS que el pool reemplaza (RC1 no las suma);
--   pool_reconocido: partes del pool en ciclos facturados/cobrados, en el mes de su factura (RC1 las suma);
--   pool_sin_reconocer: partes del pool de ese mes en ciclos todavía sin facturar (nadie las suma);
--   esperado_sin_factura: períodos de costo sin factura confirmada (RC1 suma el costo esperado);
--   ingreso_ciclos_sin_factura: ciclos facturados/cobrados sin factura (RC1 los suma como venta);
--   vinculado_cargos: parte de facturas/boletas de técnicos aplicada a cargos (el costo ya lo
--     lleva el documento propio de cada cargo, en el mes del cargo; RC1 la descuenta en el mes
--     del documento).
-- Identidades: costos RC1 = RC2.costos + personal - cubierto_pool + pool_reconocido
--                           + esperado_sin_factura - vinculado_cargos
--              ventas RC1 = RC2.ventas + ingreso_ciclos_sin_factura
-- (asignar una factura a servicios solo cambia el renglón, no el total).
with co as (select id, name, currency from companies where country in ('CL', 'UY')),
ms_area as (
  select a.id from business_areas a
  where lower(btrim(a.name)) in ('microsoft 365', 'licencias ms', 'licencias microsoft')
     or exists (select 1 from recurring_services s where s.business_area_id = a.id and s.company_id = a.company_id and s.service_type = 'ms_licenses')
),
covered as (
  select d.company_id, date_trunc('month', coalesce(d.recognized_period, d.document_date))::date as mes,
         d.net_amount * case when d.currency = c.currency then 1 else d.exchange_rate end as local
  from cost_documents d
  join co c on c.id = d.company_id
  join recurring_service_cost_pools p
    on p.company_id = d.company_id and p.service_type = 'ms_licenses'
   and p.period = coalesce(d.recognized_period, date_trunc('month', d.document_date)::date)
  where not exists (select 1 from cost_service_allocations a where a.cost_document_id = d.id and a.status = 'confirmed')
    and not exists (select 1 from projects pr where pr.id = d.project_id and pr.business_area_id not in (select id from ms_area))
    and ((p.supplier_id is not null and p.supplier_id = d.supplier_id)
      or exists (select 1 from projects pr where pr.id = d.project_id and pr.business_area_id in (select id from ms_area)))
),
pool_parts as (
  select p.company_id, p.period as mes_pool, o.status,
         a.allocated_amount * coalesce(p.exchange_rate, 1) as local,
         date_trunc('month', coalesce(
           (select min(coalesce(sd.recognized_period, sd.document_date)) from sales_allocations sa join sales_documents sd on sd.id = sa.sales_document_id
             where sa.recurring_service_period_id = o.id and sa.status = 'confirmed' and not sd.voided),
           (select coalesce(ld.recognized_period, ld.document_date) from sales_documents ld where ld.id = o.sales_document_id),
           o.invoiced_at, o.invoice_due_date, o.period))::date as mes_reconocido
  from recurring_service_cost_allocations a
  join recurring_service_cost_pools p on p.id = a.cost_pool_id
  join recurring_service_occurrences o on o.id = a.occurrence_id
),
expected as (
  select cp.company_id, date_trunc('month', cp.period)::date as mes, cp.expected_amount * coalesce(cp.exchange_rate, 1) as local
  from recurring_service_cost_periods cp
  join recurring_services rs on rs.id = cp.recurring_service_id and not rs.uses_cost_pool
  where not exists (select 1 from cost_service_allocations a where a.cost_period_id = cp.id and a.status = 'confirmed')
),
manual_rev as (
  select rs.company_id, date_trunc('month', coalesce(o.invoiced_at, o.invoice_due_date, o.period))::date as mes,
         o.amount * coalesce(o.exchange_rate, 1) as local
  from recurring_service_occurrences o join recurring_services rs on rs.id = o.recurring_service_id
  where o.status in ('invoiced', 'collected')
    and o.sales_document_id is null
    and not exists (select 1 from sales_allocations sa join sales_documents sd on sd.id = sa.sales_document_id
                    where sa.recurring_service_period_id = o.id and sa.status = 'confirmed' and not sd.voided)
),
linked as (
  select d.company_id, date_trunc('month', coalesce(d.recognized_period, d.document_date))::date as mes,
         l.cost_amount * case when d.currency = c.currency then 1 else d.exchange_rate end as local
  from technician_charge_documents l
  join cost_documents d on d.id = l.cost_document_id
  join co c on c.id = d.company_id
),
meses as (select generate_series(date '2026-01-01', date '2026-11-01', interval '1 month')::date as mes)
select co.name as empresa, m.mes,
       coalesce((select round(sum(local), 2) from linked x where x.company_id = co.id and x.mes = m.mes), 0) as vinculado_cargos,
       coalesce((select round(sum(local), 2) from covered x where x.company_id = co.id and x.mes = m.mes), 0) as cubierto_pool,
       coalesce((select round(sum(local), 2) from pool_parts x where x.company_id = co.id and x.mes_reconocido = m.mes and x.status in ('invoiced', 'collected')), 0) as pool_reconocido,
       coalesce((select round(sum(local), 2) from pool_parts x where x.company_id = co.id and x.mes_pool = m.mes and x.status not in ('invoiced', 'collected')), 0) as pool_sin_reconocer,
       coalesce((select round(sum(local), 2) from expected x where x.company_id = co.id and x.mes = m.mes), 0) as esperado_sin_factura,
       coalesce((select round(sum(local), 2) from manual_rev x where x.company_id = co.id and x.mes = m.mes), 0) as ingreso_ciclos_sin_factura
from co cross join meses m
order by 1, 2;
