-- =============================================================================
-- audit/fixes_prod.sql -- Auditoría 2026-10 (ver audit/INFORME_AUDITORIA.md §3)
--
-- ESTADO 2026-10-30: F1, F2 y F4 EJECUTADOS en prod (COMMIT, 04:35 UTC), cada
-- uno como un único bloque DO que verifica conteos exactos y aborta si algo no
-- coincide. Antes se ensayaron con ROLLBACK forzado y la huella de prod quedó
-- idéntica al backup. F3 NO se ejecutó (la empresa tiene registros). F5–F8 sin
-- cambios: no ejecutados.
-- Backup previo (JSON por tabla + esquema + huella, sin pg_dump/Docker en la
-- máquina): G:\INMA-ERP-backups\prod-2026-10-30\ (tiene datos sensibles).
-- Huella después: solo cambiaron cost_documents (2 filas), cost_lines (2),
-- cost_service_allocations (16 -> 14), technician_payments (10 -> 9) y
-- exchange_rate_snapshots (13 -> 21). Proyecto prod: jxkfpkgyvjiyufmfxsfp.
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
--
-- EJECUTADO 2026-10-30 04:35 UTC. Ensayo con ROLLBACK: 2 asignaciones, 2
-- documentos y 2 líneas. Después: neto de STARLINK CHILE SPA 11.924.741 ->
-- 11.800.373 (-124.368), los 2 documentos credit_note -31.092 / -36.999 y 0
-- asignaciones a servicio. Las asignaciones borradas (1be59360, ca656890, a los
-- períodos de costo 0806a5bc y aee19248) están en el backup.
-- -----------------------------------------------------------------------------
begin;

do $$
declare
  v_ids uuid[] := array['1d1c52c8-b7c3-47f8-ad78-ecf282cd12d8','ef627422-113f-42fb-8c6d-76994293ff0b']::uuid[];
  v_pre int; v_alloc int; v_docs int; v_lines int; v_net_before numeric; v_net_after numeric;
begin
  select count(*) into v_pre from public.cost_documents
  where id = any(v_ids) and source_document_type = 'N/C-EL' and document_type = 'invoice'
    and net_amount = 31092 and tax_amount = 5907 and exempt_amount = 0 and total_amount = 36999;
  if v_pre <> 2 then raise exception 'F1 precondition: % of 2 documents match', v_pre; end if;
  select sum(net_amount) into v_net_before from public.cost_documents where supplier_id = 'bd529989-d5ba-422a-bd5d-30a0fe5ef964';

  delete from public.cost_service_allocations where cost_document_id = any(v_ids);
  get diagnostics v_alloc = row_count;
  if v_alloc <> 2 then raise exception 'F1: % service allocations deleted, expected 2', v_alloc; end if;

  alter table public.cost_documents disable trigger cost_documents_protect_financial_fields;
  update public.cost_documents
  set document_type = 'credit_note', net_amount = -31092, tax_amount = -5907, total_amount = -36999, updated_at = now()
  where id = any(v_ids) and document_type = 'invoice' and net_amount = 31092;
  get diagnostics v_docs = row_count;
  alter table public.cost_documents enable trigger cost_documents_protect_financial_fields;
  if v_docs <> 2 then raise exception 'F1: % documents updated, expected 2', v_docs; end if;

  update public.cost_lines set amount = -31092 where cost_document_id = any(v_ids) and amount = 31092;
  get diagnostics v_lines = row_count;
  if v_lines <> 2 then raise exception 'F1: % lines updated, expected 2', v_lines; end if;

  select sum(net_amount) into v_net_after from public.cost_documents where supplier_id = 'bd529989-d5ba-422a-bd5d-30a0fe5ef964';
  if v_net_before - v_net_after <> 124368 then raise exception 'F1: Starlink net moved by %, expected 124368', v_net_before - v_net_after; end if;
  raise notice 'F1 ok: % allocations deleted, % documents, % lines; Starlink net % -> %', v_alloc, v_docs, v_lines, v_net_before, v_net_after;
end
$$;

commit;


-- -----------------------------------------------------------------------------
-- F2 [DECISIÓN] -- A-DATA-02: pago a técnico huérfano (dato de prueba).
-- technician_payments 67448a9a, 40.000 CLP, 2026-09-21, técnico "Pepe"
-- (contractor sin ningún cargo), sin aplicaciones. Rompe la regla "un pago suma
-- exactamente sus aplicaciones". Se borra el pago.
--
-- EJECUTADO 2026-10-30 04:35 UTC, solo el borrado del pago. A diferencia de la
-- primera versión de este bloque, "Pepe" NO se desactivó (sigue activo): el
-- pedido era quitar el pago de prueba, y desactivarlo quedó fuera.
-- Después: 0 pagos sin aplicaciones.
-- -----------------------------------------------------------------------------
begin;

do $$
declare
  v_pre int; v_del int;
begin
  select count(*) into v_pre from public.technician_payments p
  where p.id = '67448a9a-1a5d-4769-8a04-f18ae1908ab0' and p.amount = 40000
    and not exists (select 1 from public.technician_payment_applications a where a.payment_id = p.id)
    and not exists (select 1 from public.technician_charges c where c.personnel_id = p.personnel_id);
  if v_pre <> 1 then raise exception 'F2 precondition: % of 1 payment matches', v_pre; end if;

  delete from public.technician_payments
  where id = '67448a9a-1a5d-4769-8a04-f18ae1908ab0'
    and not exists (select 1 from public.technician_payment_applications a where a.payment_id = '67448a9a-1a5d-4769-8a04-f18ae1908ab0');
  get diagnostics v_del = row_count;
  if v_del <> 1 then raise exception 'F2: % payments deleted, expected 1', v_del; end if;
  raise notice 'F2 ok: % payment deleted', v_del;
