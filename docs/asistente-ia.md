# Asistente IA y servidor MCP

Actualizado 2026-10-12. Reemplaza lo que el asistente sabía hacer en septiembre.

## Dos formas de usar IA con el ERP

| | Asistente interno (burbuja 💬) | Servidor MCP (`/api/mcp`) |
|---|---|---|
| Quién lo usa | La persona dentro de la app, con su API key (Ajustes → IA) | Claude Desktop / Claude Code / otro cliente MCP, con un token de Ajustes → MCP |
| Empresa | La empresa abierta en la barra lateral | Se pasa `company_id` en cada herramienta |
| Guardar | Botón **Confirmar** en la tarjeta del borrador | Herramienta `confirm_draft` (borrador vence a los 15 min) |

Las dos usan **las mismas herramientas** (`web/src/lib/ai/tools.ts`) y el mismo guardado
(`web/src/lib/ai/saveDraft.ts`). El MCP corre esas herramientas con una sesión real de la
dueña del token (`web/src/lib/mcp/session.ts`), así que ve exactamente lo que ven las pantallas
y respeta RLS. Antes el MCP tenía su propia copia de cada consulta: se había desfasado (resultado
mensual con IVA y sumando notas de crédito, factura de Microsoft contada dos veces, trabajos sin
cotización) y `confirm_draft` de gastos y ventas fallaba siempre porque las funciones de la base
exigen un usuario logueado.

## Herramientas

Consulta:
- `list_companies`
- `get_monthly_result` — el mismo cálculo que el Resultado mensual de la app.
- `list_projects` — busca trabajos por nombre, cliente, N° de cotización o N° de factura/boleta; pestañas activos/finalizados/todos; incluye cotización, presupuesto de costo y saldo por facturar.
- `get_project_detail` — cotizaciones, facturado, saldo y rentabilidad acumulada.
- `list_sales_documents` — con N° de documento, trabajo, estado de cobro y vencimiento.
- `get_sales_pending` — la pantalla Pendientes.
- `list_cost_documents` — con estado provisorio/confirmado y si está cubierto por el pool de licencias MS.
- `get_recurring_services_month` — el tablero de servicios recurrentes de un mes.
- `get_technician_balances` — lo que se le debe a cada técnico externo.
- `list_clients`, `list_suppliers`, `list_business_areas`.

Borradores (no guardan hasta que la persona confirma):
- `propose_project` — alta de trabajo; N° de cotización obligatorio salvo "Por cotizar".
- `propose_project_status` — mover en el tablero; "En espera" pide motivo.
- `propose_expense` — directo (con trabajo) o general (al guardarlo lleva a Dividir costo).
- `propose_sale` — pensado para boletas y ventas sin factura (las facturas vienen de Nubox).

Moneda: en empresas de Chile siempre CLP (no se pregunta). En Uruguay USD o UYU, se pregunta.

## Requisitos para el MCP

- `SUPABASE_SERVICE_ROLE_KEY` en el entorno (ya existía): solo se usa para leer el token, generar
  el acceso de un solo uso del usuario y guardar los borradores pendientes.
- El proveedor de Email debe estar habilitado en Supabase Auth (la sesión se abre con un enlace
  mágico que se genera y canjea en el servidor; no se envía ningún correo).
- Migración `20261012010000_mcp_drafts_project_status.sql` aplicada.
