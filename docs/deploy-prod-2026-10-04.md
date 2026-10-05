# Deploy a producción — 2026-10-04

- **Resultado:** **ABORTADO en el paso 9 (backup).** No se aplicó nada en prod, no se hizo el merge a `main` y no hubo deploy en Vercel.
- **Motivo:** no se pudo sacar el backup. `supabase db dump` necesita Docker (o Podman) y en esta máquina no hay ninguno. `pg_dump` tampoco está instalado. Sin un backup verificado, la regla es no avanzar.
- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`, sa-east-1). Sigue con 40/40 migraciones; la última es `20260921020000`.
- **CLI de Supabase:** volvió a quedar linkeada a DEV `sczgankronafrxybpvnh`. Lo verifiqué con `supabase/.temp/project-ref` y con una consulta (56 migraciones, existe `recurring_service_occurrences`).

## Fase A — Chequeos previos (solo lectura)

| # | Chequeo | Resultado |
|---|---|---|
| 1 | git | **OK con una observación.** `dev` = `origin/dev` = `b1fd211`, sin cambios en archivos versionados. Hay 3 sin versionar: dos docs y `node_modules/` (que no está en `.gitignore`). `origin/main` = `07ddbbc` y es ancestro de `dev`, así que el merge es fast-forward. **El `main` local (`2ff69bb`) está 9 commits atrás de `origin/main`**, sin commits propios. No lo toqué; antes del merge hay que traerlo con `git fetch origin main:main`. |
| 2 | Link a prod | **OK.** `supabase projects list`: `jxkfpkgyvjiyufmfxsfp`, nombre `inma-erp-sa-east-1`, región `sa-east-1`, ACTIVE_HEALTHY. Antes de cada comando leí `supabase/.temp/project-ref`. La CLI usa un login role temporal, así que no hizo falta la contraseña de la base. |
| 3 | `migration list --linked` | **OK.** Hay 40 aplicadas, las mismas 40 de `origin/main`, y la última es `20260921020000`. Las 16 pendientes son exactamente las del reporte, de `20260922010000` a `20261004050000`. |
| 4 | `exchange_rate_snapshots` | **OK, sin anomalías.** Hay 2 filas: CLP 2026‑09 (1,5957 ARS por unidad; 945,27 CLP/USD) y UYU 2026‑09 (37,6943 ARS por unidad; 40,02 UYU/USD). Ninguna tasa es 1 y no hay fechas anteriores a 2025 ni futuras. Hay una sola fila por moneda, así que el desvío respecto de la mediana es 0 %. **No hay snapshot de octubre.** Hoy no afecta, porque todos los documentos de prod están en la moneda de su empresa (ver paso 7). |
| 5 | Vercel Production | **OK.** `vercel env ls production` (proyecto `inma-erp`): `SUPABASE_SERVICE_ROLE_KEY` existe, como Secret de Production. No imprimí valores. |
| 6 | Compatibilidad | **OK: nada crítico.** El detalle está abajo. |
| 7 | Simulación de ciclos | **OK, pero el resultado es vacío.** Prod tiene **0 servicios recurrentes** (contado como `postgres`, sin RLS), así que las migraciones 10 y 11 no generan ningún ciclo. El detalle está abajo. |

### Paso 6 — Qué pasa en la ventana entre migrar y desplegar (app de `main` + esquema nuevo)

- **Snapshots de tipo de cambio.** La migración 14 le quita a `authenticated` el permiso de escribir. En la app vieja, `getOrSnapshotRate` hace el upsert con el cliente del usuario: el error solo se loguea (`console.error`) y la función devuelve la tasa en vivo. No se rompe nada; solo no queda guardado el snapshot del mes.
- **`create_project_with_quote`.** La firma vieja (`p_budget`) sigue existiendo y guarda el monto como cotización (`quoted_amount`). La app vieja muestra `budget`, así que un trabajo creado en la ventana se vería sin presupuesto hasta que salga la app nueva.
- **Editar un trabajo** (`edit/actions.ts`). La app vieja escribe `budget`, que la app nueva ya no lee. Una edición hecha en la ventana no llega a `quoted_amount`.
- **Servicios recurrentes.**
  - Si en la ventana se crea uno **anual**, falla por el check `due_month` obligatorio, porque la app vieja no lo envía.
  - Si se desactiva uno, cambia `active` pero no `status`.
  - El trigger de país fuerza CLP en Chile y rechaza UY en CLP.
  - Hoy hay 0 servicios, así que el riesgo es bajo.
- **Nubox.** `import_nubox_documents_batch(uuid, jsonb)` mantiene la firma; solo cambia el comportamiento (adopta ventas sin factura).
- **Columnas nuevas.** Todas admiten null o tienen default. El trigger de tasa ignora lo que mande el cliente, y `covered_by_cost_pool_id` es una columna calculada. Nada de lo que inserta la app vieja choca con ellas.
- **Conclusión.** La ventana no rompe lecturas. Lo único que puede fallar es crear un servicio anual. Igual conviene que sea corta: hacer el merge apenas termina el `db push`.

### Paso 7 — Simulación (ensayo completo con rollback)

Las migraciones 10 y 11 dependen de las 1 a 9: la tabla `recurring_service_occurrences` todavía no existe en prod. Por eso ensayé **las 16 en orden** dentro de un único bloque `DO`, que siempre termina en `RAISE EXCEPTION`. Un error revierte todo el bloque, sin importar cómo maneje las transacciones el endpoint. Antes probé el mecanismo con una tabla temporal. Al final confirmé que prod seguía igual: 40 migraciones, sin `recurring_service_occurrences` y sin columnas nuevas en `projects`.

Esto devolvió el ensayo:

- **Las 16 migraciones aplicaron sin error sobre los datos reales de prod.**
- **Ciclos generados: ninguno.** No hay servicios, así que no hay nada que listar por empresa, servicio y período. Tampoco hay duplicados ni ciclos de servicios inactivos.
- **Ventas:** 163, todas en CLP y en empresas CLP, de 2026‑01 a 2026‑09. Ninguna quedó sin tasa.
- **Costos:** 2, de 2026‑09 y en CLP. Ninguno quedó sin tasa.
- **Pools:** 0. **Costos cubiertos por pool:** 0.
- **Proyectos:** 1, con `quoted_amount = budget` después del backfill.

## Fase B — Backup

| # | Paso | Resultado |
|---|---|---|
| 8 | Carpeta | Creé `G:\INMA-ERP-backups\prod-20261004-2137`. **La borré** al abortar: solo tenía un `roles.sql` vacío del intento fallido. |
| 9 | Dump | **FALLÓ.** `supabase db dump --linked --role-only` devolvió `docker: command not found (podman also not found)`. No hay `pg_dump` ni `psql` en el PATH. Para usar `pg_dump` también haría falta la contraseña de prod, que no pasa por el chat. |
| 10 | Verificación | No se llegó a hacer. |

## Fase C y Fase D

No se ejecutaron. No hubo `db push`, ni merge, ni push a `main`, ni deploy, ni verificación post-deploy.

## Cómo destrabarlo

Hay que tener una de estas dos cosas y volver a correr todo desde la Fase A:

1. **Docker Desktop** instalado y corriendo. Así `supabase db dump --linked` funciona tal cual lo pide el runbook.
2. **Las herramientas cliente de PostgreSQL 17** (`pg_dump` ≥ 17, porque prod es 17.6). Con eso, vos corrés el dump en tu terminal con la cadena de conexión de prod.

Además:

- Antes del merge, traé `main`: `git fetch origin main:main`.
- No pude leer la variable `DB_MIGRATIONS_ENABLED` del repo (el token de `gh` da 403). Si está en `true`, el push a `main` dispara `db push` en CI. Corrido después del push manual, no hace nada, pero conviene saberlo.

## Para revisar en el navegador (después del deploy, cuando se haga)

Son los ítems 3 a 9 del checklist de `docs/verificacion-contable-2026-10-04.md`:

1. **Resultado Mensual y dashboard** de un mes cerrado: las cifras tienen que ser iguales antes y después. Prod tiene una sola empresa con movimiento en CLP; no hay datos en UY.
2. **Costos, listado del mes con pool:** revisar cada badge "Cubierto por pool". Hoy no hay pools en prod, así que no debería aparecer ninguno.
3. **Alta de costo** con el proveedor del pool y una fecha de ese mes: tiene que aparecer el aviso con link al reparto.
4. **Reparto licencias MS → Nuevo:** el campo dice "Monto neto (sin IVA)" y el total con IVA se actualiza al escribir.
5. **Ficha del trabajo:** muestra "Cotización (venta)" y "Presupuesto de costo". El dashboard dice "Sin presupuesto" hasta que se cargue uno.
6. **Importación Nubox de prueba** (vista previa, sin confirmar): revisar la adopción de ventas sin factura.
7. **Con un usuario común:** escribir `exchange_rate_snapshots` desde la API tiene que dar error.
8. **Abrir un reporte de octubre:** tiene que crear el snapshot de 2026‑10 con el service role. Hoy prod no lo tiene.

## Cómo restaurar desde el backup

No aplica: prod no cambió. Para el próximo intento, el procedimiento es este, con un backup de tres archivos (`roles.sql`, `schema.sql`, `data.sql`):

1. Crear un proyecto nuevo, o resetear el actual si se decide así.
2. Restaurar en orden: `roles.sql`, `schema.sql`, `data.sql`. Se hace con `psql --single-transaction --variable ON_ERROR_STOP=1 -f <archivo>` y la cadena de conexión del destino, que corre el dueño de la contraseña en su terminal. El `data.sql` de `supabase db dump --data-only` trae `session_replication_role = replica` para no disparar triggers.
3. Volver a dejar `supabase_migrations.schema_migrations` en las 40 de `main` (viene en el dump de datos).
4. Si prod se restaura sobre otro proyecto, actualizar las variables de Vercel Production.
