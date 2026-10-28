# Auditoría INMA-ERP — 2026-10

- **Fecha:** 2026-10-28 · **Rama:** `audit/2026-10` (desde `dev` @ `40d3146`) · **Autor:** Claude (autónomo)
- **Bases:** prod `jxkfpkgyvjiyufmfxsfp` solo lectura (cada consulta dentro de `begin transaction read only`), dev `sczgankronafrxybpvnh`. No se escribió nada en ninguna base (ver §5, decisión D1).
- **Verificación final de la rama:** `tsc` OK · `eslint` 0 errores / 0 warnings (antes 6) · `vitest` 651/651 (antes 650) · `next build` OK.

---

## 1. Resumen ejecutivo

1. El esquema de dev y prod es **idéntico** (huella md5 de columnas, constraints, índices, 121 políticas, 139 funciones, 82 triggers, grants); ambos tienen las 79 migraciones del repo, en orden. Las 43 tablas tienen RLS y el aislamiento entre empresas está bien resuelto (políticas por `company_memberships` + triggers `*_validate_company_refs`).
2. **Lo más urgente era Next 16.3.5**, con 3 advisories críticas (RCE en Image Optimization con SVG y en `use cache`, DoS de Server Actions). Quedó en 16.4.3 en la rama.
3. Datos de prod sanos en lo central: 0 duplicados de ventas o costos, 0 montos que no cuadran, 0 monedas incoherentes, 0 sobrepagos a técnicos, repartos de licencias exactos.
4. Hay 4 problemas de datos reales para corregir en prod (SQL listo, sin ejecutar):
   - 2 notas de crédito de Starlink suman como facturas: 124.368 CLP de costo neto de más.
   - Faltan las tasas CLP→USD de ene–ago 2026: el consolidado en USD marca a Chile como "pendiente" esos meses.
   - Hay 1 pago de técnico de prueba sin aplicaciones.
   - Hay 1 empresa vacía con moneda incoherente.
5. Muchos hallazgos de la auditoría de sep-2026 ya están resueltos (H01–H05, H07, H08, H10, H11, H17). Siguen abiertos H06, H14, H15, H21, H27 y H28; esta rama cerró H13, H23, H25 y H30.

**Top 5 prioridades**

| # | Qué | Dónde |
|---|---|---|
| 1 | Mergear y desplegar el upgrade de Next (A-SEC-01) | commit `95e2729` |
| 2 | Corregir las 2 N/C de Starlink (A-DATA-01) | `audit/fixes_prod.sql` F1 |
| 3 | Cargar las tasas CLP ene–ago 2026, y que un cron guarde la tasa de cada mes (A-DATA-04 / H15) | F4 + pendiente de código |
| 4 | Aplicar la migración `20261029010000_audit_hardening` en dev y prod | commit `a5014c1` |
| 5 | Índices únicos que respalden la deduplicación de imports (A-DB-05) | pendiente (cambio de esquema) |

---

## 2. Tabla de hallazgos

Severidad: crítica / alta / media / baja. Estado: **arreglado** (en esta rama) / **pendiente** (solo reportado).

