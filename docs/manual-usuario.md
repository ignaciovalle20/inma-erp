# Manual de usuario — INMA ERP

> Esta guía explica **qué hace la aplicación y cómo se usa**, módulo por módulo, para cualquier persona de Inmasoft que necesite cargar datos o leer reportes. Para el detalle de requisitos y decisiones de producto ver [`prd.md`](prd.md); para el detalle técnico (base de datos, seguridad) ver [`architecture.md`](architecture.md).

## 1. Qué problema resuelve

Inmasoft factura en Chile y Uruguay, pero antes de este ERP no existía un cálculo único y confiable de **cuánto gana realmente cada mes** ni **cuánto margen deja cada cliente, proyecto o área de negocio**. El sistema no reemplaza la contabilidad tributaria ni maneja bancos/cobros — su único propósito es ser la **fuente de verdad del resultado de gestión**: ventas netas, costos, margen y resultado operativo, con trazabilidad completa hasta el documento de origen.

## 2. Conceptos clave (glosario)

Estos conceptos aparecen en todas las pantallas de reportes; entenderlos es la base para leer cualquier número del sistema.

| Concepto | Qué significa |
|---|---|
| **Ventas netas** | Importe de las ventas sin impuestos recuperables (el IVA se guarda pero nunca cuenta como ganancia). |
| **Costo directo** | Costo atribuible a una venta o proyecto concreto (ej. un proveedor contratado para ese trabajo). |
| **Costo general** | Gasto de estructura de la empresa que no pertenece a un proyecto puntual (ej. arriendo, costo de personal no asignado). |
| **Margen directo** | Ventas netas − costos directos. |
| **Resultado operativo** | Margen directo − costos generales del período. Es el número principal de "cuánto ganó la empresa ese mes". |
| **Costo pendiente vs. costo cero confirmado** | Un proyecto **sin costo cargado** no es lo mismo que un proyecto **con costo cero real**. El sistema distingue ambos estados explícitamente para que un dato faltante nunca se lea como ganancia. |
| **Documento anulado (`voided`)** | Una venta se corrige anulándola (con fecha y usuario registrados), nunca borrándola: los reportes la excluyen pero el historial queda. |
| **Período de reconocimiento** | El mes al que se le atribuye una venta o costo. Por defecto es el mes de la fecha del documento, pero se puede reasignar manualmente (proyectos que cruzan varios meses). |
| **Asignación de costo (`cost_allocations`)** | Repartir un mismo costo entre varios proyectos/clientes/áreas, por porcentaje o por monto fijo. |
| **Trabajo** | Forma coloquial de referirse a un **proyecto**: la unidad que agrupa la venta y los costos de una operación concreta con un cliente. Es el mismo registro de la sección 6, no una entidad nueva. |
| **Gasto provisorio vs. confirmado** | Un gasto cargado a ojo desde el celular (carga rápida) entra como **provisorio**; queda **confirmado** cuando se carga con el formulario completo o cuando una factura importada lo respalda. |
| **Vínculo de importación** | Al importar una factura de compra, apuntarla a un gasto provisorio ya existente en vez de crear un documento nuevo — actualiza ese gasto con los datos reales y lo confirma, sin duplicarlo. |

## 3. Ingreso y navegación

- **Login**: correo y contraseña (Supabase Auth). No hay autorregistro visible; los usuarios se crean/asocian a empresas desde el backend.
- Después de iniciar sesión, la app redirige a **`/companies`**: la lista de empresas a las que el usuario tiene acceso.
- Cada usuario tiene un **rol por empresa** (`admin` o miembro). Los roles no admin pueden ver y cargar datos, pero no editar la configuración inicial, como Empresas o Áreas de negocio (los enlaces "Editar"/"Nueva área" solo aparecen para `admin`).
- Al entrar a una empresa, el menú lateral da acceso a sus módulos, en tres grupos: **Gestión** (Resumen/Panel de control, Ventas, Costos, Proyectos y Servicios recurrentes), **Análisis** (reportes) y **Configuración** (Clientes, Proveedores, Áreas de negocio y Personal).
- Arriba de cada pantalla con datos mensuales hay un **selector de período** (mes/año) que reconstruye toda la vista para ese mes.

