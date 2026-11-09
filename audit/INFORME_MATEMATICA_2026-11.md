# Auditoría matemática INMA-ERP — 2026-11

- **Fecha:** 2026-11-08 · **Rama:** `audit-math/2026-11` (desde `dev` @ `4878556`) · **Autor:** Claude (autónomo)
- **Bases:** prod `jxkfpkgyvjiyufmfxsfp` solo lectura (`supabase db query --remote=<ref> --read-only`, transacción READ ONLY, y un wrapper que rechaza todo lo que no sea SELECT/WITH); dev `sczgankronafrxybpvnh` (migración nueva y tests de integración).
- **Consultas:** `audit/consultas_matematica_2026-11.sql` (bloques `@check` = filas con problema; `@recalc` = totales para conciliar).
- **Verificación de la rama:**
  - `tsc` OK · `eslint` 0 errores / 0 warnings · `vitest` 785/785 (antes 755, con 1 fallando) · `next build` OK.
  - Integración contra dev: 184 tests OK, 9 saltados (qaFase2b, saltados por diseño) y 1 fallo conocido: `accounting.golden` §4, desactualizado desde `2eba8be`. Corregí ese test y el archivo da 25/25.

---

## 1. Resumen ejecutivo

1. Los documentos de prod están sanos en lo aritmético: 0 casos de neto + IVA ≠ total, 0 líneas que no suman su documento, 0 decimales en CLP, 0 signos invertidos, 0 monedas incoherentes con su empresa, 0 asignaciones que exceden su documento, 0 pagos de técnicos sin aplicar, 0 sobrepagos.
2. Recalculé 2026 (ene–nov) de forma independiente desde las líneas: ventas, costos y resultado de Chile y Uruguay **cuadran al peso** con lo que muestra el sistema (22 meses, diferencia máxima 0,01 UYU). Validé antes que mi réplica SQL da lo mismo que el código real (`getMonthlySeries`, `getProfitabilityBreakdown`) sobre los datos de dev.
3. El problema más grande es el **reparto de licencias MS**:
   - **M-01:** el reparto de nov-2026 (Intcomex, 1.036.626) quedó solo en Razo y TREI; SIMTA y TOTAL GP, con costo 0. Arreglado en la rama, con "Volver a repartir".
   - **M-02:** el costo del pool solo se reconoce cuando se factura el ciclo. Hoy faltan 1.036.626 en los costos de nov-2026 de Chile.
   - **M-03:** de ene a oct no hay pool. Las facturas de Intcomex (16.343.896) entran como gasto general y los servicios MS figuran con margen 100 %.
4. Además encontré y arreglé 6 errores de fórmula:
   - margen % con base ≤ 0;
   - áreas que no suman el mes (24 % de las ventas de Chile sin área);
   - sugerencias de Starlink que exigían el monto exacto (genera doble conteo);
   - reparto de facturas con una parte negativa;
   - decimales en CLP y sumas en punto flotante en los importadores.
5. Hay 9 correcciones de datos para hacer desde la pantalla (§4), entre ellas un ingreso contado dos veces (idarwin, 16.700) y dos costos de Starlink contados dos veces.

**Top 5 prioridades**

| # | Qué | Dónde |
|---|---|---|
| 1 | Desplegar M-01 y apretar "Volver a repartir" en el pool de nov-2026 de Chile | migración `20261108010000`, commit `6882cfe`; §4 C1 |
| 2 | Decidir la regla de reconocimiento del costo MS (M-02): mes del pool para todo ciclo no anulado | §2 M-02 (solo reportado) |
| 3 | Cargar los pools MS de ene–oct 2026 de Chile (M-03) y definir si Uruguay usa pool (TGM) | §4 C2 |
| 4 | Corregir los dobles conteos: idarwin 2725, WIND-2025 may y Entrelomas jun | §4 C3–C5 |
| 5 | Desplegar M-05/M-06/M-07/M-08/M-09 (fórmulas y redondeos) | commits `e81af84`, `54813c8`, `af4188a`, `9271e80` |

---

## 2. Tabla de hallazgos

Severidad: alta / media / baja. Estado: **arreglado** (en esta rama) / **pendiente** (solo reportado: regla de negocio o cambio de montos de prod).