| ID | Módulo | Sev. | Descripción | Archivo:línea / tabla | Estado | Commit |
|---|---|---|---|---|---|---|
| A-SEC-01 | Dependencias | **crítica** | `next@16.3.5` afectado por 11 advisories (3 críticas: RCE en Image Optimization con SVG, RCE en `use cache` con typed arrays y RCE en `next/og`; altas: SSRF en image optimization y DoS de Server Actions). También tenían advisories `brace-expansion`, `sharp`, `source-map-js`, `vite` y `zod` (transitivas). | `web/package.json` | arreglado: `next`/`eslint-config-next` → 16.4.3 + `npm audit fix` sin `--force` | `95e2729` |
| A-DATA-01 | Costos / Nubox | **alta** | 2 N/C-EL de compra de Starlink (N° 79361 y 80404, 31.092 neto c/u) están guardadas como `invoice` positivas y asignadas a un servicio. Suman +62.184 de costo cuando deberían restar 62.184. El backfill de `20261024050000` las saltó por tener asignación a servicio. | `cost_documents` 1d1c52c8, ef627422 | pendiente (F1) | — |
| A-DATA-04 | Tipo de cambio | **alta** | Las snapshots CLP empiezan en 2026-09, pero las ventas de Chile arrancan en 2026-01. Entre ene y ago 2026, el resultado de Chile en USD sale incompleto y el consolidado lo lista en `pendingRateCompanies`. Causa de fondo (H15, abierto): la tasa de un mes solo se guarda si alguien abre un reporte **durante** ese mes. | `exchange_rate_snapshots`; `web/src/lib/exchangeRates.ts:103-165` | pendiente (F4 + cron) | — |
| A-DB-01 | Técnicos | media | La regla "un pago suma exactamente sus aplicaciones" solo se validaba al INSERT. Borrar una aplicación dejaba un pago aplicado a nada: en prod hay uno (40.000 CLP, técnico "Pepe", sin cargos, 2026-09-21; parece de prueba). | trigger `technician_payment_check_balanced` | arreglado (trigger en DELETE) + dato pendiente (F2) | `a5014c1` |
| A-SEC-02 | IA | media | Las API keys de proveedores de IA se guardan en texto plano (`user_ai_settings.api_key`). RLS limita la lectura a su dueño, pero quedan legibles con service role y en todos los backups JSON. | `user_ai_settings`; `web/src/lib/ai/settings.ts:30` | pendiente (Supabase Vault / pgsodium) | — |
| A-DB-02 | RLS / performance | media | Las 121 políticas usan `auth.uid()` sin envolver en `(select auth.uid())`, así que Postgres la re-evalúa por fila (advisor `auth_rls_initplan`). Con 1.594 costos en Chile ya se nota en listados y reportes. | `pg_policies` (todas) | pendiente (migración mecánica, ver §4) | — |
| A-DB-05 | Importadores | media | La deduplicación de imports es "chequear y después insertar", sin lock ni índice único (H14 y H27). Faltan `cost_documents (company_id, supplier_id, source_document_type, document_number)` y `clients (company_id, normalize_tax_id(tax_id))`. Dos imports simultáneos pueden duplicar. Hoy hay 0 duplicados en prod, así que los índices se pueden crear. | `import_cost_rows_batch`, `import_sales_rows_batch`, `clients` | pendiente (cambio de esquema) | — |
| A-CODE-01 | Importadores | media | Un CSV re-guardado por Excel en Windows‑1252 se leía como UTF‑8 y creaba clientes llamados "Construcci�n �and�" (H13). | `web/src/lib/importFile.ts`, `…/sales/import/nubox/actions.ts:130` | arreglado (fallback a Windows-1252 + test) | `de8618a` |
| A-CODE-04 | UI | media | 107 mensajes de error en **inglés** ("Please select a client.", "You don't have permission…") en 18 server actions de una UI en español. | p. ej. `…/recurring-services/services/new/actions.ts:98`, `…/projects/[projectId]/edit/actions.ts:35` | pendiente (§5 D4) | — |
| A-CODE-07 | Paridad CL/UY | media | En Chile, el formulario de servicios recurrentes **fuerza CLP** (`country === "CL" ? "CLP"`), así que una empresa chilena no puede tener un servicio en USD, contra la regla "local + USD". Las demás diferencias por país son de diseño: el flujo de técnicos con respaldo factura/boleta es solo de Chile, y Uruguay usa monto + "IVA incluido". | `…/recurring-services/currency-field.tsx:27`, `…/services/new/form.tsx:74` | pendiente (regla de negocio) | — |
| A-DEP-01 | Dependencias | media | Siguen abiertos `vitest@3` (críticas en `tinypool` y `@vitest/mocker`; solo afecta a dev/CI y pide un salto a v5) y `uuid` vía `exceljs` (el único fix es bajar exceljs a 3.x). | `web/package.json` | pendiente | — |
| A-SEC-03 | Seguridad DB | baja | 6 funciones SECURITY DEFINER seguían ejecutables por `anon`: `create_company`, `delete_technician_charge`, `update_technician_charge`, `update_import_batch_counts`, `update_cost_import_batch_counts` y `seed_default_business_areas` (H25). Todas validan `auth.uid()` adentro, así que no hubo exposición real. | `pg_proc` | arreglado (revoke anon) | `a5014c1` |
| A-SEC-04 | Cron | baja | `CRON_SECRET` se comparaba con `===` (comparación no constante). | `web/src/app/api/cron/recurring-service-occurrences/route.ts:20` | arreglado (`timingSafeEqual`) | `82f4525` |
| A-SEC-05 | MCP | baja | Los tokens MCP no vencen y se aceptan por `?token=` (tradeoff documentado). Hay 1 token activo ("Nacho") sin uso desde 2026-09-23. | `web/src/lib/mcp/auth.ts:31`; `mcp_access_tokens` | pendiente (vencimiento) + F8 | — |
| A-SEC-06 | Seguridad DB | baja | `anon` conserva SELECT/INSERT/UPDATE en las 43 tablas (grants por defecto de Supabase). RLS lo bloquea porque todas las políticas son `TO authenticated`, pero es defensa en una sola capa. | `information_schema.role_table_grants` | pendiente (revoke all on tables from anon) | — |
| A-DB-03 | Índices | baja | 14 FKs de join/lookup sin índice, entre ellas `recurring_service_occurrences.sales_document_id`, `sales_documents.business_area_id` e `import_row_id`, `cost_import_rows.cost_document_id` y `company_memberships.company_id`. | ver migración | arreglado | `a5014c1` |
| A-DB-04 | Multiempresa | baja | `client_aliases` no validaba que `client_id` fuera de la misma empresa que el alias (es la única tabla con `client_id` sin ese trigger). | `client_aliases` | arreglado (trigger) | `a5014c1` |
| A-DB-06 | Convención | baja | El signo de las N/C es distinto según la tabla: en **ventas** se guardan positivas y se restan en código (`signedSalesAmount`); en **costos** se guardan negativas (CHECK). Cualquier suma nueva de ventas que olvide el signo infla el ingreso. Hoy hay 8 N/C de venta, todas positivas, y se manejan bien. | `web/src/lib/reporting.ts:86`; CHECK `cost_documents_document_type_sign_check` | pendiente (regla de cálculo, no se toca) | — |
| A-DB-07 | Constraints | baja | Faltan constraints que hoy se cumplen en el 100 % de los datos de prod: `net+tax+other = total` en ventas, `net+tax+other = total` en costos (el neto incluye el exento), signo de N/C en ventas y `cost_allocations.percentage` entre 0 y 100. Además, los CHECK `projects_quoted_amount_check` y `projects_cost_budget_check` siguen `NOT VALID`, aunque hay 0 violaciones. | `sales_documents`, `cost_documents`, `projects` | pendiente | — |
| A-DB-08 | Recurrentes | baja | El cron corre una vez por mes (`0 6 1 * *`) sin reintento (H06). Está mitigado: `ensure_recurring_service_periods` completa los períodos al usar las pantallas, y en prod no falta ningún período mensual desde 2026-01 (R02 = 0). | `web/vercel.json` | pendiente (cron diario, es idempotente) | — |
| A-CODE-02 | Dashboard | baja | La home tragaba los errores de `computeMonthlyResult` (`catch { return null }`) y mostraba la tarjeta vacía (H23). | `web/src/app/page.tsx:30` | arreglado (log + "No se pudo calcular") | `761ca7e` |
| A-CODE-03 | Lint | baja | 6 warnings: 5 de variables `_` sin usar y 1 de `exhaustive-deps` en el importador de costos (H30). | `eslint.config.mjs`, `…/costs/import/form.tsx:95` | arreglado (0 warnings) | `64f80a0` |
| A-CODE-05 | Reportes | baja | `computeClientProfitability` y `computeAreaProfitability` no las usa ninguna pantalla (solo un test). Conservan la aritmética vieja: costos con IVA, N/C sumadas y sin conversión de moneda. Es una trampa si alguien las reutiliza. | `web/src/lib/reporting.ts:1092`, `:1189` | arreglado parcial (`@deprecated`); borrar = pendiente | `1ba328d` |
| A-CODE-08 | Fechas | baja | `isCurrentMonth` de tipo de cambio usa UTC: entre las 21 h y las 24 h del último día del mes, en Chile ya cuenta como el mes siguiente (H28, parcial; `company_local_date` ya existe en DB). | `web/src/lib/exchangeRates.ts:253` | pendiente | — |
| A-CODE-09 | Nubox | baja | `normalizeRut` no valida el dígito verificador (H21). | `web/src/lib/nubox.ts:148` | pendiente | — |
| A-DB-09 | Operación | baja | Prod tiene 3 esquemas de backup (`backup_20261004`, `backup_20261013_import_uy`, `backup_20261015`; 26 tablas). No están expuestos a anon ni a authenticated (verificado). | prod | pendiente (F7) | — |

