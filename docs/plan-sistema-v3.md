# Plan de trabajo — sistema, sin migración de datos

> Documento para `docs/`. Reemplaza al plan de migración del punto 4.8 de `cambios-flujo-v2.md`, que queda **en pausa**. El foco ahora es estabilidad del sistema y funciones nuevas. Los puntos 4.1 y 4.2 de `cambios-flujo-v2.md` ya están implementados; 4.3 a 4.7 siguen vigentes y se retoman acá.

## 0. Decisiones

- **No se migran datos por ahora.** No se crean trabajos históricos, no se cruza el Excel 2026, no se emparejan a mano las notas de crédito viejas. El histórico que ya está cargado (1.735 documentos desde 2022) se deja como está: suma en totales, pero no se completa.
- Consecuencia inmediata: **Pendientes hay que poder acotarlo por fecha**, o queda inservible con ~1.500 facturas viejas sin trabajo (ver B1).
- El MCP queda en pausa (hallazgos A03 y A09 de `auditoria-2026-09-20.md`).
- Referencias `A*` y `H*` son de `docs/auditoria-2026-09-20.md`.

## 1. Orden de trabajo

| Bloque | Contenido | Por qué en ese orden |
|---|---|---|
| 0 | Mergear lo que ya está listo | Hay 3 ramas terminadas sin entrar a `main` |
| 1 | Bugs y deuda que afectan cifras (B1–B5) | Un número mal no se nota hasta que decide algo |
| 2 | Técnicos externos (F1) | Es lo que falta para dejar de usar Planner |
| 3 | Cierre de mes y reparto Microsoft (F2) | Cierra el circuito mensual |
| 4 | Cierre automático del trabajo (F3) | Depende de F1 y F2 |
| 5 | Tareas del trabajo y clientes mensuales (F4, F5) | Comodidad, no bloquean nada |
| 6 | Rendimiento y pruebas (D1–D3) | Después de medir en producción |

## 2. Bloque 0 — Mergear lo pendiente

Orden: `fix/tablero-errores-reales` → `ci/github-actions` → `feature/ventas-nubox-cobro`.

- Con el CI mergeado, marcar el chequeo como obligatorio en la protección de `main`.
- Antes del merge del 4.2, confirmar que sus migraciones estén aplicadas en Supabase.
- Regla de despliegue a partir de ahora: la migración se aplica justo antes de mergear el PR que la necesita, nunca antes.

## 3. Bugs y deuda (bloque 1)

### B1 · Pendientes acotado por fecha · alto
Hoy Pendientes mezcla facturas de 2022 con las del mes. Sin migrar nada:
- Agregar a la empresa una fecha "gestionar desde" (`companies.management_start_date`, Chile `2026-01-01`), editable.
- Pendientes (sin trabajo, sin área, N/C sin emparejar, cobro a revisar) solo muestra documentos con `document_date >= management_start_date`. Lo anterior se cuenta en un aviso del tipo "1.487 documentos anteriores a 2026, fuera de gestión".
- No cambia ningún dato: es solo filtro.
- **Aceptación**: Pendientes no lista nada anterior a la fecha configurada; cambiar la fecha cambia la lista sin tocar la base.

### B2 · "Revisar cobro en Nubox" por antigüedad · medio
Hoy compara con la fecha más antigua del último archivo importado, y con el histórico cargado no lista nada (A12). Cambiar la regla: facturas `vencido` con más de 60 días desde el vencimiento, dentro del rango de gestión. Permitir marcarlas pagadas a mano.

### B3 · Tope de 1.000 filas en costos y reportes · alto (A02, H10)
La API devuelve como máximo 1.000 filas y no avisa. En 4.2 se resolvió en Ventas; faltan `dal.ts`, `reporting.ts` y la pantalla de Costos.
- Mover las sumas a SQL (`sum` agrupado) donde se pueda, o usar el helper de paginación existente.
- H10: el "Total del mes" de Costos suma todos los costos de la empresa, sin filtrar por mes.
- **Aceptación**: un caso de prueba con más de 1.000 documentos en el rango da la misma cifra que la suma en SQL.

### B4 · Parser de importes del importador genérico · medio (H13)
`sales/import/actions.ts` elimina las comas: `"1234,5"` se convierte en `12345`. Afecta a Uruguay, que carga por el importador genérico. Corregir y cubrir con tests: coma decimal, punto de miles, mezcla de ambos.

### B5 · Errores que no se propagan · medio (H06)
Quedan `console.error` sin propagar en `dal.ts`, `reporting.ts` y `mcp/tools.ts`. Prioridad: los de `reporting.ts`, porque un error ahí se ve como un cero, no como un error. Que la pantalla muestre el error en vez de mostrar cifras incompletas.

## 4. Funciones nuevas

