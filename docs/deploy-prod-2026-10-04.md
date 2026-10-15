# Deploy a producción — 2026-10-04

- **Resultado final:** **DESPLEGADO.** Las 16 migraciones están aplicadas en prod (56/56). `dev` se mergeó a `main` sin squash (`ef48b10`), y Vercel Production quedó en READY con ese commit.
- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`, sa-east-1).
- **Red de seguridad:** esquema `backup_20261004` dentro de prod. No hay dump externo: se decidió no usar pg_dump. Ver "Backup".
- **CLI de Supabase:** volvió a quedar linkeada a DEV `sczgankronafrxybpvnh`. Lo verifiqué con `supabase/.temp/project-ref` y con una consulta: 56 migraciones y las empresas Demo/TEST_QA.

Hubo dos intentos:

1. **Primer intento (~21:37 −03).** Abortó en el paso 9. `supabase db dump` necesita Docker o Podman, y `pg_dump` no está instalado. No se tocó nada.
2. **Segundo intento (~21:40–21:47 −03).** Se omitió el dump. En su lugar se armó una copia mínima en prod y se desplegó.

## Cronología del segundo intento

| Hora (−03) | Paso | Resultado |
|---|---|---|
| — | `git fetch origin main:main` | `main` pasó de `2ff69bb` a `07ddbbc` (= `origin/main`). `dev` = `origin/dev` = `4b6f5ae`. `origin/main` es ancestro de `dev`. |
| — | Re-chequeo de prod | Sin cambios desde el primer intento (detalle abajo). No hizo falta repetir la simulación. |
| — | Línea base | Resultado Mensual de sep‑2026 por empresa, con SQL independiente, **antes** de migrar. |
| — | `backup_20261004` | Se crearon 5 tablas. Los conteos coinciden y `anon`/`authenticated` no tienen acceso. |
| — | `db push --dry-run` | Listó exactamente las 16 del reporte, en orden, sin seeds ni roles. |
| 21:44:31 | `db push --linked` | Las 16 se aplicaron sin errores. |
| 21:44:46 | Merge y push | `git merge --no-ff dev` y push: `07ddbbc..ef48b10 main -> main`. La ventana entre migrar y pushear fue de unos 15 s. |
| 21:44:48 → ~21:45:45 | Vercel | `dpl_GsriSMAaaS2oseK834MBUY7TRDPn`, target production. Build de 55 s, **READY**, commit `ef48b10` (ref `main`). |
| — | Alias | `inma-erp.vercel.app`. `/login` responde 200 y `/` redirige con 307. |
| — | GitHub Actions sobre `ef48b10` | `CI` dio success. `DB migrations` quedó en skipped, porque `DB_MIGRATIONS_ENABLED` no está en `true`. |

## Paso 1 — Re-chequeo (solo lectura)

Comparado con el primer intento, en prod no cambió nada:

- **Migraciones:** 40 aplicadas; la última es `20260921020000`.
- **`exchange_rate_snapshots`:** las mismas 2 filas, con los mismos valores y el mismo `fetched_at`:
  - CLP 2026‑09: 1,5957 ARS por unidad; 1.508,375 ARS por USD.
  - UYU 2026‑09: 37,6943 ARS por unidad; 1.508,375 ARS por USD.
- **Conteos:** `recurring_services` 0 · `projects` 1 · `sales_documents` 163 · `cost_documents` 2 · `clients` 165 · `companies` 3.
- **Objetos nuevos:** todavía no existían `recurring_service_occurrences` ni `backup_20261004`.

Entre los dos intentos, `dev` solo sumó el commit del reporte (`b1fd211..4b6f5ae`, un `.md`). Las migraciones son las mismas que ya se habían ensayado.

## Backup — esquema `backup_20261004` (en prod)

Se creó con `CREATE TABLE ... AS SELECT *`, en un único bloque atómico, justo antes del `db push`:

| Tabla | Filas en el backup | Filas en vivo al copiar |
|---|---|---|
| `projects` | 1 | 1 |
| `sales_documents` | 163 | 163 |
| `cost_documents` | 2 | 2 |
| `exchange_rate_snapshots` | 2 | 2 |
| `recurring_services` | 0 | 0 |
| `recurring_service_occurrences` | — | La tabla no existía antes del deploy, así que no se copió. |

Permisos y alcance:

- Se revocó todo a `public`, `anon` y `authenticated`, en el esquema y en cada tabla. Lo verifiqué con `has_schema_privilege` y `has_table_privilege`: todo dio `false`.
- El esquema tiene un comentario que explica qué es. **No lo borré**; queda para que lo borres vos (`drop schema backup_20261004 cascade;`).
- Es una copia de **datos** de esas 5 tablas. No es un dump completo: no incluye roles, ni esquema, ni el resto de las tablas.

## Fase C — Migraciones aplicadas (en este orden)

1. `20260922010000_recurring_services_v2_schema.sql`
2. `20260922020000_recurring_services_status_default.sql`
3. `20260922030000_recurring_service_occurrences_generation.sql`
4. `20260922040000_recurring_service_occurrences_generation_fix.sql`
5. `20260922050000_recurring_service_cost_pool_allocation.sql`
6. `20260922060000_recurring_service_occurrences_nubox_matching.sql`
7. `20260922070000_recurring_service_occurrences_generation_revoke_api_roles.sql`
8. `20260922080000_revoke_anon_execute_member_rpcs.sql`
9. `20260922090000_recurring_service_occurrences_arrears_period.sql`
10. `20261002010000_recurring_services_country_and_monthly_cycles.sql`
11. `20261003010000_recurring_service_occurrences_floor_on_due_month.sql`
12. `20261004010000_cost_pool_allocation_largest_remainder.sql`
13. `20261004020000_nubox_adopt_ventas_sin_factura.sql`
14. `20261004030000_document_exchange_rates.sql`
15. `20261004040000_projects_quoted_amount_cost_budget.sql`
16. `20261004050000_cost_documents_covered_by_ms_pool.sql`

## Fase D — Verificación post-deploy (solo lectura)

| Chequeo | Resultado |
|---|---|
| `supabase migration list --linked` | **56/56.** Las 56 tienen remoto y local iguales; la última es `20261004050000`. |
| Documentos sin tasa de cambio | **0** en ventas, costos, ciclos y pools. Todas las tasas son 1: todos los documentos están en la moneda de su empresa (CLP). |
| `budget` → `quoted_amount` | **OK.** "Camaras y acceso bodega 12": `budget` 1.174.520 = `quoted_amount` 1.174.520, y `cost_budget` quedó vacío. Comparado con `backup_20261004.projects`: 0 diferencias. `budget` no se tocó. |
| Documentos cubiertos por pool | **Ninguno.** Prod no tiene pools de licencias MS. |
| Ciclos recurrentes generados | **0**, igual que en la simulación: prod no tiene servicios recurrentes. |
| Datos de documentos vs backup | 0 ventas y 0 costos cambiaron en importe, fecha, período reconocido, anulación, clasificación o moneda. |
| Escritura de `exchange_rate_snapshots` | `authenticated` ya no puede hacer INSERT ni UPDATE, y `anon` no puede hacer INSERT. |

### Resultado Mensual de septiembre 2026

Comparé tres cálculos:

- **(a)** SQL independiente **antes** de migrar.
- **(b)** El mismo SQL **después**.
- **(c)** SQL con la fórmula de `computeMonthlyResult` de la app nueva: tasa guardada por documento, exclusión de los cubiertos por pool, ciclos recurrentes y sueldos del mes.

| Empresa | Moneda | Ventas netas | Costos directos | Costos generales | Sueldos | Resultado | (a) = (b) = (c) |
|---|---|---|---|---|---|---|---|
| Inmasoft Chile | CLP | 13.443.699 | 468.025 | 0 | 0 | **12.975.674** | Sí |
| Inmasoft Uruguay | CLP | 0 | 0 | 0 | 0 | **0** | Sí |
| Inmasoft UY | UYU | 0 | 0 | 0 | 0 | **0** | Sí |

**Limitación:** (c) reproduce la fórmula de la app en SQL; no corre la app. Que la pantalla muestre estas cifras queda en la lista para el navegador.

## Compatibilidad en la ventana entre migrar y desplegar

El análisis del primer intento sigue valiendo: en la ventana, lo único que podía fallar en la app vieja era crear un servicio recurrente anual. La ventana real fue de unos 15 s hasta el push, más 1 min de build.

## Para revisar en el navegador (`inma-erp.vercel.app`)

1. **Home y dashboard, sep‑2026:**
   - Inmasoft Chile: ventas 13.443.699, costos directos 468.025, resultado 12.975.674.
   - Inmasoft Uruguay e Inmasoft UY: 0.
   - Sin banner de "Datos incompletos".
2. **Ficha del trabajo "Camaras y acceso bodega 12":** muestra "Cotización (venta)" en 1.174.520 y "Presupuesto de costo" vacío. El badge del dashboard dice "Sin presupuesto".
3. **Editar ese trabajo:** cargar un presupuesto de costo y confirmar que el badge pasa a comparar contra el costo acumulado (468.025, si todo es de este trabajo).
4. **Abrir cualquier reporte de octubre 2026:** tiene que crear el snapshot de 2026‑10 con el service role. Hoy prod solo tiene los de septiembre. Después, en SQL: `select currency, period from exchange_rate_snapshots`.
5. **Servicios recurrentes:**
   - El tablero carga vacío y sin errores.
   - Dar de alta un servicio de prueba: ver país, moneda, `requires_invoice` y vencimiento, y que genere el ciclo del mes.
   - Ojo: **"Inmasoft Uruguay" tiene moneda CLP.** Si su país es UY, el trigger nuevo va a rechazar servicios en CLP. Conviene revisar si esa empresa está bien configurada o si es un duplicado de "Inmasoft UY".
6. **Reparto licencias MS → Nuevo:** el campo dice "Monto neto (sin IVA)" y el total con IVA se actualiza al escribir.
7. **Costos:** hoy ningún costo tiene el badge "Cubierto por pool". Cuando se cargue el primer pool, revisar el aviso al dar de alta un costo con el proveedor del pool y una fecha de ese mes.
8. **Importación Nubox de prueba** (vista previa, sin confirmar): una venta sin factura del mismo cliente con fecha cercana aparece en "se vinculan a su documento"; dos parecidas aparecen "a revisar".
9. **Con un usuario común:** escribir `exchange_rate_snapshots` desde la API tiene que dar error. Los permisos ya están verificados en SQL; falta confirmarlo desde la app.

## Cómo restaurar si hiciera falta

Antes que nada: **no reviertas el código sin revertir el esquema**, ni al revés. La app nueva necesita las columnas nuevas, y la app vieja funciona con el esquema nuevo (ver "Compatibilidad").

1. **Volver la app.** En Vercel → Deployments, hacer "Promote to Production" del deployment anterior que estaba Ready (`inma-d6foymbmg…`, de hace unos 13 días). Así se vuelve al código de `07ddbbc`, sin tocar la base. Si además hay que revertir `main`, se hace con `git revert -m 1 ef48b10` (nunca con un force-push).
2. **Volver los datos de las 5 tablas.** Las columnas existentes no cambiaron (verificado contra el backup). Si después del deploy algo las modifica y hay que volver atrás, se restauran desde `backup_20261004` con `update public.<tabla> t set <col> = b.<col> from backup_20261004.<tabla> b where b.id = t.id`. Las filas nuevas se identifican con un `not exists` contra el backup.
3. **Volver el esquema.** Hay que seguir la columna "Reversible" de la tabla de migraciones en `docs/verificacion-contable-2026-10-04.md`:
   - Borrar las columnas, tablas, triggers y funciones nuevas, en orden inverso.
   - Reponer las versiones anteriores de las funciones (`import_nubox_documents_batch`, `create_project_with_quote`, `allocate_recurring_service_cost_pool`) desde las migraciones de `07ddbbc`.
   - Reponer las policies de INSERT/UPDATE de `exchange_rate_snapshots`.
   - Borrar las 16 filas de `supabase_migrations.schema_migrations`.
   - Se pierde lo que se haya cargado en las tablas nuevas.
4. **Restauración completa.** El esquema de backup no alcanza: queda el backup diario o PITR del proyecto en el Dashboard de Supabase (Database → Backups), según lo que incluya el plan.
