# Estado de pago, resúmenes multimoneda y paridad entre empresas (2026-10-14)

Rama `dev`, proyecto Supabase **dev** (`sczgankronafrxybpvnh`). Prod no se tocó.

## Migración

`supabase/migrations/20261014010000_payment_status_two_states_and_import_parity.sql` (aplicada solo en dev):

1. **País normalizado**: `companies.country` es texto libre e "Inmasoft UY" decía `Uruguay` (no `UY`), así que las reglas por país (moneda de servicios recurrentes, etc.) no se le aplicaban. Se normaliza a `UY`/`CL` y se completa `recurring_services.country` de esas empresas.
2. **`sales_documents.payment_status` con dos estados**: `pagado` / `impago`, `not null`, default `impago`. Se reutilizó el campo que ya llenaba Nubox (no se creó otro). Mapeo de los datos existentes: `pagado`, `no_aplica` → `pagado`; `por_vencer`, `vencido`, `pendiente`, `null` → `impago`. `paid_at` queda opcional y se borra al volver a impaga.
3. **RPC `set_sales_documents_payment_status(ids[], estado, fecha)`** para el cambio individual y masivo (permisos del usuario, ignora anuladas y notas de crédito). `mark_sales_document_paid` (fecha ahora opcional) y `mark_sales_document_pending` (cualquier venta) mantienen su firma. `create_manual_sale_without_invoice` arranca en `impago`.
4. **`import_nubox_documents_batch`**: mismo cuerpo, con el estado normalizado a dos valores; el estado importado sobrescribe el cargado a mano (y borra `paid_at` si queda impaga).
5. **`create_import_batch` / `create_cost_import_batch`**: sin el bloqueo "solo Chile" (la membresía la sigue exigiendo RLS).
6. **`import_sales_rows_batch`** (importador genérico): acepta `document_number`, `payment_status` y `paid_at`. Con N° de documento se identifica como Nubox (empresa + folio): si ya existe no se crea de nuevo; si el archivo trae estado de pago, lo sobrescribe (`updated`); si no, `duplicate`. Sin N° sigue el chequeo cliente + fecha + total.

## Tarea 1 — Estado de pago en Ventas

- Lista de ventas: columna **Pago** con badge Pagada/Impaga, fecha de pago, "vence"/"vencida" (vencida se deriva de `due_date`, ya no es un estado) y acción por fila "Marcar pagada / Marcar impaga".
- **Selección múltiple**: checkbox por fila + "seleccionar todas" y barra con fecha de pago opcional y "Marcar pagadas" / "Marcar impagas".
- **Filtro** Estado de pago: Todas / Pagadas / Impagas.
- Detalle de la venta: bloque "Estado de pago" con selector y fecha opcional.
- Pendientes: "Revisar pago" (impagas vencidas hace más de 60 días) y "Ventas sin factura impagas"; marcar pagada sin fecha ya es válido.
- Exportación CSV: columnas Moneda y Fecha de pago, y el neto USD conserva los centavos.
- Asistente IA: filtro `pagado`/`impago`.

## Tarea 2 — Resúmenes multimoneda

Helper único: **`web/src/lib/multiCurrency.ts`** (`summarizeMoney`, `combineSummaries`, `convertOn`). Reglas:

- Montos netos; subtotal por moneda en su moneda original.
- Total combinado en moneda local (UYU / CLP) **y** en USD, cada monto con el tipo de cambio de su fecha: snapshot de ese mes o el más cercano anterior (misma regla que `exchange_rate_on` en la base). Para la moneda local se usa el `exchange_rate` guardado en el documento cuando existe, así el total coincide con el resultado mensual.
- Sin tipo de cambio: ese monto queda fuera del total combinado y la UI marca **"incompleto"**; nunca 1:1.
- Tabla de tipos: `getRateTable()` en `lib/exchangeRates.ts` (lee `exchange_rate_snapshots`, crea el del mes actual si falta). El respaldo de `getOrSnapshotRate` también pasó a "mes o más cercano anterior".
- UI: componente `MoneyBreakdown`.

Dónde se aplicó: lista de **Ventas** (tarjetas Total/Facturado/N/C, chip de filtro, pie), **Gastos** (tarjetas y pie), **Dashboard** (4 KPIs), **Resultado mensual** (cada línea y el resultado), **Rentabilidad** (resumen del mes), **Consolidado USD** (ahora documento por documento), **Inicio** (resultado por empresa), **Servicios recurrentes** (tablero y deuda: total combinado). Además se corrigió el gasto/ganancia por fila de la lista de ventas, que mezclaba la moneda del documento con la de la empresa.

