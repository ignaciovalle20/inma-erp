# Deploy a producción — asignación por importe, factura mixta e importación Nubox (2026-10-25)

- **Resultado final:** **DESPLEGADO.**
  - Las migraciones `20261024040000_cost_allocations_position`, `20261024050000_cost_import_exempt_and_credit_notes` y `20261025010000_cost_mixed_service_allocations` quedaron aplicadas en prod, en ese orden (**76/76**).
  - `dev` (`d92a1de`) se mergeó a `main` sin squash: `b85069b`.
  - Vercel Production quedó **Ready** con ese commit: GitHub lo marcó "success" ("Deployment has completed") a las 21:04:57.
  - Datos: 34 de 39 tablas idénticas fila por fila. Los cambios en las otras 5 son los esperados (ver Fase C), salvo un efecto lateral en 2 filas de `cost_allocations` (ver "Pendiente", punto 1).
- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`). Todos los comandos usaron `--linked --project-ref jxkfpkgyvjiyufmfxsfp`; la CLI sigue linkeada a DEV (`sczgankronafrxybpvnh`).
- **Respaldo:** `G:\INMA-ERP\backups\prod-2026-10-25\` (fuera de git: `/backups/` en `.git/info/exclude`).

**Qué entra:**

| Commit | Cambio |
|---|---|
| `887cad4` | "Editar asignación": porcentaje e importe editables en cada fila, importes enteros en CLP, "Partes iguales" y "Completar el faltante" exactos, aviso "Te pasaste por X". Las filas guardan su orden (`cost_allocations.position`). |
| `8b75e84` | Importación de compras de Nubox: facturas exentas (Neto + Exento), notas de crédito en negativo, número de documento y otros impuestos. Corrige lo ya importado (backfill). |
| `d92a1de` | Factura mixta: una factura se reparte entre servicios recurrentes y trabajos, clientes o áreas desde "Editar asignación" (`set_cost_document_allocations`). |

Las tres migraciones se aplicaron **antes** del merge, porque el código nuevo lee las columnas nuevas. La app anterior seguía funcionando con ellas: solo agregan columnas, y las funciones nuevas mantienen la firma de las viejas.

## Cronología (2026-10-25, −03)

| Hora | Paso | Resultado |
|---|---|---|
| 20:5x | Chequeos previos (solo lectura) | 73 migraciones en prod; pendientes exactamente las 3 de este deploy |
| 20:5x | Vista previa del backfill de Nubox (solo lectura) | 1.574 documentos de Nubox: 161 a corregir (25 notas de crédito), neto total −4.474.692 CLP, 2 se dejan como están |
| 20:57–21:01 | Huella y respaldo JSON de prod | 39 tablas `public`, 6.749 filas; conteos iguales a la huella |
| 21:01:49–21:01:56 | `supabase db push` a prod | Las 3 migraciones aplicadas sin error, en orden |
| 21:02 | Verificación (solo lectura) | OK, con el efecto lateral de "Pendiente" punto 1 |
| 21:04:17 | Merge `dev` → `main` (`b85069b`, `--no-ff`, en un worktree temporal) y push | El árbol resultante es idéntico al de `dev` |
| 21:04:57 | Vercel Production | **Ready** |
| 21:05:43 | CI en `main` ("Types, lint and tests") | success. "Apply migrations" se salteó, como siempre (`DB_MIGRATIONS_ENABLED` apagado) |

## Fase A — Chequeos previos (solo lectura)

- `main` solo tenía merges `--no-ff` de deploys anteriores. `dev` tenía 3 commits nuevos: `887cad4`, `8b75e84` y `d92a1de`.
- `supabase migration list` en prod: 73 aplicadas y las 3 de hoy pendientes. En dev ya estaban aplicadas (76).
- Las 6 funciones que reemplazan las migraciones tienen en prod el mismo cuerpo que su última migración anterior. Se comparó el md5 del texto con los saltos de línea normalizados: `set_cost_allocations` (`20260913030000`), `cost_documents_protect_financial_fields` (`20260921020000`), `delete_cost_document` e `import_cost_rows_batch` (`20261024020000`), `cost_service_allocations_validate` y `cost_allocations_guard_service_allocations` (`20261020010000`). No se pisó ningún cambio hecho a mano. `set_cost_document_allocations` no existía.
- Dry-run de `db push` contra prod: exactamente las 3 migraciones, en orden.
- Antes, en dev: `tsc --noEmit` OK, `npm test` 623/623, `npm run build` OK, la suite de integración (100 OK, 9 omitidos) y los e2e `cost-allocation-amounts` (4/4) y `cost-allocation-mixed` (3/3).

## Respaldo y cómo restaurar

En `G:\INMA-ERP\backups\prod-2026-10-25\`:

| Archivo | Contenido |
|---|---|
| `data.json` | Las 39 tablas `public`, como `{ "public.tabla": [filas] }`. Incluye `mcp_access_tokens` y `user_ai_settings`: no compartir. No incluye `auth` (las migraciones no lo tocan). |
| `counts-backup.json` | Filas por tabla en el respaldo, iguales a los conteos de la huella. |
| `fingerprint-before.json` / `fingerprint-after.json` | Por tabla: cantidad de filas y md5 de todas sus filas ordenadas. |
| `schema-before.json` | Antes del deploy: la definición completa de las 6 funciones reemplazadas, las columnas y las constraints de `cost_documents`, `cost_lines`, `cost_allocations`, `cost_service_allocations` y `cost_import_rows`. |
| `changed-documents.json` | Los ids de los 161 documentos con montos corregidos por el backfill de Nubox. |

El respaldo se armó con `query_to_xml`, y los textos se desescaparon (`&amp;`, `&lt;`…) al guardarlo. Se verificó que no quedan entidades ni caracteres mal codificados.

No es un dump SQL reimportable. Para volver atrás:

- **Esquema:** primero hay que revertir el código (`main` a `84c0a18`). Después, con una migración inversa:
  - recrear las 6 funciones desde `schema-before.json` y borrar `set_cost_document_allocations`;
  - quitar las columnas nuevas: `cost_allocations.position`, `cost_service_allocations.gross_amount` y `position`, las 5 de `cost_documents` y las 2 `deleted_*` de `cost_import_rows`;
  - quitar la constraint `cost_documents_document_type_sign_check` y el índice `cost_documents_document_number_idx`.
- **Datos:** los montos de los 161 documentos y sus líneas se restauran desde `data.json` (`net_amount`, `tax_amount`, `total_amount`, `updated_at` y `cost_lines.amount`), con el trigger `cost_documents_protect_financial_fields` desactivado durante el `update`.

## Fase B — Deploy

1. `supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp --yes`: las 3 migraciones, en orden de versión.
2. `git merge --no-ff origin/dev` sobre `origin/main` en un worktree temporal → `b85069b`, push a `origin/main`.
3. El deploy se siguió por el estado público del commit en la API de GitHub (`context: Vercel`).

## Fase C — Verificación (solo lectura)

| Chequeo | Resultado |
|---|---|
| Historial de migraciones | **76**, la última `20261025010000` |
| Las 7 funciones (6 reemplazadas + `set_cost_document_allocations`) | El cuerpo en prod coincide (md5) con el de las migraciones nuevas |
| `set_cost_document_allocations` | Execute para `authenticated`, no para `anon` |
| Columnas nuevas | `cost_allocations.position`; `cost_service_allocations.gross_amount` y `position`; `cost_documents.document_type`, `source_document_type`, `document_number`, `exempt_amount` y `other_taxes` |
| Datos, tabla por tabla | 34 tablas con el mismo md5 antes y después. Cambian solo `cost_documents`, `cost_lines`, `cost_import_rows`, `cost_allocations` y `cost_service_allocations` (por las columnas nuevas y el backfill) |
| `cost_documents` | Mismas 1.597 filas. 161 con montos corregidos, y ninguna otra columna original cambiada aparte de `updated_at` en esas 161. 25 notas de crédito ahora en negativo. Neto total −4.474.692 CLP, igual a la vista previa. 1.574 con número de documento |
| `cost_lines` | Mismas 1.597 filas: cambian solo las 161 líneas de los documentos corregidos, cada una igual al nuevo neto de su documento |
| `cost_import_rows` | Mismas 1.781 filas; ninguna columna original cambió |
| `cost_service_allocations` | Mismas 16 filas, sin cambios; `gross_amount` y `position` en NULL (fueron asignadas desde "Asignar a servicios") |
| `cost_allocations` | Mismas 2 filas, con montos y destinos iguales, `position` 0 y 1. **`updated_at` y `updated_by` cambiaron** (ver "Pendiente", punto 1) |
| Sitio | `https://inma-erp.vercel.app/login` 200; `/` y `/companies` redirigen a `/login` (307) |
| Smoke test con usuario real | **No se hizo:** no hay credenciales de producción en el entorno (`web/.env.local` apunta a dev) |

