-- =============================================================================
-- audit/fixes_prod.sql -- Auditoría 2026-10 (ver audit/INFORME_AUDITORIA.md §3)
--
-- NO EJECUTADO. Ninguna sentencia de este archivo se corrió contra prod ni dev.
-- Cada bloque es independiente, arranca con BEGIN y termina con ROLLBACK: para
-- aplicarlo de verdad, revisalo, corré primero sus SELECT de precondición y
-- cambiá el ROLLBACK final por COMMIT. Proyecto prod: jxkfpkgyvjiyufmfxsfp.
--
-- Recomendado antes de cualquier bloque: backup JSON de las tablas tocadas
-- (receta en la memoria del proyecto / docs/deploy-prod-*.md).
--
-- Los bloques marcados [DECISIÓN] cambian montos o borran filas: necesitan el
-- OK de negocio antes de pasar a COMMIT.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- F1 [DECISIÓN] -- A-DATA-01: 2 notas de crédito de compra de Starlink (N/C-EL
-- 79361 y 80404, 31.092 neto c/u) guardadas como FACTURA positiva y asignadas a
-- un servicio. Hoy suman +62.184 de costo neto cuando deberían restar 62.184
-- (error total 124.368 CLP neto). El backfill de 20261024050000 las saltó por
-- estar asignadas a servicios.
-- Una asignación a servicio no puede ser negativa (CHECK amount > 0), así que
-- la N/C queda como costo general negativo, sin asignación a servicio.
-- -----------------------------------------------------------------------------
begin;

-- Precondición: deben devolver exactamente 2 filas, ambas 'invoice', 31092/36999.
select id, document_type, source_document_type, document_number, net_amount, tax_amount, total_amount
from public.cost_documents
where id in ('1d1c52c8-b7c3-47f8-ad78-ecf282cd12d8', 'ef627422-113f-42fb-8c6d-76994293ff0b')
  and source_document_type = 'N/C-EL' and document_type = 'invoice'
  and net_amount = 31092 and tax_amount = 5907 and total_amount = 36999;

delete from public.cost_service_allocations
where cost_document_id in ('1d1c52c8-b7c3-47f8-ad78-ecf282cd12d8', 'ef627422-113f-42fb-8c6d-76994293ff0b');

alter table public.cost_documents disable trigger cost_documents_protect_financial_fields;

update public.cost_documents
set document_type = 'credit_note',
    net_amount = -31092,
    tax_amount = -5907,
    total_amount = -36999,
    updated_at = now()
where id in ('1d1c52c8-b7c3-47f8-ad78-ecf282cd12d8', 'ef627422-113f-42fb-8c6d-76994293ff0b')
  and document_type = 'invoice' and net_amount = 31092;

update public.cost_lines
set amount = -31092
where cost_document_id in ('1d1c52c8-b7c3-47f8-ad78-ecf282cd12d8', 'ef627422-113f-42fb-8c6d-76994293ff0b')
  and amount = 31092;

alter table public.cost_documents enable trigger cost_documents_protect_financial_fields;

-- Verificación: 2 filas credit_note -31092, 0 asignaciones a servicio.
select id, document_type, net_amount, total_amount,
       (select count(*) from public.cost_service_allocations a where a.cost_document_id = cd.id) as service_allocations
from public.cost_documents cd
where id in ('1d1c52c8-b7c3-47f8-ad78-ecf282cd12d8', 'ef627422-113f-42fb-8c6d-76994293ff0b');

rollback;  -- cambiar por COMMIT tras el OK


-- -----------------------------------------------------------------------------
-- F2 [DECISIÓN] -- A-DATA-02: pago a técnico huérfano (dato de prueba).
-- technician_payments 67448a9a, 40.000 CLP, 2026-09-21, técnico "Pepe"
-- (contractor sin ningún cargo), sin aplicaciones. Rompe la regla "un pago suma
-- exactamente sus aplicaciones". Se borra el pago y se desactiva "Pepe"
-- (no se borra: puede tener otras referencias).
-- -----------------------------------------------------------------------------
begin;