## 4. Empresas

- `/companies`: lista de empresas del usuario, con país, moneda y rol.
- Cada empresa (hoy: **Inmasoft Chile**, moneda CLP, y **Inmasoft Uruguay**, moneda UYU) tiene su propia moneda base, datos fiscales y estado activo/inactivo.
- Todo lo que se carga (ventas, costos, clientes, proyectos) pertenece a una única empresa — no hay mezcla de datos entre Chile y Uruguay salvo en el reporte consolidado (sección 9.4).
- Solo un `admin` puede crear o editar una empresa.

## 5. Configuración inicial

Antes de cargar ventas o costos hace falta tener cargados estos datos base de la empresa:

| Dato | Para qué sirve | Notas |
|---|---|---|
| **Clientes** | Ficha única por cliente, evita duplicar nombres y permite consolidar su rentabilidad. | Estado activo/inactivo; solo clientes activos aparecen al cargar una venta nueva. |
| **Proveedores** | Ficha única por proveedor de costos/gastos. | Igual lógica de activo/inactivo. |
| **Áreas de negocio** | Clasificación configurable del tipo de servicio (Microsoft 365, hosting, desarrollo, soporte TI, redes, seguridad/CCTV, GPS, energía solar, otros). | Toda venta y proyecto se etiqueta con un área para poder ver rentabilidad por línea de negocio. |
| **Proyectos** | Agrupa ventas y costos de un trabajo concreto, con cliente, área, estado (`activo` / `en pausa` / `cerrado`), cotización, presupuesto de costo y responsable. | Es la unidad más granular de rentabilidad; ver sección 6. |
| **Personal** | Personas (empleados o socios) cuyo costo mensual se puede asignar a proyectos. | Tipo `employee` o `partner`; el costo del propio trabajo del socio también se puede cargar aquí. |

## 6. Proyectos y su estado de costo

La pantalla **Proyectos** (`/companies/{id}/projects`) muestra, para el período elegido, un semáforo por proyecto:

- **Con costos**: ya tiene al menos un costo cargado ese mes.
- **Cero confirmado**: alguien confirmó explícitamente que ese proyecto no tuvo costo real ese mes (botón "Confirmar cero").
- **Pendiente**: todavía no se cargó ningún costo y tampoco se confirmó cero — el panel de control avisa cuántos proyectos están en este estado, porque el resultado del mes puede bajar cuando se complete la carga.

Cada proyecto guarda dos montos: la **cotización** (lo que se le vende al cliente, neto; contra ella se calcula el saldo por facturar al importar Nubox) y el **presupuesto de costo** (lo que se espera gastar). En el reporte de rentabilidad y en el panel, el desvío compara el **costo acumulado** del trabajo, convertido a la moneda de la empresa, con el presupuesto de costo; un trabajo sin presupuesto de costo muestra "Sin presupuesto". (Hasta el 2026-10-04 había un solo campo, `budget`, que se usaba para las dos cosas: su valor pasó a la cotización.)

## 7. Ventas

### 7.1 Alta manual (todas las empresas)

`/companies/{id}/sales/new`: formulario completo — tipo de documento (factura, recibo, nota de crédito, manual), cliente, proyecto y área asociados, fecha, moneda, importe neto/IVA/total.

### 7.2 Carga rápida (solo Uruguay)

`/companies/{id}/sales/quick`: formulario reducido pensado para el uso diario en Uruguay, donde no hay importación automática. Requiere tener al menos un cliente y un área de negocio activos; si la empresa no es de moneda UYU, la app redirige directo al formulario completo.

### 7.3 Importación CSV/Excel (solo Chile)

`/companies/{id}/sales/import`: solo disponible para empresas con país Chile. Flujo de 3 pasos:

1. **Subir archivo** — se procesa en el navegador (no se guarda el archivo original).
2. **Mapear columnas** — se indica qué columna del archivo corresponde a fecha, cliente, importe, moneda e IVA (el sistema intenta auto-detectar por el nombre de encabezado).
3. **Vista previa y confirmación** — se muestra cada fila, marcando como *posible duplicado* las que coinciden en cliente + fecha + monto con una venta ya cargada. La importación real se hace fila por fila: las filas válidas se cargan aunque otras tengan error, y se puede forzar la carga de una fila marcada como duplicada si corresponde.

