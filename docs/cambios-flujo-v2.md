# Cambios para alinear el ERP con el flujo de trabajo v2.5 (Chile)

> Documento para `docs/`. Resume cómo trabaja hoy inmasoft Chile (Nubox + Planner + Excel de ventas) y qué hay que cambiar en el ERP para reemplazar Planner y Excel. Revisado contra el repo en el commit `52a2983` (PR #118).

## 1. Cómo se trabaja (flujo acordado)

1. Se cotiza en **Nubox**. Cuando el cliente acepta, se da de alta el **trabajo** en el ERP con el N° de cotización (hoy se hace en Planner).
2. Durante la ejecución se cargan en el trabajo: costos (con foto o PDF), técnicos externos (monto acordado, abonos, boleta) y tareas o visitas.
3. Al terminar, el trabajo se factura en Nubox. Algunos clientes **no piden factura**: esas ventas se registran en el ERP con cobro manual.
4. **Cierre de mes**: se importa el CSV de documentos de Nubox (últimos N documentos, con estado de cobro conciliado con el banco; no incluye N° de cotización). Lo que ya existe se actualiza, no se duplica. Cada factura se vincula a su trabajo por saldo por facturar, o a mano. No se importan cotizaciones ni compras.
5. La factura de licencias Microsoft del proveedor llega por el total. En el cierre se ingresa ese total y se reparte entre los clientes con venta de Microsoft del mes, **en proporción a lo vendido**.
6. Los clientes con servicio mensual (Microsoft, hosting, Starlink, soporte) piden cotización mensual para su OC. No se modelan como contratos: el ERP recuerda qué cotizaciones enviar y permite repetir el trabajo del mes anterior.
7. Un trabajo se cierra solo cuando está cobrado, el técnico pagado y la boleta recibida.

Notas de crédito: no se gestionan como módulo, pero se importan y anulan automáticamente la factura que corrigen (ver 4.2).

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
| El importador trata como duplicado lo que ya existe. | Con el export de Nubox (últimos N documentos) casi todas las filas se marcarían duplicadas en cada carga. |

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

### 4.2 Importación de ventas de Nubox, estado de cobro y vista de ventas (reemplaza el Excel)

**Archivo de Nubox** (validado con un export real, `documentos_2026-09-19.csv`):
- CSV UTF-8, separador `;`, valores entre comillas, fechas `dd/mm/aaaa`, montos enteros sin separador de miles.
- Nubox no filtra por mes: exporta los últimos N documentos visibles (el ejemplo trae 50, del 02/07 al 14/09). **Subir un archivo con documentos que el ERP ya tiene va a ser lo normal**, no un error.

| Columna Nubox | Uso en el ERP |
|---|---|
| Fecha | `document_date` |
| Documento | Tipo: `FAC-EL` → factura, `N/C-EL` → nota de crédito. Cualquier otro valor: fila con error "tipo no soportado". |
| Folio | `document_number`. Clave del documento = empresa + tipo + folio. |
| Rut Cliente | Busca el cliente por `tax_id`, normalizando el RUT (sin puntos, guion y DV en mayúscula). Si no existe, se crea con el nombre del archivo. |
| Cliente | Solo para crear el cliente nuevo; no se usa para buscar. |
| Monto neto + Monto exento | Neto de gestión = neto + exento. |
| Monto IVA | `tax_amount`. |
| Monto impuestos | Otros impuestos; se guarda aparte, no suma al neto. |
| Monto total | `total_amount`. Validar neto + exento + IVA + impuestos = total; si no cuadra, fila con error. |
| Estado | Solo se importan filas `Emitido`. |
| Fecha vencimiento | `due_date`. Puede ser igual a la fecha de emisión (contado). |
| Estado de cobro | `BALANCED` → pagado, `TO_EXPIRE` → por vencer, `EXPIRED` → vencido, `NOT_APPLY` → no aplica (notas de crédito). Se guarda el valor de Nubox tal cual; no se recalcula. |
| Nº de Envío, Origen, Cedido | Se guardan como referencia; no afectan cálculos. |

**Datos**
- `sales_documents.document_number text`, `due_date date`, `payment_status text` (`pagado`, `por_vencer`, `vencido`, `no_aplica`, `pendiente`), `payment_status_updated_at`, `paid_at`, `payment_method`, `nubox_send_number`, `other_taxes`.
- Índice único parcial en `(company_id, document_type, document_number)` donde `document_number is not null`.
- `pendiente` es para ventas sin factura (sin vencimiento) y se marca a mano.

**Reimportación (upsert)**: cada fila se clasifica en la vista previa como:
- **Nueva** → se crea.
- **Ya existe, cambió el estado de cobro o el vencimiento** → se actualiza.
- **Ya existe, sin cambios** → se omite en silencio.
- **Ya existe con montos o cliente distintos** → no se toca; se marca "revisar" (no debería pasar en documentos emitidos).

La vista previa muestra un resumen ("12 nuevas · 9 con cobro actualizado · 29 sin cambios · 0 a revisar") y la tabla detallada solo de nuevas y a revisar. La regla vieja de duplicado por cliente + fecha + total queda solo para ventas manuales sin folio.

**Facturas pendientes fuera del archivo**: como el archivo cubre solo los últimos documentos, una factura vieja impaga deja de actualizarse. En los pendientes del cierre, listar facturas `por_vencer` o `vencido` con fecha anterior a la más antigua del último archivo importado, como "revisar cobro en Nubox", con opción de marcarlas pagadas a mano.

**Notas de crédito (manejo automático)**: no se llevan aparte, pero hay que importarlas porque se usan para anular facturas reemitidas. En el ejemplo, la FAC 2650 de $4.058.100 fue anulada por la N/C 358 y reemitida como FAC 2666 y 2681 de $2.029.050 cada una; si la N/C se ignora, las ventas de ese trabajo se cuentan dos veces.
- La N/C se empareja con la factura del mismo cliente, mismo neto y fecha anterior que no tenga N/C asociada. Si hay una sola candidata, se empareja sola; si hay varias (ej. Activo tiene varias facturas de $86.090), se elige de una lista.
- La factura emparejada queda `anulada_por_nc` y ambas se excluyen de ventas y reportes. Nada más: no hay pantalla de notas de crédito.
- Una N/C sin emparejar va a pendientes del cierre.

**Vinculación factura → trabajo** (el CSV no trae N° de cotización):
- Candidatos: trabajos del mismo cliente con saldo por facturar > 0 (monto cotizado − facturas ya vinculadas no anuladas).
- Si el neto coincide exacto con el saldo de un único trabajo, se pre-marca para confirmar. Si no, se elige de la lista (trabajos del cliente con saldo primero).
- Una factura va a un solo trabajo. El área de la factura se toma del trabajo.
- Las mensuales se resuelven solas con esta regla: el trabajo del mes anterior ya tiene saldo cero (ej. EBCO factura $49.900 casi todos los meses).
- Lo no vinculado queda "sin vincular" en los pendientes del cierre.

**Ventas sin factura**: desde el trabajo, "Registrar venta sin factura" crea un documento `manual` sin folio, con monto, fecha y `payment_status = pendiente`; se marca pagado a mano con fecha y medio.

**Vista de ventas**: listado con las columnas del Excel (fecha, folio, cliente, área, trabajo, neto, gasto, ganancia, margen %, estado de cobro), filtros por mes, área, cliente y cobro, y exportación a Excel. Si un trabajo tiene varias facturas, su gasto se reparte entre ellas en proporción al neto, para que la suma cuadre con el margen del trabajo.

**Aceptación**: importar `documentos_2026-09-19.csv` dos veces seguidas deja las mismas 47 facturas y 3 notas de crédito, sin duplicados; la segunda vez el resumen dice 0 nuevas. Las N/C 358 y la FAC 2650 quedan emparejadas y excluidas de ventas.

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
2. Vincular facturas a trabajos (sugeridas por cliente + monto neto para confirmar, el resto a mano).
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

### 4.8 Inicio de gestión (1/1/2026) y migración del histórico

**Fecha de inicio de gestión**: `companies.management_start_date`, para Chile `2026-01-01`. Desde esa fecha el ERP tiene datos completos (cada factura con trabajo, área y costo; N/C emparejadas) para poder hacer el cierre de año 2026. Lo anterior es histórico: suma en totales y reportes, pero no aparece en Pendientes ni pide trabajo, área o emparejamiento.

**Trabajos históricos automáticos**
- Acción de administración "Crear trabajos históricos" con rango de fechas (por defecto `management_start_date` → 30/09/2026, fin del mes en que empezó el tablero).
- Para cada factura del rango sin trabajo vinculado (no anulada, sin contar N/C), crea un trabajo con: nombre `Folio · Cliente`, cliente de la factura, estado `cerrado`, monto cotizado = neto de la factura, `is_historical = true`, y lo vincula.
- Idempotente: correrla dos veces no crea trabajos repetidos. Una factura que ya tiene trabajo no se toca.
- Los trabajos históricos no se muestran en el tablero por defecto (filtro "Incluir históricos"), pero sí en reportes y en la vista de ventas.

**Área y costo desde el Excel "FINANZAS INMASOFT 2026"** (enero a junio 2026, archivo en `local/`, no se versiona)
- Hoja única; encabezados en la fila 2. Columnas: Cliente, Pais, Moneda, Mes, Fecha (número de serie de Excel), Descripción (= área), Monto NETO, Gastos Neto, Ganancia, Documento, Pago. Hay filas vacías y filas de fórmulas al final: usar solo filas con Cliente.
- Solo filas con `Pais = CL`. Las de Uruguay se ignoran en esta tarea.
- Cruce con la factura importada de Nubox por folio: `Documento` viene como `FAC-EL-2533` → tipo factura, folio `2533`. Filas sin Documento o con un valor que no es folio (hay filas con el N° en Descripción) van a un reporte de "no cruzadas".
- Área: `Descripción` normalizada (sin espacios, mayúsculas/minúsculas) → área del ERP: Microsoft, Web, Instalación, Hosting, Visita, Starlink, Soporte, Cloud. Crear las áreas que falten.
- **Folio repetido en varias filas**: si la suma de `Monto NETO` de esas filas coincide con el neto de la factura, es una factura con varias áreas: el trabajo toma el área de la fila de mayor neto y el costo es la suma de `Gastos Neto`. Si no coincide, es una fila copiada: se usa la fila cuyo neto coincide con la factura y el resto va al reporte de "no cruzadas".
- Costo: `Gastos Neto` se carga como una línea de costo "Costo histórico (Excel)" del trabajo, confirmada, en la fecha de la factura. `Gastos Neto` vacío → sin línea de costo; el trabajo queda marcado "costo faltante".
- Si el neto del Excel no coincide con el de Nubox, se usa el de Nubox (manda el documento) y la fila va al reporte como diferencia.
- `Pago` del Excel no se usa: el estado de cobro viene de Nubox.
- Resultado: pantalla o CSV con cruzadas, no cruzadas, diferencias de monto y trabajos con costo faltante.

**Julio a septiembre 2026**: no hay Excel. Los trabajos históricos de esas facturas quedan sin área y aparecen en Pendientes con "Asignar área", que permite aplicarla a todas las facturas sin área de un mismo cliente de una vez. El costo queda faltante salvo que se cargue a mano.

**Notas de crédito**: las de 2026 sin emparejar van a Pendientes. Las anteriores a 2026 no.

**Pendientes**: filtrar todo por `document_date >= management_start_date`. "Revisar cobro en Nubox" pasa a ser por antigüedad: facturas `vencido` con más de 60 días desde el vencimiento, en vez de compararlas con la fecha más antigua del último archivo.

**Aceptación**: después de correr la migración, ventas de enero a junio 2026 por área coinciden con la suma por Descripción del Excel (filas CL cruzadas); ninguna factura de 2026 queda sin trabajo; Pendientes no muestra nada anterior a 2026.

**Tablero**: los trabajos de Planner abiertos se cargan a mano como trabajos activos (sin cambios respecto a antes).

### 4.9 Documentación

- `manual-usuario.md`: gasto rápido disponible en Chile; nuevas secciones de tablero, técnicos, cierre de mes y estado de pago.
- `prd.md`: el estado de cobro de ventas pasa a estar en alcance (solo estado, sin bancos).
- `decisiones-abiertas.md`: reparto Microsoft resuelto (proporcional a la venta neta del mes).

## 5. Pendiente de confirmar

- Cuántos documentos permite mostrar Nubox por página (define cuántos meses de cobro se actualizan por archivo).