end
$$;

commit;


-- -----------------------------------------------------------------------------
-- F3 -- A-DATA-03: empresa "Inmasoft Uruguay" (b10291f2) sin país, con moneda
-- CLP (incoherente para Uruguay), sin miembros ni datos (0 clientes, 0 proyectos,
-- 0 ventas, 0 costos). Es un resto de pruebas: se desactiva, no se borra.
--
-- NO EJECUTADO (2026-10-30). Revisadas las 26 FK hacia companies más toda
-- columna company_id (43 columnas en total): la empresa tiene 2 áreas de
-- negocio en public.business_areas ("Starlink" y "Cloud", creadas 2026-10-05,
-- sin ventas ni proyectos) y su copia en backup_20261013_import_uy. Como tiene
-- registros, no se borró ni se desactivó: queda a decisión de negocio.
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
-- Criterio: el mismo de los snapshots UYU ya cargados (scripts/import-uy-2026.mjs):
-- un snapshot por mes, tomado el último día hábil del mes.
--   ars_per_usd  = MonedAPI usd/oficial de ese día, punto medio compra/venta
--                  (https://monedapi.ar/api/v2/date/YYYY-MM-DD/usd/oficial). Es
--                  exactamente el mismo valor de los snapshots UYU de esas fechas.
--   ars_per_unit = ars_per_usd / dólar observado del Banco Central de Chile de
--                  ese día (https://mindicador.cl/api/dolar/2026, consultado el
--                  2026-10-30; mindicador.cl publica la serie del BCCh).
-- Así 1/rate da exactamente el dólar observado (CLP por USD).
-- Control: MonedAPI clp/oficial (existe desde mayo) difiere del observado entre
-- 0,3 % y 0,6 % en may–ago; los snapshots en vivo de sep/oct (945,27 / 973,98)
-- difieren 0,7 % / 0,5 % del observado de su fecha de captura (952,00 / 978,61).
--
--   Mes      Fecha       Observado BCCh   ARS/USD
--   2026-01  2026-01-30  858,45           1439,56
--   2026-02  2026-02-27  861,19           1401,185
--   2026-03  2026-03-31  931,57           1383,86
--   2026-04  2026-04-30  901,76           1389,63
--   2026-05  2026-05-29  892,89           1405,835
--   2026-06  2026-06-30  922,34           1476,345
--   2026-07  2026-07-31  924,78           1485,63
--   2026-08  2026-08-31  929,18           1505,765
--
-- EJECUTADO 2026-10-30 04:35 UTC: 8 snapshots insertados. exchange_rate_on('CLP',
-- 'USD', …) resuelve cada mes de ene–ago con su propio snapshot (antes devolvía
-- vacío), así que el consolidado en USD deja de marcar a Chile como pendiente.
-- -----------------------------------------------------------------------------
begin;

do $$
declare
  v_pre int; v_ins int; v_missing int;
begin
  select count(*) into v_pre from public.exchange_rate_snapshots where currency = 'CLP' and period between date '2026-01-01' and date '2026-08-01';
  if v_pre <> 0 then raise exception 'F4 precondition: % CLP snapshots already in 2026-01..08', v_pre; end if;

  insert into public.exchange_rate_snapshots (currency, period, ars_per_unit, ars_per_usd, fetched_at)
  values
    ('CLP', date '2026-01-01', 1.676929, 1439.56, (date '2026-01-30' + time '18:00') at time zone 'America/Santiago'),
    ('CLP', date '2026-02-01', 1.627034, 1401.185, (date '2026-02-27' + time '18:00') at time zone 'America/Santiago'),
    ('CLP', date '2026-03-01', 1.485514, 1383.86, (date '2026-03-31' + time '18:00') at time zone 'America/Santiago'),
    ('CLP', date '2026-04-01', 1.541020, 1389.63, (date '2026-04-30' + time '18:00') at time zone 'America/Santiago'),
    ('CLP', date '2026-05-01', 1.574477, 1405.835, (date '2026-05-29' + time '18:00') at time zone 'America/Santiago'),
    ('CLP', date '2026-06-01', 1.600652, 1476.345, (date '2026-06-30' + time '18:00') at time zone 'America/Santiago'),
    ('CLP', date '2026-07-01', 1.606469, 1485.63, (date '2026-07-31' + time '18:00') at time zone 'America/Santiago'),
    ('CLP', date '2026-08-01', 1.620531, 1505.765, (date '2026-08-31' + time '18:00') at time zone 'America/Santiago')
  on conflict (currency, period) do nothing;
  get diagnostics v_ins = row_count;
  if v_ins <> 8 then raise exception 'F4: % snapshots inserted, expected 8', v_ins; end if;

  select count(*) into v_missing
  from generate_series(date '2026-01-01', date '2026-08-01', interval '1 month') g(m)
  where not exists (select 1 from public.exchange_rate_on('CLP', 'USD', (g.m + interval '14 days')::date) r where r.period = g.m::date);
  if v_missing <> 0 then raise exception 'F4: % months still do not resolve their own CLP rate', v_missing; end if;
  raise notice 'F4 ok: % CLP snapshots inserted', v_ins;
end
$$;

commit;


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
