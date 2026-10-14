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

- ~~Revisión visual en el navegador~~: cubierta por las pruebas e2e (abajo). Queda mirar a ojo las capturas y los datos reales de Inmasoft UY.
- La venta sin factura desde un trabajo (`create_manual_sale_without_invoice`) sigue usando la moneda de la empresa (UY no elige USD ahí).
- Aplicar la migración a prod cuando se mergee a `main`.

## Pruebas e2e

Playwright contra un build de producción local que habla con **inma-erp-dev** (`npm run test:e2e`). Cada spec crea empresas, clientes y un usuario descartables `zz-test-e2e-*` con el admin API e inicia la sesión del lado del servidor (las cookies se pasan al navegador; no se escriben credenciales en la página). Todo se borra en `afterAll`. El setup compartido está en `web/e2e/helpers/devSession.ts`. Al terminar, una consulta en dev confirmó 0 empresas, clientes, usuarios, ventas, trabajos y servicios `zz-test-e2e-*`, y 0 snapshots de 1995. Las capturas quedan en `web/e2e/screenshots/2026-10-14/` (ignorada por git).

### Qué se cubrió (24 tests nuevos; la suite completa da 37/37)

- `payment-status.spec.ts` (empresa UY), con cada cambio verificado también en la base:
  - Impaga por defecto.
  - Botón por fila → Pagada, que persiste al recargar.
  - Selección múltiple: "Marcar pagadas" con fecha y después "Marcar impagas", que borra la fecha.
  - Filtro Pagadas / Impagas.
  - Detalle de la venta: estado y fecha, y luego "Editado" en la lista.
  - Nota de crédito: sin casilla, sin botón y sin estado, ni en la lista ni en el detalle.
- `multi-currency-summaries.spec.ts`. Snapshots propios de 1995:
  - UYU marzo 40/USD y mayo 50/USD; sin enero (ni nada anterior) y sin abril.
  - CLP marzo 1.000/USD.

  Ventas USD y UYU en meses distintos, gastos USD y UYU, un trabajo y dos servicios recurrentes (USD y UYU). Los esperados se calculan en el test. Se verifica:
  - **Ventas:** subtotal por moneda, total combinado en UYU y USD, abril con la tasa de marzo y enero "incompleto". Además, el gasto y la ganancia por fila quedan en UYU (no USD menos UYU).
  - **Gastos, Dashboard (KPIs de abril), Resultado mensual (marzo y enero incompleto), Rentabilidad:** los mismos controles.
  - **Consolidado USD:** UY + CL; en enero, UY queda excluida por tipo de cambio pendiente.
  - **Inicio:** venta en USD del mes actual, con su tasa guardada.
  - **Servicios recurrentes:** total combinado de los ciclos USD y UYU.
- `import-parity.spec.ts`. CSV y .xlsx generados en el test, con columnas de nombres no estándar ("F. emisión", "Nro Factura", "Razón social", "Importe s/IVA", "Divisa", "IVA $", "Situación", "Cobrada el"):
  - **UY:** mapeo a mano, previsualización e importación del .xlsx. En la base se verifican folio, tipo, moneda, neto, IVA, estado, fecha de pago y el cliente nuevo.
  - **Reimportación** como CSV: 0 importadas, 3 ya existentes, sin duplicados.
  - El **estado del archivo pisa** el marcado a mano.
  - **CL:** el importador genérico está disponible, la moneda es fija CLP y una fila en USD se rechaza.
  - **Nubox:** la pestaña solo aparece en CL.
- `currency-parity.spec.ts`:
  - **CL:** alta y edición de venta y alta de gasto sin preguntar moneda (CLP fijo).
  - **UY:** USD o UYU obligatorio, sin valor por defecto; la edición conserva la moneda de la venta.
  - **Gasto rápido del trabajo en UY:** elige moneda y se guarda en USD.
  - **Carga rápida de ventas** en ambas empresas: se guarda CLP y USD.
  - Ninguna pantalla ni la guía dice "solo Chile" o "solo Uruguay".

### Bugs encontrados y arreglados

1. **El filtro "Impagas" listaba las notas de crédito.** Se guardan con el default `impago`, y las de Nubox con `pagado` ("no aplica"). Cuando se filtra por estado de pago, `getSalesListRows` ahora deja fuera las notas de crédito. Test unitario: `salesListFilters.test.ts`.
2. **Dos puntos sueltos en el total combinado de Servicios recurrentes** ("Por facturar:8.007,53 UYU"): `MoneyBreakdown` imprimía la etiqueta aunque estuviera vacía. Test unitario: `moneyBreakdown.test.ts`.
3. **Accesibilidad del mapeo de columnas:** los `<label>` de los importadores (ventas y compras) no estaban asociados a su `<select>`. Ahora cada select tiene `aria-label` "Columna para …".

Ajustes de los propios tests, sin relación con la app: un localizador que tomaba el encabezado de la tarjeta, y la subida del archivo antes de que el formulario hidratara (ahora espera la carga).

### Lo que no se probó y por qué

- **Pestaña Nubox:** solo se verificó que aparece en CL. El flujo completo ya lo cubren los tests de integración (`accounting.golden`) y no hay un export real de Nubox para subir.
- **Datos reales de Inmasoft UY:** los specs usan empresas descartables con montos redondos para poder calcular los esperados a mano. Revisar a ojo con los datos reales queda para una persona.
- **Servidor:** el log de `next start` muestra "The destination stream closed early" al navegar mientras una página todavía hace streaming. Es una respuesta cortada por la navegación siguiente y no hace fallar ningún test.
