# Deploy a producción — costos de servicios recurrentes y ciclos anuales (2026-10-20 → ejecutado 2026-10-23)

- **Resultado final:** **DESPLEGADO.**
  - Las migraciones `20261020010000_recurring_service_costs`, `20261020020000_recurring_annual_anniversary_cycles` y `20261020030000_recurring_annual_cost_to_monthly` quedaron aplicadas en prod (**70/70**).
  - `dev` (`0dc2c8c`, con `c83ac6b`) se mergeó a `main` sin squash: `fb6ec44`.
  - Vercel Production quedó **Ready** con ese commit (`dpl_8oZUb4EVZHwCJS7zwA7ZJPhou7CA`, estado "success" en GitHub a las 02:20:16).
  - La verificación pasó completa. El smoke test en navegador no se hizo (no hay credenciales de prod en el entorno).
- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`). Todos los comandos usaron `--linked --project-ref jxkfpkgyvjiyufmfxsfp`; la CLI sigue linkeada a DEV (`sczgankronafrxybpvnh`).
- **Respaldo:** `G:\INMA-ERP\backups\prod-2026-10-20\` (fuera de git: `/backups/` en `.git/info/exclude`). Ver "Respaldo y cómo restaurar".
- **Plan:** `docs/servicios-recurrentes-costos.md`, sección 8.

`supabase db dump` no se pudo usar: necesita Docker y esta máquina no lo tiene (error `DockerRunError`). Se frenó ahí el 2026-10-20 y el respaldo se hizo en JSON con solo SELECT, como en el deploy del 2026-10-19.

## Cronología (2026-10-23, −03)

| Hora | Paso | Resultado |
|---|---|---|
| 02:1x | Chequeos previos repetidos (habían pasado 3 días) | Sin cambios desde el 20: 67 migraciones, 3 pendientes, 22 ciclos anuales sin colisiones, 36 servicios, ninguno editado desde el 20 |
| 02:18 | Respaldo JSON de prod | 41 tablas + esquema + foto previa + migraciones de `main` |
| 02:19 | Merge `dev` → `main` (`fb6ec44`, `--no-ff`, en un worktree temporal) y push | El árbol resultante es idéntico al de `dev` |
| 02:20:16 | Vercel Production | **Ready** |
| 02:21:01–02:21:09 | `supabase db push` a prod | Las 3 migraciones aplicadas sin error |
| 02:22–02:26 | Verificación (solo lectura) | OK |

La ventana con código nuevo y esquema viejo fue de unos 50 segundos.

## Fase A — Chequeos previos (solo lectura)

- `dev` contenía `c83ac6b` y `0dc2c8c`. `main` solo tenía los merges `--no-ff` de deploys anteriores (ningún commit propio); el merge de `dev` da exactamente el árbol de `dev`. Entraron 55 archivos (los dos commits).
- `supabase migration list` en prod: 67 aplicadas; pendientes exactamente `20261020010000`, `20261020020000`, `20261020030000`.
- Consulta de colisiones de `20261020020000`: 22 ciclos anuales, **ninguno** cae en la misma clave por aniversario.
- `expected_cost > 0` con `fixed_monthly_cost` nulo y sin pool: 24 servicios (más 2 que ya tenían costo fijo y 1 con pool, que no se copian). Valores resultantes en "Servicios con costo fijo".
- En `web/`: `tsc --noEmit` OK, `lint` 0 errores (6 advertencias previas), `npm test` 574/574, `npm run build` OK.

## Respaldo y cómo restaurar

En `G:\INMA-ERP\backups\prod-2026-10-20\`:

| Archivo | Contenido |
|---|---|
| `data.json` | Todas las tablas `public` (41) más `auth.users`/`auth.identities`, como `{ "schema.tabla": [filas] }`. Incluye hashes de contraseña: no compartir. |
| `schema.json` | Columnas, constraints, índices, funciones, triggers, vistas, políticas y migraciones de prod antes del deploy. |
| `snapshot-before.json` | Por empresa/moneda/mes: ingresos recurrentes, costo recurrente (regla vieja) y costos de documentos; todos los ciclos y `sales_allocations`. |
| `snapshot-after.json` | Lo mismo después del deploy, más servicios, cobertura de períodos de costo y ciclos anuales. |
| `migrations-main/` | Las 67 migraciones de `main` antes del merge. |

No es un dump SQL reimportable. Para volver atrás datos puntuales:

- **Costo esperado / costo fijo:** `recurring_services` en `data.json` tiene `expected_cost`, `fixed_monthly_cost` y `due_month` originales por `id`.
- **Clave de los ciclos anuales:** `recurring_service_occurrences` en `data.json` tiene el `period` original por `id` (todos los anuales estaban en `2025-01-01`).
- **Esquema:** volver atrás las migraciones requiere revertir el código (`main` a `a157526`) y escribir una migración inversa a partir de `schema.json`; no se preparó porque la verificación pasó.

## Fase C — Deploy

1. `git merge --no-ff origin/dev` sobre `origin/main` en un worktree temporal → `fb6ec44`, push a `origin/main`.
2. La CLI de Vercel no tiene acceso al equipo (`forbidden`) y `gh` no está autenticado: el deploy se siguió por el estado público del commit en la API de GitHub (`context: Vercel`), que pasó de `pending` a `success` ("Deployment has completed").
3. `supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp --yes`: las tres migraciones, en orden.

## Fase D — Verificación (solo lectura)

| Chequeo | Resultado |
|---|---|
| Historial de migraciones | **70**, las últimas `20261020010000/020000/030000` |
| `expected_cost` / `fixed_monthly_cost` | Ya no existen |
| Anuales no dominio | Todos `cost_periodicity = monthly` con el costo esperado / 12 |
| Dominios | `cost_periodicity = annual` con el valor tal cual (10.000) |
| Períodos de costo | Los 27 servicios activos sin pool con costo fijo tienen exactamente sus períodos desde max(inicio, 2026-01) hasta 2026-10 (o su fecha de fin); ninguno falta ni sobra |
| Ciclos anuales | Cada uno en el mes de aniversario de su inicio (tabla abajo) |
| Ciclos conservados | 124 antes → 126 después: 0 faltantes, 0 cambios en estado, vencimiento, facturado/cobrado, monto o factura vinculada. 2 nuevos (abajo) |
| `sales_allocations` | 50, idénticas a las del respaldo |
| `cost_service_allocations` | 0 (las asignaciones se crean al importar compras o con "Sugerir asignaciones") |
| Ingresos recurrentes por mes | Idénticos antes y después (Chile oct 2026: 690.811; el resto 0) |
| Costos generales por mes | Idénticos antes y después (ninguna factura asignada a servicios todavía) |
| Sitio | `https://inma-erp.vercel.app/login` 200; `/` redirige a `/login` |
| Smoke test con Playwright | **No se hizo:** no hay credenciales de producción en el entorno (`web/.env.local` apunta a dev) |

