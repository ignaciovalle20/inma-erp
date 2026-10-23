# Costos de servicios recurrentes y ciclos anuales por aniversario

Cambios de octubre 2026 (migraciones `20261020010000_recurring_service_costs.sql` y
`20261020020000_recurring_annual_anniversary_cycles.sql`). Lo que ve el usuario está en
`docs/manual-usuario.md` (secciones 8.4, 8.5 y 9.1); acá, cómo está armado.

## 1. El costo del servicio

En `recurring_services`:

| Columna | Qué es |
|---|---|
| `fixed_cost` | Costo fijo, **neto de IVA**, en la moneda del servicio (≥ 0, nulo = sin costo fijo). Antes `fixed_monthly_cost`. |
| `cost_periodicity` | `monthly` / `annual`: cada cuánto se paga, independiente de `periodicity` (cómo se vende). La app propone `annual` para dominios y `monthly` para el resto. |
| `supplier_id` | Proveedor cuyas facturas de compra son el costo del servicio. Trigger `recurring_services_validate_supplier`: de la misma empresa y activo al elegirlo (uno que se desactiva después puede quedar). |

`expected_cost` se eliminó. Antes de borrarlo, la migración copió su valor a `fixed_cost`
donde `fixed_monthly_cost` era nulo, era mayor que 0 y el servicio no usa pool. En un
servicio anual `expected_cost` era el costo del año: si no es dominio (hosting,
Starlink…) se paga mensual, así que quedó `cost_periodicity = monthly` con
`round(expected_cost / 12)` (CLP sin decimales, el resto 2); un dominio quedó
`cost_periodicity = annual` con el valor tal cual; un servicio mensual, mensual con el
valor tal cual.

En dev la primera versión de esa migración ya había copiado el costo anual con
frecuencia anual: `20261020030000_recurring_annual_cost_to_monthly.sql` corrige esos
servicios (anuales no dominio con `cost_periodicity = annual`) de la misma forma y
rehace sus períodos de costo sin asignaciones desde enero 2026. En una base donde
`20261020010000` corre ya corregida, no encuentra nada.

Los servicios con pool de licencias MS (`uses_cost_pool`) no usan nada de esto: su costo
sigue saliendo de `recurring_service_cost_pools` / `recurring_service_cost_allocations`.

## 2. Períodos de costo (`recurring_service_cost_periods`)

Una fila por servicio y período de costo: `period` (día 1 del mes), `expected_amount`
(el `fixed_cost` al generarse), `currency` (siempre la del servicio), `exchange_rate`
(guardado con el mismo trigger que el resto de los documentos). Único por
`(recurring_service_id, period)`.

`generate_recurring_service_cost_periods(p_company_id, p_service_id, p_until)` (idempotente):

- Solo servicios activos, sin pool, con `fixed_cost` o con `supplier_id`.
- `monthly`: cada mes; `annual`: el mes de cada aniversario de `start_date`.
- Desde `max(start_date, 2026-01-01)` hasta el mes actual en la zona horaria de la
  empresa (`company_local_date`), nunca después de `end_date`.

Se llama desde: el alta de un servicio (trigger `recurring_services_create_cost_periods`),
`generate_recurring_service_occurrences_since_start` (la app la usa al crear/editar,
`syncRecurringServiceCycles`), `ensure_recurring_service_periods` (tablero y períodos) y
`generate_due_recurring_service_occurrences` (cron mensual).

Trigger `recurring_services_sync_cost_periods` al editar costo, frecuencia, proveedor,
pool, estado o fechas: si cambia la frecuencia borra los períodos del mes actual en
adelante sin facturas; si cambia `fixed_cost` actualiza el esperado de los períodos del
mes actual en adelante sin facturas; después genera los que falten. Los períodos pasados
o con facturas no se tocan.

Vista `recurring_service_cost_period_summary` (security invoker): por período, el
esperado, lo facturado (asignaciones confirmadas en la misma moneda), lo sugerido,
cantidades y `cost_status` = `invoiced` (tiene confirmadas) / `estimated`.

