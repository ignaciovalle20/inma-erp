# Servicios recurrentes, períodos y asignación de facturas

Rama `dev`. **Nada de esto está en prod.** Migraciones, todas aplicadas en **inma-erp-dev** (historial 67/67), cada una probada antes dentro de una transacción revertida:

| Migración | Qué hace |
|---|---|
| `20261016010000_sales_allocations_and_recurring_periods` | Esquema base (2026-10-16): referencial, períodos, `sales_allocations`, vistas, backfill. |
| `20261017010000_allocation_suggestions_and_multi_links` | Motivo de la sugerencia, saca el sugeridor SQL, `unpaid_amount` en la vista de períodos, búsqueda de trabajos sin placeholders y por asignación. |
| `20261017020000_set_sales_allocations_keeps_reason` | El editor conserva el motivo al guardar. |
| `20261017030000_period_billing_paid_only_by_invoices` | Corrige el estado de un período con una factura pagada y otra impaga (ver hallazgo 4). |

## Esquema

| Tabla / objeto | Cambio |
|---|---|
| `recurring_services` | `price` → `reference_amount` (nullable, valores migrados por rename). Nuevos `pricing_mode` (`fixed`/`per_unit`), `unit_price`, `default_quantity`; en `per_unit` la BD calcula referencial = precio × cantidad. Nuevo `service_type = 'domain'` (obligatoriamente anual; la renovación es `due_month`/`due_day`). |
| `recurring_service_occurrences` | Es la tabla de períodos (ya existía, se adaptó). `amount` = monto esperado (snapshot del referencial); nuevo `quantity` (por período, recalcula el esperado). `status` sigue siendo el estado manual para clientes sin factura. |
| `project_quotes` | Nuevos `quoted_amount` (opcional) y `placeholder` (cotización interna de un trabajo sin número de cotización; nunca se muestra como cotización). |
| `sales_allocations` | Documento → exactamente un destino (período o cotización), `amount`, `status` (`suggested`/`confirmed`), `notes`, `suggestion_reason` (`exact` / `single_period` / `proportional` / `quote`, null si es manual). RLS por `company_memberships`. Trigger: misma empresa, documento asignable, período no anulado, suma ≤ neto (½ peso / ½ centavo). Únicos por documento+destino. |
| Vistas | `sales_document_allocation_summary` (neto, asignado, sin asignar), `recurring_service_period_summary` (esperado, facturado, diferencia, `billing_status`, `unpaid_amount`), `project_quote_billing_summary` (cotizado, facturado, %). Todas `security_invoker`. |
| Funciones | `ensure_recurring_service_periods`, `set_sales_allocations`, `project_default_quote_id`, `refresh_recurring_service_occurrence_billing`, `sync_sales_document_project`, `recurring_service_period_billed_amount`. Reescritas: generación de períodos, `allocate_recurring_service_cost_pool` (pondera por lo facturado), `match_recurring_service_occurrences_to_invoices` (no toca lo ya asignado), `list_projects` (busca por asignación, ignora placeholders). `match_recurring_service_occurrences_for_import_batch` quedó como no-op (la app vieja la llama). `suggest_sales_allocations*` se eliminaron: la sugerencia vive en la app. |

## Sugerencia automática

Código: `web/src/lib/allocationSuggestions.ts` (reglas puras, con tests unitarios) y `allocationSuggestionsLoader.ts` (lee y guarda con el cliente que recibe). Corre al terminar cada importación (Nubox y CSV), desde "Buscar sugerencias" en Conciliar y desde el editor de la factura. Siempre mismo cliente y misma moneda; documentos en orden de fecha y cada sugerencia cuenta para las siguientes:

