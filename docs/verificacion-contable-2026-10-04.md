# Verificación contable del ERP — DEV

- **Fecha:** 2026-10-04
- **Rama:** `dev`. Base `0e0e199` → 13 commits locales, **sin push**.
- **Supabase:** DEV `sczgankronafrxybpvnh`. Lo verifiqué en `web/.env.local` (`NEXT_PUBLIC_SUPABASE_URL`) y en `supabase/.temp/project-ref` antes de la primera consulta. Nada se ejecutó contra otro proyecto.
- **Método:** oráculo independiente.
  - Un **dataset dorado** con cifras calculadas a mano y escritas como constantes. Es el test permanente `web/src/lib/__tests__/integration/accounting.golden.integration.test.ts`; corre como miembros reales, con RLS, en empresas desechables `TEST_ACCT_`.
  - Un **SQL de solo lectura** que recalcula de forma independiente los totales reales de DEV de septiembre y octubre 2026.

---

## Veredicto

1. **Antes de esta verificación, los números no eran confiables.** El Resultado Mensual, el dashboard, el home y el consolidado no incluían los servicios recurrentes. El costo de las licencias MS facturadas por Nubox era 0. La ficha de cada trabajo calculaba con IVA. Los listados de ventas y costos sumaban pesos con dólares.
2. Corregí 12 errores de cálculo, uno por commit y con un test que primero fallaba. El dataset dorado (18 casos) y el test del reparto de licencias (4 casos) pasan completos.
3. **Ahora cuadran las invariantes:**
   - Σ clientes = Σ áreas = Resultado Mensual (con los costos no asignados aparte).
   - Σ trabajos + recurrentes + no asignado = resultado operativo.
   - El consolidado USD es igual a la suma de los resultados convertidos.
   - El reparto MS suma exacto, sin partes negativas y sin ocurrencias anuladas.
   - Saldo de técnicos y cobros cuadran.
