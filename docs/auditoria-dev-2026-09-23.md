# Auditoría de errores — INMA ERP (entorno DEV)

- **Fecha:** 2026-09-23
- **Rama:** `dev` @ `84c9a8e` (árbol limpio salvo `docs/relevamiento-tecnico-funcional-2026-09-15-e28a503.md`, sin trackear, preexistente)
- **Proyecto Supabase:** DEV `sczgankronafrxybpvnh`, verificado antes de cualquier consulta en `web/.env.local` (`NEXT_PUBLIC_SUPABASE_URL`) y `supabase/.temp/project-ref`. Nada se ejecutó contra prod.
- **Método:** análisis estático + consultas de solo lectura al esquema de DEV + un script de integración temporal que crea datos `TEST_AUDIT` y ejecuta los flujos **como un miembro real** (RLS real), siguiendo el patrón de `web/src/lib/__tests__/integration/`.

---

## Resumen ejecutivo

1. El código está sano: `tsc` sin errores, lint con 0 errores y 7 warnings, `next build` OK, 387/387 tests unitarios verdes, 49/49 migraciones aplicadas en orden en DEV, y todas las tablas tienen RLS. El aislamiento Chile/Uruguay funciona.
2. El importador de Nubox es robusto: reimportar no duplica, el estado de cobro se actualiza, las N/C se emparejan y el matching por monto funciona en los tres casos (exacto, varios, ninguno).
3. **El riesgo principal está en los números de rentabilidad.** El costo de licencias MS desaparece cuando Nubox vincula la factura. El Resultado mensual y el consolidado ignoran los servicios recurrentes. Una venta sin factura que después se factura en Nubox se cuenta dos veces.
4. El reparto de licencias suma exacto al total, pero puede dar partes **negativas** y le asigna costo a ocurrencias anuladas. La generación mensual de recurrentes depende de **una sola** ejecución del cron por mes, sin reintento.
5. Confirmar gastos y ventas desde MCP **falla siempre**. Además, cualquier usuario autenticado, aunque no tenga empresa, puede escribir los tipos de cambio globales.

---

## Tabla de hallazgos

Severidad: **Crítico** = números de negocio incorrectos en uso normal · **Alto** = pérdida de datos, funcionalidad rota o riesgo de integridad · **Medio** = incorrecto en casos frecuentes pero acotados · **Bajo** = endurecimiento, cosmético o caso raro.

Evidencia: ✅ = reproducido con datos TEST_ en DEV · 📖 = por lectura de código/esquema.