## 3. Facturas de compra → períodos (`cost_service_allocations`)

Modelo de `sales_allocations`: `cost_document_id`, `cost_period_id`, `amount` (> 0, en la
moneda de la factura), `status` (`suggested` / `confirmed`), `suggestion_reason`
(`exact`, `same_amount_batch`, `proportional`), `notes`. Único por (factura, período).
RLS por membresía de la empresa.

Validaciones en la base (`cost_service_allocations_validate` y guardas):

- Factura y período de la misma empresa; nunca un servicio con pool.
- La factura debe ser un costo **general sin trabajo**, sin `cost_allocations` ("Dividir")
  y, para confirmar, no cubierta por el pool de licencias MS.
- La suma confirmada nunca supera el neto de la factura (tolerancia medio peso / medio
  centavo).
- Con asignaciones confirmadas, la factura no puede pasar a un trabajo ni a directo
  (`cost_documents_guard_service_allocations`) ni dividirse
  (`cost_allocations_guard_service_allocations`); las sugeridas se borran solas en esos
  casos.

Columna calculada `service_allocated_amount(cost_documents)`: lo confirmado. 
`covered_by_cost_pool_id` excluye las facturas con asignaciones confirmadas.

RPC `set_cost_service_allocations(p_cost_document_id, p_allocations)`: reemplaza todas las
asignaciones de la factura (el editor "Asignar a servicios" guarda todo confirmado; una
lista vacía la deja sin asignar).

## 4. Reglas automáticas (`web/src/lib/costAllocationSuggestions.ts`)

Puras y con tests (`__tests__/costAllocationSuggestions.test.ts`). Candidatas: facturas
generales sin trabajo, con proveedor, sin ninguna asignación, no cubiertas por pool; y
períodos sin asignaciones de servicios sin pool con proveedor. Se agrupan por
**proveedor + mes + moneda** (mes = período reconocido, si no la fecha):

1. **exact**: una factura igual al esperado de un único período del grupo → confirmada.
2. **same_amount_batch**: N facturas de igual monto y ≥ N períodos con ese esperado → una a
   cada período (por fecha y nombre de servicio), confirmadas; las facturas que sobran
   quedan sin asignar.
3. **proportional**: con lo que queda, una factura igual a la suma de los esperados de los
   períodos libres → se reparte por esperado con resto mayor (redondeo de la moneda),
   confirmada; si no cuadra pero es la única factura del grupo → mismo reparto,
   **sugerida**.
4. Nada más: sin sugerencia.

`costAllocationSuggestionsLoader.ts` (`suggestCostAllocations(supabase, companyId,
{ documentIds | month | supplierId })`) carga candidatas con la sesión del usuario (RLS),
aplica las reglas e inserta por factura. Nunca toca una factura que ya tiene alguna
asignación, así que repetirlo no duplica. Se corre:

- al importar facturas de compra (solo las importadas),
- al crear un costo general a mano con proveedor,
- al crear o editar un servicio (`syncRecurringServiceCycles` / `suggestCostsForService`,
  solo su proveedor),
- al generar períodos (`ensureRecurringServicePeriods` cuando creó algo, y el cron, mes
  actual),
- con "Sugerir asignaciones" (lista de costos, mes en pantalla) y "Buscar sugerencias"
  (Conciliar).

Las sugeridas se confirman o descartan en Conciliar (`resolveCostSuggestions`).

## 5. Reportes (`web/src/lib/reporting.ts`)

- Costo de un servicio sin pool: por **período de costo**, en su mes, en el cliente y el
  área del servicio: suma de las asignaciones confirmadas (cada una con el tipo de cambio
  guardado de su factura) o, si no tiene, el `expected_amount` (con el tipo guardado del
  período). Se eliminó el viejo `fixed_monthly_cost × 12` sobre el ciclo anual.
- La venta anual se sigue contando entera en el mes de su ciclo; solo el costo sigue su
  propio calendario.
