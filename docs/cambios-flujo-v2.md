# Cambios para alinear el ERP con el flujo de trabajo v2.5 (Chile)

> Documento para `docs/`. Resume cómo trabaja hoy inmasoft Chile (Nubox + Planner + Excel de ventas) y qué hay que cambiar en el ERP para reemplazar Planner y Excel. Revisado contra el repo en el commit `52a2983` (PR #118).

## 1. Cómo se trabaja (flujo acordado)

1. Se cotiza en **Nubox**. Cuando el cliente acepta, se da de alta el **trabajo** en el ERP con el N° de cotización (hoy se hace en Planner).
2. Durante la ejecución se cargan en el trabajo: costos (con foto o PDF), técnicos externos (monto acordado, abonos, boleta) y tareas o visitas.
3. Al terminar, el trabajo se factura en Nubox. Algunos clientes **no piden factura**: esas ventas se registran en el ERP con cobro manual.
4. **Cierre de mes**: se importa el CSV de **ventas** de Nubox (incluye estado de pago, conciliado con el banco). No se importan cotizaciones ni compras.
5. La factura de licencias Microsoft del proveedor llega por el total. En el cierre se ingresa ese total y se reparte entre los clientes con venta de Microsoft del mes, **en proporción a lo vendido**.
6. Los clientes con servicio mensual (Microsoft, hosting, Starlink, soporte) piden cotización mensual para su OC. No se modelan como contratos: el ERP recuerda qué cotizaciones enviar y permite repetir el trabajo del mes anterior.
7. Un trabajo se cierra solo cuando está cobrado, el técnico pagado y la boleta recibida.

Fuera de interés: notas de crédito (el modelo las soporta; no hace falta tocarlas).

## 2. Qué ya está bien y se mantiene

- Empresas, clientes, proveedores, áreas, RLS y roles.
- Ventas con neto/IVA/total, anulación con trazabilidad y vínculo a proyecto.
- Importador de ventas con mapeo, vista previa, lote e historial.
- Costos con asignaciones (`cost_allocations`), gasto rápido desde el celular con foto y estado provisorio/confirmado. El gasto rápido ya funciona en Chile (el manual dice "solo Uruguay"; hay que corregir el manual).
- Costo pendiente vs. cero confirmado.
- Reportes: resultado mensual, rentabilidad por cliente/proyecto/área, consolidado USD y drill-down.
- Importación de compras: se deja como está, aunque en el flujo actual no se usa.

## 3. Problemas encontrados en el código actual

| Problema | Impacto |
|---|---|
| `sales_documents` no tiene N° de documento (folio). La detección de duplicados usa cliente + fecha + total. | Falsos duplicados: FAC-EL-2551 y 2552 (mismo cliente, fecha y monto en enero) chocan. No hay forma de vincular por folio. |
| "Generar" en servicios recurrentes crea la venta del mes. | Si además se importa la factura de Nubox, la venta queda **duplicada**. |
| `projects.status` solo tiene `active`, `on_hold`, `closed`. | No alcanza para reemplazar el tablero de Planner. |
| Proyectos sin N° de cotización. | No se puede dar de alta el trabajo como hoy ni vincular la factura al importar. |
| `personnel` solo admite `employee` y `partner`, con costo mensual. | No cubre técnicos externos pagados por trabajo, con abonos y boleta. |
| Ventas sin estado de pago. | No reemplaza la columna "Pago" del Excel ni permite el cierre automático. |

## 4. Cambios, en orden de prioridad

### 4.1 Trabajo con cotización y tablero (reemplaza Planner)

**Datos**
- `project_quotes` (`project_id`, `company_id`, `quote_number`): un trabajo puede tener varias cotizaciones (ej. 1674 y 1691). Único por `company_id + quote_number`.
- `projects.status`: `por_cotizar`, `en_ejecucion`, `en_espera`, `finalizado`, `cerrado`, `cancelado`. Migrar `active → en_ejecucion`, `on_hold → en_espera`, `closed → cerrado`.
- `projects.invoiceable boolean default true` ("¿se factura?"). `clients.invoiceable boolean default true`: si el cliente es "sin factura", sus trabajos nacen con `false`.
- `projects.quoted_net_amount` (reusar `budget` si se prefiere) y `projects.hold_reason text`.
- `clients.monthly boolean`: cliente con servicio mensual.

**Pantallas**
- Alta de trabajo en una pantalla usable en celular: N° de cotización (obligatorio salvo en `por_cotizar`), cliente (buscador, alta rápida con nombre y RUT), descripción, área, monto neto cotizado, moneda, técnicos opcionales.
- Tablero kanban por estado, con filtro por área y responsable. Cada tarjeta muestra área, N° de cotización e indicadores: facturación, cobro, pago al técnico y boleta.
- Botón "Repetir del mes anterior" en trabajos de clientes mensuales: copia todo y pide solo el N° de cotización nuevo y el monto.

**Aceptación**: se puede cargar un trabajo nuevo desde el celular en menos de un minuto, y todas las tarjetas abiertas del Planner caben en el tablero sin perder información.

### 4.2 Folio, cotización y estado de pago en ventas (reemplaza el Excel)

**Datos**
- `sales_documents.document_number text` (folio). Duplicado = `company_id + document_type + document_number`; mantener cliente + fecha + total solo como aviso cuando no hay folio.
- `sales_documents.quote_reference text`.
- `sales_documents.payment_status` (`pendiente`, `pagado`), `due_date`, `paid_at`, `payment_method`.
- Vencido se calcula: `pendiente` con `due_date < hoy`.

**Importador**: mapear folio, referencia de cotización, estado de pago y vencimiento. Reimportar un mes actualiza el estado de pago de las facturas ya cargadas en vez de marcarlas duplicadas.

**Vinculación**: al importar, la factura se une al trabajo por `quote_reference = project_quotes.quote_number`. Si no hay match, sugerir por cliente + monto neto cotizado; si no, queda "sin vincular".

**Ventas sin factura**: desde el trabajo, "Registrar venta sin factura" crea un documento `manual` con monto y cobro marcado a mano.

**Vista de ventas**: listado con las columnas del Excel (fecha, factura, cliente, área, trabajo, neto, gasto, ganancia, margen %, pago), filtros por mes, área, cliente y pago, y exportación a Excel.

### 4.3 Técnicos externos

**Datos**
- `personnel.type`: agregar `contractor`. Agregar `tax_id`, `payment_document` (`boleta_honorarios`, `factura`), `default_rates jsonb` (visita, hora, punto de red) y datos de pago.
- `technician_charges` (`project_id`, `personnel_id`, `description`, `amount`, `vat_included boolean`, `net_amount`, `document_status` `pendiente`/`recibida`). Entra como costo directo del trabajo.
- `technician_payments` (`personnel_id`, `date`, `amount`, `method`) + `technician_payment_applications` (`payment_id`, `charge_id`, `amount`): un pago o abono puede cubrir varios cargos.

**Pantallas**: ficha del técnico con cuenta corriente (cargos, abonos, saldo, boletas pendientes) y registro de un pago que cubre varios trabajos.

**Regla**: `work_allocations` queda para empleados y socios con costo mensual. Los técnicos externos no pasan por ahí.

### 4.4 Cierre de mes

Asistente en `/companies/{id}/close/{period}`:

1. Importar CSV de ventas (reusa el importador).
2. Vincular facturas a trabajos (automáticas + sugeridas para confirmar).
3. Estado de pago actualizado (sale del paso 1).
4. **Reparto Microsoft**: ingresar el total de la factura del proveedor. Se crea un `cost_document` y `cost_allocations` a cada trabajo (o cliente, si no hay trabajo) con venta del área Microsoft en el período, en proporción a su venta neta. Si ya existe para el período, se recalcula.
5. Pendientes: facturas sin vincular, trabajos sin costo, ventas sin factura sin cobrar, cargos de técnico por pagar.
6. Cerrar el mes: `period_closures` (`company_id`, `period`, `closed_by`, `closed_at`). Un mes cerrado no admite cambios en ventas ni costos de ese período sin reabrirlo.

### 4.5 Cierre automático del trabajo

Un trabajo en `finalizado` pasa a `cerrado` cuando: todas sus ventas están `pagado`, todos sus `technician_charges` están saldados y con documento `recibida`, y no quedan gastos provisorios. Recalcular al importar ventas, registrar pagos o marcar boletas.

### 4.6 Servicios recurrentes

- Desactivar "Generar" para empresas con importación de ventas (Chile), para no duplicar lo que viene de Nubox.
- Al inicio de cada mes, mostrar en el panel la lista de clientes mensuales con la cotización del mes todavía no cargada.

### 4.7 Tareas del trabajo

`project_tasks` (`project_id`, `title`, `done`, `done_at`, `assigned_to`): checklist de visitas, marcable desde el celular. Reemplaza los checklist del Planner (ej. "Soporte Trei septiembre 0/4").

### 4.8 Migración

- Importar las ventas ene–jun 2026 del Excel "FINANZAS INMASOFT 2026" como historial: una venta por fila con su área y el gasto como una línea de costo, trabajos en `cerrado`.
- Marcar para revisión las filas con folio repetido (FAC-EL-2533, 2568, 2580, 2608: filas copiadas).
- Tomar el estado de pago del export de Nubox, no de la columna Pago del Excel.
- Cargar las tarjetas abiertas del Planner como trabajos activos.

### 4.9 Documentación

- `manual-usuario.md`: gasto rápido disponible en Chile; nuevas secciones de tablero, técnicos, cierre de mes y estado de pago.
- `prd.md`: el estado de cobro de ventas pasa a estar en alcance (solo estado, sin bancos).
- `decisiones-abiertas.md`: reparto Microsoft resuelto (proporcional a la venta neta del mes).

## 5. Pendiente de confirmar

- Columnas exactas del CSV de ventas de Nubox, en particular si trae el N° de cotización como referencia. Sin ese dato, la vinculación del paso 4.2 queda solo por sugerencia de cliente + monto.