-- Precondición: 1 fila, 0 aplicaciones, técnico sin cargos.
select p.id, p.amount, pe.name,
       (select count(*) from public.technician_payment_applications a where a.payment_id = p.id) as applications,
       (select count(*) from public.technician_charges c where c.personnel_id = p.personnel_id) as charges
from public.technician_payments p
join public.personnel pe on pe.id = p.personnel_id
where p.id = '67448a9a-1a5d-4769-8a04-f18ae1908ab0';

-- Primero desactivar a "Pepe" (necesita el pago para encontrar su id).
update public.personnel
set active = false
where name = 'Pepe'
  and id = (select personnel_id from public.technician_payments where id = '67448a9a-1a5d-4769-8a04-f18ae1908ab0')
  and not exists (select 1 from public.technician_charges c where c.personnel_id = personnel.id);

delete from public.technician_payments
where id = '67448a9a-1a5d-4769-8a04-f18ae1908ab0'
  and not exists (select 1 from public.technician_payment_applications a where a.payment_id = '67448a9a-1a5d-4769-8a04-f18ae1908ab0');

rollback;  -- cambiar por COMMIT tras el OK


-- -----------------------------------------------------------------------------
-- F3 -- A-DATA-03: empresa "Inmasoft Uruguay" (b10291f2) sin país, con moneda
-- CLP (incoherente para Uruguay), sin miembros ni datos (0 clientes, 0 proyectos,
-- 0 ventas, 0 costos). Es un resto de pruebas: se desactiva, no se borra.
-- -----------------------------------------------------------------------------
begin;

-- Precondición: todo en 0.
select c.id, c.name, c.country, c.currency, c.active,
       (select count(*) from public.company_memberships m where m.company_id = c.id) as members,
       (select count(*) from public.clients x where x.company_id = c.id) as clients,
       (select count(*) from public.projects x where x.company_id = c.id) as projects,
       (select count(*) from public.sales_documents x where x.company_id = c.id) as sales,
       (select count(*) from public.cost_documents x where x.company_id = c.id) as costs
from public.companies c
where c.id = 'b10291f2-55b8-4736-8a23-e2848412500f';

update public.companies
set active = false
where id = 'b10291f2-55b8-4736-8a23-e2848412500f'
  and not exists (select 1 from public.company_memberships m where m.company_id = companies.id)
  and not exists (select 1 from public.sales_documents x where x.company_id = companies.id)
  and not exists (select 1 from public.cost_documents x where x.company_id = companies.id);

rollback;  -- cambiar por COMMIT


-- -----------------------------------------------------------------------------
-- F4 [DATOS EXTERNOS] -- A-DATA-04: faltan snapshots de tipo de cambio CLP de
-- 2025-01 a 2026-08 (el primero es 2026-09). Las ventas de Chile arrancan en
-- 2026-01, así que el consolidado en USD de ene-ago 2026 marca a Chile como
-- "conversión pendiente" (las tasas por documento existen; lo que falta es CLP->USD).
-- UYU falta 2025-01..2025-11 (sin documentos UY en ese rango: no urgente).
--
-- NO se inventan tasas. Completar ars_per_unit (ARS por 1 CLP) y ars_per_usd
-- (ARS por 1 USD) de la misma fuente que usa la app (MonedAPI "oficial", o
-- BCCh dólar observado convertido a la misma base) y descomentar.
-- -----------------------------------------------------------------------------
begin;