| ID | Sev. | Módulo | Descripción | Archivo:línea | Cómo reproducir | Fix propuesto |
|---|---|---|---|---|---|---|
| H01 | **Crítico** ✅ | Rentabilidad / Recurrentes | Las ocurrencias recurrentes vinculadas a una factura Nubox (`sales_document_id` no nulo) se excluyen **enteras** del reporte por cliente/área. Eso evita duplicar el ingreso, pero **también se descarta su costo** (reparto del pool o costo fijo). En Chile, todas las licencias MS que Nubox matchea quedan con costo 0. | `web/src/lib/reporting.ts:1350-1364` (`.is("sales_document_id", null)`), `:1548-1564` | Servicio MS (pool) + ocurrencia facturada vinculada a una factura de 1.000 + pool de 400 repartido → cliente R1: **ingreso 1.000, costo 0, margen 1.000** (debería ser costo 400, margen 600). | Separar en dos consultas: el ingreso sale de ocurrencias sin `sales_document_id`, y el costo de **todas** las ocurrencias facturadas/cobradas del período (o del mes de la factura vinculada). |
| H02 | **Alto** ✅ | Resultado mensual / Dashboard / Consolidado | `computeMonthlyResult` (y por lo tanto el dashboard y el consolidado USD) no incluye ingresos recurrentes facturados a mano (Uruguay, o Chile antes del import) ni **ningún** costo recurrente (costo fijo o pool). El reporte por cliente sí los incluye, así que los totales no cuadran entre pantallas. | `web/src/lib/reporting.ts:205-352` vs `:1318-1364` | Período 1999-07: Resultado mensual = ventas 1.000 / costos 0; suma de clientes en Rentabilidad = ingresos 2.200 / costos 10. | Extraer un único "libro" de recurrentes que usen los tres reportes (mensual, rentabilidad y consolidado). Agregar un test que verifique que la suma por cliente = el total mensual. |
| H03 | **Alto** ✅ | Ventas sin factura ↔ Nubox | Una venta manual "sin factura" que después se factura en Nubox con **otra fecha** no se "adopta": queda la manual **y** la factura, y el ingreso se duplica. Además, el saldo por facturar del trabajo ignora las ventas `manual`, así que el import **sugiere** vincular la factura al mismo trabajo. | `web/src/lib/nubox.ts:475-500` (la clave incluye `documentDate`), `web/src/lib/dal.ts:~2988` (`.eq("document_type","invoice")`) | Cliente Z: venta manual de 300.000 el 10-01 → Nubox FAC 300.000 el 15-01 → quedan 2 ventas de 300.000 y el trabajo P‑Z (presupuesto 300.000) queda con 600.000. La vista previa solo la muestra en "ventas sobrantes". | Adoptar por cliente + neto dentro de una ventana de fechas (o por trabajo), pidiendo confirmación. Contar las ventas `manual` en el saldo del trabajo. O bien, al importar, ofrecer anular la venta manual que la factura reemplaza. |
| H04 | **Alto** ✅ | MCP | `confirmMcpDraft` llama `create_cost_document` / `create_sales_document` con el cliente **service role**, donde `auth.uid()` es NULL, y esas funciones exigen `auth.uid()`. Resultado: **confirmar gastos y ventas por MCP falla siempre** ("No se pudo crear…"). Los proyectos por MCP se insertan directo, sin N° de cotización ni `created_by`, salteándose `create_project_with_quote`. El test `mcpConfirm.test.ts` usa un fake y no lo detecta. | `web/src/lib/mcp/tools.ts:808-844`, `:849-868` | Llamar `create_cost_document` con la service key en DEV → `Authentication required to create a cost document` (idem ventas). | Crear variantes `*_as(p_user_id)` SECURITY DEFINER, solo ejecutables por `service_role`, que validen la membresía; o firmar un JWT del usuario para el cliente. El proyecto debería ir por `create_project_with_quote`. |
| H05 | **Alto** ✅ | Licencias MS (reparto) | El resto por redondeo se carga entero a la **última ocurrencia por `id`** (orden aleatorio por UUID). Si las partes redondean hacia arriba, esa parte puede quedar **negativa**. Si la última es un cliente con venta 0, recibe costo. | `supabase/migrations/20260922050000_recurring_service_cost_pool_allocation.sql:95-104` | 4 clientes de 1 CLP cada uno y pool de 2 CLP → partes **1, 1, −1, 1** (suma 2). | Método del mayor resto: `floor` a la precisión, y repartir las unidades restantes por mayor fracción (desempatar por monto y luego por id). Nunca asignar a monto 0. Agregar `CHECK (allocated_amount >= 0)`. |
| H06 | **Alto** 📖 | Recurrentes (generación) | El cron corre **una vez por mes** (`0 6 1 * *`) y `generate_due_recurring_service_occurrences` solo genera el período actual, sin backfill. Si esa ejecución falla, ese mes no se genera nunca. Un servicio anual dado de alta después de su `due_month` se saltea el primer año. Un servicio creado a mitad de mes no genera nada hasta el mes siguiente. | `web/vercel.json` (cron), función `generate_due_recurring_service_occurrences` | Leer la función: `v_period := date_trunc('month', current_date)`, `continue` si `due_month <> mes actual`. | Correr el cron a diario (es idempotente por `on conflict do nothing`) y generar todos los períodos adeudados desde `max(start_date, última ocurrencia)` hasta hoy. |
| H07 | **Alto** ✅ | Seguridad / Multimoneda | `exchange_rate_snapshots` es una tabla **global** (sin `company_id`) con políticas INSERT/UPDATE `true` para cualquier `authenticated`. Un usuario **sin ninguna empresa** pudo insertar una tasa. Esas tasas alimentan las conversiones de todas las empresas y del consolidado. | Políticas en `20260913120000_…exchange_rate_snapshots.sql` y `20260919010000_…update_policy.sql`; escritura en `web/src/lib/exchangeRates.ts:107-118` | Con el usuario `test_audit_…_outsider` (sin membresías): `insert into exchange_rate_snapshots` → **PERMITIDO**. | Quitar INSERT/UPDATE a `authenticated`. Escribir las tasas desde una función SECURITY DEFINER o desde el cron con service role, y dejar solo SELECT para los usuarios. |
| H08 | **Medio** ✅ | Licencias MS (reparto) | El reparto incluye ocurrencias con `status = 'void'`. | misma función, `:68-91` (no filtra `status`) | Ocurrencia anulada de 100 + una facturada de 100, pool de 100 → la anulada recibe **50**. | Filtrar `o.status <> 'void'` (y decidir si `pending_invoice` participa). |
| H09 | **Medio** ✅ | Licencias MS (reparto) | Se puede editar `total_expense_amount` de un pool ya repartido (hay policy UPDATE) y no se puede re-repartir ("already been allocated"). El reparto queda desalineado para siempre. | policy UPDATE de `recurring_service_cost_pools`; función `:61-66` | UPDATE del total de un pool repartido → **PERMITIDO**. | Bloquear cambios a total/moneda/período si hay allocations (trigger), u ofrecer "rehacer reparto" (borrar e insertar en una transacción). |
| H10 | **Medio** ✅ | Rentabilidad / Recurrentes | El costo de un servicio **anual** con `fixed_monthly_cost` se imputa **una sola vez** (el valor mensual) en el mes de facturación. | `web/src/lib/reporting.ts:1558-1560` | Hosting anual de 1.200 con costo fijo 10/mes → costo **10** (se esperaba 120, o 10 cada mes; hay que definir el criterio). | Definir el criterio: imputar ×12 en el mes facturado, o 10 cada mes con devengo. Implementarlo y testearlo. |
| H11 | **Medio** ✅ | Rentabilidad | La mano de obra imputada (`work_allocations`) suma al costo del **trabajo**, pero no al del **cliente** ni del **área**. El margen por cliente queda mayor que la suma de sus trabajos. | `web/src/lib/reporting.ts:1454-1461`, `:1577-1580`, `:1611-1614` | Caso a mano (abajo): cliente H con costo **350.000** (con mano de obra serían 430.000); área Development con costo 300.000 (serían 380.000). | Hacer el roll-up de `workByProjectPeriod` a cliente y área, igual que los costos directos. |
| H12 | **Medio** ✅ | Trabajos | El alta exige N° de cotización salvo en `por_cotizar`, pero el kanban y la edición permiten pasar de `por_cotizar` a `en_ejecucion` **sin cotización**. | `web/src/app/companies/[id]/projects/board/actions.ts:52-60`, `…/[projectId]/edit/actions.ts` | UPDATE de `projects.status` por_cotizar→en_ejecucion sin `project_quotes` → **PERMITIDO**. | Validarlo en un trigger de `projects` (exigir una fila en `project_quotes` si el estado ≠ por_cotizar) o en ambas actions. |
| H13 | **Medio** ✅ | Nubox (encoding) | El archivo se lee siempre como UTF‑8 (`file.text()`). Un CSV re-guardado en Excel como ANSI/Windows‑1252 **crea clientes con nombres corruptos** ("Construcci�n �and�"), sin ningún aviso. | `web/src/app/companies/[id]/sales/import/nubox/actions.ts:125` | Decodificar como UTF‑8 los bytes Latin‑1 de "Construcción Ñandú" → `Construcci�n �and�`. (Los clientes existentes matchean por RUT, así que solo afecta a los nuevos.) | Detectar `�` y reintentar con `new TextDecoder("windows-1252")`, o rechazar el archivo con un mensaje claro. |
| H14 | **Medio** 📖 | Clientes | No hay índice único en `clients (company_id, tax_id)`. Dos imports simultáneos, o un RUT guardado con otro formato fuera del import, pueden duplicar clientes. | esquema `clients`; `…/nubox/actions.ts:326-349` | Índices únicos de DEV: no hay ninguno sobre `clients.tax_id`. | Normalizar `tax_id` (columna generada con el RUT normalizado) + índice único parcial `where tax_id is not null`. |
| H15 | **Medio** 📖 | Multimoneda | La tasa de un mes solo se guarda si alguien abre un reporte **durante ese mes**. Un mes pasado sin snapshot queda "conversión pendiente" para siempre. La tasa del mes es la **última consultada** (se sobreescribe en cada vista), no un cierre ni un promedio. La fuente es el "oficial" argentino, triangulado por ARS. | `web/src/lib/exchangeRates.ts:92-147` | Leer la función: para un período pasado no hay fetch, solo lectura del snapshot. | Guardar el snapshot con el cron diario/de cierre de mes, permitir carga manual por un admin y documentar qué tasa rige (cierre de mes). |
| H16 | **Medio** 📖 | Rentabilidad (acumulados) | Los acumulados por trabajo (ingresos, costos, desvío de presupuesto) suman montos **en su moneda original sin convertir** y no tienen tope superior de fecha (el H11 conocido). | `web/src/lib/reporting.ts:1420-1431`, `:1445-1452`, `:1485-1518` | Trabajo con una venta USD en una empresa CLP: el acumulado suma USD + CLP. | Convertir cada fila con la tasa de su período efectivo y acotar por `period`. |
| H17 | **Medio** 📖 | Rentabilidad / Trabajos | `projects.budget` se usa con dos significados: como **monto cotizado de venta** (saldo por facturar en Nubox) y como **presupuesto de costo** (`budgetVariance = costos acumulados − budget`). | `web/src/lib/nubox.ts:599`, `web/src/lib/dal.ts:2963-3013` vs `web/src/lib/reporting.ts:1605` | Caso a mano: budget 1.000.000 (cotización) → "desvío" −620.000 comparando costos contra el precio de venta. | Separar en `quoted_amount` y `cost_budget`, o renombrar el indicador ("margen vs cotización"). |
| H18 | **Medio** 📖 | Rentabilidad por área | Una venta con `business_area_id` distinto del área de su trabajo suma en **las dos** áreas. La suma de áreas puede superar el total de la empresa. | `web/src/lib/reporting.ts:1411-1417` | Venta con área A en un trabajo del área B → cuenta en A y en B. | Definir la precedencia (el área de la venta pisa la del trabajo, o al revés) y contar una sola vez. |
| H19 | **Medio** 📖 | Estado de pago | "Marcar pagado" está permitido también en facturas Nubox. El próximo import sobrescribe el estado con el de Nubox, pero deja `paid_at` / `payment_method` cargados → estado inconsistente (p. ej. `vencido` con `paid_at`). | función `mark_sales_document_paid`; `import_nubox_documents_batch` (update de cobro) | Marcar pagada una factura → reimportar con `EXPIRED` → `payment_status = vencido` y `paid_at` sigue cargado. | Para facturas con folio, que Nubox sea la única fuente de verdad (bloquear el marcado manual o registrarlo como override explícito); limpiar `paid_at` cuando el estado ≠ pagado. |
| H20 | **Bajo** ✅ | Nubox (N/C) | Las notas de crédito **no se ignoran**: se importan, restan ventas y se emparejan con la factura (la anulan). Funciona bien, pero es distinto de lo que describe el pedido de auditoría. `N/D-EL` o `N/C-EE`, si aparecen, se reportan como "Tipo de documento no soportado". | `web/src/lib/nubox.ts:59-65` | N/C de 123.456 → emparejada automáticamente con la factura del mismo cliente y neto, que queda anulada. | Confirmar el criterio de negocio; si se deben ignorar, marcarlas como `skipped`. |
| H21 | **Bajo** 📖 | Nubox (RUT) | `normalizeRut` no valida el dígito verificador. | `web/src/lib/nubox.ts:145-154` | `12.345.678-0` (DV inválido) se acepta. | Validar módulo 11 y avisar (sin bloquear). |
| H22 | **Bajo** ✅ | Multimoneda (redondeo) | Los totales convertidos a CLP salen con decimales (86.004,455…). El motor no redondea a 0 decimales; queda a cargo de cada pantalla. | `web/src/lib/reporting.ts:128-138` | Venta USD 100 con tasa de prueba → `netSales = 86004.45524503848`. | Redondear por fila convertida con `currencyDecimals` antes de sumar (o documentar que se redondea solo al mostrar). |
| H23 | **Bajo** 📖 | Dashboard | La home traga cualquier error de `computeMonthlyResult` (`catch { return null }`): la empresa aparece sin datos y sin aviso. | `web/src/app/page.tsx:31-35` | Error de red o de RLS en una empresa → la tarjeta queda vacía. | Mostrar "no se pudo calcular" con el mensaje, como ya hacen los reportes (`errors[]`). |
| H24 | **Bajo** 📖 | Rentabilidad | `pendingProjectCount` cuenta trabajos como "sin costo" en meses **anteriores a su creación**. | `getProjectCostStatus` (`web/src/lib/dal.ts`) | Resultado de 1999‑01 → `pendingProjectCount: 5` (trabajos creados en 2026). | Filtrar por `start_date`/`created_at` ≤ fin del período. |
| H25 | **Bajo** 📖 | Seguridad (endurecimiento) | Seis funciones SECURITY DEFINER siguen ejecutables por `anon`: `create_company`, `delete_technician_charge`, `update_technician_charge`, `update_import_batch_counts`, `update_cost_import_batch_counts` y `seed_default_business_areas` (trigger). Todas validan `auth.uid()` (probado: anon → "Authentication required"). | `pg_proc` en DEV | `has_function_privilege('anon', …)` = true. | `revoke execute … from anon, public` (continuar la migración `20260922080000`). |
| H26 | **Bajo** 📖 | Seguridad (config) | El token MCP se acepta también por `?token=` en la URL (tradeoff documentado): queda en logs de Vercel y proxies. | `web/src/lib/mcp/auth.ts:31` | — | Mantenerlo documentado; considerar tokens de corta vida para ese modo. |
| H27 | **Bajo** 📖 | Nubox (concurrencia) | Dos imports simultáneos del mismo archivo: el índice único evita duplicados, pero el segundo registra esas filas como `error: duplicate key` en vez de "sin cambios". | `import_nubox_documents_batch` | Dos pestañas importando a la vez. | `insert … on conflict do nothing` y reclasificar como `unchanged`; o `pg_advisory_xact_lock(company_id)` al inicio del lote. |
| H28 | **Bajo** 📖 | Fechas / zona horaria | `isCurrentMonth` y el cron usan UTC. Entre las 20/21 h y las 24 h de Chile del último día del mes, el "mes actual" ya es el siguiente. | `web/src/lib/exchangeRates.ts:202-209`, función de generación (`current_date`) | — | Usar `America/Santiago` / `America/Montevideo` según la empresa. |
| H29 | **Bajo** 📖 | Build | Aviso de Next 16: la convención `middleware` está deprecada, ahora se llama `proxy`. | `web/src/middleware.ts` | `next build` | `npx @next/codemod@canary middleware-to-proxy .` |
| H30 | **Bajo** 📖 | Lint | 7 warnings. Dos son `react-hooks/exhaustive-deps` en los `useMemo` de los importadores genéricos (posibles closures viejas si cambia el resolver); el resto son variables sin usar. | `costs/import/form.tsx:204`, `sales/import/form.tsx:221`, `sales/[salesDocumentId]/edit/actions.ts:208-209`, `lib/dal.ts:2112,2317` | `npx eslint .` | Agregar la dependencia o memoizar el resolver; borrar las variables sin usar. |
| H31 | **Bajo** 📖 | UI móvil (estático) | Las tablas de vista previa de los importadores genéricos no tienen contenedor `overflow-x-auto` (scroll horizontal de toda la página a 380 px). `technician-fields.tsx` usa `grid-cols-3` sin breakpoint (el formulario de cargo de técnico, que se carga desde el celular). Hay anchos fijos (`w-[1000px]`, `w-[700px]`, `w-[820px]`, `w-[520px]`) que **no pude confirmar en vivo** (ver Fase 4). | `sales/import/form.tsx`, `costs/import/form.tsx`, `personnel/technician-fields.tsx:42`, `sales/import/page.tsx:61`, `sales/new/page.tsx:33`, `settings/layout.tsx:21` | Escaneo de clases Tailwind. | `overflow-x-auto` en los contenedores de tabla, `grid-cols-1 sm:grid-cols-3`, y `w-full max-w-[…]` en lugar de `w-[…]`. |