| ID | Módulo | Sev. | Fórmula / archivo:línea | Ejemplo numérico (esperado vs. obtenido) | Estado | Commit |
|---|---|---|---|---|---|---|
| M-01 | Licencias MS | **alta** | `allocate_recurring_service_cost_pool` (migración `20261016010000`): reparte entre los ciclos que existen al repartir. Las partes son de solo inserción y no hay forma de rehacerlas. | Chile, pool 2026-11, Intcomex, neto 1.036.626. Se repartió el 04-11 21:08; SIMTA se creó a las 21:35 y TOTAL GP el 08-11. Razo: obtenido 580.963, esperado 347.935. TREI: obtenido 455.663, esperado 272.895. SIMTA: obtenido 0, esperado 356.388. TOTAL GP: obtenido 0, esperado 59.408. | arreglado: antes de repartir se crea el ciclo del mes de cada servicio mensual activo (anticipado = ese mes; vencido = el mes siguiente). `reallocate_recurring_service_cost_pool` rehace el reparto (definer, solo miembros). La pantalla avisa y ofrece "Volver a repartir". | `6882cfe` |
| M-02 | Licencias MS / reportes | **alta** | `reporting.ts:465` (`toRecurringLedgerRows`): la parte del pool se cuenta solo en ciclos `invoiced`/`collected` y en el mes de su factura. En cambio, la factura del proveedor se excluye de inmediato (`covered_by_cost_pool_id`). | Nov-2026, Chile: la factura 3800929 (1.036.626) no suma, y las partes de Razo y TREI tampoco (sus ciclos están en `pending_invoice`). Costos esperados: 6.539.937; obtenidos: 5.503.311. Si un ciclo nunca se factura (anulado o impago), su parte del costo se pierde para siempre. | pendiente (regla de negocio, ver §5 D4) | — |
| M-03 | Licencias MS | **alta** | Proceso: hay un solo pool en prod (Chile, 2026-11). | Chile, ene–oct 2026: 24 facturas de Intcomex, 16.343.896 neto, cuentan como gasto general (jul–sep, algunas como directo). Los servicios MS (Razo, SIMTA, TOTAL GP, TREI, idarwin) quedan con costo 0 y margen 100 % en rentabilidad por área y por cliente. El total de la empresa no cambia. Uruguay no tiene pool: no hay datos de TGM S.A. y Trimant/grupoAM usan costo fijo. | pendiente (datos: §4 C2) | — |
| M-04 | Recurrentes | media | `recurring_service_period_summary` / `cycleMoney` (`recurringServicePending.ts:241`): con todas sus facturas pagadas, el período queda "pagado" aunque lo facturado sea menor que lo esperado. | 49 períodos 2025-12…2026-11 con facturado < esperado (38 de ellos en "paid"). Ejemplos: Licencias Razo 2026-01 (esperado 600.000, facturado 289.402, "pagado"); Microsoft SIMTA 2025-12 (614.576 contra 374.750). Los montos de referencia parecen desactualizados (MS varía cada mes). | pendiente (regla de negocio) | — |
| M-05 | Costos fijos / Starlink | media | `costAllocationSuggestions.ts`: la sugerencia automática exigía el monto exacto. | WIND - 2025, 2026-05: esperado 39.496; facturas Starlink de 39.495. Sin asignar, el período suma el esperado (39.496) y la factura suma como gasto general (39.495): costo doble. | arreglado: una diferencia de 1 unidad se **sugiere** (motivo `rounding`), nunca se confirma sola | `6882cfe` |
| M-06 | Rentabilidad por área | media | `reporting.ts` `getProfitabilityBreakdown`: una venta sin área ni trabajo no estaba en ninguna área, y las áreas cargan costos generales. | Prod, Chile 2026: 77 ventas sin área (22.013.356, el 24 %) no aparecían en "Margen por área". Además, 6.444.759 de gastos generales repartidos a trabajos (4 documentos) están en las áreas pero no en el margen directo. En dev, octubre: costos de las áreas 3.220.250 contra 1.075.836 de costos directos. | arreglado: `areaUnassigned` y `generalCostsInAreas`; fila "Sin área asignada" en el resultado mensual y nota en rentabilidad. Identidad exacta verificada con el código real en dev. | `54813c8` |
| M-07 | Panel / reportes | baja | `page.tsx:222`, `monthly-result/page.tsx:143`, `MonthlyChart.tsx:21`, `projects/[projectId]/page.tsx:165`, `salesView.ts:190`: margen / ventas sin mirar el signo de la base. | Ventas −100 y costos 50 dan margen −150; −150 / −100 se mostraba como "+150 %". Ventas 0 con costos se mostraba "0 %" (por ejemplo, CCTV Los Copihues: ingresos 0, costos 2.120.248). | arreglado: `lib/margins.ts` da null ("—") cuando la base no es positiva | `af4188a` (+ `54813c8` en el resultado mensual) |
| M-08 | Asignaciones de venta | baja | `allocationSuggestions.ts:133` `splitProportionally`: redondea cada parte y la última toma el resto. | Neto 2 CLP entre 4 períodos iguales: esperado 0/0/1/1, obtenido 1/1/1/−1. La parte negativa se descartaba y las otras sumaban 3 > 2. Con neto 10: esperado 2/2/3/3, obtenido 3/3/3/1. | arreglado (resto mayor, suma exacta). Prod: 0 asignaciones afectadas (V10 = 0). | `9271e80` |
| M-09 | Importadores | baja | `genericImport.ts` `resolveSaleAmounts`, `purchaseImport.ts` `resolvePurchaseRow`. | "1234,5" en CLP se guardaba como 1234.5. En compras, neto 0,1 + exento 0,2 se guardaba como 0.30000000000000004. | arreglado: rechazo con motivo (CLP sin decimales; USD/UYU ≤ 2) y redondeo a la moneda. Prod: 0 montos con decimales de más (V03/C03 = 0). | `e81af84` |
| M-10 | Repartos de costo | baja | `reporting.ts:1076` `allocationShare`: neto × % / 100 sin redondear. | CCTV 16ch Arlegui: costo 971.922,57 CLP. Instalación casa Jose: 3.181.047,43 CLP. La suma por documento es exacta y solo el detalle por trabajo tiene centavos de peso. | pendiente (cambiaría el costo por trabajo en menos de 1 peso) | — |
| M-11 | Recurrentes / ventas | media | Dato: ciclo marcado "facturado" a mano sin factura, más su factura real sin asignar. | Microsoft idarwin, período 2026-09: ingreso de 16.700 en oct (por `invoiced_at` 05-10). La factura 2725 (02-11, neto 16.700) no está asignada y suma de nuevo en nov. Ventas contadas dos veces: +16.700. | pendiente (dato: §4 C3) | — |
| M-12 | Técnicos | baja | `apply_technician_document`: tolera 1 peso por cargo. | BOL-HE 158 (22-07-2026): bruto 589.970, vinculado a cargos por 589.971. El resto como gasto general queda en −1. | pendiente (dentro de la tolerancia de diseño) | — |
| M-13 | Boletas | baja | Dato importado de Nubox. | BOL-HE 131836 (04-11-2025, bruto 20.000) y 97588 (13-03-2025, bruto 29.000): retención 0 y líquido = bruto. Con la tasa de 2025 (14,5 %), la retención sería 2.900 y 4.205, y el líquido 17.100 y 24.795. El costo (bruto) no cambia. | pendiente (verificar en Nubox: puede ser retención del emisor) | — |
| M-14 | Compras | baja | Dato importado. | 4 FAC-EL con IVA distinto del 19 % del neto: 841 (10-04-2023, neto 59.805, IVA 10.155 = 17 %), 17219424 (2022, diferencia 1,76), 7027 y 639603 (2024, diferencia 2–3). | pendiente (anteriores a 2025, sin impacto en 2026) | — |
| M-15 | Tipo de cambio | baja | `exchange_rate_snapshots`. | No hay snapshot de CLP de 2025-12 (la primera es 2026-01). Todo resultado de Chile anterior a 2026 sale con el USD incompleto. 2026 está completo en los 11 meses. | pendiente (no hay pantalla: §4 C9) | — |
| M-16 | Trabajos | baja | `project_quote_billing_summary` (`20261106032837`): `sum(a.amount * fx.rate)` descarta en silencio una factura sin tasa y no redondea. | Prod: 0 facturas de otra moneda asignadas a cotizaciones (P01), así que hoy no hay impacto. | pendiente | — |
| M-17 | Técnicos Uruguay | baja | `charge-form.tsx:290`: un cargo de Uruguay (sin respaldo) puede marcar "El monto incluye IVA (22 %)". Entonces el costo queda en monto / 1,22, no en lo pagado. | Prod: el único cargo de Uruguay (Mauro Da Silva, 2.990 UYU) tiene `vat_included = false` y costo = pagado. | pendiente (regla de negocio: el pedido dice que en Uruguay el sin respaldo es exactamente lo pagado, pero el código no lo impone) | — |
| M-18 | Técnicos | media | Seguimiento. | 3 cargos con factura, pendientes, sin documento ni pago: Luis con F, 955.000 (23-06, 138 días) y 75.000 (25-09); Luis Fuentes, 279.000 (05-11). | pendiente (ya conocido: lo resolvés desde la pantalla) | — |