### F1 · Técnicos externos (era 4.3)
Sin cambios respecto a `cambios-flujo-v2.md` 4.3. Resumen:
- `personnel.type` suma `contractor`, con `tax_id`, tipo de documento (boleta de honorarios o factura), tarifas habituales y datos de pago.
- `technician_charges` por trabajo: descripción, monto, casilla "IVA incluido" que calcula el neto, estado del documento (pendiente / recibida). Entra como costo directo del trabajo.
- `technician_payments` + aplicaciones: un pago o abono puede cubrir varios cargos de un mismo técnico.
- Ficha del técnico con cuenta corriente: cargos, abonos, saldo y boletas pendientes.
- En la tarjeta del tablero: indicadores de pago al técnico y boleta.
- `work_allocations` sigue siendo para empleados y socios con costo mensual.
- **Aceptación**: cargar un trabajo con dos técnicos, pagarle a uno un abono que cubre dos trabajos y ver el saldo correcto en su ficha y el costo correcto en cada trabajo.

### F2 · Cierre de mes y reparto Microsoft (era 4.4)
Asistente en `/companies/{id}/close/{period}` que encadena lo que ya existe:
1. Importar el CSV de Nubox (pantalla actual del 4.2).
2. Vincular facturas a trabajos (pendientes actuales).
3. **Reparto Microsoft**: se ingresa el total de la factura del proveedor del mes. Se crea un `cost_document` y se reparte entre los trabajos con venta del área Microsoft en el período, **en proporción a la venta neta de cada uno**. Si ya existe para ese período, se recalcula. Si un cliente del área no tiene trabajo vinculado, la parte queda pendiente y se avisa.
4. Revisar pendientes del período.
5. Cerrar el mes: `period_closures` (empresa, período, quién y cuándo). Un mes cerrado no admite cambios en ventas ni costos de ese período sin reabrirlo, y reabrir queda registrado.
- **Aceptación**: con una factura de proveedor de $1.000.000 y las ventas de Microsoft de un mes, cada trabajo queda con su parte proporcional y la suma de las partes es exactamente el total de la factura (el redondeo se ajusta en la mayor).

### F3 · Cierre automático del trabajo (era 4.5)
Un trabajo en `finalizado` pasa a `cerrado` cuando: todas sus ventas están pagadas (o marcadas pagadas a mano si no llevan factura), todos los cargos de técnico están saldados y con documento recibido, y no quedan costos provisorios. Recalcular al importar ventas, al registrar un pago a técnico y al confirmar un costo. Mostrar en la tarjeta qué falta para cerrar.

### F4 · Tareas del trabajo (era 4.7)
`project_tasks` (trabajo, título, hecha, fecha, asignado). Checklist marcable desde el celular, visible en la tarjeta como "2/4". Reemplaza los checklist del Planner.

### F5 · Clientes mensuales (era 4.6)
- Marca `clients.monthly`.
- Panel de inicio de mes: clientes mensuales sin trabajo cargado en el mes en curso.
- Botón "Repetir del mes anterior" ya existe en trabajos: verificar que funcione bien con los mensuales.
- Desactivar "Generar" en servicios recurrentes para empresas que importan ventas (Chile), para no duplicar lo que llega de Nubox.

## 5. Rendimiento y pruebas (bloque 6)

### D1 · Medir en producción
Los tiempos de la auditoría son del servidor de desarrollo. Medir en Vercel antes de optimizar.

### D2 · Índices y agregación en SQL
Índices compuestos `sales_documents (company_id, document_date)` y `cost_documents (company_id, document_date)`. Pasar a SQL las sumas de Resumen, Resultado mensual y Rentabilidad (se resuelve junto con B3).

### D3 · Pruebas de RPC y RLS
Hoy hay 154 tests, todos de lógica en TypeScript. Falta probar las funciones SQL y las políticas de acceso. Requiere un proyecto de Supabase de pruebas, separado del de producción, que además evita repetir el problema de que un preview escriba en la base real.

## 6. Fuera de alcance por ahora

- Migración de datos: trabajos históricos, cruce con el Excel 2026, emparejar N/C viejas, asignar áreas al histórico. Queda documentado en `cambios-flujo-v2.md` 4.8 para retomarlo cuando se decida.
- MCP: A03 (no puede crear gastos ni ventas) y A09 (superficie del endpoint).
- Boletas y otros tipos de documento de Nubox sin folio único (A12).
- Roles de solo lectura y `requireMember` (A08).

## 7. Decisiones de negocio pendientes

- **Repositorio público**: hoy `ignaciovalle20/inma-erp` es público e incluye documentación interna. Pasarlo a privado no afecta a Vercel.
- **Proyecto de Supabase de pruebas**: hoy los previews escriben en la base real.