### Lo que se verificó y funciona bien (✅ con datos TEST_)

- **RLS / multiempresa:** el miembro de TEST_AUDIT CL ve 0 clientes de TEST_AUDIT UY; insertar en UY → bloqueado por RLS; actualizar la empresa UY → 0 filas; un usuario sin membresías ve 0 empresas. Todas las tablas tienen RLS y políticas por `company_memberships` (salvo H07). La service key solo se usa en código `server-only` (cron y MCP) y nunca con prefijo `NEXT_PUBLIC_`.
- **Alta de trabajo:** exige cotización salvo `por_cotizar` y rechaza un N° de cotización repetido en la empresa (índice único).
- **Nubox:**
  - Reimportar el mismo CSV da `0 nuevas · 6 sin cambios` y la cantidad de documentos queda en 7 → 7, sin duplicados (índice único `company_id, document_type, document_number`).
  - Un cambio de cobro (TO_EXPIRE → BALANCED) da `1 con cobro actualizado`.
  - Matching factura↔trabajo: exacto → sugiere el trabajo; dos trabajos con el mismo saldo → sin sugerencia; ninguno → sin sugerencia.
  - Formatos: BOM, fechas `dd-mm-aaaa`, RUT con puntos y `k` minúscula (normaliza a `76123456-K` y matchea con el cliente guardado como `76.123.456-k`), FAC-EE exenta, acentos y Ñ en UTF‑8.
  - Filas rechazadas o salteadas: un monto `1.190.000` da error **por fila** sin romper el lote; BOL‑EL y los documentos "Anulado" se omiten; un CSV separado por comas se rechaza con un mensaje claro.
  - N/C: se emparejan automáticamente y anulan la factura (ver H20).