4. Sobre los datos reales de DEV (Demo Chile SpA y Demo Uruguay SRL, sep y oct 2026), el sistema coincide con el SQL independiente en las 4 combinaciones empresa/mes, tanto en el Resultado Mensual como en la serie del dashboard.
5. **Quedaban abiertos riesgos que dependían de criterios de negocio** (sección Hallazgos):
   - Doble ingreso de una venta sin factura que después se factura en Nubox.
   - Si el pool de licencias se carga neto o con IVA.
   - Cómo se fija la tasa de cambio del mes.

   **Actualización (mismo día, más tarde):** con los criterios ya definidos, P01–P05 y la doble carga de P08 quedaron resueltos. Ver la sección [Puntos abiertos resueltos](#puntos-abiertos-resueltos). Siguen pendientes P06, P07, la parte "pool sin repartir = costo 0" de P08 y P09–P15.

   **Son confiables para decidir** el Resultado Mensual, la rentabilidad del período y el consolidado. Desde la actualización, también los **acumulados por trabajo en moneda extranjera**. Hay que seguir leyendo con cuidado los meses con pools de licencias sin repartir.

---

## Dashboard — widgets y KPIs

**Fuente:** `web/src/app/companies/[id]/page.tsx` (panel por empresa) y `web/src/app/page.tsx` (home multiempresa).

**Datos:** "Esperado" es el oráculo a mano para TEST_ACCT_CL, marzo 1998, en CLP (y 1998‑02 para el mes anterior). "Obtenido" es lo que devuelve la función que alimenta el widget, después de los fixes. "Antes" es la primera corrida, sin fixes y sin la NC2; esa corrida esperaba 1.674.000 de ventas y 819.000 de resultado.

| Widget | Fuente | Fórmula | Período / moneda | Esperado | Obtenido | Estado |
|---|---|---|---|---|---|---|
| KPI Ventas netas | `getMonthlySeries` (último punto) | Σ neto de ventas no anuladas (N/C restan) + ingreso de ciclos recurrentes facturados sin factura Nubox | Mes elegido (por defecto, el mes local de la empresa); moneda de la empresa | 1.624.000 | 1.624.000 | OK. Antes: 1.502.000, faltaban 172.000 de recurrentes (C01) |
| KPI Costos directos | `getMonthlySeries` | Σ neto de costos `direct` + costos recurrentes (fijo ×12 si es anual, o parte del pool) | idem | 355.000 | 355.000 | OK. Antes: 300.000 (C01) |
| KPI Margen directo | `getMonthlySeries` | Ventas − costos directos | idem | 1.269.000 | 1.269.000 | OK |
| KPI Resultado operativo | `getMonthlySeries` | Margen − (Σ costos `general` netos + sueldos del mes) | idem | 769.000 | 769.000 | OK. Antes: 702.000 sobre 819.000 esperados (C01) |
| Gráfico "Ventas, costos y margen" (12 meses) | `getMonthlySeries(…, 12)` | La misma fórmula por mes, con conversión por la tasa de **cada** mes | 12 meses hasta el elegido | Feb‑98 ventas 70.000; Abr‑98 50.000 (factura del 01‑04) | 70.000 / 50.000 | OK |
| Waterfall "De ventas a resultado" | `getMonthlySeries` | Ventas → −directos → margen → −generales → resultado | idem | 1.624.000 / 355.000 / 1.269.000 / 500.000 / 769.000 | igual | OK |
| Tarjeta "Servicios del mes" (nueva) | `getRecurringServiceOccurrencesForMonth` + `isOverdue` | Cuenta los ciclos del mes del tablero: por facturar (`pending_invoice`), por cobrar (`invoiced` / `pending_collection`), vencidos (vencimiento < hoy y abiertos) | **Siempre el mes actual** en la zona de la empresa; no sigue el selector de período | Oct‑2026: 0 / 1 / 0 al 04‑10; 1 vencido al 06‑10 | 0 / 1 / 0 y 1 | OK. Si la consulta falla muestra ceros sin aviso (P14) |
| Aviso "Proyectos sin costo registrado" | `getMonthlySeries.pendingProjectCount` | Trabajos `en_ejecucion` sin `cost_documents` en el mes y sin confirmación de costo 0 | Mes elegido | 1 (J2) | 1 | OK según el criterio vigente. J2 tiene 60.000 de sueldos imputados y aun así sale "sin costo" (P09) |
| Tabla "Proyectos del mes" | `getProfitabilityBreakdown().projects` (top 8 por ingreso) | Ingreso = ventas del trabajo; costo = directos + prorrateos (netos) + sueldos imputados | Mes elegido | J1 950.000 / 390.000 / 560.000; J2 500.000 / 60.000 / 440.000 | igual | OK |
| Badge "Vs. presupuesto" | idem `budgetVariance` | Costos **acumulados** − `projects.budget` | Histórico completo | J1 −1.610.000 → "Bajo presupuesto" | −1.610.000 | OK numéricamente; `budget` mezcla dos significados (P05) |
| Banner "Datos incompletos" | `hasError` y `errors` de las dos fuentes | Aparece si falla alguna consulta, ahora también la de recurrentes | — | sin banner | sin banner | OK |
| Home: "RESULTADO mm/aaaa" por empresa | `computeMonthlyResult` | La misma fórmula del KPI Resultado operativo | Mes actual en hora de Montevideo | CL 769.000 · UY USD 2.320 | 769.000 · 2.320 | OK. Antes no incluía recurrentes (C01) y cortaba el mes en UTC (C08) |
| Home → Consolidado USD | `computeConsolidatedResult` | Σ resultado de cada empresa × USD por unidad del snapshot del período | Mes elegido; USD | 769 + 2.320 + 0 = 3.089 | 3.089 | OK. Antes: 2.902 (C01) |
| Ficha de cada trabajo (no es del dashboard) | `computeProjectProfitability` | Fila del trabajo en `getProfitabilityBreakdown` | Mes actual local | J1 950.000 / 390.000 / 560.000 | igual | OK. Antes: costo 447.000 **con IVA** (C02) |

**Filtros y aislamiento:**

- **Empresa vacía** (TEST_ACCT_EMPTY): Resultado Mensual, serie de 12 meses y rentabilidad dan todo 0, sin errores ni filas.
- **Usuario de otra empresa** (miembro solo de CL): al pedir los datos de UY recibe 0 y listas vacías. En su consolidado aparece **solo** CL.
- **Selector de período:** el dashboard usa el mes de la URL. Sin parámetro, ahora toma el mes local de la empresa (C08).

---

## Invariantes de cuadre

| Invariante | Resultado | Diferencia |
|---|---|---|
| CL: Σ ingresos por cliente = Σ por área = ventas netas del Resultado Mensual | 1.624.000 = 1.624.000 = 1.624.000 | 0 (antes, Σ áreas daba 2.674.000 por doble conteo: C07) |
| CL: Σ costos por cliente + no asignado = costos del Resultado Mensual | 565.000 + 290.000 = 855.000 | 0. No asignado (a mano): K2 80.000 + mitad de K3 asignada a área 60.000 + sueldos no imputados 150.000 |
| CL: Σ costos por área + no asignado = costos del Resultado Mensual | 565.000 + 290.000 = 855.000 | 0 (antes faltaba la mano de obra: C04) |
| CL: Σ margen de trabajos + recurrentes + no asignado = resultado operativo | 1.000.000 − 231.000 = 769.000 | 0 |
| UY (USD con documentos en UYU, 40 UYU = 1 USD): Resultado Mensual, clientes y áreas | ventas 3.700, directos 880, generales 500, resultado 2.320; Σ costos de clientes + 500 = 1.380 | 0 |
| Consolidado USD = Σ resultados convertidos | 769 + 2.320 + 0 = 3.089 | 0 |
| Reparto MS: suma = total de la factura | marzo `[334, 333, 333, 0]` = 1.000; mayo `[1, 1, 0, 0]` = 2; UY `[2.000]` | 0 (antes: `[500, 167, 167, 167, −1]` y `[1, 1, 1, −1]`) |
| Reparto MS: ninguna parte negativa, anuladas excluidas, venta 0 recibe 0 | Se cumple | — (antes la anulada recibía 500 y la de venta 0, −1: C05/C06) |
| Asignaciones ≤ costo del documento | Prorrateo K3 = 142.800 = total; sueldos imputados 150.000 ≤ 300.000 | 0 |
| Técnicos: cargos − pagos aplicados = saldo mostrado | 119.000 − 50.000 = 69.000 | 0 |
| Cobros de ventas (bruto): facturado = cobrado + pendiente | 1.768.380 = 1.666.000 + 102.380; la pantalla de pendientes lista solo la venta manual impaga (100.000 neto) | 0 |
| Recurrentes (tablero): por facturar + por cobrar + cobrado = todo lo no anulado del mes | Mar‑98: 0 + 62.000 + 121.000 = 183.000; Sep‑26: cobrado 10.000; Oct‑26: por cobrar 10.000 | 0 |
| Cortes de mes | Venta del 31‑03 en marzo; del 01‑04 en abril. 23:30 del 30‑09 (CL y UY) → septiembre; 00:30 del 01‑10 → octubre; invierno chileno (UTC−4) cubierto | OK después de C08/C09 |
| **Datos reales de DEV** (SQL independiente vs `computeMonthlyResult` y `getMonthlySeries`) | Ver la tabla siguiente | < 0,000001 en las 4 combinaciones |

**Datos reales (solo lectura):**

| Empresa | Mes | Ventas netas (SQL = sistema) | Costos directos | Costos generales | Resultado |
|---|---|---|---|---|---|
| Demo Chile SpA (CLP) | 2026‑09 | 3.283.699,25 | 283.555,34 | 100.000 | 2.900.143,90 |
| Demo Chile SpA (CLP) | 2026‑10 | 674.111 | 0 | 0 | 674.111 |
| Demo Uruguay SRL (UYU) | 2026‑09 | 60.010,54 | 4.802,53 | 12.000 | 43.208,01 |
| Demo Uruguay SRL (UYU) | 2026‑10 | 8.015,06 | 0 | 0 | 8.015,06 |

Los decimales en CLP vienen de convertir documentos en USD con la tasa del mes. La pantalla los redondea al mostrar (P12). En octubre la tasa es el snapshot vigente. Ese snapshot se reescribe cada vez que alguien abre un reporte del mes en curso (P03), así que estos números de octubre van a cambiar.

---

## Hallazgos

Severidad: **Crítico** = cifra de negocio incorrecta en uso normal · **Alto** = total incorrecto o que mezcla unidades · **Medio** = incorrecto en casos acotados · **Bajo** = menor o cosmético.

### Corregidos

| ID | Severidad | Módulo | Descripción | Archivo:línea | Estado | Commit |
|---|---|---|---|---|---|---|
| C12 | Crítico | Rentabilidad / recurrentes | Las ocurrencias vinculadas por Nubox a una factura se excluían enteras para no duplicar el ingreso. Así también se perdía su **costo**: las licencias MS facturadas por Nubox quedaban con costo 0 por cliente y por área. Además solo se tomaba la primera allocation del pool. | `web/src/lib/reporting.ts` (`toRecurringLedgerRows`, `RECURRING_LEDGER_COLUMNS`) | corregido | `5ed805f` |
| C01 | Alto | Resultado Mensual / dashboard / home / consolidado / asistente | `computeMonthlyResult` y `getMonthlySeries` no incluían servicios recurrentes: ni el ingreso de los ciclos facturados a mano ni ningún costo recurrente. Σ clientes ≠ Resultado Mensual. | `web/src/lib/reporting.ts` (`computeMonthlyResult`, `getMonthlySeries`) | corregido | `009f24a` |
| C02 | Alto | Ficha del trabajo | `computeProjectProfitability` usaba `total_amount` (con IVA) en costos directos y prorrateos, sumaba todas las ventas (una N/C sin emparejar **sumaba**) y no convertía moneda. La ficha y el reporte mostraban márgenes distintos para el mismo trabajo. | `web/src/lib/reporting.ts` (`computeProjectProfitability`) | corregido | `87cfd29` |
| C05 | Alto | Reparto de licencias MS | Todo el resto por redondeo iba a la última ocurrencia por id. Si todas las partes redondeaban hacia arriba, quedaba una parte negativa (`1, 1, 1, −1`). | `supabase/migrations/20261004010000_cost_pool_allocation_largest_remainder.sql` | corregido (migración aplicada en DEV) | `ed1cf56` |
| C10 | Alto | Listado de ventas | Las tarjetas y el pie sumaban el neto de todas las monedas: una empresa CLP con una factura en USD mostraba pesos + dólares. | `web/src/app/companies/[id]/sales/salesView.ts` (`summarizeRows`), `page.tsx` | corregido | `c2b8aec` |
| C11 | Alto | Listado de costos | Total, Directos, Generales y el pie sumaban `net_amount` de todas las monedas (Demo Chile SpA suma USD 250 a sus pesos de septiembre). | `web/src/lib/costTotals.ts`, `web/src/app/companies/[id]/costs/page.tsx` | corregido | `9fe0890` |
| C03 | Medio | Rentabilidad / recurrentes | El costo fijo **mensual** de un servicio **anual** se imputaba una sola vez contra la factura anual (2.000 en vez de 24.000). | `web/src/lib/reporting.ts` (`toRecurringLedgerRows`) | corregido | `9759734` |
| C04 | Medio | Rentabilidad por cliente / área | Los sueldos imputados a un trabajo sumaban al trabajo pero no a su cliente ni a su área. | `web/src/lib/reporting.ts` (roll‑up de `workByProjectPeriod`) | corregido | `f13b559` |
| C06 | Medio | Reparto de licencias MS | Las ocurrencias anuladas (`void`) recibían parte de la factura del proveedor. | misma migración | corregido | `ed1cf56` |
| C07 | Medio | Rentabilidad por área | Una venta con área distinta a la de su trabajo sumaba en **las dos** áreas: Σ áreas > ventas netas. | `web/src/lib/reporting.ts` (bucketing por área) | corregido | `4381d30` |
| C08 | Medio | Períodos | El mes actual por defecto de dashboard, Resultado Mensual, Rentabilidad, trabajos, ficha, consolidado y home se calculaba en UTC. Desde las ~20/21 h del último día del mes mostraba el mes siguiente. | `web/src/lib/period.ts` (`currentMonth(country)`) y 7 páginas | corregido | `7565434` |
| C09 | Medio | Períodos | La fecha propuesta en "venta sin factura" y "marcar pagado" salía de `toISOString()` (UTC): de noche proponía el 1 del mes siguiente y la venta o el cobro se guardaba en el mes equivocado. | `web/src/lib/period.ts` (`localDate`), `manual-sale/form.tsx`, `sales/pending/forms.tsx` | corregido | `a0ac708` |

Además hay dos commits de tests: `fd0f14a` (tipado del test del reparto) y `6dde875` (dataset dorado permanente).

### Pendientes (no corregidos: requieren definir un criterio, o no son de cálculo)

| ID | Severidad | Módulo | Descripción | Archivo:línea | Estado | Recomendación |
|---|---|---|---|---|---|---|
| P01 | Alto | Ventas sin factura ↔ Nubox | Sigue abierto (H03 de la auditoría anterior). Una venta manual que después se factura en Nubox con **otra fecha** no se adopta: quedan dos ingresos. Además el saldo por facturar del trabajo ignora las ventas manuales, así que el import sugiere vincular la factura al mismo trabajo. | `web/src/lib/nubox.ts:475-500`, `web/src/lib/dal.ts` (`getProjectBillingBalances`, `.eq("document_type","invoice")`) | **resuelto** (`a9ae65f`) | Definir el criterio. Propuesta: contar las ventas `manual` en el saldo del trabajo y, al importar, ofrecer anular o adoptar la venta manual del mismo trabajo y monto aunque la fecha difiera. |
| P02 | Alto | Reparto MS (neto vs bruto) | El formulario del pool pide "Monto total de la factura", lo que en Chile se lee **con IVA**. Los ingresos del servicio y todos los reportes son netos: si se carga el total, el margen de licencias queda subestimado en el 19 % del costo. | `web/src/app/companies/[id]/costs/ms-licenses/new/form.tsx:69` | **resuelto** (`e9ce4f8`) | Decidir si el pool se carga neto: rotular "Monto **neto** de la factura (sin IVA)", o pedir neto e IVA por separado. Revisar los pools ya cargados. |
| P03 | Alto | Multimoneda | Sigue abierto (H07/H15). La tasa del mes es la **última consultada**: se sobrescribe cada vez que se abre un reporte del mes en curso. Un mes que nadie abrió queda "conversión pendiente" para siempre. La tabla es global y cualquier usuario autenticado puede escribirla. | `web/src/lib/exchangeRates.ts:92-147`; políticas de `exchange_rate_snapshots` | **resuelto** (`2112558`) | Fijar la tasa de cierre de mes con un cron (service role), quitar INSERT/UPDATE a `authenticated` y permitir carga manual por un admin. |
| P04 | Medio | Rentabilidad (acumulados) | Sigue abierto (H16). Los acumulados por trabajo y el badge "Vs. presupuesto" suman cada documento en su moneda original, sin convertir y sin tope de fecha. | `web/src/lib/reporting.ts` (`accumulatedRevenueByProject` y siguientes) | **resuelto** la conversión (`2c182e0`); el tope de fecha sigue sin cambiar | Convertir cada fila con la tasa de su propio mes y acotar por período. Requiere P03. |
| P05 | Medio | Trabajos | Sigue abierto (H17). `projects.budget` es a la vez la **cotización de venta** (saldo por facturar en Nubox) y el **presupuesto de costo** (badge "Vs. presupuesto" = costos − budget). Hoy casi todo trabajo sale "Bajo presupuesto". | `web/src/lib/nubox.ts:599`, `web/src/lib/reporting.ts` (`budgetVariance`) | **resuelto** (`2c182e0`) | Separar `quoted_amount` y `cost_budget`, o cambiar el badge a "margen vs cotización". |
| P06 | Medio | Recurrentes (reconocimiento) | Los ciclos de servicios **sin factura** (`requires_invoice = false`, estado `pending_collection`) no cuentan como ingreso hasta que se cobran. Las ventas manuales sin factura, en cambio, cuentan al cargarse. | `web/src/lib/reporting.ts` (`recurringLedgerQuery`, filtro `invoiced`/`collected`) | pendiente (criterio conservador vigente) | Decidir si se reconocen en su mes de vencimiento, igual que una venta manual pendiente. |
| P07 | Medio | Reparto MS | Sigue abierto (H09). Se puede editar el total de un pool ya repartido, y entonces el reparto deja de sumar el total. No se puede re-repartir. | policy UPDATE de `recurring_service_cost_pools` | pendiente | Bloquear con un trigger los cambios de total, moneda o período si hay allocations, u ofrecer "rehacer reparto". |
| P08 | Medio | Reparto MS (operativo) | Un pool sin repartir aporta costo 0 en todos los reportes. Y si la factura de Microsoft se carga **también** como documento de costo, ahora (con C01) se contaría dos veces en el Resultado Mensual. | — | **resuelta la doble carga** (`1ed2d43`, `d9d7ede`); "pool sin repartir = costo 0" sigue pendiente | Regla: la factura de licencias se carga **solo** como pool. Agregar un aviso de "pool sin repartir" en el dashboard. |
| P09 | Bajo | Dashboard (aviso) | "Proyectos sin costo registrado" ignora los sueldos imputados y el `recognized_period`: un trabajo con mano de obra aparece "sin costo". | `web/src/lib/dal.ts` (`getProjectCostStatus`), `web/src/lib/reporting.ts` (`getMonthlySeries`) | pendiente | Considerar también `work_allocations` y el período efectivo. |
| P10 | Bajo | Nubox ↔ recurrentes | El matching estampa `invoiced_at = current_date` (fecha UTC del import), no la fecha de la factura. Los reportes ya usan la fecha de la factura vinculada (C12); el tablero muestra la del import. | `supabase/migrations/20260922060000_…nubox_matching.sql:82` | pendiente | Usar `sd.document_date`. |
| P11 | Bajo | Áreas | Las empresas creadas después del 22‑09 no reciben las áreas **Starlink** ni **Cloud**: el trigger `seed_default_business_areas` solo siembra las 9 originales. | función `seed_default_business_areas` | pendiente | Migración: agregar las dos al trigger. |
| P12 | Bajo | Multimoneda | El motor conserva los decimales de la conversión en CLP y `Money` redondea al mostrar: las partes mostradas pueden diferir ±1 peso del total. | `web/src/components/Money.tsx` | pendiente (decisión: no cambiar) | Si molesta, redondear por fila convertida antes de sumar. |
| P13 | Bajo | Código muerto | `computeClientProfitability` / `computeAreaProfitability` no se usan en ninguna pantalla, pero siguen exportadas con `total_amount` (bruto) y sin restar N/C. | `web/src/lib/reporting.ts` | pendiente | Borrarlas o hacerlas derivar de `getProfitabilityBreakdown`, como C02. |
| P14 | Bajo | Dashboard | La tarjeta "Servicios del mes" muestra 0 / 0 / 0 si su consulta falla (`fetchRecurringServiceOccurrences` devuelve `[]` ante error). | `web/src/lib/dal.ts` (`fetchRecurringServiceOccurrences`) | pendiente | Propagar el error y mostrar "no se pudo leer". |
| P15 | Medio (no contable) | Recurrentes | El cron sigue corriendo una vez por mes (`0 6 1 * *`), aunque ahora el tablero genera los ciclos al abrir el mes (mitigación de H06). | `web/vercel.json` | pendiente | Cron diario (es idempotente). |

### Regresiones de la auditoría anterior (`docs/auditoria-dev-2026-09-23.md`)

| Hallazgo anterior | Estado al inicio de esta verificación | Ahora |
|---|---|---|
| H01: costo de recurrentes vinculados a Nubox = 0 | **Abierto** (`reporting.ts` sin cambios desde la auditoría) | Corregido (C12) |
| H02: recurrentes fuera del Resultado Mensual | **Abierto** | Corregido (C01) |
| H05: reparto MS con partes negativas | **Abierto** (reproducido con datos reales: −1) | Corregido (C05) |
| H08: reparto MS con anuladas | **Abierto** (la anulada recibió 500) | Corregido (C06) |
| H10: costo fijo de servicios anuales | **Abierto** | Corregido (C03) |
| H11: mano de obra fuera de cliente/área | **Abierto** | Corregido (C04) |
| H18: venta en dos áreas | **Abierto** | Corregido (C07) |
| H03: doble ingreso venta sin factura + Nubox | **Abierto** | Sigue pendiente (P01: criterio) |
| H09, H15/H07, H16, H17 | Abiertos | Siguen pendientes (P07, P03, P04, P05) |
| H06: generación mensual sin reintento | Mitigado por el equipo (el tablero genera al abrir el mes) | Cron todavía mensual (P15) |

---

## Decisiones que tomé sin consultar

1. **Costo recurrente = costo directo** en el Resultado Mensual. Es atribuible a la venta de un cliente concreto, igual que los costos de un trabajo. El KPI "Costos directos" y el waterfall lo incluyen. El link del KPI sigue llevando al listado de documentos de costo, que no muestra los recurrentes.
2. **Mes del costo de una ocurrencia vinculada por Nubox = mes de su factura** (`recognized_period` o `document_date`), para que ingreso y costo caigan juntos. Las no vinculadas siguen la regla que ya existía: facturación → vencimiento → período.
3. **Servicio anual: costo fijo mensual × 12, imputado en el mes de la factura anual.** Es la contraparte de un ingreso que también se reconoce entero en ese mes. No implementé devengo mensual.
4. **Una venta suma en una sola área:** la de su trabajo si tiene trabajo (ahí caen sus costos), si no la propia.
5. **Totales en otra moneda: aparte, sin convertir.** En los listados de ventas y costos no invento una tasa: los muestro por moneda como "no sumado".
6. **Pantallas multiempresa** (home y consolidado): mes actual en hora de Montevideo. Las de una empresa usan su país: CL → America/Santiago, UY → America/Montevideo.
7. **Criterios conservadores que dejé como estaban:** pool sin repartir = costo 0; ciclos sin factura no se reconocen hasta cobrarse (P06); redondeo de CLP solo al mostrar.
8. **Reparto MS: desempate del mayor resto** por fracción, después monto, después id. Las ocurrencias con venta 0 nunca reciben resto. Los pools ya repartidos en DEV **no se modificaron**: la migración solo reemplaza la función (no destructiva).
9. **Migración aplicada en DEV:** `20261004010000_cost_pool_allocation_largest_remainder.sql`, con `supabase db push --linked` después de un `--dry-run` que confirmó destino `sczgankronafrxybpvnh` y una sola migración pendiente.
10. **Comparación sobre datos reales:** las funciones del sistema leyeron con la service role y `getSession` simulado. El tipo de cambio se leyó del snapshot del mes, sin fetch en vivo, para que el mes en curso no escribiera en la tabla global. El script fue temporal y lo saqué de `src/`.
11. **Script `zzAuditoria.integration.test.ts`** de la auditoría anterior: estaba sin trackear en `src/` y **rompía `tsc`/build**. Lo moví fuera del repo, al scratchpad de la sesión; no lo borré.
12. **No corrí las otras suites de integración existentes:** generan ocurrencias para todos los servicios activos de DEV, no solo los de prueba. Corrí solo `accounting.golden` y `costPoolAllocation`, que crean y borran sus propios datos.
13. **No toqué los datos `TEST_AUDIT` (auditoría anterior) ni `TEST_QA` (QA del equipo)** que siguen en DEV: no son `TEST_ACCT_` y borrar datos existentes estaba fuera de alcance.

---

## Datos TEST_ACCT_ — eliminados

Los dos tests (`accounting.golden.integration.test.ts` y `costPoolAllocation.integration.test.ts`) crean sus datos y los borran en `afterAll`, con el cliente service role y en orden de claves foráneas. Es el mismo patrón que `reportingRecurringServices.integration.test.ts`. Antes de terminar, el dorado verifica que no quedó nada.

Verificación final con una consulta de solo lectura a DEV, después de la última corrida:

| Qué | Filas restantes |
|---|---|
| `companies` con nombre `TEST_ACCT%` (incluye `TEST_ACCT_POOL`) | 0 |
| `auth.users` con email `test_acct%` | 0 |
| `clients` / `projects` / `personnel` / `recurring_services` con nombre `TEST_ACCT%` | 0 / 0 / 0 / 0 |
| `exchange_rate_snapshots` de 1998‑02 y 1998‑03 (los inserta el dorado) | 0 |

---

## Cómo volver a correrlo

```bash
cd web
npm test
npm run test:integration -- accounting.golden costPoolAllocation
```

`tsc`: 0 errores · lint: 0 errores (los mismos 7 warnings que antes) · 429/429 tests unitarios · `next build` OK.

---

## Puntos abiertos resueltos

- **Fecha:** 2026-10-04, después de la verificación de arriba, con los criterios definidos por el equipo.
- **Rama:** `dev`, commits locales **sin push**.
- **Supabase:** solo DEV `sczgankronafrxybpvnh`. Lo verifiqué en `web/.env.local` y `supabase/.temp/project-ref` antes de cada sesión, y cada `db push` pasó primero por un `--dry-run`.
- **Método:** cada punto arrancó con un test que fallaba. Después vino el fix, y por último tsc + lint + suite unitaria + dorado + build. Cada caso quedó en el test dorado (`accounting.golden.integration.test.ts`), en un bloque propio con empresas `TEST_ACCT2_`, así el oráculo original no se mueve.

**Estado final:** tsc 0 errores · lint 0 errores (7 warnings, los mismos) · **455/455** tests unitarios · dorado **25/25** · las 5 suites de integración, 58/58 · `next build` OK.

### Qué se hizo en cada punto

| # | Punto | Qué cambió | Commits | Migración |
|---|---|---|---|---|
| 1 | Doble ingreso venta sin factura ↔ Nubox (P01) | Al importar, la factura adopta la **única** venta sin factura (`manual`) del mismo cliente con neto ±1 y fecha ±31 días. Si hay más de una candidata, o si dos facturas reclaman la misma, no adopta ninguna: la factura queda "requiere revisión" y no se importa. La venta adoptada toma la fecha, el neto y los impuestos de la factura. El saldo por facturar del trabajo cuenta las ventas sin factura, así que ya no se sugiere vincular la factura a un trabajo que ya tiene esa venta. | `a9ae65f` | `20261004020000` |
| 2 | Pool de licencias MS neto (P02) | El campo dice "Monto neto (sin IVA)". Debajo se ve el total con IVA (19 % CL, 22 % UY) solo como referencia: no se guarda. Cambiaron también los textos del listado, la ficha del pool, la guía y el manual. | `e9ce4f8` | — |
| 3 | Tipo de cambio por documento (P03) | Ventas, costos, ciclos recurrentes y pools guardan `exchange_rate` y `exchange_rate_period`. Los fija un trigger al crearse o importarse, con el snapshot del mes de su fecha o el más cercano anterior. Todos los reportes convierten con la tasa guardada. Hubo un backfill no destructivo. Solo el service role escribe `exchange_rate_snapshots`, y `getOrSnapshotRate` lo hace con el service role. | `2112558` | `20261004030000` |
| 4 | Cotización y presupuesto de costo (P04, P05) | Columnas `quoted_amount` (copiada de `budget`) y `cost_budget`. "Vs. presupuesto" compara el **costo acumulado** con `cost_budget`. Los acumulados por trabajo convierten cada fila a la moneda de la empresa. Se actualizaron formularios, ficha, listado, badge del dashboard, rentabilidad, MCP y el saldo de Nubox. `budget` queda **sin uso y sin borrar**. | `2c182e0` | `20261004040000` |
| 5 | Factura de Microsoft duplicada (P08) | La columna calculada `cost_documents.covered_by_cost_pool_id` marca el documento cuando su mes tiene pool de licencias MS y coincide el proveedor del pool o el área de Licencias MS. Esos documentos no suman en el Resultado Mensual, el dashboard ni la rentabilidad. El alta de costo y la pantalla de asignación avisan en vivo, con link al reparto. El listado y la ficha muestran el badge "Cubierto por pool", también con link. | `1ed2d43`, `d9d7ede` | `20261004050000` |

**Efecto sobre los datos reales de DEV:**

- **Demo Chile SpA, sep‑2026.** El costo general "Licencias de software" (100.000 CLP, 01‑09) es la misma factura que el pool de licencias de ese mes, también de 100.000. Se contaba dos veces y ahora queda "cubierto por pool": los costos generales de septiembre bajan de 100.000 a 0 y el resultado sube 100.000. Recalculado con SQL independiente: costos directos 283.555,34 (igual que en la verificación), generales 0. Las ventas de septiembre ya no son las de la tabla de arriba: hoy a las 12:26 (‑03) alguien del equipo importó un archivo de Nubox en Demo Chile SpA con 19 documentos de septiembre (ventas netas del mes ahora: 17.668.198,25). Ese cambio viene de esa importación, no de estos cambios.
- **Tipo de cambio.** El backfill rellenó todos los documentos, sin ninguno pendiente. Los de septiembre tomaron el snapshot de septiembre, el mismo que ya usaba el reporte, así que esas cifras no cambian. Los de octubre quedaron fijos con el snapshot de octubre vigente al aplicar la migración, y ya no cambian cuando alguien abre un reporte.
- **Pool que podría tener IVA.** Hay un solo pool real: Demo Chile SpA, sep‑2026, 100.000 CLP. Se cargó con el rótulo viejo, "Monto total de la factura". Que sea un número redondo y que coincida con el costo "Licencias de software" sugiere que es neto, pero no se puede confirmar desde el sistema. No lo modifiqué.

### Decisiones que tomé sin consultar

1. **Punto 1:**
   - La tolerancia (±1, ±31 días) aplica solo a ventas sin factura (`manual`) adoptadas por una **factura**. Las ventas viejas sin folio cargadas como `invoice`/`receipt`, y las notas de crédito, siguen necesitando fecha y neto exactos.
   - Una coincidencia exacta se adopta primero, como antes. La tolerancia mira solo lo que queda.
   - La venta adoptada toma la fecha y el neto de la factura (con su línea única ajustada), pero su ingreso **se queda en el mes en que ya estaba reconocido** (`recognized_period`), para que ningún mes pasado cambie.
   - La migración vuelve a validar la adopción con la misma tolerancia y nunca confía en la vista previa.
2. **Punto 2:** sin IVA conocido para otro país, no se muestra total (no se adivina una tasa).
3. **Punto 3:**
   - La fecha de un ciclo recurrente es `invoiced_at`, si no `invoice_due_date`, si no `period`, tomada al crearse.
   - El documento conserva su tasa salvo que cambie su moneda o su fecha; un valor enviado por un cliente se ignora.
   - Sin ningún snapshot anterior, la tasa queda vacía y el reporte usa la del mes, como antes (o marca "conversión pendiente").
   - Los sueldos no tienen tasa propia y siguen con la del mes.
   - El consolidado USD convierte el **resultado** de cada empresa con la tasa del período: no es un documento.
   - Quité también DELETE y TRUNCATE de `exchange_rate_snapshots` a `anon`/`authenticated`; TRUNCATE salteaba RLS.
4. **Punto 4:**
   - La firma vieja de `create_project_with_quote` (`p_budget`) queda por compatibilidad y guarda el monto como cotización; nada escribe `budget`.
   - Los acumulados siguen sin tope de fecha (P04 lo mencionaba, pero no estaba en lo pedido).
5. **Punto 5:**
   - Lectura **conservadora** de "mismo proveedor": un documento imputado a un trabajo o área **fuera** de Licencias MS nunca queda cubierto. En DEV, el proveedor del pool de Demo Chile SpA también facturó "Discos y memoria" (USD 250) a un trabajo de IT Support; con la regla literal se habría excluido un costo real.
   - "Área de Licencias MS" = un área llamada "Microsoft 365" / "Licencias MS", o la que usa un servicio recurrente `ms_licenses` de la empresa.
   - La marca es una columna calculada, no guardada: vale igual si el pool se carga antes o después que el documento.
   - El aviso no impide guardar.
6. **Orden de las tareas:** la limpieza de TEST_AUDIT la hice **antes** del backfill del punto 3, no al final. Tenía un snapshot de prueba "UYU 1998‑01" con tasa 1,0, y el "más cercano anterior" lo habría tomado para documentos uruguayos sin snapshot propio.
7. **TEST_AUDIT:** antes de borrar verifiqué que no compartía datos con empresas reales (ni membresías, ni referencias cruzadas, ni filas creadas por sus usuarios fuera de sus empresas). Lo borré con el SQL del reporte de auditoría y después eliminé sus 2 usuarios con la API admin. No toqué TEST_QA, salvo el corte temporal del punto siguiente.
8. **Suites de integración:**
   - Puse `end_date = 2000‑01‑01` a los 10 servicios de TEST_QA, con `session_replication_role = replica` para que ningún trigger tocara nada. Corrí las suites y restauré `end_date` y `updated_at` exactos (comparado contra el respaldo: idéntico).
   - Antes simulé el cron dentro de una transacción revertida: con ese corte, `generate_due_recurring_service_occurrences()` no generaba nada para las empresas demo. Por eso el corte alcanzó para aislarlas.
   - `qaFase2b` no se corrió: es opcional (`QA_FASE2B=1`) y conserva sus datos en TEST_QA.
   - Dos ciclos de Demo Chile SpA tienen `updated_at` de hoy a las 12:24 (‑03): son "cobrado" marcados desde la app, antes de correr las suites, no por los tests.

### Verificación de limpieza (solo lectura, al final)

Todo en **0**:

- Empresas `TEST_ACCT%` (incluye `TEST_ACCT2_` y `TEST_ACCT_POOL`).
- Usuarios `test_acct%`.
- Membresías huérfanas.
- Snapshots de 1997–1998.
- Clientes, trabajos, cotizaciones, proveedores, personal, servicios, folios, líneas, lotes de importación y cargos de técnico con prefijo `TEST_ACCT`.
- Documentos, ciclos, pools y sueldos de 1997–1998.
- Filas huérfanas: ciclos sin servicio, repartos sin pool o ciclo, líneas sin documento, asignaciones sin documento o sin sueldo, filas de importación sin lote, documentos creados por usuarios borrados.

En DEV quedan solo Demo Chile SpA, Demo Uruguay SRL y TEST_QA CL/UY (con su usuario `test_qa_fase2b`).

### Migraciones para producción

**Referencia.** Según git (sin conectarme a prod), el último deploy a producción es `origin/main` (`07ddbbc`, 2026‑09‑21), con 40 migraciones, la última `20260921020000_external_technicians.sql`. El registro del 2026‑09‑21 dice que prod coincidía 40/40 con el repo. Si después se aplicó algo a mano en prod, hay que revisarlo con `supabase migration list` antes del deploy.

**Orden de aplicación:** el de la tabla (por nombre). El workflow `db-migrations.yml` las aplica al hacer push a `main`, si `DB_MIGRATIONS_ENABLED=true`. Las migraciones tienen que estar aplicadas **antes** de que corra la app nueva, porque la app lee columnas nuevas.

**Columnas de la tabla.**

- **Reversible.** "Sí": basta reponer la versión anterior de la función o de los permisos, sin perder datos. "Sí (esquema)": hay que borrar columnas, tablas o triggers nuevos, y se pierde lo que se haya cargado en ellos después. "Parcial": además insertó o modificó datos que habría que identificar y borrar a mano.
- **Backfill.** Si la migración escribe datos existentes al aplicarse.

| # | Migración | Qué hace | Reversible | Backfill |
|---|---|---|---|---|
| 1 | `20260922010000_recurring_services_v2_schema.sql` | Columnas nuevas en `recurring_services`; tablas `recurring_service_occurrences`, `_cost_pools`, `_cost_allocations` con RLS y triggers | Sí (esquema) | Sí: `status` de los servicios existentes desde `active` |
| 2 | `20260922020000_recurring_services_status_default.sql` | Default `status = 'active'` | Sí | No |
| 3 | `20260922030000_recurring_service_occurrences_generation.sql` | Función del cron que genera ciclos | Sí | No |
| 4 | `20260922040000_recurring_service_occurrences_generation_fix.sql` | Reescribe la función del cron | Sí | No |
| 5 | `20260922050000_recurring_service_cost_pool_allocation.sql` | Función de reparto del pool | Sí | No |
| 6 | `20260922060000_recurring_service_occurrences_nubox_matching.sql` | Función que vincula ciclos con facturas de Nubox (escribe datos al **llamarse**, no al migrar) | Sí | No |
| 7 | `20260922070000_recurring_service_occurrences_generation_revoke_api_roles.sql` | Quita EXECUTE del cron a anon/authenticated | Sí | No |
| 8 | `20260922080000_revoke_anon_execute_member_rpcs.sql` | Quita EXECUTE de 3 RPC a anon | Sí | No |
| 9 | `20260922090000_recurring_service_occurrences_arrears_period.sql` | Función del cron (período vencido) | Sí | No |
| 10 | `20261002010000_recurring_services_country_and_monthly_cycles.sql` | `country`, `requires_invoice`, `notes`, `note`; triggers de país y moneda; generación mes a mes | Parcial | Sí: `country` de los servicios; **genera los ciclos de sep y oct 2026** de todos los servicios activos |
| 11 | `20261003010000_recurring_service_occurrences_floor_on_due_month.sql` | Generación por mes de vencimiento | Parcial | Sí: **vuelve a generar sep 2026** (solo inserta los que faltan) |
| 12 | `20261004010000_cost_pool_allocation_largest_remainder.sql` | Reparto MS por mayor resto (verificación anterior, C05/C06) | Sí | No (los pools ya repartidos no cambian) |
| 13 | `20261004020000_nubox_adopt_ventas_sin_factura.sql` | Punto 1: nueva versión de `import_nubox_documents_batch` | Sí | No |
| 14 | `20261004030000_document_exchange_rates.sql` | Punto 3: funciones de tasa, columnas y triggers de `exchange_rate`; permisos de `exchange_rate_snapshots` | Sí (esquema) | Sí: `exchange_rate`/`exchange_rate_period` de todas las ventas, costos, ciclos y pools sin tasa (solo columnas nuevas) |
| 15 | `20261004040000_projects_quoted_amount_cost_budget.sql` | Punto 4: `quoted_amount`, `cost_budget`; nueva firma de `create_project_with_quote` | Sí (esquema); `budget` queda intacta | Sí: `quoted_amount = budget` |
| 16 | `20261004050000_cost_documents_covered_by_ms_pool.sql` | Punto 5: funciones `is_ms_licenses_area`, `ms_licenses_area_ids`, columna calculada `covered_by_cost_pool_id` | Sí (sin datos; la app nueva la necesita) | No |

**Para prod:**

- La 14 llena las tasas desde los snapshots de prod. Hasta esta migración, cualquier usuario podía escribir esa tabla (H07), así que conviene revisar los snapshots de prod **antes** de aplicarla.
- La 10 y la 11 insertan ciclos pendientes en las empresas reales.
- La app necesita `SUPABASE_SERVICE_ROLE_KEY` en el entorno de producción de Vercel para guardar el snapshot del mes. Ya la usan el cron y MCP.

### Checklist de verificación manual después del deploy

1. `supabase migration list` contra prod: las 16 aplicadas, en orden.
2. Consulta de solo lectura en prod: ninguna venta, costo, ciclo ni pool en moneda distinta a la de su empresa con `exchange_rate` vacío (o, si hay, que sea por falta de snapshot y el reporte lo marque "conversión pendiente").
3. Resultado Mensual y dashboard de un mes cerrado, en CL y en UY: cifras iguales antes y después del deploy, salvo los documentos "cubierto por pool".
4. Costos → listado del mes con pool de licencias: revisar cada badge "Cubierto por pool" y confirmar que es la factura de Microsoft. Si no lo es, corregir su proveedor o su imputación.
5. Alta de costo con el proveedor del pool y la fecha de ese mes: aparece el aviso con el link al reparto; al cambiar de mes o de trabajo, desaparece.
6. Reparto licencias MS → Nuevo: el campo dice "Monto neto (sin IVA)" y el total con IVA cambia al escribir.
7. Ficha de un trabajo: muestra "Cotización (venta)" y "Presupuesto de costo"; el dashboard dice "Sin presupuesto" hasta que se cargue un presupuesto de costo.
8. Importación Nubox de prueba (vista previa, sin confirmar): una venta sin factura del mismo cliente con fecha cercana aparece en "se vinculan a su documento"; dos parecidas aparecen "a revisar".
9. Con un usuario común: intentar escribir `exchange_rate_snapshots` desde la API devuelve error.

### Cómo volver a correrlo

```bash
cd web
npm test
npm run test:integration -- accounting.golden costPoolAllocation
```

Las demás suites de integración (`recurringServiceOccurrences`, `recurringServicesMonthly`, `reportingRecurringServices`) corren el cron real sobre **todos** los servicios activos de DEV. Antes de correrlas, cortá temporalmente los servicios TEST_ como en la decisión 8.