1. **Exacta**: un único período abierto del mes (o una única cotización con saldo) igual al neto, ± ½ unidad.
2. **Único período del mes**: si el cliente tiene un solo período pendiente (o con saldo) que vence el mes de la factura, todo el neto va ahí, aunque no coincida, siempre que el neto sea como máximo `SINGLE_PERIOD_MAX_RATIO` (2) veces lo que el período espera. Si lo supera, no se sugiere nada.
3. **Reparto proporcional**: varios períodos del mes cuyos esperados suman el neto ± `SUGGESTION_SUM_TOLERANCE` (15 %, constante en `allocationSuggestions.ts`): una línea por período, en proporción a los esperados; la última toma el redondeo para que la suma sea exactamente el neto.
4. **Cotización con saldo**: si el mes no tiene períodos, la única cotización del cliente con saldo ≥ neto.
5. Si no, nada: la factura queda en "Pendientes de conciliar".

Las sugerencias son `suggested` y no cambian el período hasta confirmarse. Un documento que ya tiene alguna asignación nunca se toca, así que reimportar no duplica. El editor y Conciliar muestran el motivo y, si el monto difiere de lo que el período esperaba, la diferencia.

## Columnas legadas con asignaciones múltiples (investigación)

`recurring_service_occurrences.sales_document_id` y `sales_documents.project_id` guardan **un solo** vínculo; con asignaciones se sincronizan así: el período apunta a la factura con mayor parte; el documento, al trabajo con mayor parte (y su área).

### Quién las leía

| Lector | Columna | Qué pasaba con 2+ destinos / 2+ facturas | Estado |
|---|---|---|---|
| Reporte de rentabilidad, página del trabajo, dashboard (`getProfitabilityBreakdown`) | `project_id` | **Factura en 2 trabajos: el neto entero en el trabajo mayor, 0 en el otro**. Factura trabajo + servicio: el trabajo se quedaba también con la parte del servicio. Las áreas, igual (todo al área del trabajo mayor). | **Corregido**: reparto por asignación (`lib/salesAttribution.ts`). |
| Lista de ventas: filtro por trabajo / área (drill-down del reporte), costo y margen por fila | `project_id`, `business_area_id` | El trabajo menor no veía la factura; el costo del trabajo se prorrateaba sobre el neto entero. | **Corregido**: filtro por parte, columna "aquí X", costo por parte, "+N trabajos". |
| Saldo por facturar de cada trabajo (sugerencia de vínculo en import Nubox, Pendientes, asistente IA) | `project_id` | Neto entero al trabajo mayor: el otro parecía sin facturar. | **Corregido**: sale de `project_quote_billing_summary`. |
| Búsqueda de trabajos por N° de documento (`list_projects`) | `project_id` | Solo encontraba el trabajo mayor. | **Corregido** (migración 2). |
| Libro de recurrentes de los reportes | `sales_document_id` | Correcto en total (el ciclo no suma ingreso si tiene factura), mes = factura principal. | **Migrado** a asignaciones (mes = primera factura confirmada). |
| Deuda, totales del tablero del mes y de cada servicio | ninguna (usaban `amount`) | **Mostraban el esperado**, no lo facturado: un período facturado por otro monto o con 2 facturas (una pagada) mostraba la deuda equivocada. | **Corregido**: `cycleMoney` usa lo facturado impago (`unpaid_amount`). |
| Estado del período (`refresh_recurring_service_occurrence_billing`) | `status` | Hallazgo 4: período con una factura pagada que recibe otra impaga quedaba "cobrado" y salía de Deuda. | **Corregido** (migración 4). |
| Tarjeta del tablero | `sales_document_id` | Mostraba solo la factura principal. | Muestra "+N más" con enlace al período. |

Otros lectores revisados, sin problema de montos: `link_recurring_service_occurrence_to_invoice`, `match_recurring_service_occurrences_to_invoices` y "Revisar vínculo" usan `sales_document_id` como "tiene factura"; `import_nubox_documents_batch`, `create_sales_document`, `update_sales_document`, `create_manual_sale_without_invoice` y `link_sales_document_to_project` lo **escriben** (el trigger puente crea la asignación); el export CSV muestra el nombre del trabajo principal; `getSalesDocuments` (dal) no tiene llamadores.

