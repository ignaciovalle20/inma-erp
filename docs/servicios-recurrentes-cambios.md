# Servicios recurrentes: país/moneda automáticos y ciclos mes a mes

2026-10-02 · rama `dev` · Supabase `inma-erp-dev` (`sczgankronafrxybpvnh`)

## 1. Qué había (relevamiento)

El módulo ya existía y estaba bastante avanzado (`docs/plan-servicios-recurrentes.md`, commits `a6a57ab` / `da45278`). Se extendió lo existente en vez de crear algo paralelo.

| Pieza | Estado previo |
| --- | --- |
| `recurring_services` | Epic 5.1 + rediseño v2: `company_id`, `client_id`, `name`, `price`, `currency` (CLP/UYU/USD libre), `periodicity` (monthly/annual), `invoicing_mode` (advance/arrears), `due_day`/`due_month` (nullables), `status`, `service_type`, `quote_ref`, costos. **Sin** país, sin "requiere factura", sin notas. |
| `recurring_service_occurrences` | Ya existía: `period date` (1° del mes o 1/1 del año), `invoice_due_date`, `collection_due_date`, `amount`, `currency`, `status` (`pending_invoice` / `invoiced` / `pending_collection` / `collected` / `void`), `invoiced_at`, `collected_at`, `sales_document_id` (FK a `sales_documents`), `unique(recurring_service_id, period)`. RLS por membresía a través del servicio. |
| Generación | Cron de Vercel → `generate_due_recurring_service_occurrences()` (solo `service_role`), solo el mes actual. Vencido = factura el mes que cerró. Sin `due_day` dejaba el vencimiento en null. |
| UI | Lista de servicios agrupada por tipo, pantalla "Pendientes" con Facturar/Cobrar/Anular (sin deshacer), pools de costo. |
| Empresa activa | Sale de la URL `/companies/[id]`; `getCompanyForEdit` valida la membresía (`company_memberships`) y trae `companies.country` (`CL` / `UY`). Ya había `todayForCountry` para la fecha local. |
| Otros consumidores | Matching Nubox (fase 7) y reporte de rentabilidad (cuenta `invoiced`/`collected`). |

En dev hay 4 servicios reales de prueba en "Demo Chile SpA" y ninguno en "Demo Uruguay SRL" (en dev no existe "inmasoft Chile"; el país se toma de `companies.country`, así que funciona igual en prod).

## 2. Migración creada

`supabase/migrations/20261002010000_recurring_services_country_and_monthly_cycles.sql`, aplicada en dev con `supabase db push --linked`. Todo aditivo:

- `recurring_services`: `country text` (CL/UY), `requires_invoice boolean not null default true`, `notes text`. El país de los servicios existentes se rellenó **sin tocar `updated_at`** (se desactivó ese trigger solo durante el backfill).
- Trigger `recurring_services_apply_company_country`: en cada insert/update copia el país de la empresa (lo que mande el cliente se ignora). Chile → fuerza `CLP`. Uruguay → exige `USD` o `UYU` (si no, error). Empresas sin país (fixtures de test) quedan como antes.
- `recurring_service_occurrences.note text` + trigger `recurring_service_occurrences_validate_currency` (misma regla de moneda para el monto editable de cada ciclo).
- Función nueva `generate_recurring_service_occurrences_for_month(p_month, p_company_id)` (security invoker: corre con la sesión del usuario y su RLS; ejecutable por `authenticated`, no por `anon`). Es la que usa el tablero al abrir un mes.
- `generate_due_recurring_service_occurrences()` (cron) ahora solo llama a la anterior para el mes actual en todas las empresas: el cron y el tablero comparten una única regla. Mismos permisos (solo `service_role`).
- Backfill: corre la generación para septiembre y octubre 2026. `ON CONFLICT DO NOTHING`: los ciclos existentes quedan exactamente como estaban.

## 3. Cambios en la app