### Resultado mensual: diferencia por el cambio de costo de servicios

Ingresos y costos de documentos no cambian; la diferencia del resultado mensual es solo el costo de servicios recurrentes. Antes contaba `fixed_monthly_cost` (×12 si el servicio era anual) en el mes del ciclo facturado; los hostings anuales no tenían costo fijo, así que no sumaban nada. Ahora cuenta cada período de costo en su mes (sin facturas asignadas todavía: el costo fijo esperado).

| Mes | Chile CLP antes | Chile CLP después | Diferencia (menor resultado) | Uruguay USD antes → después |
|---|---:|---:|---:|---|
| 2026-01 | 0 | 81.832 | 81.832 | 40 → 40 |
| 2026-02 | 0 | 81.832 | 81.832 | 40 → 40 |
| 2026-03 | 0 | 81.832 | 81.832 | 40 → 40 |
| 2026-04 | 0 | 81.832 | 81.832 | 40 → 40 |
| 2026-05 | 0 | 81.832 | 81.832 | 40 → 40 |
| 2026-06 | 31.092 | 112.924 | 81.832 | 40 → 40 |
| 2026-07 | 0 | 185.108 | 185.108 | 40 → 40 |
| 2026-08 | 31.092 | 179.108 | 148.016 | 40 → 40 |
| 2026-09 | 0 | 169.108 | 169.108 | 40 → 40 |
| 2026-10 | 0 | 169.108 | 169.108 | 40 → 40 |