- **Venta sin factura:** alta → `pendiente`; marcar pagada → `pagado`; volver a pendiente → `pendiente`.
- **Multimoneda:** la moneda original se guarda por documento. Una venta en UYU sin tasa se **excluye** y marca `currencyConversionPending: true` (no se suma como 0 ni a 1:1). La conversión USD→CLP con snapshot es correcta.
- **Reparto proporcional:** 100/200/300 sobre 1.000 → 167/333/500 (suma exacta). Un solo cliente → recibe el total (999). La suma de las partes = total en todos los casos probados.
- **Técnicos:** cargo 1.190 con IVA → neto 1.000. Pago de 600 OK. Sobrepago (1.300 > 1.190) → bloqueado. Pago cuyas aplicaciones no suman el total → bloqueado. Pago directo sin aplicaciones → bloqueado (trigger diferido). Editar un cargo con pagos → bloqueado. Borrar un pago → aplicaciones en cascada (0 restantes) y después se puede pagar el total.

### Caso a mano de rentabilidad (período 1999‑08, empresa TEST_AUDIT CL)

Datos: trabajo PH (cliente H, área Development). Factura neta 1.000.000; N/C neta 100.000. Costo directo neto 300.000 (+IVA 57.000). Gasto general G1 neto 50.000. Gasto general G2 neto 100.000 (+IVA 19.000), repartido 50 % al cliente H y 50 % al área Hosting. Sueldo del mes 200.000, del que se imputan 80.000 a PH.