- **Formularios (alta/edición)**: no hay campo país. Chile muestra "Chile · CLP" fijo (sin selector) y el server fuerza CLP. Uruguay muestra un selector obligatorio USD/UYU sin valor por defecto; el server rechaza cualquier otra cosa (`resolveServiceCurrency`). Nuevos campos: "Detalle / notas" y "Requiere factura".
- **Mes a mes** (`/recurring-services`, ahora la portada del módulo): selector de mes con flechas (por defecto el mes actual, mínimo sept 2026, máximo el mes siguiente), columnas Hosting / Licencias MS / Starlink-Servidor / Otros, tarjetas con cliente, servicio, período, notas, COT#, nota del ciclo, monto con moneda, badge Facturar/Cobrar/Pagado, vencimiento en rojo si venció y no está cobrado, "sin vencimiento definido" cuando corresponde. Botones de un toque **Facturado** y **Cobrado**, ambos con **Deshacer**. Vincular factura de `sales_documents` (buscador por N° o monto, por defecto del mismo cliente, excluye anuladas y ya vinculadas). Editar monto/moneda/vencimiento/nota del ciclo. Resumen del mes por moneda (por facturar / por cobrar / cobrado, nunca suma monedas distintas). Filtro "Solo pendientes".
- **Deuda** (`/recurring-services/debt`): todos los ciclos no cobrados de cualquier mes, en dos bloques (2026-10-03): **Vencido** (vencimiento anterior a hoy) y **Por vencer** (el resto, incluidos los sin fecha), cada uno con totales por moneda y agrupado por cliente. El resumen del tablero mensual muestra también cuánto de lo pendiente está vencido. Dentro de cada bloque, agrupados por cliente (el de deuda más antigua primero), con antigüedad ("vencido hace N días") y subtotales por moneda. `/pending` redirige acá.
- **Detalle del servicio** (`/recurring-services/[id]`): condiciones del contrato + historial de todos sus períodos con estado y acciones.
- **Catálogo** pasó a `/recurring-services/services`. Pestañas comunes: Mes a mes · Deuda · Servicios · Pools de costo.
- Archivos principales: `web/src/app/companies/[id]/recurring-services/{page.tsx, debt/, services/, [recurringServiceId]/page.tsx, occurrence-card.tsx, currency-field.tsx, nav.tsx, pending/actions.ts}`, `web/src/lib/{dal.ts, recurringServicePending.ts, recurringServiceTypes.ts}`, `web/src/components/PeriodPicker.tsx` (límites min/max opcionales).

## 4. Decisiones ante ambigüedades

1. **No se creó una tabla nueva**: se adaptó `recurring_service_occurrences`, que ya cumplía casi todo. Los nombres siguen en inglés como el resto del esquema (`period`, `invoice_due_date`, `sales_document_id`, `note`).
2. **`period` sigue siendo `date`** (1° del mes / 1° de enero), no texto `'2026-09'`: cambiar el tipo rompía el matching Nubox, los pools de costo y el reporte. La UI lo muestra como "sep 2026" / "2026". La unicidad `(servicio, período)` es la misma.
3. **"Fecha de vencimiento"** = `invoice_due_date`; `collection_due_date` se mantiene igual (al editar se escriben las dos).
4. **Estados**: `invoiced` sigue significando "facturado = pendiente de cobro" (no se usa un paso intermedio). `pending_collection` es donde nace el ciclo cuando `requires_invoice = false`. Deshacer cobrado vuelve a `invoiced` si había sido facturado, si no a `pending_collection`. Deshacer facturado vuelve a `pending_invoice` y desvincula la factura. Anular sigue siendo final.
5. **En qué mes aparece cada ciclo**: el tablero de un mes muestra lo que **vence** ese mes (lo que hay que hacer ese mes, como el tablero de Planner). Se mantuvo la regla de modalidad ya acordada en `20260922090000`: mes adelantado factura el mismo mes; **mes vencido factura el mes que cerró** (el ciclo de septiembre vence en octubre y aparece en el tablero de octubre); anual aparece solo en su mes de vencimiento (`due_month`). Si se edita la fecha de vencimiento de un ciclo, la tarjeta se mueve a ese mes.
6. **Piso septiembre 2026**: ningún tablero antes de septiembre. El piso se aplica al **mes de vencimiento**, igual para mensuales y anuales: el tablero de septiembre de un servicio mes vencido trae su ciclo de agosto (vence en septiembre), y un anual vencido que vence en dic-2026 factura el año 2025. *(Corregido el 2026-10-03 en `20261003010000`: la primera versión aplicaba el piso al período en los mensuales y el tablero de septiembre quedaba sin los vencidos. Ver `docs/qa-servicios-recurrentes-2026-10-03.md`.)*
7. **Backfill**: se generaron los ciclos de los tableros de septiembre y octubre. Para mes adelantado eso son los períodos sep y oct; para mes vencido, los períodos ago y sep (el de octubre se genera al abrir noviembre o con el cron del 1/11, porque recién vence en noviembre). El período ago de los vencidos lo agrega `20261003010000`.
8. **Sin día de vencimiento**: se usa el día 1 y la tarjeta dice "sin vencimiento definido".
9. **Mes máximo navegable** = mes siguiente al actual, para preparar facturas adelantadas sin congelar montos de meses lejanos (cada apertura de mes crea ciclos con el monto vigente del servicio).
10. **Moneda en empresas sin país** (solo fixtures de test): se mantiene la elección libre CLP/UYU/USD.
11. **Edición de un servicio existente de Uruguay**: el selector viene con la moneda actual (el "sin valor por defecto" aplica al alta).
12. **Permisos**: cualquier miembro de la empresa (igual que antes). El generador por mes corre con la sesión del usuario; un no miembro no genera nada (verificado).
13. **Vinculación de facturas**: se permiten `invoice`, `receipt` y `manual` no anuladas y no vinculadas a otro ciclo; la búsqueda por monto compara neto o total exacto.