-- insert into public.exchange_rate_snapshots (currency, period, ars_per_unit, ars_per_usd, fetched_at)
-- values
--   ('CLP', '2026-01-01', <ars_por_clp>, <ars_por_usd>, now()),
--   ('CLP', '2026-02-01', <ars_por_clp>, <ars_por_usd>, now()),
--   ('CLP', '2026-03-01', <ars_por_clp>, <ars_por_usd>, now()),
--   ('CLP', '2026-04-01', <ars_por_clp>, <ars_por_usd>, now()),
--   ('CLP', '2026-05-01', <ars_por_clp>, <ars_por_usd>, now()),
--   ('CLP', '2026-06-01', <ars_por_clp>, <ars_por_usd>, now()),
--   ('CLP', '2026-07-01', <ars_por_clp>, <ars_por_usd>, now()),
--   ('CLP', '2026-08-01', <ars_por_clp>, <ars_por_usd>, now())
-- on conflict (currency, period) do nothing;

-- Verificación: meses sin snapshot desde 2026-01.
select g.m::date as missing_clp_month
from generate_series('2026-01-01'::timestamptz, date_trunc('month', current_date), interval '1 month') g(m)
where not exists (select 1 from public.exchange_rate_snapshots e where e.currency = 'CLP' and e.period = g.m::date);

rollback;


-- -----------------------------------------------------------------------------
-- F5 [REVISIÓN] -- A-DATA-05: 12 períodos de servicios recurrentes marcados
-- facturado/cobrado sin factura vinculada ni asignación (10 de "Mantenimiento
-- Happydog" UY 2025-12..2026-09, "Microsoft RAZO" 2026-08 y "Microsoft idarwin"
-- 2026-09 en Chile). Desde 20261017030000 el estado del período sale de las
-- facturas asignadas, así que estos estados manuales no tienen respaldo.
-- Solo consulta: la corrección es asignar la factura real desde la pantalla de
-- la venta (Asignar a períodos), no un UPDATE ciego.
-- -----------------------------------------------------------------------------
select co.name as company, rs.name as service, o.period, o.status, o.amount, o.currency, o.invoiced_at, o.collected_at
from public.recurring_service_occurrences o
join public.recurring_services rs on rs.id = o.recurring_service_id
join public.companies co on co.id = rs.company_id
where o.status in ('invoiced', 'pending_collection', 'collected')
  and o.sales_document_id is null
  and not exists (select 1 from public.sales_allocations a where a.recurring_service_period_id = o.id)
order by co.name, rs.name, o.period;


-- -----------------------------------------------------------------------------
-- F6 [REVISIÓN] -- A-DATA-06: cliente duplicado por nombre en Chile
-- ("pekes pro spa", RUT 15045498-0 y 76982985-7, ambos activos). Puede ser
-- legítimo (persona natural vs. SpA); si no, fusionar desde la app.
-- -----------------------------------------------------------------------------
select c.id, c.name, c.tax_id, c.active,
       (select count(*) from public.sales_documents s where s.client_id = c.id) as sales,
       (select count(*) from public.projects p where p.client_id = c.id) as projects
from public.clients c
where lower(btrim(c.name)) = 'pekes pro spa';


-- -----------------------------------------------------------------------------
-- F7 [DECISIÓN] -- A-DATA-07: esquemas de backup en prod (backup_20261004,
-- backup_20261013_import_uy, backup_20261015; 26 tablas). No están expuestos a
-- anon/authenticated (verificado), pero ocupan espacio y quedan en los dumps.
-- Borrar solo cuando ya no se necesiten.
-- -----------------------------------------------------------------------------
-- drop schema backup_20261004 cascade;
-- drop schema backup_20261013_import_uy cascade;
-- drop schema backup_20261015 cascade;


-- -----------------------------------------------------------------------------
-- F8 [OPCIONAL] -- A-DATA-08: token MCP activo "Nacho" sin uso desde
-- 2026-09-23 (los tokens no vencen). Revocar si ya no se usa.
-- -----------------------------------------------------------------------------
begin;
update public.mcp_access_tokens
set revoked_at = now()
where label = 'Nacho' and revoked_at is null and coalesce(last_used_at, created_at) < now() - interval '30 days';
rollback;  -- cambiar por COMMIT si corresponde