El **historial de importaciones** (`/companies/{id}/sales/import-history`) lista cada lote con su archivo de origen, quién lo importó y cuántas filas se importaron, fallaron o se detectaron como duplicadas — clave para la trazabilidad exigida por el negocio.

### 7.4 Edición, anulación y filtros

- Toda venta se puede editar, con historial de cambios.
- "Eliminar" una venta en realidad la **anula** (`voided`): queda registrada con fecha y usuario, pero se excluye de todos los reportes.
- El listado de ventas admite filtros por fecha, cliente, proyecto y área — son los mismos filtros que usa el "drill-down" desde los reportes (sección 9).

## 8. Costos y gastos

`/companies/{id}/costs`: alta manual de costos y gastos, con:

- **Clasificación**: `directo` (atribuible a un proyecto/venta puntual) o `general` (gasto de estructura de la empresa).
- **Asignación (`cost_allocations`)**: un mismo costo puede repartirse entre varios proyectos, clientes o áreas, por porcentaje o por monto fijo — para gastos compartidos que no pertenecen a un solo proyecto.
- Filtros por fecha, proyecto y clasificación, y un filtro rápido de **"costos generales sin asignar"** para encontrar gastos que todavía no se distribuyeron (una factura asignada a servicios recurrentes ya no aparece ahí, sección 8.5).
- **Sugerir asignaciones**: asigna las facturas de compra del mes en pantalla a los períodos de costo de los servicios recurrentes de su proveedor (sección 8.5).
- **Reparto licencias MS** (`/companies/{id}/costs/ms-licenses`, botón en la pantalla de Costos): se carga el **monto neto (sin IVA)** de la factura del proveedor de licencias de un período (debajo del campo se ve el total con IVA, 19 % en Chile y 22 % en Uruguay, solo como referencia: no se guarda) y se reparte entre los servicios recurrentes de ese tipo, proporcional a lo que se le factura a cada cliente.

### 8.1 Carga rápida desde un Trabajo (mobile, solo Uruguay)

`/companies/{id}/projects/{projectId}` es la pantalla de detalle de un Trabajo (proyecto): venta, costos y margen acumulados, más los últimos gastos cargados. Desde ahí, el botón **"+ Agregar gasto"** (`/companies/{id}/projects/{projectId}/quick-expense`) abre un formulario mínimo pensado para cargar desde el celular en el momento: solo **monto y categoría** (equipos, materiales, traslados, mano de obra, otros) son obligatorios; descripción, fecha (por defecto hoy) y foto del comprobante son opcionales. El costo queda siempre `directo` para ese Trabajo. Igual que la carga rápida de ventas, solo está disponible para empresas de moneda UYU.

### 8.2 Estado provisorio/confirmado y comprobante

Un gasto cargado por el formulario rápido entra con estado **provisorio** (fue una carga a ojo desde el campo); uno cargado por el formulario completo, o ya vinculado a una factura real, queda **confirmado**. La lista de gastos de un Trabajo marca cada uno con su estado y avisa cuando un provisorio todavía no tiene comprobante adjunto. La foto (opcional) se sube a un storage privado, accesible solo para miembros de la misma empresa.

### 8.3 Todo a un Trabajo vs. dividir el costo

Al cargar un costo desde el formulario completo (`/companies/{id}/costs/new`) se elige entre **"Todo a este trabajo"** (costo directo, un único proyecto) o **"Dividir costo"** (costo general): esta segunda opción lleva directo a la pantalla de asignación (`/companies/{id}/costs/{id}/allocate`) para repartirlo entre dos o más proyectos, clientes o áreas. Un costo que quedó sin asignar (por ejemplo, una factura importada) se puede resolver de la misma forma después: **"Asignar a un trabajo"** (`/companies/{id}/costs/{id}/assign`) para imputarlo entero a uno solo, "Dividir" para repartirlo, o **"Asignar a servicios"** (sección 8.5) si es la factura del proveedor de servicios recurrentes.