## Tarea 3 — Paridad entre empresas

Configuración por empresa: **`web/src/lib/companyConfig.ts`** (país normalizado, moneda local, monedas permitidas, moneda fija, IVA, zona horaria, importadores de ventas). Los helpers existentes (`serviceCountry`, `currenciesForCountry`, `vatRateFor`, `todayForCountry`, IVA de técnicos, asistente IA) leen de ahí.

| Diferencia encontrada | Resolución |
|---|---|
| Importar ventas (CSV) e Historial: solo CL (UI, acción y `create_import_batch`) | Para todas; pestañas según `salesImportFormats` (CL: Nubox + genérico; UY: genérico). |
| Importar facturas de compra: solo CL (UI, acción y `create_cost_import_batch`) | Para todas. |
| Carga rápida de ventas: solo UYU | Para todas; moneda según configuración. |
| Formularios de venta/gasto ofrecían CLP/UYU/USD a cualquier empresa | `DocumentCurrencySelect`: CL fijo CLP sin preguntar; UY elige USD o UYU (sin default, como servicios recurrentes). Validado en el servidor. Editar una venta conserva su moneda aunque no esté en la lista. |
| Gasto rápido del trabajo: siempre moneda de la empresa | UY elige USD/UYU. |
| IVA de cargos de técnicos por moneda (`UYU`→22 %, cualquier otra→19 %): un USD de Uruguay usaba 19 % | IVA por país de la empresa. |
| Asistente IA: regla de moneda con `country === "CL"` | Desde la configuración. |
| "Inmasoft UY" con país `Uruguay` quedaba fuera de toda regla por país | Normalizado en la migración y en código. |
| Guía in-app decía "solo Chile"/"solo Uruguay" | Actualizada. |

Importador genérico (ventas y gastos): CSV o **Excel .xlsx** (`lib/importFile.ts`, con `exceljs`) → mapeo de columnas (fecha, N° de documento, cliente, RUT/RUC, monto neto, moneda, IVA, estado de pago, fecha de pago; ningún nombre de columna asumido, solo se sugiere) → moneda del archivo si no hay columna (UY) → previsualización (ya existe / duplicado / error / cliente nuevo) → importar. Reutiliza `import_batches`/`import_rows` y la deduplicación por folio de Nubox.

## Decisiones tomadas

- Nubox `NOT_APPLY` (notas de crédito, nada que cobrar) → `pagado`. Las notas de crédito no muestran ni cambian estado de pago.
- "Vencida" no es un estado: se muestra cuando es impaga y `due_date` ya pasó.
- Nubox sigue ofreciéndose solo donde la configuración lo indica (Chile): es el sistema de facturación chileno; UY tiene el importador genérico.
- UY elige moneda explícitamente en altas (como ya hacía servicios recurrentes); en la carga rápida queda elegida para la siguiente.
- Importador: una celda de moneda distinta a CLP en una empresa chilena es error (no se re-etiqueta); "$" solo es ambiguo y se rechaza.
- Cambiar el estado de pago actualiza `updated_at` (la venta muestra "Editado"), igual que ya pasaba con Nubox.
- Las tablas por trabajo/cliente/área quedan en moneda local (convertidas documento por documento); el total USD está en los resúmenes del mes.

## Verificación

- `tsc`, `eslint` (0 errores; 6 warnings preexistentes), `next build`: OK.
- Unit: 524 tests (nuevos: `multiCurrency`, `companyConfig`, `importFile`, y los ajustados).
- Integración contra dev (`npm run test:integration`): toda la suite pasa, incluida la golden contable, más `paymentStatusMultiCurrency.integration.test.ts` (como usuario miembro real con RLS): pagada/impaga individual y masivo con y sin fecha, filtro, resumen con USD y UYU mezclados (subtotales, total UYU y USD, "incompleto"), e importador con mapeo para Uruguay (folio, moneda, estado, fecha, re-importación que ignora existentes y sobrescribe el estado).

## Pendiente

- Revisión visual en el navegador (Claude no puede iniciar sesión en la app): Ventas → seleccionar varias → "Marcar pagadas"/"Marcar impagas"; filtro; detalle de una venta; Ventas/Gastos/Dashboard de Inmasoft UY (USD + UYU); Importar → CSV/Excel con mapeo.
- La venta sin factura desde un trabajo (`create_manual_sale_without_invoice`) sigue usando la moneda de la empresa (UY no elige USD ahí).
- Aplicar la migración a prod cuando se mergee a `main`.
