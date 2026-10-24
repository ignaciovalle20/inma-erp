# Deploy a producción — tipo de servicio "Mnto Web" (2026-10-24, tarde)

- **Resultado final:** **DESPLEGADO.**
  - La migración `20261024030000_service_type_web_maintenance` quedó aplicada en prod (**73/73**).
  - `dev` (`3e881f9`) se mergeó a `main` sin squash: `8032602`.
  - Vercel Production quedó **Ready** con ese commit: GitHub lo marcó "success" ("Deployment has completed") a las 16:21:54.
  - Ningún dato cambió por el deploy: ver Fase C.
- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`). Todos los comandos usaron `--linked --project-ref jxkfpkgyvjiyufmfxsfp`; la CLI sigue linkeada a DEV (`sczgankronafrxybpvnh`).
- **Respaldo:** `G:\INMA-ERP\backups\prod-2026-10-24-web\` (fuera de git). Solo la definición anterior de los checks y la huella de las tablas: la migración reemplaza dos checks por otros que aceptan más valores, así que no puede cambiar datos y no se hizo el respaldo JSON completo.

## Qué entra

| Commit | Cambio |
|---|---|
| `269b60b` | Tipo de servicio recurrente "Mnto Web" (`web_maintenance`): migración, opción en los formularios de servicios y de pools, y columna "Mnto Web" en el tablero mensual. |
| `d28cb6f` | Los servicios de dominio no aparecían en el tablero mensual (ninguna columna tenía el tipo `domain`): ahora van en la columna Hosting. Test nuevo: todo tipo cae en alguna columna. |
| `a96981b` | Al elegir "Mnto Web", el formulario sugiere el área de negocio Web. |
| `3e881f9` | Al elegir "Licencias MS", el formulario sugiere el área Microsoft (buscaba "Microsoft 365", que no existe en las empresas reales; queda como segunda opción porque es el nombre que crea `seed_default_business_areas`). |

La migración reemplaza `recurring_services_service_type_check` y `recurring_service_cost_pools_service_type_check` para aceptar `'ms_licenses', 'hosting', 'starlink', 'server', 'domain', 'web_maintenance', 'other'`. El check de pools tampoco tenía `'domain'`: se agregó. Es aditiva (la app anterior funciona igual con ella), así que se aplicó **antes** del merge.

## Cronología (2026-10-24, −03)

| Hora | Paso | Resultado |
|---|---|---|
| 16:1x | Chequeos previos (solo lectura) | 72 migraciones en prod; pendiente solo `20261024030000` |
| 16:1x | Respaldo de esquema y huella, antes | Definición de los dos checks; conteo y md5 de las 39 tablas `public` |
| 16:19:43–16:19:50 | `supabase db push` a prod (dry-run antes: solo esa migración) | Aplicada sin error |
| 16:20 | Verificación (solo lectura) | OK |
| 16:21:09 | Merge `dev` → `main` (`8032602`, `--no-ff`, en un worktree temporal) y push | El árbol resultante es idéntico al de `dev` |
| 16:21:54 | Vercel Production | **Ready** |

## Fase A — Chequeos previos (solo lectura)

- `main` (`eeb6f4d`) solo tenía merges de deploys anteriores. `dev` tenía los 4 commits de la tabla de arriba.
- Checks en prod antes: `recurring_services` aceptaba `ms_licenses, hosting, starlink, server, domain, other`; `recurring_service_cost_pools`, lo mismo sin `domain`. Guardados en `schema-before.json`.
- Servicios en prod por tipo: hosting 21, ms_licenses 9, starlink 5, domain 2, server 2. Los 2 de dominio empiezan a verse en el tablero con este deploy.
- Áreas: "Web" y "Microsoft" existen en Chile y Uruguay, así que las sugerencias nuevas encuentran el área. "Hosting" existe solo en Chile.
- En `web/`, sobre `3e881f9`: `npx vitest run` 589/589, `npx tsc --noEmit` sin errores salvo los de `LayoutProps` que ya existían, eslint sin errores en los archivos cambiados. En dev la misma migración se aplicó y verificó antes.

## Fase C — Verificación (solo lectura)

| Chequeo | Resultado |
|---|---|
| Historial de migraciones | **73**, la última `20261024030000` |
| `recurring_services_service_type_check` | Acepta los 7 tipos, incluido `web_maintenance`; validado |
| `recurring_service_cost_pools_service_type_check` | Acepta los 7 tipos, incluidos `domain` y `web_maintenance`; validado |
| Datos, tabla por tabla | 37 de 39 tablas con el mismo md5 de todas sus filas antes y después, entre ellas `recurring_services` y `recurring_service_cost_pools`. `project_notes` (4 → 5) y `projects` cambiaron por uso normal: una nota creada a las 16:20:14, 24 s después del push, que actualiza `projects.updated_at` del trabajo. La migración no toca esas tablas |
| Sitio | `https://inma-erp.vercel.app/login` 200; `/companies` redirige a `/login` (307) |
| Smoke test con usuario real | **No se hizo:** no hay credenciales de producción en el entorno |

## Cómo volver atrás

Revertir el código (`main` a `eeb6f4d`) y recrear los dos checks con las definiciones de `schema-before.json`. Antes, cambiar el tipo de cualquier servicio o pool que ya use `web_maintenance` (o `domain` en pools), porque el check viejo lo rechazaría.

## Pendiente (para revisar a mano)

1. Smoke test en el navegador: en un servicio nuevo, elegir "Mnto Web" y ver que se sugiere el área Web; elegir "Licencias MS" y ver que se sugiere Microsoft. En el tablero mensual, ver la columna "Mnto Web" (si hay servicios de ese tipo) y los 2 dominios en Hosting.
2. Borrar `G:\INMA-ERP\backups\prod-2026-10-24-web\` cuando ya no haga falta (no tiene datos sensibles, solo huellas).