- Servicios con pool: igual que antes (su parte del reparto, en el ciclo).
- Costos generales: `net_amount − service_allocated_amount` (lo asignado a servicios ya
  está en el costo del servicio). Vale para el resultado mensual, la serie del panel y el
  consolidado; la rentabilidad por cliente/área/proyecto nunca contaba las facturas
  generales sin asignar, así que no hay doble conteo.
- Tests: `reportingRecurringAnnualCost.test.ts` (Starlink anual con costo mensual,
  dominio con costo anual, período con y sin factura, factura proporcional en 3 hostings,
  factura asignada fuera de generales) y `integration/recurringServiceCosts.integration.test.ts`.

## 6. Ciclos anuales por aniversario (`20261020020000`)

El error: un período anual era el año calendario y solo se generaba en `due_month`.
"EBCO LA LIGUA - ANUAL" (Starlink, anual adelantado, 2026-07-01 → 2027-06-01, vencimiento
"1 de junio") no tuvo ningún ciclo: junio 2026 era antes del inicio y el siguiente junio
es 2027.

Ahora:

- El período N va de `start_date + N años` al día anterior al siguiente aniversario; su
  clave `period` es el día 1 del mes en que empieza.
- **Adelantado**: se genera (para facturar y cobrar) en el mes en que empieza el período;
  **vencido**: en el mes en que termina.
- `due_month` de un servicio anual se deriva (trigger `recurring_services_derive_due_month`):
  `month(start_date)` adelantado, `month(start_date + 1 año − 1 día)` vencido. El formulario
  ya no lo pide; lo muestra calculado. `due_day` sigue editable.
- Funciones ajustadas: `generate_recurring_service_occurrences_for_month`,
  `generate_recurring_service_occurrences_since_start` (también genera períodos de costo),
  `generate_recurring_service_entry`. El matching con Nubox, el tablero y la deuda usan la
  fecha de vencimiento guardada en cada ciclo, que la migración conserva.
- En la app: `boardMonthOf`, `formatPeriod` y `periodLabel` (un período anual se muestra
  "jul 2026 – jun 2027") y `periodEnd` siguen el aniversario.

Migración de datos: cada ciclo anual existente pasa a la clave del período de aniversario
al que corresponde según el mes en que vence (su `invoice_due_date`, si no su `period`
viejo): ese mes es el de inicio (adelantado) o el de fin (vencido). Conserva estado,
fechas, tipo de cambio, notas y `sales_allocations`. Si dos ciclos de un mismo servicio
cayeran en la misma clave, la migración falla y lista los servicios (en dev no hubo
ninguno). Después recalcula `due_month` y genera los ciclos que falten desde enero 2026.

## 7. Pantallas

- Servicio (alta/edición): "Costo fijo", "Se paga", "Proveedor", mes de vencimiento
  calculado.
- Detalle del servicio: costo y proveedor; "Costos del servicio" con cada período
  (esperado, factura asignada, monto real, estado) y "Asignar factura"
  (`/recurring-services/services/{id}/cost-periods/{costPeriodId}`).
- Costo: sección "Servicios recurrentes" y editor "Asignar a servicios"
  (`/costs/{id}/services`, acepta `?period=`).
- Lista de costos: "Sugerir asignaciones", "Asignar a servicios" junto a "Asignar a un
  trabajo"/"Dividir", "Imputado a: Servicios recurrentes".
- Conciliar: "Facturas de compra sugeridas a servicios" con Confirmar / Descartar /
  Confirmar todas.

## 8. Producción

Aplicar en orden, junto con el código: `20261020010000_recurring_service_costs.sql`,
`20261020020000_recurring_annual_anniversary_cycles.sql` y
`20261020030000_recurring_annual_cost_to_monthly.sql` (en prod no cambia nada: la primera
ya copia bien). Después revisar:

- los servicios anuales: la nueva clave de sus ciclos y el `due_month` derivado (puede
  cambiar respecto del que se había cargado a mano);
- los costos fijos copiados desde `expected_cost` y su frecuencia;
- cargar el proveedor de cada servicio para que se asignen sus facturas.
