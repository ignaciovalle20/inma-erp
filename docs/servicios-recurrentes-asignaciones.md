# Servicios recurrentes, períodos y asignación de facturas (2026-10-16)

Rama `dev`. Migración `20261016010000_sales_allocations_and_recurring_periods.sql`, aplicada en **inma-erp-dev** (historial 64/64). **No está en prod.**

## Esquema

| Tabla / objeto | Cambio |
|---|---|
| `recurring_services` | `price` → `reference_amount` (nullable, valores migrados por rename). Nuevos `pricing_mode` (`fixed`/`per_unit`), `unit_price`, `default_quantity`; en `per_unit` la BD calcula referencial = precio × cantidad. Nuevo `service_type = 'domain'` (obligatoriamente anual; la renovación es `due_month`/`due_day`). |
| `recurring_service_occurrences` | Es la tabla de períodos (ya existía, se adaptó). `amount` = monto esperado (snapshot del referencial); nuevo `quantity` (por período, recalcula el esperado). `status` sigue siendo el estado manual para clientes sin factura. |
| `project_quotes` | Nuevos `quoted_amount` (opcional) y `placeholder` (cotización "Sin número" creada por el sistema para trabajos sin cotización). |
| `sales_allocations` | Nueva. Documento → exactamente un destino (período o cotización), `amount`, `status` (`suggested`/`confirmed`), `notes`. RLS por `company_memberships`. Trigger: misma empresa, documento asignable, período no anulado, suma ≤ neto (tolerancia ½ peso / ½ centavo). Únicos por documento+destino. |
| Vistas | `sales_document_allocation_summary` (neto, asignado, sin asignar), `recurring_service_period_summary` (esperado, facturado, diferencia, `billing_status`), `project_quote_billing_summary` (cotizado, facturado, %). Todas `security_invoker`. |
| Funciones | `ensure_recurring_service_periods`, `suggest_sales_allocations`, `suggest_sales_allocations_for_import_batch`, `set_sales_allocations`, `project_default_quote_id`, `refresh_recurring_service_occurrence_billing`, `sync_sales_document_project`, `recurring_service_period_billed_amount`. Reescritas: generación de períodos (usa referencial/cantidad), `allocate_recurring_service_cost_pool` (pondera por lo facturado), `match_recurring_service_occurrences_*` (no tocan lo ya asignado; la de importación ahora solo sugiere). |

Sincronización (para que tablero, Deuda y reportes sigan igual): las asignaciones confirmadas fijan `occurrences.sales_document_id`/`status` y `sales_documents.project_id`; el estado de pago de la factura pasa al período; anular una factura (o anularla con N/C) borra sus asignaciones; y al revés, el código que todavía vincula por `sales_document_id` o `project_id` crea la asignación confirmada correspondiente.

Backfill en dev: 19 vínculos ciclo↔factura, 8 factura↔trabajo (3 cotizaciones "Sin número" creadas) y 1 documento del generador viejo → asignaciones `confirmed`; 0 documentos sobre-asignados. Períodos generados desde septiembre 2026 hasta el mes siguiente.

## Pantallas

- **Servicios recurrentes → Períodos** (nueva): grilla servicio × mes desde sep 2026 con esperado (gris), facturado, estado y diferencia; aviso de dominios que renuevan en ≤ 60 días.
- **Período** (nueva): esperado / facturado / diferencia, cantidad (por unidad), pago manual, facturas asignadas y "Usar este monto como referencial de aquí en adelante".
- **Ventas → Asignar** (nueva, por documento): editor de asignaciones con saldo sin asignar, confirmar sugeridas, sugerir por monto, y sugerencia del dominio al asignar hosting.
- **Ventas → Conciliar** (nueva): pendientes de conciliar por mes, "Buscar sugerencias", confirmar sugeridas completas.
- **Trabajo**: bloque "Facturado vs. cotizado" por cotización; alta de cotización con monto opcional.
- **Servicio (alta/edición)**: modo de precio, referencial opcional, por unidad; tipo Dominio.
- **Reparto licencias MS**: el reparto usa lo facturado de cada período (o el esperado si no se facturó).
- Importadores Nubox (CL) y CSV (UY): sugieren asignaciones al terminar; nunca duplican al reimportar.

## Decisiones tomadas

1. Se adaptó `recurring_service_occurrences` como tabla de períodos (no se creó `recurring_service_periods`); por eso la columna de período sigue siendo `period` y el esperado sigue en `amount`. La FK en `sales_allocations` se llama `recurring_service_period_id` como pedía el diseño.
2. `price` se renombró (no se duplicó) a `reference_amount`.
3. El costo de un dominio usa los campos de costo existentes (`fixed_monthly_cost`, ×12 en anuales); no se agregó un costo anual aparte.
4. Las cotizaciones no tenían monto: se agregó `project_quotes.quoted_amount`; si falta, la cotización principal del trabajo usa `projects.quoted_amount` (no se tocó `projects`).
5. Los documentos ligados a un trabajo sin cotización van a una cotización "Sin número" (`placeholder`); al cargar una cotización real, esta toma sus asignaciones.
6. Sugerencia: monto neto exacto (± ½ unidad), mismo cliente y moneda; período pendiente con vencimiento en el mes de la factura, o cotización cuyo saldo sea ese monto. Si no hay un único destino, prueba hosting + dominio del mismo mes. Las sugeridas no cambian el estado del período hasta confirmarse.
7. "Pagado": todas las facturas confirmadas pagadas; un período cobrado a mano se mantiene cobrado salvo que la factura pase a impaga. "Cobrado"/"Deshacer cobrado" en un período con facturas marca esas facturas pagadas/impagas.
8. Las licencias MS existentes quedaron en modo `fixed` (no hay precio unitario cargado); se pasan a `per_unit` editando el servicio.

## Para llevarlo a prod

1. Desplegar migración y código juntos (el código nuevo lee `reference_amount`; el desplegado lee `price`).
2. Antes: simular la migración en prod dentro de `begin; … ` + bloque `DO` que haga `RAISE` con los conteos (mismo truco que en deploys anteriores) y revisar: documentos sobre-asignados = 0, vínculos sin asignación = 0.
3. `supabase db push` con el CLI enlazado a prod, merge `dev` → `main`, verificar el deploy de Vercel.
4. Probar a mano (con usuario real): Períodos, una factura en Ventas → Asignar, Conciliar del mes, y una importación de Nubox repetida (no debe duplicar sugerencias).