### Qué sigue dependiendo de las columnas (no se pueden borrar todavía)

1. **Notas de crédito**: nunca se asignan; su trabajo es `sales_documents.project_id` (reportes y lista lo leen como respaldo).
2. **Documentos sin asignación confirmada** (solo sugerencias, o anteriores al backfill): reportes y lista caen a `project_id`.
3. **Ciclos vinculados a la manera vieja** sin asignación (factura sin saldo libre al vincular): el libro de recurrentes cae a `sales_document_id`.
4. **Vinculación y matching legados** (`link_recurring_service_occurrence_to_invoice`, `match_recurring_service_occurrences_to_invoices`, "Marcar facturado con factura", Pendientes → vincular a trabajo, import Nubox con trabajo): escriben las columnas y el trigger crea la asignación.

La sincronización queda activa. Para eliminarlas en una entrega futura:

1. Asignar las notas de crédito (asignación negativa o "anula a" la factura con su mismo reparto) y quitar el respaldo a `project_id` en `salesAttribution.ts`.
2. Pasar los escritores del punto 4 a `set_sales_allocations` y borrar los triggers `recurring_service_occurrences_sync_allocations` y `sales_documents_sync_project_allocation`.
3. Convertir los vínculos legados sin asignación en asignaciones (o marcarlos "sin factura") y quitar el respaldo del libro de recurrentes.
4. Cambiar `needsLinkReview`, la tarjeta y el export para leer la vista de resumen.
5. Recién entonces: `drop column` de `recurring_service_occurrences.sales_document_id` y `sales_documents.project_id`, con `sync_sales_document_project` y la parte de `refresh_…` que las escribe.

## Cotizaciones "Sin número" (placeholder)

No aparecen en: badges y conteo del trabajo, tablero kanban, asistente IA (`getProjectQuotesByProject` / `getProjectQuotes` las filtran), búsqueda de trabajos, ni la tabla "Facturado vs. cotizado" (lo facturado sin cotización se muestra en una línea aparte). En el editor de la factura se ofrecen como el trabajo ("Trabajo sin cotización"); un trabajo sin ninguna cotización también aparece y la interna se crea al guardar. No hay export ni reporte de cotizaciones.

## Pantallas

- **Servicios recurrentes → Períodos**: grilla servicio × mes desde sep 2026 con esperado (gris), facturado, estado y diferencia; dominios que renuevan en ≤ 60 días.
- **Período**: esperado / facturado / diferencia, cantidad (por unidad), pago manual, facturas asignadas, "Usar este monto como referencial de aquí en adelante".
- **Ventas → Asignar**: editor con saldo sin asignar, motivo de cada sugerencia, confirmar, sugerir destino, dominio al asignar hosting.
- **Ventas → Conciliar**: pendientes por mes, motivo y diferencia de las sugerencias, "Buscar sugerencias", confirmar sugeridas completas.
- **Trabajo**: "Facturado vs. cotizado" por cotización; alta de cotización con monto opcional.
- **Servicio (alta/edición)**: modo de precio, referencial opcional, por unidad; tipo Dominio.
- **Reparto licencias MS**: pondera por lo facturado de cada período (o el esperado si no se facturó).

## Decisiones tomadas