**Verificado y correcto** (sin hallazgo):
- **Neto/IVA/total:**
  - Neto + IVA + otros = total en las 228 ventas y en los 1.669 costos.
  - Las líneas suman el documento.
  - El IVA de ventas es el 19 % (Chile) o el 22 %/10 % (Uruguay) del neto, ±1.
  - El ingreso por total con IVA reparte con `round(total / (1 + tasa))`, y el IVA es el resto: neto + IVA = total exacto (propiedad probada en 3.000 casos).
  - Por documento, redondeo a la moneda (CLP entero, USD/UYU 2 decimales).
- **Notas de crédito:**
  - En ventas se guardan positivas y restan al leer (`signedSalesAmount`), en todos los totales, en el reparto por trabajo y área y en el USD.
  - En costos se guardan negativas.
  - La única N/C de venta no anulada (352, 45.990) resta.
  - Las 8 N/C que anulan facturas están anuladas junto con su factura, por el mismo monto.
- **Boleta de honorarios:** la tasa 2026 es 15,25 %, verificada con fuentes públicas (Ley 21.133: 14,5 % en 2025, 15,25 % en 2026, 16 % en 2027, 17 % en 2028), y coincide con `boleta_withholding_rates`. El costo para INMA es el bruto y lo pagado al técnico es el líquido. Líquido → bruto → líquido es exacto en 5.000 casos.
- **Técnicos:**
  - Factura: neto ↔ total con IVA 19 %, ida y vuelta exacta.
  - Sin respaldo: costo = pagado (16 cargos de Chile y 1 de Uruguay).
  - Cada cargo tiene su documento de costo, con el mismo neto, el mismo total, el mismo trabajo y el mismo mes.
  - Pago = Σ aplicaciones. Ningún cargo sobrepagado. "Recibida" = cubierta.
- **Tipo de cambio:**
  - Snapshots en ARS: USD por unidad = ars_per_unit / ars_per_usd.
  - Se usa el mes del documento o el anterior más cercano.
  - Ida y vuelta exacta (2.000 casos).
  - Ningún documento con la tasa guardada de un mes anterior teniendo hoy la de su mes (V08 = 0).
  - Toda tasa de documento en su propia moneda = 1.
- **Recurrentes:**
  - Los anuales tienen un ciclo por aniversario (R04 = 0) y la venta se cuenta entera en su mes.
  - Los costos mensuales se cuentan por período de costo.
  - Ninguna asignación supera su factura ni cae en un documento anulado.
- **Reparto MS:** suma exacta al total (1.036.626). Un cliente con venta 0 no recibe nada, salvo que todos estén en 0.

---

## 3. Conciliación de prod (2026, ene–nov)

### 3.1 Método

- **Sistema:**
  - `RC1` es una réplica en SQL de `computeMonthlyResult`/`getMonthlySeries`, regla por regla.
  - Antes de usarla en prod la validé contra el código real: un harness temporal (no commiteado) ejecutó `getMonthlySeries` y `getProfitabilityBreakdown` sobre los datos de dev, y `RC1`/`RC4` dieron lo mismo en los 22 meses (diferencia máxima 0,005) y en los 17 trabajos.