## Pendiente (para revisar a mano)

1. **Efecto lateral en `cost_allocations`.** El backfill de `position` disparó el trigger `set_updated_at` en las 2 filas que existían, del mismo documento. `updated_at` pasó de `2026-10-19 13:10:20` a la hora del deploy, y `updated_by` quedó en NULL; antes era el usuario `24a15703-…`. Los montos y destinos no cambiaron. Los valores originales están en `data.json` y se pueden restaurar con un `update` hecho con ese trigger desactivado. La migración debió desactivarlo, como hace la de Nubox.
2. **Dos notas de crédito de Starlink sin corregir** (empresa Chile): `ef627422-…` del 2026-08-06 y `1d1c52c8-…` del 2026-08-20, de 31.092 neto y 36.999 total cada una. El backfill las saltó a propósito porque ya estaban asignadas a servicios. Siguen en **positivo**, así que suman costo en vez de restarlo. Hay que quitarles la asignación, pasarlas a negativo y decidir cómo descontarlas de los servicios.
3. Smoke test en el navegador con un usuario real:
   - abrir "Editar asignación" de un costo general y comprobar que se edita el importe y que aparece el tipo "Servicio";
   - revisar en Costos un documento importado que sea nota de crédito (monto negativo).
4. El e2e `web/e2e/recurring-service-costs.spec.ts` busca la columna de importación "Importe neto", que `8b75e84` renombró a "Neto": hay que actualizarlo. No corre en CI.
5. Borrar el respaldo `G:\INMA-ERP\backups\prod-2026-10-25\` cuando ya no haga falta.