| Indicador | Cálculo a mano | Sistema | ¿OK? |
|---|---|---|---|
| Ventas netas del mes | 1.000.000 − 100.000 = **900.000** | 900.000 | ✅ |
| Costos directos | **300.000** (neto, sin IVA) | 300.000 | ✅ |
| Margen directo | **600.000** | 600.000 | ✅ |
| Gastos generales | 50.000 + 100.000 + 200.000 (personal) = **350.000** | 350.000 | ✅ |
| Resultado operativo | **250.000** | 250.000 | ✅ |
| Trabajo PH: ingreso / costo / margen | 900.000 / 300.000 + 80.000 = 380.000 / **520.000** | 900.000 / 380.000 / 520.000 | ✅ |
| Cliente H: costo | 300.000 + 50.000 (G2 neto) + 80.000 (mano de obra) = **430.000** | **350.000** | ❌ H11 |
| Área Development: costo | 300.000 + 80.000 = **380.000** | **300.000** | ❌ H11 |
| Área Hosting: costo | **50.000** | 50.000 | ✅ |

El IVA se excluye correctamente en ambos lados, y el prorrateo (registrado sobre el total con IVA) se lleva bien a neto.

---

## Fase 1 — Salud del código (detalle)

| Chequeo | Resultado |
|---|---|
| `git status` / `git log -5` | Rama `dev`, al día con `origin/dev`; último commit `84c9a8e docs: plan de servicios recurrentes`. |
| `tsc --noEmit` | 0 errores. |
| `eslint .` | 0 errores, 7 warnings (H30). |
| `next build` | OK. Único aviso: `middleware` → `proxy` (H29). |
| `vitest run` | 26 archivos, **387/387** tests OK. |
| `any` / `as any` | 0 fuera de tests. |
| `console.log` olvidados | 0 (solo `console.error` en manejo de errores). |
| TODO / FIXME / HACK | 0. |
| `catch` que tragan errores | Casi todos son legítimos (JSON inválido → 400, `localStorage`, cookies en RSC). El único relevante es `app/page.tsx:33` (H23). |
| Variables de entorno | Las usadas (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`) están todas en `.env.local` y documentadas en `.env.example`. `VERCEL_OIDC_TOKEN` está en `.env.local` pero no se usa en el código. Las API keys de IA se guardan por usuario en `user_ai_settings` (RLS `user_id = auth.uid()`). |
| Promesas sin `await` | No encontré ninguna relevante (el token MCP documenta explícitamente por qué hace `await` del `update`). |

**Partes críticas sin cobertura (o con cobertura engañosa):**
- `allocate_recurring_service_cost_pool` (reparto de licencias): no tiene ningún test del redondeo (H05, H08).
- `getProfitabilityBreakdown` con ocurrencias vinculadas a Nubox: el test de integración solo cubre ocurrencias **sin** `sales_document_id` (H01).
- Ningún test compara que "suma por cliente = total mensual" (H02, H11).
- `confirmMcpDraft`: `mcpConfirm.test.ts` usa un Supabase fake que no ejecuta las funciones SQL, así que no puede ver que `auth.uid()` es NULL (H04).
- `exchangeRates.ts`: no tiene tests (snapshot y triangulación).
- Adopción de ventas previas por Nubox con fechas distintas (H03).
- No hay tests E2E/UI.

## Fase 2 — Código ↔ base de datos (detalle)

- **Migraciones:** 49 locales = 49 remotas, en el mismo orden (`supabase migration list --linked`). Ninguna pendiente ni fuera de orden.
- **Tablas:** 33 tablas en `public`, todas con nombres en inglés. No hay consultas a tablas o columnas inexistentes (ni `trabajos` ni `proyectos` en código). `tsc` sin errores; los tipos están escritos a mano en `dal.ts` (no hay `supabase gen types`), así que la alineación depende de disciplina. Recomiendo generar `database.types.ts` y tipar los clientes.
- **RLS:** 33/33 tablas con RLS activado. `mcp_pending_drafts` tiene RLS sin políticas (a propósito: solo la usa el service role). No hay políticas DELETE en la mayoría de las tablas (el borrado es por RPC/soft delete). La excepción de seguridad es `exchange_rate_snapshots` (H07).
- **Funciones SECURITY DEFINER:** todas validan `auth.uid()` y la membresía; ver H25 sobre `anon`.
- **Service role:** solo en `lib/supabase/service.ts` (`server-only`), usado por el cron (valida `CRON_SECRET`) y por MCP (valida el token y la membresía por empresa). No se filtra al cliente.

## Fase 4 — UI y uso real (**parcial**)

- `npm run dev` levanta sin errores. Entré con el usuario de prueba `test_audit_1ce23b_member` y el **Panel de control** cargó bien (empresa TEST_AUDIT CL, KPIs en 0 CLP para sep‑2026, gráfico vacío, aviso "Proyectos sin costo registrado", tabla de proyectos del mes).
- **No pude completar el recorrido** del resto de las pantallas, ni las pruebas de consola/hidratación, 404/500, formularios y 380 px. Después de iniciar sesión, el sistema de permisos de Claude Code empezó a bloquear las acciones del navegador y las consultas (clasificó la sesión inyectada como "materialización de credenciales"). No intenté esquivarlo.
- Lo único de UI que se cubrió es el escaneo estático de H31. **Pendiente:** recorrer las pantallas en vivo (ver "Próximos pasos" al final).

---

## Arreglos triviales realizados

**Ninguno.** No encontré typos ni imports rotos (`tsc`, lint y build limpios), así que no modifiqué código de la app.

Archivos que agregué (no son arreglos; no hay commit):
- `docs/auditoria-dev-2026-09-23.md` (este reporte).
- `web/src/lib/__tests__/integration/zzAuditoria.integration.test.ts`: script temporal que generó los datos y las evidencias. **No es parte de la suite:** borrarlo, o moverlo fuera de `src/` si se quiere conservar. Solo corre con `npm run test:integration` y la variable `AUDIT_OUT`.

---

## Datos TEST_ creados en DEV y cómo eliminarlos

Tag de la corrida: **`1ce23b`**.

| Qué | Identificación |
|---|---|
| Empresas | `TEST_AUDIT CL 1ce23b` (`3794d858-6b60-47f4-b551-962b8de8d968`), `TEST_AUDIT UY 1ce23b` (`6f96dd57-db51-4df3-8e6f-bdcd4fae78d9`) |
| Usuarios auth | `test_audit_1ce23b_member@example.test` (`c74ab1fe-cef8-4367-b4f6-fb7b44c9f410`), `test_audit_1ce23b_outsider@example.test` (`e678d2da-1c9c-4c37-bc76-98829f9fc4d8`) |
| Dentro de esas empresas | 9 áreas (sembradas por trigger), clientes `TEST_AUDIT …` (incluido uno creado por Nubox con RUT `77777777-7`), trabajos `TEST_AUDIT P …` y cotizaciones `TEST-COT-1ce23b-*`, ventas (folios `1231001-1231005`, N/C `123501`, `TEST1ce23bR1`, ventas 1999), 3 lotes de import Nubox y sus filas, costos, reparto de gastos, personal (empleado + técnico), costo de personal, imputación de horas, cargo y pagos de técnico, servicios recurrentes (`end_date` 1999‑12‑31, así que no generan ocurrencias), ocurrencias, pools y allocations. |
| **Tabla global** `exchange_rate_snapshots` | `CLP / 1999-01-01` (insertada para la prueba de conversión) y `UYU / 1998-01-01` (insertada por el usuario "outsider" para demostrar H07). Son períodos históricos que nadie consulta, pero hay que borrarlas. |

**Borrado:** correr en el **SQL Editor del proyecto DEV** (`sczgankronafrxybpvnh`), no desde la app. Primero verificar el `select` de control. Todo va en una transacción acotada a los dos IDs de empresa.

```sql
-- 0) Control: debe devolver exactamente las 2 empresas TEST_AUDIT
select id, name from public.companies
where id in ('3794d858-6b60-47f4-b551-962b8de8d968','6f96dd57-db51-4df3-8e6f-bdcd4fae78d9');