- **Independiente:**
  - `RC2`: ventas = Σ líneas de los documentos no anulados (N/C −); costos = Σ líneas (o neto) de **todos** los documentos de costo, más personal.
  - `RC3`: las partidas que separan ambos cálculos.
- **Identidades (se cumplen en los 22 meses):**
  - `ventas sistema = ventas líneas + ciclos facturados sin factura`
  - `costos sistema = costos documentos + personal − cubierto por pool + pool reconocido + costo esperado sin factura − vinculado a cargos de técnico`

### 3.2 Resultado mensual (moneda local; resultado también en USD)

| Empresa | Mes | Ventas sistema | Ventas líneas | Ciclos sin factura | Dif. | Costos sistema | Docs + personal | Cubierto pool | Pool sin reconocer | Esperado sin factura | Vinculado a cargos | Dif. | Resultado | Resultado USD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Chile | 2026-01 | 6.174.120 | 6.174.120 | 0 | 0 | 1.609.508 | 1.527.676 | 0 | 0 | 81.832 | 0 | 0 | 4.564.612 | 5.317,27 |
| Chile | 2026-02 | 5.893.471 | 5.893.471 | 0 | 0 | 1.264.351 | 1.182.519 | 0 | 0 | 81.832 | 0 | 0 | 4.629.120 | 5.375,26 |
| Chile | 2026-03 | 4.002.198 | 4.002.198 | 0 | 0 | 2.946.900 | 2.865.068 | 0 | 0 | 81.832 | 0 | 0 | 1.055.298 | 1.132,82 |
| Chile | 2026-04 | 3.287.971 | 3.287.971 | 0 | 0 | 2.227.418 | 2.145.586 | 0 | 0 | 81.832 | 0 | 0 | 1.060.553 | 1.176,09 |
| Chile | 2026-05 | 7.482.788 | 7.482.788 | 0 | 0 | 4.899.171 | 4.777.843 | 0 | 0 | 121.328 | 0 | 0 | 2.583.617 | 2.893,54 |
| Chile | 2026-06 | 6.804.543 | 6.804.543 | 0 | 0 | 7.156.937 | 7.044.013 | 0 | 0 | 112.924 | 0 | 0 | −352.394 | −382,07 |
| Chile | 2026-07 | 4.856.026 | 4.856.026 | 0 | 0 | 6.273.508 | 8.805.451 | 0 | 0 | 122.924 | 2.654.867 | 0 | −1.417.482 | −1.532,78 |
| Chile | 2026-08 | 16.261.186 | 16.261.186 | 0 | 0 | 3.548.258 | 7.625.018 | 0 | 0 | 124.924 | 4.201.684 | 0 | 12.712.928 | 13.681,88 |
| Chile | 2026-09 | 14.520.489 | 14.520.489 | 0 | 0 | 10.413.158 | 10.248.234 | 0 | 0 | 164.924 | 0 | 0 | 4.107.331 | 4.345,12 |
| Chile | 2026-10 | 19.242.726 | 19.226.026 | 16.700 | 0 | 12.335.092 | 12.170.168 | 0 | 0 | 164.924 | 0 | 0 | 6.907.634 | 7.092,20 |
| Chile | 2026-11* | 2.821.944 | 2.811.954 | 9.990 | 0 | 5.503.311 | 6.281.737 | 1.036.626 | 1.036.626 | 258.200 | 0 | 0 | −2.681.367 | −2.698,47 |
| Uruguay | 2026-01 | 11.109 | 9.109 | 2.000 | 0 | 11.785 | 10.245 | 0 | 0 | 1.540 | 0 | 0 | −676 | −17,55 |
| Uruguay | 2026-02 | 17.314 | 15.314 | 2.000 | 0 | 10.040 | 8.504 | 0 | 0 | 1.536 | 0 | 0 | 7.274 | 189,41 |
| Uruguay | 2026-03 | 13.298 | 11.298 | 2.000 | 0 | 9.631 | 8.012 | 0 | 0 | 1.619 | 0 | 0 | 3.667 | 90,59 |
| Uruguay | 2026-04 | 13.235 | 11.235 | 2.000 | 0 | 8.534 | 6.924 | 0 | 0 | 1.610 | 0 | 0 | 4.701 | 116,78 |
| Uruguay | 2026-05 | 13.271 | 11.271 | 2.000 | 0 | 2.264 | 663 | 0 | 0 | 1.601 | 0 | 0 | 11.007 | 275,01 |
| Uruguay | 2026-06 | 22.545 | 20.545 | 2.000 | 0 | 5.769 | 4.171 | 0 | 0 | 1.598 | 0 | 0 | 16.776 | 419,90 |
| Uruguay | 2026-07 | 18.944 | 16.944 | 2.000 | 0 | 9.993 | 8.383 | 0 | 0 | 1.610 | 0 | 0 | 8.951 | 222,33 |
| Uruguay | 2026-08 | 15.027 | 13.027 | 2.000 | 0 | 2.273 | 666 | 0 | 0 | 1.608 | 0 | 0 | 12.753 | 317,30 |
| Uruguay | 2026-09 | 11.769 | 11.769 | 0 | 0 | 5.689 | 4.088 | 0 | 0 | 1.601 | 0 | 0 | 6.080 | 151,94 |
| Uruguay | 2026-10 | 68.846 | 68.846 | 0 | 0 | 62.288 | 60.688 | 0 | 0 | 1.600 | 0 | 0,01 | 6.558 | 163,94 |
| Uruguay | 2026-11* | 21.214 | 21.214 | 0 | 0 | 11.488 | 9.888 | 0 | 0 | 1.600 | 0 | 0 | 9.726 | 241,67 |