**Verificado y correcto** (sin hallazgo):
- RLS en las 43 tablas y aislamiento por `company_memberships`. `mcp_pending_drafts` no tiene políticas a propósito (solo service role).
- Triggers de empresa cruzada en todas las tablas hijas (salvo `client_aliases`, ya corregido).
- `ON DELETE CASCADE` solo en hijos legítimos.
- `exchange_rate_snapshots` solo lectura para usuarios (H07 cerrado).
- MCP firma como el usuario y no usa service role para datos (H04 cerrado).
- Endpoints `/api/assistant/*` con sesión + membresía.
- El service role solo se importa en el cron, en MCP y en `exchangeRates`.
- No hay secretos commiteados (solo `web/.env.example`, vacío).
- Parser de montos CL/UY estricto, que rechaza lo ambiguo (`web/src/lib/amounts.ts`).
- Nubox exige enteros.
- Cálculo de boleta de honorarios: probé líquido→bruto→líquido para todo líquido de 1 a 2.000.000 con las 4 tasas (14,5 %, 15,25 %, 16 % y 17 %) y dio 0 diferencias de redondeo.
- Factura de técnico: neto↔total con IVA 19 % redondeado a peso.
- Consultas grandes paginadas (`selectAll` / `fetchAllPages`), lo que evita el corte de 1.000 filas de PostgREST: Chile ya tiene 1.594 costos.