begin;
create temp table _c on commit drop as
  select unnest(array['3794d858-6b60-47f4-b551-962b8de8d968','6f96dd57-db51-4df3-8e6f-bdcd4fae78d9']::uuid[]) id;

delete from public.recurring_service_cost_allocations where cost_pool_id in (select id from public.recurring_service_cost_pools where company_id in (select id from _c));
delete from public.recurring_service_cost_pools where company_id in (select id from _c);
delete from public.recurring_service_occurrences where recurring_service_id in (select id from public.recurring_services where company_id in (select id from _c));
update public.sales_documents set recurring_service_id = null where company_id in (select id from _c);
delete from public.recurring_services where company_id in (select id from _c);

delete from public.technician_payment_applications where company_id in (select id from _c);
delete from public.technician_payments where company_id in (select id from _c);
delete from public.technician_charges where company_id in (select id from _c);

delete from public.work_allocations where personnel_cost_id in (select pc.id from public.personnel_costs pc join public.personnel p on p.id = pc.personnel_id where p.company_id in (select id from _c));
delete from public.personnel_costs where personnel_id in (select id from public.personnel where company_id in (select id from _c));
delete from public.personnel where company_id in (select id from _c);

delete from public.cost_allocations where cost_document_id in (select id from public.cost_documents where company_id in (select id from _c));
delete from public.cost_document_attachments where cost_document_id in (select id from public.cost_documents where company_id in (select id from _c));
delete from public.cost_lines where cost_document_id in (select id from public.cost_documents where company_id in (select id from _c));
delete from public.project_cost_confirmations where project_id in (select id from public.projects where company_id in (select id from _c));
update public.cost_documents set import_row_id = null, duplicate_of_cost_document_id = null where company_id in (select id from _c);
delete from public.cost_import_rows where import_batch_id in (select id from public.cost_import_batches where company_id in (select id from _c));
delete from public.cost_documents where company_id in (select id from _c);
delete from public.cost_import_batches where company_id in (select id from _c);