### 8.4 Importación de facturas de compra (todas las empresas)

`/companies/{id}/costs/import`: mismo flujo de 3 pasos que la importación de ventas (sección 7.3), pero para facturas de compra — mapeo de proveedor, fecha, importe neto, IVA y moneda. Está disponible para todas las empresas (Chile y Uruguay); la moneda de cada fila sigue la configuración de la empresa. Un proveedor del archivo que no coincide con ninguno existente se crea automáticamente (o se puede redirigir a mano a uno ya existente, para evitar duplicados).

Cada factura importada queda, por defecto, como un costo **general sin asignar** — el archivo no trae información de a qué Trabajo corresponde, así que se asigna después (sección 8.3) igual que cualquier otro costo general. Si el proveedor tiene servicios recurrentes, al terminar la importación el sistema intenta asignar cada factura a los períodos de costo de esos servicios (sección 8.5) y el resumen dice cuántas quedaron asignadas y cuántas sugeridas.

### 8.5 Facturas de compra de servicios recurrentes

Una factura de compra que es el costo de servicios recurrentes (el proveedor de Starlink, del hosting, del dominio…) se asigna a los **períodos de costo** de esos servicios (sección 9.1). Esa parte de la factura pasa a ser el costo real de cada servicio y deja de ser un costo general: no aparece en "costos generales sin asignar" ni se cuenta dos veces en los reportes. Una factura asignada a servicios no puede además asignarse a un trabajo, dividirse ni entrar en el reparto de licencias MS.

- **A mano:** en el detalle del costo (`/companies/{id}/costs/{id}`) o en la lista de costos, **"Asignar a servicios"** (`/companies/{id}/costs/{id}/services`). La pantalla trae precargados los períodos del mes de la factura de los servicios de ese proveedor (repartiendo el neto según el costo esperado de cada uno); se pueden cambiar montos, agregar otros servicios o quitar todos. La suma nunca puede superar el neto de la factura. También se llega desde el servicio: en su historial de costos, **"Asignar factura"** muestra las facturas de su proveedor de ese mes.
- **Automático:** al importar facturas de compra, al cargar un costo general a mano, al generarse períodos de costo, con **"Buscar sugerencias"** en Conciliar y con **"Sugerir asignaciones"** en la lista de costos (sobre el mes en pantalla). Se comparan facturas y períodos del **mismo proveedor, mes y moneda**:
  1. **Monto exacto:** una factura igual al costo esperado de un único período → se asigna y confirma.
  2. **Lote de montos iguales:** varias facturas del mismo monto y la misma cantidad (o más) de períodos con ese costo esperado → una factura a cada período, confirmadas; las que sobran quedan sin asignar.
  3. **Proporcional:** si una factura cubre exactamente la suma de varios períodos, se reparte por su costo esperado y se confirma; si no cuadra pero es la única factura del proveedor ese mes, se reparte igual y queda **sugerida**.
  4. Si nada de eso aplica, no se sugiere nada.
- Las **sugerencias** pendientes aparecen en **Ventas → Conciliar** (sección "Facturas de compra sugeridas a servicios"), con **Confirmar**, **Descartar** y **Confirmar todas**. Mientras no se confirma, el período sigue contando su costo esperado.

**Vínculo sin duplicar:** si un gasto ya se cargó a mano desde el celular (carga rápida, sección 8.1) y después llega la factura real de esa misma compra, la pantalla de importación permite, por cada fila, elegir **"¿Corresponde a un gasto ya cargado?"** y apuntar al gasto provisorio correspondiente. En ese caso la importación no crea un documento nuevo: actualiza el gasto existente con el monto, la fecha y el proveedor reales, lo marca como confirmado, y conserva el Trabajo al que ya estaba imputado. La detección automática de duplicados (misma lógica que ventas: proveedor + fecha + importe) sigue funcionando para el resto de las filas.

## 9. Servicios recurrentes y personal

### 9.1 Servicios recurrentes