- 81.832/mes: 18 hostings anuales (costo anual / 12: 64.162), Microsoft ADQUICOMER 11.667, Servidor VCB 6.000 y Numancia sports 3.
- Desde junio/julio: los tres EBCO Starlink, 31.092 cada uno desde su inicio (antes solo sumaban el mes en que se facturaba el ciclo).
- Julio y agosto: los dominios criaderopichiblanco.cl (julio) y circodedinosaurioschile.cl (agosto), 10.000 en su aniversario.
- Desde agosto: Servidor VCB ya no suma (sus períodos de costo llegan hasta julio, su fecha de fin).
- Uruguay: Microsoft Trimant, 40 USD por mes, igual que antes.

### Ciclos anuales después del deploy

Todos los existentes estaban en `period = 2025-01-01`; ahora cada uno tiene la clave del mes en que empieza su año. La fecha de vencimiento guardada en cada ciclo no cambió; el mes de vencimiento del servicio (`due_month`) ahora se calcula: con mes vencido es el mes en que termina el año, que para un inicio el día 1 es el mes **anterior** al aniversario.

| Servicio | Inicio | Modo | Mes venc. antes → ahora | Período | Vence | Estado |
|---|---|---|---|---|---|---|
| ACDI - Plan Grande | 2022-04-01 | vencido | 4 → 3 | 2025-04 | 2026-04-30 | Facturar |
| activodesarrollo - Nuevo Concon | 2021-02-01 | vencido | 2 → 1 | 2025-02 | 2026-02-28 | Facturar |
| activodesarrollo - Q6 | 2023-02-01 | vencido | 2 → 1 | 2025-02 | 2026-02-28 | Facturar |
| activodesarrollo - Q8 | 2021-02-01 | vencido | 2 → 1 | 2025-02 | 2026-02-28 | Facturar |
| aventureatravel.cl - Plan Medio | 2024-03-01 | vencido | 3 → 2 | 2025-03 | 2026-03-30 | Cobrado |
| Circo de dinosaurios - Plan Grande | 2021-10-01 | vencido | 10 → 9 | 2025-10 | 2026-10-30 | Facturar |
| circodedinosaurioschile.cl (dominio) | 2021-08-01 | vencido | 8 → 7 | 2025-08 | 2026-08-30 | Facturar |
| Colegio Alborada de Coyhaique | 2018-09-01 | vencido | 9 → 8 | 2025-09 | 2026-09-30 | Facturar |
| Colegio Castilla y Aragon | 2018-09-01 | vencido | 9 → 8 | 2025-09 | 2026-09-30 | Facturar |
| Colegio Diego Velazquez | 2018-09-01 | vencido | 9 → 8 | 2025-09 | 2026-09-30 | Facturar |
| Colegio Numancia - Plan Grande | 2020-09-07 | vencido | 9 → 9 | 2025-09 | 2026-09-30 | Facturar |
| Colegio Villa Acncagua | 2018-09-01 | vencido | 9 → 8 | 2025-09 | 2026-09-30 | Facturar |
| criaderopichiblanco.cl (dominio) | 2021-07-01 | vencido | 7 → 6 | 2025-07 | 2026-07-30 | Cobrado |
| criaderopichiblanco.cl - Plan Medio | 2021-07-01 | vencido | 7 → 6 | 2025-07 | 2026-07-30 | Cobrado |
| **EBCO LA LIGUA - ANUAL** | 2026-07-01 | adelantado | 6 → 7 | **2026-07 (nuevo)** | 2026-07-01 | Facturar |
| ecmovial.cl - Plan Corporaciones | 2022-04-01 | vencido | 4 → 3 | 2025-04 | 2026-04-30 | Cobrado |
| Escuela Alborada del Mar x2 | 2018-09-01 | vencido | 9 → 8 | 2025-09 | 2026-09-30 | Facturar |
| **ingesal.cl - Plan Medio** | 2019-11-01 | vencido | 11 → 10 | **2025-11 (nuevo)** | 2026-10-30 | Facturar |
| IVCB - Plan Basico | 2023-04-01 | vencido | 4 → 3 | 2025-04 | 2026-04-30 | Facturar |
| Microsoft ADQUICOMER | 2025-06-05 | vencido | 7 → 6 | 2025-06 | 2026-07-05 | Facturar |
| Numancia sports - plan grande | 2022-03-14 | vencido | 3 → 3 | 2025-03 | 2026-03-01 | Cobrado |
| raicespenablanca.cl - plan medio | 2024-07-14 | vencido | 7 → 7 | 2025-07 | 2026-07-01 | Facturado |
| razo.cl Plan Medio | 2025-07-14 | vencido | 8 → 7 | 2025-07 | 2026-08-05 | Facturado |
| terroraventura.cl - Plan Medio | 2023-05-19 | vencido | 5 → 5 | 2025-05 | 2026-05-30 | Cobrado |