\* Noviembre en curso (corte 2026-11-08).

**Totales ene–nov 2026:**

| Empresa | Ventas netas | Costos | Resultado operativo | En USD |
|---|---:|---:|---:|---:|
| Chile | 91.347.462 CLP | 58.177.612 CLP | 33.169.850 CLP | 36.400,86 |
| Uruguay | 226.571,01 UYU | 139.754,01 UYU | 86.817,03 UYU | 2.171,32 |
| **Consolidado** | | | | **38.572,18 USD** (USD completo los 11 meses en ambas empresas) |

**Lectura:**
- No hay ninguna diferencia mayor a 1 unidad entre el sistema y la recomputación independiente: cada peso de diferencia se explica por una partida conocida.
- Las partidas en sí esconden 3 problemas:
  - **Pool sin reconocer** (M-02): 1.036.626 de nov-2026 no suman en ningún lado hoy.
  - **Ciclos sin factura** (M-11): los 16.700 de oct son de idarwin, que tiene su factura 2725 aparte → doble conteo.
  - **Esperado sin factura** (M-05): 39.496 de may (WIND-2025) y 31.092 de jun (Entrelomas) tienen además sus facturas Starlink como gasto general → doble conteo.
- Los 2.000 UYU/mes de Uruguay (ene–ago) son ciclos de "Mantenimiento Happydog" cobrados a mano. No hay factura suelta que los duplique (R08).

### 3.3 Por área (2026)

- **Chile:**
  - 77 ventas (22.013.356) no tienen área, trabajo ni asignación: antes de M-06 no estaban en ninguna área.
  - 6.444.759 de gastos generales están repartidos a trabajos con área: el resultado mensual los cuenta como generales y la rentabilidad, como costo del área.
  - Con el arreglo, Σ áreas + "Sin área" = ventas netas, y Σ costos de áreas + "Sin área" = costos directos + generales en áreas. Es una identidad exacta, verificada con el código real.
- **Uruguay:** todas las ventas tienen área.

### 3.4 Por trabajo (2026, `RC4`; réplica validada en dev contra el código real)

| Empresa | Trabajo | Ingresos | Costos | Margen |
|---|---|---:|---:|---:|
| Chile | Redes en colegios del interior | 31.739.400 | 22.780.921 | 8.958.479 |
| Chile | Instalacion casa Jose, red seguridad y acceso | 4.899.940 | 3.181.047,43 | 1.718.893 |
| Chile | STARLINK La Ligua | 2.246.600 | 1.651.428 | 595.172 |
| Chile | Camaras y acceso bodega 12 | 1.174.520 | 885.409 | 289.111 |
| Chile | CCTV 16ch Arlegui | 1.200.000 | 971.922,57 | 228.077 |
| Chile | GPS | 349.800 | 100.000 | 249.800 |
| Chile | Control de acceso HIK | 547.200 | 365.113 | 182.087 |
| Chile | Puntos de red Oficina | 499.200 | 386.471 | 112.729 |
| Chile | Reparacion avicola Copihues | 99.900 | 0 | 99.900 |
| Chile | Tintas Wind | 100.065 | 37.815 | 62.250 |
| Chile | Modificaciones Web | 45.080 | 0 | 45.080 |
| Chile | Soporte Remoto | 34.900 | 0 | 34.900 |
| Chile | Revision camaras | 79.800 | 55.000 | 24.800 |
| Chile | CCTV Los Copihues | 0 | 2.120.248 | −2.120.248 |
| Chile | Mover DVRs a Rack Heladeria | 0 | 234.454 | −234.454 |
| Chile | Cambio de Rack | 0 | 190.000 | −190.000 |
| Chile | Nuevo disco Sonia H | 0 | 90.000 | −90.000 |
| Chile | Soporte TREI Oct | 0 | 80.000 | −80.000 |
| Chile | PTZ Andres | 0 | 70.000 | −70.000 |
| Uruguay (UYU) | Venta Play 5 | 37.602,44 | 34.298,23 | 3.304 |
| Uruguay (UYU) | CCTV Madre | 12.534 | 2.990 | 9.544 |
| Uruguay (UYU) | Mantenimiento web y servidor | 3.377,70 | 0 | 3.378 |
| Uruguay (UYU) | PC Nuevo | 0 | 14.988,97 | −14.989 |
| Uruguay (UYU) | WEB Distrilove | 7.545 | 0 | 7.545 |
| Uruguay (UYU) | Soporte Remoto | 5.600 | 0 | 5.600 |
| Uruguay (UYU) | Soporte (3 trabajos) | 13.400 | 3.000 | 10.400 |

Los centavos de peso en "Instalacion casa Jose" y "CCTV 16ch Arlegui" vienen de repartos por porcentaje (M-10).

### 3.5 Técnicos: cuenta corriente (`T07`)

| Empresa | Técnico | Cargos | Debe (a pagar) | Pagado | Saldo |
|---|---|---:|---:|---:|---:|
| Chile | Luis Fuentes | 19 | 14.564.004 | 12.910.004 | 1.654.000 |
| Chile | Luis con F | 2 | 1.030.000 | 0 | 1.030.000 |
| Chile | Javier Herrera | 1 | 75.000 | 0 | 75.000 |
| Chile | Ricardo Ruiz | 1 | 40.000 | 0 | 40.000 |
| Chile | CARLOS JAVIER GUTIERREZ RIVERO | 2 | 500.000 | 500.000 | 0 |
| Chile | EXEQUIAS IVAN CATRIN CURIN | 2 | 750.000 | 750.000 | 0 |
| Uruguay | Mauro Da SIlva | 1 | 2.990 | 2.990 | 0 |