Menú **Gestión → Servicios recurrentes** (`/companies/{id}/recurring-services`): contratos de cobro periódico (ej. Microsoft 365, hosting, Starlink, servidor) con cliente, monto, modalidad (mes adelantado, mes vencido o anual), día de vencimiento y vigencia. El país sale de la empresa: en Chile la moneda es siempre CLP; en Uruguay se elige USD o UYU. Tiene tres pestañas:

- **Tablero del mes** (vista por defecto): los ciclos que vencen en el mes elegido, agrupados en Hosting, Licencias MS y Starlink/Servidor. Cada tarjeta se marca **Facturado** y **Cobrado** con un toque (ambos se pueden deshacer) y al facturar se puede vincular la factura.
- **Deuda** (`/recurring-services/debt`): todo lo no cobrado de cualquier mes, por cliente y con su antigüedad.
- **Servicios** (`/recurring-services/services`): el listado de servicios, el alta (`/services/new`), la edición y el detalle de cada uno con el historial de sus períodos (`/services/{servicio}`).

**Servicios anuales.** Un servicio anual se cobra por años contados desde su **fecha de inicio** (aniversario), no por año calendario. Cada período anual se identifica por el mes en que empieza. Con **mes adelantado**, el período se genera —para facturar y cobrar— en el mes en que empieza (ej. "EBCO LA LIGUA - ANUAL", desde el 1/07/2026: vence en julio 2026 y cada julio); con **mes vencido**, en el mes en que termina el año. El **mes de vencimiento ya no se pide**: el formulario lo muestra calculado a partir de la fecha de inicio y la modalidad; el día de vencimiento sí se edita. La venta anual se cuenta entera en el mes de su período.

**Costos del servicio.** En el alta y la edición:

- **Costo fijo**: lo que cuesta el servicio, **neto de IVA**, en la moneda del servicio. Es el costo estimado de cada período mientras no haya una factura de compra asignada.
- **Se paga: Mensual / Anual**: cada cuánto se paga ese costo, independiente de cómo se vende el servicio (un Starlink vendido anual puede pagarse mensual). Por defecto anual para dominios y mensual para el resto. Si es anual, se imputa en el mes de cada aniversario de la fecha de inicio.
- **Proveedor**: el proveedor (activo, de la misma empresa) cuyas facturas de compra corresponden a este servicio. Se ve en el detalle del servicio.
- Un servicio con **pool de costo compartido** (licencias MS) no usa estos campos: su costo sale del reparto de licencias, como antes.

Con eso el sistema arma los **períodos de costo** del servicio: uno por mes (pago mensual) o uno por aniversario (pago anual), desde la fecha de inicio (o enero 2026 si empezó antes) hasta el mes actual, nunca después de la fecha de fin. Un servicio sin costo fijo ni proveedor no tiene períodos de costo. Si se cambia el costo fijo, solo se actualiza el esperado de los períodos del mes actual en adelante que no tengan factura asignada.

En el detalle del servicio, **"Costos del servicio"** muestra cada período de costo con su costo esperado, la factura asignada, el monto real (el de la factura confirmada, o el esperado si no hay) y su estado: **Con factura**, **Sugerida** o **Estimado**; y el botón **"Asignar factura"** para elegir una factura de compra de su proveedor de ese mes (sección 8.5).

**En los reportes**, el costo de un servicio (que no use pool) es, en el mes de cada período de costo, la suma de sus facturas asignadas y confirmadas o, si no tiene, su costo fijo esperado; va al cliente y al área del servicio. Las facturas asignadas a servicios no se cuentan además como costo general.

El reparto del costo de licencias MS entre clientes está en **Costos → Reparto licencias MS** (`/companies/{id}/costs/ms-licenses`).

Las direcciones anteriores (`/recurring-services/new`, `/recurring-services/{servicio}`, `/recurring-services/pending` y `/recurring-services/cost-pools`) redirigen solas a las nuevas.

### 9.2 Personal / mano de obra

`/companies/{id}/personnel`: ficha de cada persona (empleado o socio) con su costo mensual. Desde "Costos" se carga el costo del período, y ese costo se puede **asignar a uno o más proyectos** (`work_allocations`) con un monto real y horas informativas — así el costo de mano de obra entra en la rentabilidad del proyecto igual que un costo de proveedor. El costo de personal no asignado a ningún proyecto entra como costo general de la empresa.