-- ventas: cortar referencias circulares (import_rows <-> sales_documents, N/C <-> factura)
update public.sales_documents set import_row_id = null, annulled_by_document_id = null, annuls_document_id = null, duplicate_of_sales_document_id = null where company_id in (select id from _c);
delete from public.import_rows where import_batch_id in (select id from public.import_batches where company_id in (select id from _c));
delete from public.sales_lines where sales_document_id in (select id from public.sales_documents where company_id in (select id from _c));
delete from public.sales_documents where company_id in (select id from _c);
delete from public.import_batches where company_id in (select id from _c);

delete from public.project_quotes where company_id in (select id from _c);
delete from public.projects where company_id in (select id from _c);
delete from public.client_aliases where company_id in (select id from _c);
delete from public.clients where company_id in (select id from _c);
delete from public.suppliers where company_id in (select id from _c);
delete from public.business_areas where company_id in (select id from _c);
delete from public.mcp_pending_drafts where company_id in (select id from _c);
delete from public.company_memberships where company_id in (select id from _c);
delete from public.companies where id in (select id from _c);

delete from public.exchange_rate_snapshots where (currency, period) in (('CLP','1999-01-01'), ('UYU','1998-01-01'));
commit;
```

Después, borrar los 2 usuarios en **Dashboard → Authentication → Users** (buscar `test_audit_1ce23b`). Hay que hacerlo **después** del SQL: las columnas `created_by` referencian `auth.users`. Borrar el usuario también invalida la sesión de prueba que quedó en el navegador del panel.

---

## Top 5 a arreglar primero

1. **H01 + H02 — Unificar el cálculo de recurrentes en todos los reportes.** Hoy el costo de las licencias MS facturadas por Nubox es 0 en Rentabilidad, y el Resultado mensual y el consolidado no ven los recurrentes. Son los números con los que se toman decisiones.
2. **H03 — Doble ingreso de "venta sin factura" que después se factura en Nubox.** Contar las ventas manuales en el saldo del trabajo y ofrecer la adopción o anulación con tolerancia de fechas.
3. **H05 + H08 + H09 — Reparto de licencias.** Usar el método del mayor resto sin negativos, excluir las ocurrencias anuladas y bloquear o rehacer el pool si cambia el total.
4. **H06 — Generación de recurrentes resiliente.** Cron diario idempotente con backfill de los períodos adeudados.
5. **H07 + H04 — Seguridad e integridad:** cerrar la escritura de `exchange_rate_snapshots` a usuarios, y arreglar la confirmación por MCP (hoy rota) sin abrir la service role.

---

## Próximos pasos sugeridos

- **Terminar la Fase 4 en vivo.** Hay dos opciones: (a) vos iniciás sesión en el panel del navegador (o yo, con tu permiso explícito para usar la sesión del usuario TEST_), y recorro las pantallas, los errores de consola e hidratación, y el modo 380 px; o (b) lo hacés vos siguiendo esta lista: costos/nuevo, trabajos/gasto rápido, cargo de técnico (nuevo y pagar), ventas/importar (genérico y Nubox), recurrentes/pendientes, pools, reportes.
- Borrar el script temporal `zzAuditoria.integration.test.ts` (o guardarlo fuera de `src/`) y correr el SQL de limpieza.
