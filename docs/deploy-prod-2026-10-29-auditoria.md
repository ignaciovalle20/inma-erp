# Deploy a prod — auditoría 2026-10 (2026-10-29)

- **Prod:** `jxkfpkgyvjiyufmfxsfp`. Todos los comandos usaron `--linked --project-ref jxkfpkgyvjiyufmfxsfp`; la CLI siguió linkeada a DEV (`sczgankronafrxybpvnh`), sin re-enlazar.
- **Código:** `main` = `5b62f52` (merge `--no-ff` de `dev` `befeb57`, que es el merge de `audit/2026-10`). Vercel producción: **Ready** 05:01:52 UTC (`https://vercel.com/nachovalle20-8464s-projects/inma-erp/H4krg2wnqFrXuaJZ1DCGA1PMpVQn`). Corre **Next 16.4.3**: `window.next.version` en `https://inma-erp.vercel.app/login` y el chunk del runtime de cliente (antes 16.3.5).
- **Resultado:** migración aplicada, **ningún dato cambió** (huella idéntica en las 43 tablas). No hizo falta revertir.

## 1. Migración aplicada

| Migración | Qué hace |
|---|---|
| `20261029010000_audit_hardening` | Revoca EXECUTE a `anon` en 6 funciones, chequea el saldo de un pago de técnico al borrar una aplicación, valida que un alias de cliente sea de la misma empresa, y agrega 14 índices de FK (`audit/INFORME_AUDITORIA.md`) |

Aplicada 04:58:31–04:58:36 UTC, sin error. Prod pasó de 79 a **80** (= dev).

## 2. Antes de aplicar

- **Backup** en `G:\INMA-ERP-dumps\prod-2026-10-29-audit\` (fuera del repo): `data.json` con las 43 tablas `public` (6.788 filas, cada una cotejada contra `count(*)`; incluye `mcp_access_tokens` y `user_ai_settings`: **no compartir** y borrarlo cuando ya no haga falta), `counts.json`, `schema.json` (79 migraciones, 139 funciones con su definición, columnas, 140 índices, 82 triggers, 121 políticas, RLS, vistas y grants) y `fingerprint-before.json` / `fingerprint-after.json` (count + md5 por tabla). Igual que en los deploys anteriores no es un `pg_dump`: en esta máquina no hay `pg_dump` ni Docker.
- **Dev verde** en `befeb57`: `tsc` OK, `eslint` 0, `vitest` 651/651, `next build` OK. El día antes se corrieron las integraciones contra dev: 132/132, y la suite golden 25/25 después de su fix (`888c0ca`).
- `migration list`: las 79 locales coinciden con las remotas, ninguna está solo en remoto y la única pendiente era `20261029010000`. El dry-run mostró solo esa.
- Estado previo: ninguna de las funciones, triggers o índices nuevos existía; `anon` tenía EXECUTE en las 6 funciones; 0 alias apuntaban a un cliente de otra empresa (el trigger nuevo no rechaza nada de lo que ya hay).

## 3. Después: verificación (SELECT en prod)

| Chequeo | Resultado |
|---|---|
| Migraciones | 80, la última `20261029010000` |
| Índices nuevos | 14/14, 0 inválidos |
| Triggers nuevos | `technician_payment_applications_balanced_on_delete` (constraint, deferrable, initially deferred) y `client_aliases_validate_company_refs`, los dos activos |
| `anon` sin EXECUTE | Sí en `update_technician_charge`, `create_company`, `update_import_batch_counts`, `update_cost_import_batch_counts` y `delete_technician_charge`. `authenticated` lo conserva. Ver la nota de abajo para `seed_default_business_areas` |
| RLS | Activa en las 43/43 tablas, con 121 políticas (igual que antes) |
| Datos | Huella antes = después en las 43 tablas |

**Nota sobre `seed_default_business_areas()`:** el revoke a `anon` se aplicó, pero la función conserva el EXECUTE por defecto a `PUBLIC` (`=X/postgres` en su ACL), así que `has_function_privilege('anon', …)` sigue en `true`. A las 2 funciones de trigger nuevas les pasa lo mismo. Las tres devuelven `trigger`: Postgres no deja llamarlas de forma directa y PostgREST no las expone (en dev, `POST /rest/v1/rpc/seed_default_business_areas` con la anon key da 404 `PGRST202`). No hay ningún acceso real. Para que el chequeo quede limpio, una migración futura puede hacer `revoke execute … from public` en las funciones de trigger.

## 4. Smoke test

Solo lectura: no se creó ni editó ningún registro.

- **HTTP, sin sesión, contra `https://inma-erp.vercel.app`:** `/login` responde 200 ("INMA ERP"), con la consola del navegador sin errores y todos los recursos en 200. Redirigen a `/login` (307) sin ningún 5xx: `/` y `/companies`; y en Chile y en Uruguay, el Resumen, Proyectos y su tablero, Importar ventas, el historial de importaciones, Importar costos, Servicios recurrentes (tablero, lista y deuda), Personal, más la cuenta corriente de un técnico. `/api/cron/recurring-service-occurrences` sin secreto o con uno falso devuelve 401.
- **SELECT en prod, sobre las tablas y vistas que leen esas pantallas:** 3 empresas, 24 proyectos, `project_quote_billing_summary` 21, 41 servicios recurrentes, 11 ciclos de octubre, `recurring_service_period_summary` 146, `recurring_service_cost_period_summary` 247, `sales_document_allocation_summary` 194, 6 lotes de importación de ventas y 1 de costos, 9 personas, 17 cargos de técnicos, 7 pagos, 6 aplicaciones, y 22 ventas y 26 costos de octubre. Todas responden.
- **El mismo build en el Preview (contra dev, con sesión de un usuario descartable):** 21 pantallas de Chile y Uruguay en 200, 0 errores de consola y 0 respuestas 5xx.
- **No verificado:** las pantallas de prod con sesión iniciada. Hacerlo implicaría crear un usuario en prod (el pedido era no crear registros), y no ingreso contraseñas. Para cerrarlo, abrir con tu usuario el Resumen, Proyectos, Ventas → Importar, Servicios recurrentes y Personal → un técnico → Cuenta corriente.

## 5. Rollback (no ejecutado)

`audit/rollback_20261029010000_audit_hardening.sql` deshace exactamente la migración (índices, triggers, funciones, grants a `anon`) y la saca del historial. Termina en `ROLLBACK`: hay que cambiarlo por `COMMIT` para aplicarlo. No hizo falta.

## 6. Pendientes

1. Borrar `G:\INMA-ERP-dumps\prod-2026-10-29-audit\` cuando ya no haga falta (tiene datos sensibles).
2. Correcciones de datos de `audit/fixes_prod.sql` (F1–F8, sin ejecutar): F1 y F2 necesitan OK de negocio y F4 necesita las tasas CLP reales.
3. `revoke execute … from public` en las funciones de trigger (sección 3, opcional).