1. Se adaptó `recurring_service_occurrences` como tabla de períodos; la columna sigue siendo `period` y el esperado `amount`. La FK en `sales_allocations` es `recurring_service_period_id`.
2. `price` se renombró (no se duplicó) a `reference_amount`.
3. El costo de un dominio usa los campos de costo existentes (`fixed_monthly_cost`, ×12 en anuales).
4. `project_quotes.quoted_amount` nuevo; si falta, la cotización principal usa `projects.quoted_amount` (no se tocó `projects`).
5. La sugerencia pasó de SQL a TypeScript para tener una sola implementación con tests unitarios; la tolerancia del 15 % se mide sobre el neto de la factura.
6. "Con saldo" para las reglas 2 y 3: lo que le falta al período tiene que ser al menos el 15 % de su esperado (un resto menor es una diferencia de precio, no lugar para otra factura). La regla exacta sí usa cualquier saldo.
7. La regla 4 exige que el mes no tenga ningún período abierto del cliente; si hay varios que no cuadran, no se sugiere nada (no cae a cotización).
8. Reparto a áreas: la parte de una factura asignada a un servicio va al área del servicio; lo no asignado, al área del documento.
9. "Pagado": todas las facturas confirmadas pagadas. Un período cobrado a mano se mantiene cobrado solo si ninguna de sus facturas está pagada; "Cobrado"/"Deshacer cobrado" con facturas marca esas facturas.

## Para llevarlo a prod

Igual que antes, con las 4 migraciones juntas:

1. Desplegar migraciones y código a la vez (el código nuevo lee `reference_amount` y ya no llama a `suggest_sales_allocations`; la app desplegada lee `price`).
2. Simular las 4 migraciones en prod dentro de `begin; …` + bloque `DO` con `RAISE` de conteos y revisar: documentos sobre-asignados = 0, vínculos sin asignación = 0, períodos re-derivados por la migración 4.
3. `supabase db push` con el CLI enlazado a prod, merge `dev` → `main`, verificar el deploy de Vercel.
4. Probar a mano: Períodos, una factura en Ventas → Asignar (motivo visible), Conciliar del mes, una importación de Nubox repetida (no debe duplicar sugerencias) y el reporte de rentabilidad de un trabajo con una factura repartida.

El ensayo con datos de prod (abajo) ya cubrió los puntos 2 y 4 sobre una copia fiel: se puede pasar directo al 3. El tope de la regla 2 es código (sin migración), así que no cambia los pasos.

## Ensayo con datos de prod (2026-10-16/17)

**Cómo se hizo.** Prod (`inma-erp-sa-east-1`) solo se leyó: `supabase db query --linked --project-ref <prod>` con SELECTs (`json_agg` por tabla); el link de la CLI quedó siempre en dev. Prod tenía 63/63, última `20261014010000`, como se esperaba. Sin `pg_dump` ni Docker en la máquina, los dumps son JSON:

- Backup de dev antes de empezar: `G:\INMA-ERP-dumps\dev-backup-2026-10-17\data.json` (todas las tablas de `public` + `auth.users`/`auth.identities`; el esquema es el del repo en `cef728b`, 67 migraciones).
- Dump de prod: `G:\INMA-ERP-dumps\prod-2026-10-17\` (`data.json`, `counts.json`, `restore.sql`, fotos antes/después). Tienen datos reales, incluidos los hashes de contraseña de los usuarios: no están en el repo.

Dev se reseteó a `20261014010000` sin seed (`db reset --linked --version`, 16 s; el reset también vació `auth.users`, así que no hubo choques de usuarios) y se cargó el dump en una transacción con `session_replication_role = replica` (9 s), secuencias ajustadas al máximo.

**Conteos prod vs. dev:** iguales en las 40 tablas (`public` + `auth.users`/`identities` + `storage`), salvo `mcp_access_tokens`, excluida a propósito: **prod tiene 1 fila ahí** (se esperaba vacía). `mcp_pending_drafts` = 0. `cost_document_attachments` = 0 y `storage.objects` = 0: no hay adjuntos que copiar.

**Tiempos del deploy** (`supabase db push --linked`, las 4 en un solo push, como en prod): 0,67 s en total — `20261016010000` 0,40 s, `20261017010000` 0,10 s, `20261017020000` 0,09 s, `20261017030000` 0,08 s.

**Backfill:**

| Verificación | Resultado |
|---|---|
| Vínculos legados | 34 ciclo↔factura (sobre 32 facturas; una de 90 cubre 3 ciclos de 30) + 6 factura↔trabajo |
| `sales_allocations` creadas | 40 confirmadas (34 a períodos, 6 a cotizaciones), 38 facturas — igual a los vínculos |
| Sobre-asignadas | 0 |
| Vínculos sin asignación | 0 ciclo↔factura, 0 factura↔trabajo |
| Cotizaciones internas (placeholder) | 3 (trabajos con factura y sin cotización) |
| Con saldo sin asignar | 149 facturas de Chile, 71.881.299 CLP (historial no vinculado); Uruguay 0 |
| Períodos desde sep 2026 | 10 → 18 (+8 generados: oct y nov). sep: 6 pendientes, 1 se debe, 2 pagados; oct: 8 pendientes; nov: 1 pendiente |
| Estados de ciclos | cobrados 25 → 28, facturados 11 → 8, pendientes 57 → 65 |
| Ventas netas por mes y empresa | **idénticas** (23 combinaciones empresa/moneda/mes) |
| Rentabilidad por trabajo 2026 | **idéntica** (no hay facturas repartidas en prod) |

**Diferencias explicadas** (todas esperables):

- **Ciclos facturados → cobrados (+3, Uruguay USD 15 + 15 + 279,1):** estaban "facturados" con su factura ya pagada en Nubox; el backfill deriva el estado de la factura. Por eso "Uruguay USD facturado 309,1" sale de Deuda.
- **Deuda Chile facturado 1.003.248 → 986.800 (−16.448):** Deuda pasa a usar lo facturado impago: un ciclo esperaba 102.447 y se facturó 86.089 (−16.358); otro esperaba 79.990 y se facturó 79.900 (−90). Dos ciclos marcados a mano sin factura conservan su esperado.
- **Deuda "por facturar" Chile +2.478.429 y Uruguay +294,1:** son los 8 períodos que la migración generó (oct/nov) para los servicios activos — los mismos que el tablero crea al abrir esos meses.
- **Ingresos por área 2026, Chile:** 2.847.059 pasan de "(sin área)" a Hosting (458.500) y Microsoft (2.388.559): facturas sin área propia asignadas a servicios ahora caen en el área del servicio (donde ya estaba su costo).

**Sugerencias** (código real de la app sobre los datos, después borradas para que dev quede como recién desplegado): 45 facturas de Chile — 1 exacta, 2 cotización, **42 "único período del mes"**; Uruguay 0. De esas 42, solo 5 están dentro del 15 % del esperado y **22 difieren más del 50 %** (p. ej. 6.579.278 sugerida a un período de 470.595; 899.000 a uno de 24.900): clientes con servicios y también trabajos, donde la factura del mes es de un trabajo. No rompen datos (son sugerencias), pero ensucian Conciliar y pueden quitarle el período a la factura correcta del mismo lote. Mitigación aplicada: "Buscar sugerencias" en Conciliar trabaja solo sobre el mes en pantalla.

**Tope de la regla 2 (decidido después del ensayo):** solo sugiere si el neto es ≤ 2× lo esperado (`SINGLE_PERIOD_MAX_RATIO`). Vuelto a correr sobre los mismos datos: 39 facturas (1 exacta, 2 cotización, **36 único período**, antes 42). Ninguna supera 1,92× lo esperado; salieron las 6 que lo pasaban (la peor, 6.579.278 contra 470.595). Queda el caso opuesto: **13 de las 36 son de menos de la mitad del esperado** (p. ej. 30.000 contra 614.576), probablemente ventas sueltas al mismo cliente; un piso (p. ej. ≥ 0,5×) las filtraría. Las sugerencias se borraron otra vez después de medir.

**Suite de integración** contra dev con los datos de prod: 83 pasan, 9 omitidos (los de siempre). No dejó filas: los conteos de las 40 tablas quedaron idénticos a los de antes de correrla y ningún período de los datos de prod se modificó.

**Estado en que queda dev:** datos de prod + las 4 migraciones (67/67), sin sugerencias. El login es con los mismos usuarios y contraseñas de prod. La CLI quedó enlazada a dev.