- Pagos = Σ aplicaciones en todos los técnicos.
- `summarizeByTechnician` usa la misma fórmula: debe = Σ a pagar, pagado = Σ aplicaciones.

### 3.6 Recurrentes y licencias MS

- **Pool 2026-11 (Chile):** total 1.036.626 = Σ partes 1.036.626, pero solo en 2 de 4 ciclos (M-01). El reparto correcto con los ciclos de hoy (pesos, ±1 por desempate) es Razo 347.935, SIMTA 356.388, TOTAL GP 59.408 y TREI 272.895.
- **Período sin estado** (`R03`): 2 ciclos facturados o cobrados sin factura en servicios que la exigen. Son idarwin 2026-09 (M-11) y "Servidor VCB - 2025" 2026-07 (9.990, cobrado a mano el 07-11).
- **Meses sin ciclo** (`R01`): en nov-2026 faltan los de los servicios "mes vencido" (idarwin, VCB, Happydog, grupoAM, Trimant). Es correcto: se generan en diciembre.
- **Meses sin tipo de cambio** (`X01`): solo CLP 2025-12 (M-15).

---

## 4. Correcciones de datos para hacer desde la pantalla

No generé SQL para prod. "Después del deploy" significa que la pantalla o el botón llegan con esta rama.

| # | Empresa | Pantalla | Registro | Valor actual | Valor correcto |
|---|---|---|---|---|---|
| C1 | Chile | Costos → Reparto licencias MS → nov 2026 (después del deploy) | Pool 2026-11, Intcomex S.A., FAC-EL 3800929, neto 1.036.626 | Razo 580.963 · TREI 455.663 · SIMTA 0 · TOTAL GP 0 | Apretar **"Volver a repartir"** → Razo 347.935 · SIMTA 356.388 · TOTAL GP 59.408 · TREI 272.895. Si antes se facturan esos ciclos, el reparto usa lo facturado. |
| C2 | Chile | Costos → Reparto licencias MS → Nuevo, uno por mes | Facturas Intcomex S.A. de ene–oct 2026 | Sin pool. Netos por mes: ene 1.065.257 · feb 882.819 · mar 462.712 · abr 911.467 · may 1.866.805 · jun 2.158.007 · jul 1.624.173 · ago 1.816.024 · sep 1.992.900 · oct 3.563.732 | Un pool por mes con ese neto y proveedor Intcomex, después "Repartir". Hacerlo después de decidir M-02: con la regla actual, el costo se reconoce en el mes de la factura de cada ciclo. Uruguay: decidir si TGM S.A. va por pool (hoy Trimant/grupoAM usan costo fijo). |
| C3 | Chile | Ventas → factura **2725** (02-11-2026, neto 16.700) → Asignaciones | Período 2026-09 de "Microsoft idarwin" (hoy "facturado" sin factura) | Factura sin asignar; el ciclo suma 16.700 como venta de oct y la factura vuelve a sumar en nov | Asignar la 2725 al período 2026-09 de idarwin. Ventas de oct: 19.242.726 → 19.226.026. |
| C4 | Chile | Costos → factura Starlink **2651443** (o la 2714609, ambas 39.495, may-2026) → Asignar a servicios; o "Buscar sugerencias" en Conciliar después del deploy | Período de costo 2026-05 de "WIND - 2025" (esperado 39.496) | Período con costo esperado 39.496 + factura como gasto general 39.495 | Asignar una de las dos facturas al período. Costos de may: −39.496. |
| C5 | Chile | Costos → facturas Starlink jun-2026: **2826664** o **2853204** (42.017 c/u) → Asignar a servicios | Período de costo 2026-06 de "Entrelomas V- anual" (esperado 31.092) | Esperado 31.092 + 3 facturas Starlink sin asignar (302.773, 42.017, 42.017) | Asignar la de Entrelomas (por el patrón de jul, 42.017). Costos de jun: −31.092. |
| C6 | Chile | Costos → BOL-HE **131836** (04-11-2025) y **97588** (13-03-2025) | Retención y líquido | Retención 0, líquido = bruto (20.000 y 29.000) | Verificar en Nubox. Si INMA retuvo: retención 2.900 / 4.205 y líquido 17.100 / 24.795. El costo no cambia. |
| C7 | Chile | Trabajos → "CCTV 16ch Arlegui" → cotización 1755 | Cotizado vs. facturado | Cotizado 1.168.710, facturado 1.200.000 (102,7 %) | Revisar si el cotizado debía ser 1.200.000. |
| C8 | Uruguay | Trabajos → "Soporte Remoto" → cotización 274 | Monto cotizado | Vacío (facturado 5.600 UYU, % facturado "—") | Cargar el cotizado. |
| C9 | Chile | — (no hay pantalla) | Tipo de cambio CLP 2025-12 | Falta | Si querés el USD de 2025: cargar la snapshot de CLP de 2025-12 con la misma fuente que F4 (MonedAPI / BCCh). Va por SQL, a tu criterio. |

**Seguimiento, no corrección:**
- Los 3 cargos de factura sin documento ni pago de Luis con F y Luis Fuentes (M-18).
- Los 49 períodos (38 "pagados") con facturado menor que el esperado (M-04), casi todos de servicios MS: conviene actualizar el monto de referencia de esos servicios.

---

## 5. Decisiones que tomé sin consultarte