Ciclos nuevos:

- **EBCO LA LIGUA - ANUAL**: el caso del error. Período jul 2026 – jun 2027, 598.800, vence 2026-07-01, para facturar.
- **ingesal.cl - Plan Medio**: su año nov 2025 – oct 2026 termina en octubre, así que con la regla nueva ya vence (2026-10-30, 79.900, para facturar). Con la regla vieja vencía en noviembre.

### Servicios con costo fijo

| Servicio | Tipo | Venta | Costo fijo | Se paga | Observación |
|---|---|---|---:|---|---|
| ACDI - Plan Grande | hosting | anual | 3.333 | mensual | |
| activodesarrollo - Q6 | hosting | anual | 3.333 | mensual | |
| aventureatravel.cl - Plan Medio | hosting | anual | 4.167 | mensual | |
| Circo de dinosaurios - Plan Grande | hosting | anual | 3.333 | mensual | |
| circodedinosaurioschile.cl | dominio | anual | 10.000 | anual | |
| Colegio Alborada de Coyhaique | hosting | anual | 3.333 | mensual | |
| Colegio Castilla y Aragon | hosting | anual | 3.333 | mensual | |
| Colegio Diego Velazquez | hosting | anual | 3.333 | mensual | |
| Colegio Numancia - Plan Grande | hosting | anual | 3.333 | mensual | |
| Colegio Villa Acncagua | hosting | anual | 3.333 | mensual | |
| criaderopichiblanco.cl | dominio | anual | 10.000 | anual | |
| criaderopichiblanco.cl - Plan Medio | hosting | anual | 3.333 | mensual | |
| EBCO LA LIGUA - ANUAL | starlink | anual | 31.092 | mensual | ya tenía costo fijo mensual |
| EBCO QUILLOTA FER MONCK | starlink | mensual | 31.092 | mensual | ya tenía costo fijo mensual |
| EBCO WIND | starlink | mensual | 31.092 | mensual | |
| ecmovial.cl - Plan Corporaciones | hosting | anual | 3.333 | mensual | |
| Escuela Alborada del Mar x2 | hosting | anual | 6.667 | mensual | |
| ingesal.cl - Plan Medio | hosting | anual | 3.333 | mensual | |
| IVCB - Plan Basico | hosting | anual | 3.333 | mensual | |
| Microsoft ADQUICOMER | licencias MS | anual | 11.667 | mensual | ⚠ Microsoft sin pool |
| Microsoft Trimant (UY) | licencias MS | mensual | 40 USD | mensual | ⚠ Microsoft sin pool; ya tenía costo fijo |
| Numancia sports - plan grande | hosting | anual | 3 | mensual | ⚠ muy bajo (costo esperado anual 40) |
| raicespenablanca.cl - plan medio | hosting | anual | 3.333 | mensual | |
| razo.cl Plan Medio | hosting | anual | 3.333 | mensual | |
| Servidor VCB | servidor | mensual | 6.000 | mensual | ya tenía costo fijo; su costo esperado 9.900 se descartó |
| terroraventura.cl - Plan Medio | hosting | anual | 3.333 | mensual | |
| trei.cl - Plan Grande | hosting | anual | 3.333 | mensual | |

**Ninguno tiene proveedor**: hasta cargarlo, sus facturas de compra no se asignan solas a los períodos de costo.

## Pendiente (para revisar a mano)

1. Los meses de vencimiento calculados de los anuales vencidos que empiezan el día 1 (bajan un mes). Si un servicio en realidad se cobra en el aniversario, corresponde cambiarle la modalidad a adelantado o la fecha de inicio.
2. ingesal.cl: el ciclo nuevo de octubre 2026.
3. Numancia sports (3 CLP/mes), ADQUICOMER y Trimant (Microsoft sin pool), Servidor VCB (9.900 descartado).
4. Cargar el proveedor de cada servicio.
5. Smoke test en el navegador con un usuario real: ficha de un servicio anual, Costos y Rentabilidad.
6. Borrar el respaldo `G:\INMA-ERP\backups\prod-2026-10-20\` cuando ya no haga falta (tiene hashes de contraseña).