---

## 3. Inconsistencias de datos en prod

Todas las consultas están en **`audit/consultas_prod.sql`** (bloques 1–4). Se corrieron el 2026-10-28, solo lectura. El SQL de corrección está en **`audit/fixes_prod.sql`**, sin ejecutar.

Contexto: hay 3 empresas.
- **Chile** (CL/CLP): 188 ventas y 1.594 costos.
- **Uruguay** (UY/UYU): 19 ventas y 3 costos.
- **Inmasoft Uruguay**: sin país, en CLP y vacía.

### 3.1 Requieren corrección

| ID | Chequeo | Conteo | Detalle | Fix |
|---|---|---|---|---|
| A-DATA-01 | D27: N/C de compra guardada como factura positiva | **2** | Starlink N° 79361 y 80404 (2026-08), 31.092 neto / 36.999 total c/u, con asignación a servicio | F1 |
| A-DATA-04 | X01: meses sin snapshot de tipo de cambio desde 2025-01 | **31** | CLP 2025-01…2026-08 (20; relevante 2026-01…08). UYU 2025-01…11 (11; sin documentos UY en ese rango) | F4 (las tasas las tiene que conseguir el usuario: no se inventan) |
| A-DATA-02 | T02: pago a técnico ≠ suma de aplicaciones | **1** | 67448a9a, 40.000, "Pepe" (0 cargos), 0 aplicaciones | F2 |
| A-DATA-03 | D01b: empresa sin país | **1** | "Inmasoft Uruguay" b10291f2, moneda CLP, 0 miembros y 0 datos | F3 (desactivar) |
| A-DATA-05 | R03: período recurrente facturado o cobrado sin factura ni asignación | **12** | 10 de "Mantenimiento Happydog" (UY, 2025-12…2026-09), "Microsoft RAZO" 2026-08 y "Microsoft idarwin" 2026-09 (CL). Relacionado, S15: 10 sin `invoiced_at` | F5 (revisión: asignar la factura real desde la app) |
| A-DATA-06 | U02: cliente con el mismo nombre dos veces | **1** | "pekes pro spa" con RUT 15045498-0 y 76982985-7, ambos activos | F6 (revisión) |
| A-DATA-07 | S16: tablas en esquemas `backup_*` | **26** | 3 esquemas; S17 = 0 expuestas | F7 |
| A-DATA-08 | M02: token MCP activo sin uso hace más de 30 días | **1** | "Nacho", último uso 2026-09-23 | F8 (opcional) |

### 3.2 Seguimiento de negocio (no son errores de datos)

