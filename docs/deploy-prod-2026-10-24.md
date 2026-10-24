# Deploy a producción — eliminar servicio recurrente y eliminar gasto (2026-10-24)

- **Resultado final:** **DESPLEGADO.**
  - Las migraciones `20261024010000_delete_recurring_service` y `20261024020000_delete_cost_document` quedaron aplicadas en prod, en ese orden (**72/72**).
  - `dev` (`978cdf0`, con `629ee3a`) se mergeó a `main` sin squash: `b3e38bd`.
  - Vercel Production quedó **Ready** con ese commit (`dpl_GLwXzH6TegD1jR2iYd1R9bjcmxyP`). GitHub lo marcó "success" ("Deployment has completed") a las 07:13:38.
  - Ningún dato cambió: 38 de 39 tablas son idénticas fila por fila; `cost_import_rows` solo ganó 5 columnas nuevas, todas en NULL (ver Fase D).
- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`). Todos los comandos usaron `--linked --project-ref jxkfpkgyvjiyufmfxsfp`; la CLI sigue linkeada a DEV (`sczgankronafrxybpvnh`).
- **Respaldo:** `G:\INMA-ERP\backups\prod-2026-10-24\` (fuera de git: `/backups/` en `.git/info/exclude`).
- **Qué hace el cambio:** "Eliminar servicio" en la ficha del servicio (commit `629ee3a`) y "Eliminar" en cada gasto, en el Trabajo, en Costos y en "Ver" (commit `978cdf0`). Detalle en `docs/manual-usuario.md`, secciones 8.6 y 9.

Las dos migraciones son aditivas: crean funciones y policies, agregan columnas nulas a `cost_import_rows` y reemplazan `import_cost_rows_batch` por una versión que además saltea las facturas eliminadas. La app desplegada antes funcionaba igual con ellas, así que se aplicaron **antes** del merge: no hubo ventana con código nuevo y esquema viejo.

## Cronología (2026-10-24, −03)

| Hora | Paso | Resultado |
|---|---|---|
| 07:0x | Chequeos previos (solo lectura) | 70 migraciones en prod; pendientes exactamente `20261024010000` y `20261024020000`; ninguna de las funciones ni policies nuevas existía |
| 07:08 | Respaldo JSON de prod | 39 tablas `public` |
| 07:09 | Huella de datos y esquema afectado, antes | Conteo y md5 de todas las filas de cada tabla, más los objetos de `storage.objects` del bucket `cost-receipts` |
| 07:09:37–07:09:43 | `supabase db push` a prod | Las 2 migraciones aplicadas sin error, en orden |
| 07:10 | Verificación (solo lectura) | OK |
| 07:12:33 | Merge `dev` → `main` (`b3e38bd`, `--no-ff`, en un worktree temporal) y push | El árbol resultante es idéntico al de `dev` |
| 07:13:38 | Vercel Production | **Ready** (`dpl_GLwXzH6TegD1jR2iYd1R9bjcmxyP`) |

## Fase A — Chequeos previos (solo lectura)

- `main` solo tenía los merges `--no-ff` de deploys anteriores (ningún commit propio). `dev` tenía dos commits nuevos, `629ee3a` y `978cdf0`: entraron 25 archivos.
- `supabase migration list` en prod: 70 aplicadas, las dos de hoy pendientes. En dev ya estaban aplicadas (72).
- En prod no existían `delete_recurring_service`, `delete_cost_document` ni ninguna policy DELETE sobre `cost_documents`, `cost_lines`, `cost_document_attachments` o `storage.objects`. El bucket `cost-receipts` existe y no tiene archivos.
- `import_cost_rows_batch` (que la segunda migración reemplaza): el cuerpo en prod es idéntico al de su migración original `20260915060000`. Se comparó el texto con los saltos de línea normalizados, y el md5 coincide (`992a0cc0…`). El hash completo era distinto al de dev solo por los CRLF guardados en dev, así que no se pisó ningún cambio hecho a mano en prod.
- Dry-run de `db push` contra prod: exactamente las dos migraciones, en orden.
- En `web/` (sobre `978cdf0`, en la sesión del cambio): `tsc --noEmit` OK, `npm test` 584/584, `npm run build` OK. El e2e `e2e/cost-document-delete.spec.ts` (4/4) y el de eliminar servicio pasaron contra dev.

## Respaldo y cómo restaurar

En `G:\INMA-ERP\backups\prod-2026-10-24\`:

| Archivo | Contenido |
|---|---|
| `data.json` | Las 39 tablas `public`, como `{ "public.tabla": [filas] }`. Incluye `mcp_access_tokens` y `user_ai_settings`: no compartir. No incluye `auth` (las migraciones no lo tocan). |
| `counts-backup.json` | Filas por tabla en el respaldo, iguales a los conteos de la huella. |
| `fingerprint-before.json` / `fingerprint-after.json` | Por tabla: cantidad de filas y md5 de todas sus filas ordenadas; también los objetos del bucket `cost-receipts`. |
| `schema-before.json` | Antes del deploy: las policies de las tablas de costos, servicios y `storage.objects`, la definición de `import_cost_rows_batch` y las columnas de `cost_import_rows`. |

Nota del respaldo: se armó con `query_to_xml`, que deja escapados como entidades XML los `&`, `<` y `>` de los textos (había 9: "R&S FARMA", "finalizado -> cerrado"…). Se corrigieron en `data.json`. Después, las 1.781 filas de `cost_import_rows` del respaldo coinciden campo por campo con las de prod.

No es un dump SQL reimportable. Para volver atrás:

- **Esquema:** primero hay que revertir el código (`main` a `a40b330`). Después, con una migración inversa: `drop function public.delete_recurring_service(uuid)`, `drop function public.delete_cost_document(uuid)`, borrar las 4 policies DELETE nuevas, recrear `import_cost_rows_batch` desde `schema-before.json` y quitar las 5 columnas `deleted_*` de `cost_import_rows`. No se preparó porque la verificación pasó.
- **Datos:** ninguno cambió en el deploy.

## Fase B — Deploy

1. `supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp --yes`: `20261024010000_delete_recurring_service` y después `20261024020000_delete_cost_document`.
2. `git merge --no-ff origin/dev` sobre `origin/main` en un worktree temporal → `b3e38bd`, push a `origin/main`.
3. La CLI de Vercel no tiene acceso al equipo y `gh` no está autenticado. El deploy se siguió por el estado público del commit en la API de GitHub (`context: Vercel`).

## Fase C — Verificación (solo lectura)

| Chequeo | Resultado |
|---|---|
| Historial de migraciones | **72**, la última `20261024020000` |
| `delete_recurring_service(uuid)` | Existe, `security definer`, `search_path=""`; execute para `authenticated`, no para `anon` |
| `delete_cost_document(uuid)` | Existe, `security definer`, `search_path=""`; execute para `authenticated`, no para `anon` |
| `import_cost_rows_batch(uuid, jsonb)` | Reemplazada (security invoker, como antes): incluye el salteo de facturas eliminadas; execute para `authenticated`, no para `anon` |
| Policies DELETE nuevas, solo para miembros de la empresa (`company_memberships`), rol `authenticated` | `cost_documents`, `cost_lines`, `cost_document_attachments`, `storage.objects` del bucket `cost-receipts` (la carpeta raíz es la empresa) |
| Policies DELETE que ya estaban | `cost_allocations` y `cost_service_allocations`, sin cambios |
| Grant DELETE de `authenticated` en `cost_document_attachments` | Sí |
| `cost_import_rows` | 5 columnas nuevas (`deleted_at`, `deleted_by`, `deleted_supplier_id`, `deleted_document_date`, `deleted_total_amount`), todas en NULL en las 1.781 filas |
| Datos, tabla por tabla | 38 tablas con el mismo md5 de todas sus filas antes y después. `cost_import_rows` cambia de md5 solo por las columnas nuevas: sus 8 columnas originales coinciden fila por fila con el respaldo |
| Bucket `cost-receipts` | 0 objetos antes y después |
| Sitio | `https://inma-erp.vercel.app/login` 200; `/` y `/companies` redirigen a `/login` (307) |
| Smoke test con usuario real | **No se hizo:** no hay credenciales de producción en el entorno (`web/.env.local` apunta a dev). No se borró nada en prod para probar |

Conteos (antes = después): cost_documents 1.598, cost_lines 1.598, cost_import_rows 1.781, cost_allocations 2, cost_service_allocations 16, cost_document_attachments 0, technician_charges 15, recurring_services 39, recurring_service_occurrences 137, recurring_service_cost_periods 244, sales_allocations 70.

## Pendiente (para revisar a mano)

1. Smoke test en el navegador con un usuario real, **sin eliminar nada real**. Abrir un Trabajo con gastos y comprobar que cada fila de "Últimos gastos" tiene "Eliminar" y que el diálogo muestra la descripción y el monto; después Cancelar. Repetir en Costos y en "Ver". En una fila de Mano de obra, el diálogo tiene que mandar a Técnicos. Para probar un borrado de verdad, hacerlo con un gasto creado para eso.
2. Las facturas de prod importadas antes de hoy quedan alcanzadas por la regla nueva: si se elimina una, la próxima importación del mismo archivo la saltea (sale "Eliminado antes"), salvo que se marque "Importar igual".
3. Borrar el respaldo `G:\INMA-ERP\backups\prod-2026-10-24\` cuando ya no haga falta.