- **D1 — Rama desde `origin/dev` (4878556), no desde el `dev` local.** El `dev` local estaba atrasado (`22768f7`).
- **D2 — Prod se leyó solo con `--read-only` y un wrapper.** El wrapper rechaza todo lo que no empiece con SELECT/WITH o tenga palabras de escritura. El rol de solo lectura no tiene EXECUTE sobre `covered_by_cost_pool_id`, `recurring_service_period_billed_amount` ni `exchange_rate_on`: reescribí esas reglas en línea en las consultas (C10, R05, P01, RC1).
- **D3 — Validación con el código real en dev, no en prod.** Para validar la réplica SQL, un harness temporal ejecutó las funciones de `reporting.ts` contra **dev** con el cliente de servicio, solo lectura de reportes. No lo commiteé. En prod no se ejecutó código de la app.
- **D4 — M-02 (cuándo se reconoce el costo del pool) no se tocó.** El comentario de `reporting.ts` lo define así a propósito ("en el ciclo, 0 hasta que se reparte") y cambiarlo mueve costos entre meses ya informados.
  - **Propuesta:** reconocer cada parte en el mes del pool para todo ciclo no anulado.
  - **Qué cambiaría en prod si se aplica:** Chile nov-2026, costos +1.036.626 y resultado −2.681.367 → −3.717.993. Los meses anteriores no cambian (no tienen pool).
- **D5 — M-04 tampoco se tocó.** Que un período facturado de menos siga "pagado" es una regla de negocio (puede ser un cambio de precio).
- **D6 — Diferencia de redondeo en la sugerencia de Starlink (M-05): sugerencia, no confirmación.** Más conservador: alguien la confirma.
- **D7 — Importadores (M-09): rechazar, no redondear.** Un monto con decimales de más se rechaza con su motivo, no se redondea en silencio. Prod tiene 0 casos.
- **D8 — "Sin área" (M-06) es una fila calculada.** No es un área nueva: no se creó ningún dato.
- **D9 — Migración `20261108010000` aplicada en dev (dev = 92 migraciones).** Lo hice antes de mergear, porque el test de integración la necesita. La rama se mergea a dev en esta misma sesión, así que el historial queda alineado. Prod sigue en 91.
- **D10 — "Volver a repartir" es una función nueva.** Sin ella la corrección C1 no se puede hacer desde la pantalla. No cambia nada por sí sola.
- **D11 — Funcionalidades que mencionaste y no están en el repo.** En el historial de git no hay commits de "técnicos sin respaldo también en Uruguay" ni de "automatización del costo MS con Intcomex/TGM". Audité lo que existe:
  - En Uruguay, el cargo no tiene respaldo (`backing = null`) y el formulario permite IVA incluido (M-17).
  - El pool MS es manual (proveedor Intcomex en el único pool de prod).
- **D12 — Lo que no se arregló:**
  - M-10: los centavos de peso por trabajo cambiarían el costo informado de cada trabajo en menos de 1 peso.
  - M-16: sin impacto hoy.
  - M-17: regla de negocio.
- **D13 — Dos tests existentes se actualizaron:**
  - `genericImportAmounts` fijaba el comportamiento corregido: "1234,5" en CLP ahora se rechaza.
  - `accounting.golden` §4 esperaba `invoicedAmount: 100` USD sumado 1:1 a un trabajo en UYU. Desde `2eba8be` el valor correcto es 4.000 UYU.

---

## 6. Pasos para revisar y pasar a prod

1. **Revisar** (5 commits de arreglo, 2 de tests y 1 de informe; mergeados a `dev` con merge commit):
   ```bash
   git log --oneline 4878556..audit-math/2026-11
   ```
2. **Verificar en `web/`.** Ya corrido: tsc, lint, 785 tests unitarios y build OK.
   ```bash
   npm ci && npx next typegen && npx tsc --noEmit -p . && npx eslint . && npx vitest run && npm run build
   ```
3. **Integración contra dev** (la migración ya está en dev):
   ```bash
   npm run test:integration
   ```
   Resultado de esta corrida: 184 OK, 9 saltados (qaFase2b) y el único fallo era el §4 desactualizado de `accounting.golden`, ya corregido en la rama (`invoicedAmount` 4.000 UYU, no 100). Los 3 fallos de conexión Postgres directa ("IPv6 is not supported") de corridas anteriores no aparecieron esta vez.
4. **Prod (cuando lo apruebes),** con la receta de siempre:
   1. Backup.
   2. Huella.
   3. `npx supabase migration list --remote=jxkfpkgyvjiyufmfxsfp`, que debe mostrar 91 + `20261108010000` pendiente.
   4. Comparar el `prosrc` de prod de `allocate_recurring_service_cost_pool` con el cuerpo de `20261016010000`, sin CR.
   5. `npx supabase db push --remote=jxkfpkgyvjiyufmfxsfp --dry-run` y después sin `--dry-run`.
   6. Merge `dev` → `main`.

   La migración no cambia datos: reemplaza una función, crea otra y amplía un CHECK.
5. **Después del deploy,** hacer las correcciones de §4, empezando por C1 (Volver a repartir nov-2026). Después C3–C5, y C2 cuando decidas M-02.
6. **Verificar después de las correcciones:** volver a correr `RC1`/`RC3` de `audit/consultas_matematica_2026-11.sql`.
   - "Pool sin reconocer" de nov debería seguir en 1.036.626 hasta que se facturen los ciclos (o hasta decidir M-02).
   - `R05` debería mostrar 4 partes.
   - `R08`/`R09` deberían quedar vacíos.

> Los pasos 4–6 de arriba quedaron superados por la sección 7 (deploy hecho el 2026-11-08) y la lista final de la sección 8.