| Chequeo | Conteo | Lectura |
|---|---|---|
| R04: períodos "por facturar" de hace más de 3 meses (servicios activos) | 42 | Todos de Chile. Son anuales de hosting (planes 2025) y MS mensuales (RAZO 6, TREI 6, SIMTA 6, TOTAL GP 5, Licencias Razo 5, idarwin 4). Es la deuda real a facturar, o servicios que habría que pausar. |
| P01: trabajos finalizados y facturables sin ninguna venta | 3 | "Redes en colegios del interior" (36,5 M cotizado), "GPS" y "Tintas Wind", creados en oct-2026. |
| D17: trabajos `por_cotizar` sin cotización | 5 | Permitido por la regla. |
| S02: ventas `pagado` sin `paid_at` | 141 | El CSV de Nubox no trae la fecha de pago. |
| C04: costos generales sin ninguna asignación | 1.555 | Gastos generales de la empresa importados de Nubox (2022-08…2026-10). Es lo normal. |
| D21: `import_rows` "imported" sin venta | 9 | El script `import-uy-2026` usó `import_rows` como bitácora (áreas, proveedores, proyectos, costos). No es un huérfano real. |
| D08: N/C de venta positivas | 8 | Es la convención (ver A-DB-06). Las 8 restan bien en los reportes. |

### 3.3 Chequeos en 0 (prod sano)

- **Montos y monedas:**
  - D01–D04: monedas coherentes con la empresa, y neto+IVA+otros = total en ventas.
  - D05: en costos, neto+IVA+otros = total, porque `net_amount` **incluye** el exento. Así lo define la migración `20261024050000`, y los 20 documentos con exento cumplen esa regla.
  - D06/D07: CLP sin decimales.
  - D09: ninguna venta que no sea N/C es negativa.
- **Duplicados:** D10–D15, sin duplicados de ventas ni de costos, ni con número ni sin él, y sin overrides.
- **Integridad de imports y relaciones:** D16, D18–D20 y D22–D26 (líneas, tasas por documento, import rows y empresas cruzadas en cotizaciones).
- **Recurrentes y repartos:**
  - R01, R02, R05–R12: ocurrencias, monedas, asignaciones de venta y de servicio, pool MS exacto, sin partes negativas ni asignadas a anuladas.
  - C01/C02: % = 100 y montos fijos = total. La regla de `set_cost_document_allocations` es sobre el total con IVA; una primera versión del chequeo comparaba contra el neto y daba un falso positivo.
- **Técnicos:** T01, T03–T10 (sin sobrepagos, estados de respaldo coherentes, costo del cargo = neto del documento, sin cruces de técnico o empresa, boletas con tasa).
- **Maestros y trabajos:** U01, U03, P02–P04.
- **Cobros, N/C y fechas:** S01, S03–S09, S13, S14.
- **Esquema:** la huella del bloque 4 es igual en dev y en prod.

---

## 4. Optimizaciones propuestas

| Propuesta | Impacto estimado | Esfuerzo |
|---|---|---|
| Reescribir las 121 políticas con `(select auth.uid())` en lugar de `auth.uid()` (migración mecánica: `alter policy … using (…)`) | Alto en listados y reportes grandes: Postgres evalúa el `EXISTS` sobre `company_memberships` una vez por consulta en vez de una vez por fila. Típicamente 2–10× en tablas de miles de filas. | Medio (1 migración generada + verificación con la huella del bloque 4) |
| Índices de FK faltantes | Bajo hoy (volúmenes chicos); evita seq scans al crecer. Joins de Nubox↔ocurrencias y filtros por área. | Hecho (`a5014c1`) |
| Cron diario en vez de mensual + snapshot de tipo de cambio en el cron | Elimina meses sin generar y meses sin tasa (A-DATA-04, A-DB-08) | Bajo (`vercel.json` + llamar a `getOrSnapshotRate` desde el cron) |
| Índices únicos de deduplicación (A-DB-05) + `pg_advisory_xact_lock(company)` en los batch import | Cierra la carrera de imports simultáneos y deja la deduplicación garantizada por la DB | Bajo–medio |
| Borrar `computeClientProfitability`/`computeAreaProfitability` y su test | −200 líneas de código muerto con aritmética divergente | Bajo |
| Traducir los 107 mensajes de error y centralizarlos | Consistencia de UI | Medio (revisar tests que comparan textos) |
| Subir `vitest` a v5 y evaluar `@anthropic-ai/sdk` 1.x y `typescript` 7 | Cierra advisories de dev y mantiene el stack al día | Medio (majors) |
| Cifrar `user_ai_settings.api_key` con Vault | Los backups dejan de contener las keys de IA | Medio |