## 5. Verificaciones (hechas en dev)

Automatizadas en `web/src/lib/__tests__/integration/recurringServicesMonthly.integration.test.ts` (corre las server actions y el DAL reales como un usuario miembro de dos empresas desechables CL y UY; limpia todo al final) y `web/src/lib/__tests__/recurringServiceForms.test.ts` (render del formulario).

| # | Verificación | Resultado |
| --- | --- | --- |
| 1 | Alta con empresa Chile no pide país ni moneda y queda CL/CLP | ✅ El formulario no tiene selector de moneda ni campo país ("Chile · CLP"). Alta sin moneda → CL/CLP; alta mandando `USD` a mano → igual queda CLP. |
| 2 | Con Uruguay pide moneda obligatoria USD/UYU y no deja guardar sin elegir | ✅ Selector `required` con opciones vacía/USD/UYU y la vacía seleccionada. Sin moneda → "Elegí la moneda: USD o UYU." y no se guarda nada; con CLP → mismo error; con UYU y USD → guarda UY/UYU y UY/USD. Un insert directo a la base con CLP también es rechazado por el trigger. |
| 3 | Servicios existentes intactos y con ciclos sept/oct pendientes | ✅ Los 4 servicios de "Demo Chile SpA" conservan todos sus valores y su `updated_at`; ganaron `country = CL`. "Microsoft 365 - Razo - mes adelantado": sept y oct creados en `pending_invoice` (vencen 05/09 y 05/10). "Licencias Microsoft 365" (vencido) ya tenía sept y oct **cobrados**: se dejaron como estaban (no se pisan). "Microsoft" terminó el 30/09: conserva su sept cobrado, no lleva octubre. "Plan Medio" es anual con vencimiento en agosto: no corresponde ciclo en sept/oct (el próximo es agosto 2027). |
| 4 | Facturado → Cobrado → deshacer funciona y Deuda lo refleja | ✅ Ciclo de oct: en Deuda como "Facturar" → Facturado (en Deuda como "Cobrar") → Cobrado (sale de Deuda) → deshacer cobrado (vuelve como "Cobrar") → deshacer facturado (vuelve a "Facturar", con `invoiced_at`, `collected_at` y `sales_document_id` en null). |
| 5 | Reabrir un mes no duplica ciclos | ✅ Generación de nov-2026 dos veces: la primera crea 2, la segunda 0; el mes sigue con 2 ciclos. Un mes anterior a sept-2026 no genera nada. |

Además:

- `npm run build` ✅, `npm run lint` ✅ (0 errores; 7 warnings preexistentes en otros archivos), `npm test` ✅ (27 archivos, 407 tests).
- Integración contra dev: `recurringServiceOccurrences` (19, actualizado a la nueva regla: día 1 por defecto, piso sept-2026, servicios sin factura, RPC por mes y sus permisos), `reportingRecurringServices` (3) y el nuevo `recurringServicesMonthly` (7): todos ✅.
- El build local falla solo por `web/src/lib/__tests__/integration/zzAuditoria.integration.test.ts`, un archivo **sin commitear** que ya estaba en el árbol y no es parte de este cambio (errores de tipos propios). Se verificó el build sin ese archivo (como lo ve Vercel) y se dejó intacto.
- No se probó la UI con login en el navegador (el login va contra Supabase con credenciales reales); queda para revisar en el deploy preview de Vercel.

## 6. Pendiente / fuera de alcance

- Matching automático con el import de Nubox y reparto del costo de licencias MS: no se tocaron (siguen funcionando como antes; el matching solo mira ciclos `pending_invoice`/`invoiced`, así que no afecta a los servicios sin factura).
- Revisar visualmente en el preview de Vercel el tablero, Deuda y el detalle en celular.
- Cargar día de vencimiento a los servicios que no lo tienen (hoy "Microsoft" en dev) para que no queden como "sin vencimiento definido".
- La migración todavía no se aplicó en prod; al aplicarla también hará el backfill de sept/oct sobre los servicios reales de prod.