---

## 7. Fase de corrección: `fix-math/2026-11` (2026-11-08)

### 7.1 Qué había en las ramas

- Busqué en todas las ramas, locales y remotas (`git branch -a`, `git log --all`, `git grep` sobre cada commit), "sin respaldo en Uruguay" y la automatización del costo MS con Intcomex/TGM.
- No existen en ninguna rama: las únicas coincidencias eran comentarios de la migración `20261108010000` de la auditoría. Las implementé desde cero (§7.2).

### 7.2 Qué se cambió

| Punto | Qué | Dónde | Commit |
|---|---|---|---|
| 1 | El costo del reparto MS se reconoce en el **mes del pool** (el de la factura de Intcomex/TGM), en el cliente y área de cada servicio, aunque los ciclos de venta no estén facturados. Cada parte cuenta, así que el mes suma exactamente la factura (resto mayor). El reparto y su vista previa toman solo los servicios MS con "Usa pool de costo compartido": antes, un servicio sin pool recibía una parte que ningún reporte contaba. | `reporting.ts` (`toPoolShareLedgerRows`); migración `20261108020000` (`recurring_service_cost_pool_shares`, `prepare_recurring_service_cost_pool_cycles`, nuevo `allocate_recurring_service_cost_pool`) | `c74934a` |
| 2 | Al registrar o importar una factura de Intcomex (CL) o TGM (UY), Costos y el detalle de la factura avisan que su mes no tiene reparto y llevan a la propuesta. "Reparto licencias MS" lista los meses sin repartir desde 2026-01, y los pools cuyo total ya no coincide con las facturas. La propuesta de cada mes muestra cliente, servicio, vendido en el mes y parte (con total exacto) y avisa qué servicios MS no usan el pool. "Confirmar reparto" crea el pool con el neto del mes y lo reparte, un mes por vez. | `ms_license_pool_months`, `is_ms_licenses_supplier`, `create_ms_license_pool_for_month`; `/costs/ms-licenses/propose` | `579d269` |
| 3 | Uruguay: el cargo de técnico puede ser "Sin documento de respaldo". En ese caso desaparece "El monto incluye IVA" y el costo es exactamente lo pagado. El trigger acepta `none` en cualquier país (factura/boleta siguen siendo de Chile) y rechaza un sin respaldo con IVA o con neto distinto del monto. | `create_unbacked_technician_charge`, `update_uruguay_technician_charge`, `technician_charges_guard`; formulario y acciones de cargos | `cd06e9b` |
| 4 | Un período queda "pagado" cuando sus facturas asignadas están cobradas, aunque lo facturado difiera del precio. La vista ya lo calculaba así; ahora la diferencia (facturado − precio) se muestra solo como dato, con el aclarado de que no cambia el estado. | `periodPriceDifference`; lista y detalle de períodos | `1bf77d3` |
| 5 | Tests. **Unitarios:** reconocimiento en el mes del pool (golden del caso de nov-2026), meses a repartir, pools que no coinciden (comparados en unidades de la moneda; el test encontró un error de punto flotante en el helper), diferencia informativa, cargo uruguayo sin respaldo y las acciones. **Integración contra dev:** Intcomex con vista previa = reparto, solo servicios con pool, suma exacta, costo del mes con ciclos pendientes y un mes repartido una sola vez; TGM con un servicio sin pool rechazado y aceptado al activarlo; cargo uruguayo sin respaldo y su ida y vuelta con IVA; Chile rechaza la RPC uruguaya; período pagado con facturado 500 y precio 600. | `auditMath2026.test.ts`, `fixMath2026.integration.test.ts` | `a100f7b` |

**Qué números cambian en prod con el deploy (sin tocar datos guardados):**
- Chile, nov-2026: los costos directos suben **+1.036.626** (las partes del pool de Intcomex ya hechas: Razo 580.963 y TREI 455.663, ahora en noviembre aunque sus ciclos sigan sin facturar). El resultado de noviembre baja en lo mismo.
- No cambia ningún otro mes, porque no hay otros pools.
- Al apretar "Volver a repartir" (§8, paso 1), el total de noviembre no cambia: solo se redistribuye entre los 4 clientes.

### 7.3 Decisiones de esta fase

- **D14 — El proveedor de licencias se reconoce por nombre.** "Intcomex…" en Chile, "TGM…" en Uruguay, o el proveedor de un pool existente. Es una función de solo lectura y no se marcó ningún dato.
- **D15 — Las facturas de Intcomex asignadas a trabajos o repartidas fuera del área de licencias no entran al pool.** Es la misma regla que "cubierto por pool": son hardware de trabajos y siguen como costo de esos trabajos. En prod pasa en may, jun, jul, ago, sep y oct (§8).
- **D16 — En Uruguay, Trimant y grupoAM no usan el pool.** Hasta que activés "Usa pool de costo compartido" en cada uno, la propuesta de TGM no tiene entre quiénes repartir y el servidor la rechaza (probado). Al activarlo, Trimant deja de contar su costo fijo de 40 USD (los servicios con pool no usan períodos de costo).
- **D17 — Una parte del pool en un ciclo anulado igual se cuenta.** Así el mes suma exactamente la factura; la pantalla del pool avisa para volver a repartir.
- **D18 — La vista previa crea antes los ciclos del mes que faltan, como hace el cron.** Si no, la vista previa y el reparto no coincidirían.
- **D19 — Un cargo uruguayo con documento, al corregirse, conserva la tasa con que se cargó.** La conserva el servidor y la pantalla ya no la manda.