---

## 5. Decisiones tomadas sin consultar

- **D1 — La migración no se aplicó a dev.** Se validó en dev dentro de una transacción con `ROLLBACK`: anon revocado, alias cruzado rechazado, alias válido aceptado, borrar una aplicación rechazado y borrar el pago entero aceptado. Después confirmé que dev seguía en 79 migraciones, sin las funciones nuevas.
  - Motivo: aplicarla dejaría la DB de dev con una migración que la rama `dev` no tiene. El próximo `db push` del equipo (Nacho también pushea a dev) fallaría con "remote migration not found".
  - Se aplica al mergear (§6).
- **D2 — Prod se leyó con `--project-ref` sin re-linkear el CLI.** Todo corrió en `begin transaction read only`, con un wrapper que rechaza cualquier SQL que no empiece con SELECT/WITH.
- **D3 — Next se subió 16.3.5 → 16.4.3 (minor)** como fix de seguridad. `vitest` no se subió: es un major y solo de dev. `exceljs` tampoco: su fix es un downgrade.
- **D4 — No traduje los 107 mensajes en inglés.** Es un diff grande, hay tests que pueden comparar textos y no cambia comportamiento. Quedó reportado.
- **D5 — No borré las funciones de reporte muertas**, por la regla "no borrar" y porque un test las usa. Las marqué `@deprecated`.
- **D6 — No creé índices únicos ni CHECKs nuevos de montos.** Cambian comportamiento: un import o un alta pueden empezar a fallar. Van como cambio de esquema a decidir.
- **D7 — Reinterpreté dos chequeos al leer el código:**
  - C02: las asignaciones de costo suman el **total con IVA**, no el neto.
  - D05: `net_amount` incluye el exento.
  - Los dos "hallazgos" iniciales eran falsos positivos y se corrigieron en `consultas_prod.sql`.
- **D8 — No corrí `npm run test:integration` ni los e2e de Playwright.** Escriben datos en dev y los e2e necesitan login. Los cambios de esta rama quedan cubiertos por tests unitarios, tsc, lint y build.
- **D9 — Cada bloque de `fixes_prod.sql` termina en `ROLLBACK`** y trae una precondición SELECT. Ejecutarlo por accidente no cambia nada.
- **D10 — Los archivos sin trackear previos quedaron fuera de los commits**: `docs/brief-para-ia.md` y `node_modules/` en la raíz.

---

## 6. Cómo revisar y mergear a `dev`

1. Revisar la rama:
   ```bash
   git fetch origin && git log --oneline origin/dev..origin/audit/2026-10
   ```
   Son 8 commits chicos: migración, cron, home, lint, deprecated, Next, encoding, e informe con su SQL.
2. Instalar y verificar en `web/`:
   ```bash
   npm ci && npx tsc --noEmit -p . && npx eslint . && npx vitest run && npm run build
   ```
3. Antes de mergear, aplicar la migración en **dev**. El link del CLI ya apunta a dev: confirmar con `supabase/.temp/project-ref`.
   ```bash
   npx supabase db push --linked --dry-run
   npx supabase db push --linked
   ```
   Si después querés correr las integraciones: `npm run test:integration`.
4. Mergear:
   ```bash
   git checkout dev && git merge --no-ff audit/2026-10 && git push origin dev
   ```
   Antes, mirar `git ls-remote origin refs/heads/dev` por si Nacho pusheó algo.
5. Deploy a prod, con el procedimiento habitual (backup → huella → `migration list --project-ref jxkfpkgyvjiyufmfxsfp` → `db push --project-ref …` → merge a main). La migración es aditiva: revokes, 2 triggers nuevos y 14 índices, sin cambios de datos.
6. Datos de prod: revisar `audit/fixes_prod.sql` bloque por bloque, correr la precondición y cambiar `ROLLBACK` por `COMMIT` solo en lo aprobado. F1 y F2 necesitan OK de negocio; F4 necesita las tasas reales.