## 10. Reportes

Todos los reportes de una empresa usan **el mismo período** (mes elegido con el selector) y **las mismas reglas de cálculo**, así que las cifras siempre reconcilian entre pantallas.

### 10.1 Panel de control (dashboard)

`/companies/{id}` — primera pantalla al entrar a una empresa:

- 4 indicadores del mes con comparación contra el mes anterior: ventas netas, costos directos, margen directo, resultado operativo.
- Tarjeta **"Servicios del mes"**: cuántos ciclos de servicios recurrentes del mes actual quedan por facturar, por cobrar y vencidos; lleva al Tablero del mes.
- Gráfico de ventas/costos/margen de los últimos 12 meses.
- Gráfico "cascada" (waterfall) de ventas netas → costos directos → margen → costos generales → resultado operativo.
- Aviso si hay proyectos con costo pendiente ese mes.
- Tabla de los proyectos con más ingresos del mes, con margen % y comparación del costo acumulado contra el presupuesto de costo.
- Cada indicador y cada fila de proyecto es un enlace: **hace clic y lleva a la lista de ventas o costos ya filtrada** con los documentos que componen esa cifra (drill-down).

### 10.2 Resultado mensual

`/companies/{id}/reports/monthly-result`: el estado de resultados de gestión en formato clásico — ventas netas, costos directos, margen directo, costos generales (desglosados en gastos y costo de personal), resultado operativo — con los mismos enlaces de drill-down, gráfico de 12 meses y ranking de margen por área.

### 10.3 Rentabilidad por cliente, proyecto y área

`/companies/{id}/reports/profitability`: tres pestañas (cliente / proyecto / área) con ingreso, costo y margen de cada uno para el período elegido, más — en el caso de proyectos — el acumulado desde el inicio del proyecto (convertido a la moneda de la empresa), su cotización y la comparación del costo acumulado contra su presupuesto de costo. Cada fila tiene enlaces de drill-down a sus ventas y costos.

### 10.4 Consolidado en USD

`/reports/consolidated`: reúne el resultado operativo de **todas las empresas** del usuario (Chile + Uruguay) convertido a dólares, más el total consolidado. Si el tipo de cambio de una empresa no se pudo obtener ese mes, la empresa se marca como **"tipo de cambio pendiente"** y se excluye del total — nunca se cuenta como cero, para no distorsionar el consolidado.

**Tipo de cambio de cada documento.** Cada venta, costo, ciclo de servicio recurrente y pool de licencias guarda, al cargarse o importarse, el tipo de cambio de su fecha (el del mes, o el último anterior si ese mes todavía no tiene). Todos los reportes convierten a la moneda de la empresa con ese tipo guardado, así que una cifra ya registrada no cambia aunque después se actualice la cotización. Solo el sistema (service role) escribe la tabla de cotizaciones; los usuarios la leen.

## 11. Reglas que sostienen la confiabilidad de los números

- Un dato faltante nunca se trata como cero: proyectos sin costo quedan "pendientes", tipos de cambio no resueltos quedan "pendientes", y ambos se muestran explícitamente en vez de ocultarse.
- El IVA/impuesto nunca es ganancia ni gasto operativo — todos los reportes trabajan sobre importes netos.
- Nada se borra: las correcciones de ventas quedan como anulación con trazabilidad, y las importaciones registran su archivo de origen y su detalle fila por fila.
- Todos los reportes de una misma empresa usan el mismo rango de fechas y las mismas reglas de exclusión (ventas anuladas fuera, IVA fuera), por lo que cualquier cifra se puede verificar yendo al detalle.

## 12. Qué queda fuera del alcance actual (V1)

Movimientos bancarios y conciliación, flujo de caja, emisión de facturas electrónicas, nómina/remuneraciones completa, CRM, mesa de ayuda/tickets, inventario avanzado y portal de clientes. El sistema calcula **resultado de gestión**, no reemplaza la contabilidad tributaria.
