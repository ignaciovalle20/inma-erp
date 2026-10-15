# Deploy a producción — 2026-10-15

- **Resultado final:** **DESPLEGADO.**
  - La migración `20261014010000_payment_status_two_states_and_import_parity` quedó aplicada en prod (63/63).
  - `dev` se mergeó a `main` sin squash (`82286cb`).
  - Vercel Production quedó **Ready** con ese commit.
  - La Fase D pasó completa.
- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`, sa-east-1).
- **Red de seguridad:** esquema `backup_20261015` dentro de prod. Ver "Backup y cómo restaurar".
- **CLI de Supabase:** volvió a quedar linkeada a DEV `sczgankronafrxybpvnh`. Lo verifiqué con `supabase/.temp/project-ref`, con `projects list` (`inma-erp-dev`, linked) y con una consulta. La consulta devolvió 63 migraciones, las empresas Demo Chile SpA, Demo Uruguay SRL e Inmasoft UY, y ningún `backup_20261015`, así que es dev.

Hubo tres corridas:

1. **Primera corrida.** Abortó en el paso 1 porque `docs/deploy-prod-2026-10-04.md` tenía cambios sin commitear. Lo commiteaste en `dev` (`acdce06`).
2. **Segunda corrida.** Abortó en el paso 6. "Inmasoft Uruguay" (`b10291f2`) tiene `country = null` y la empresa uruguaya se llama "Uruguay", no "Inmasoft UY".
3. **Tercera corrida.** Antes de arrancarla redefiniste tres esperados:
   - el null es aceptable; el criterio pasa a ser "ningún valor **no nulo** fuera de UY/CL";
   - el renombre a "Uruguay"/"Chile" fue intencional;
   - se acepta que `companies.updated_by` quede en null en "Uruguay".

   Con eso la corrida completa salió bien.

## Cronología (tercera corrida, −03)

| Hora | Paso | Resultado |
|---|---|---|
| 14:27 | Fase A | Todo OK (detalle abajo). |
| ~14:28 | Fase B | Backup creado y verificado. |
| 14:29 | Dry run | `db push --linked --dry-run` solo listó `20261014010000`. |
| 14:29:55–14:30:01 | `db push --linked` | Aplicada sin error. |
| 14:30:19 | Merge | `dev` → `main` con `--no-ff`, hecho en un worktree temporal que después se borró. Push `c03bb8b..82286cb`. |
| 14:30:22–~14:31:20 | Vercel | `dpl_B9LNGFefmAMc6ZngNxzWpxW2EJ1a`, **Ready**, `githubCommitRef: main`, `githubCommitSha: 82286cb`. Alias `inma-erp.vercel.app`. |

**Ventana entre la migración y la app nueva: ~80 s** (de 14:30:01 al Ready, ~14:31:20).

## Fase A — Chequeos previos (solo lectura sobre prod)

| # | Chequeo | Resultado |
|---|---|---|
| 1 | git | **OK.** `dev` = `origin/dev` = `acdce06` y `main` = `origin/main` = `c03bb8b`, después de `git fetch` y también con `ls-remote`. Archivos sin versionar: este reporte y `node_modules/` en la raíz (caché de vitest). Ninguno es relevante. |
| 2 | `npm run test` (web/) | **OK.** 48 archivos, 529 tests. |
| 3 | Link a prod | **OK.** `projects list` mostró `jxkfpkgyvjiyufmfxsfp`, `inma-erp-sa-east-1`, `sa-east-1`, ACTIVE_HEALTHY, linked. Antes de cada operación leí `supabase/.temp/project-ref`. |
| 4 | `migration list --linked` | **OK.** 63 locales y 62 aplicadas; incluye `20261012010000` y `20261013010000`. La única pendiente era `20261014010000` y no había migraciones solo remotas. |
| 5 | Inventario | **OK** con los esperados actualizados. Coincide con el de la segunda corrida (comparación automática). |
| 6 | Simulación | **OK** (abajo). Después de simular, el inventario de prod salió idéntico, no existía la RPC nueva y `payment_status` seguía admitiendo null. |
| 7 | Compatibilidad | **OK, solo se degradan lecturas** (abajo). `main` no cambió desde el análisis. |
| 8 | Vercel | **OK.** Production estaba en `dpl_EcNJCQ3BZLbe6GZruATJpSDNbi9w`, Ready, desde `main` @ `c03bb8b`. |

### Paso 5 — Inventario previo

**companies**

| id | nombre | country antes | moneda |
|---|---|---|---|
| `6daad6e3-ff4c-4026-aa3d-4f8290e10724` | Chile | `CL` | CLP |
| `9f3d4d07-eb87-439c-a5fd-ece044553bc5` | Uruguay (ex "Inmasoft UY") | `Uruguay` | UYU |
| `b10291f2-55b8-4736-8a23-e2848412500f` | Inmasoft Uruguay (sin datos) | `null` | CLP |

**sales_documents** (182; 19 con `paid_at`)

| Empresa | Antes | Ventas | Con paid_at |
|---|---|---|---|
| Chile | pagado | 126 | 0 |
| Chile | no_aplica | 8 | 0 |
| Chile | por_vencer | 10 | 0 |
| Chile | vencido | 19 | 0 |
| Uruguay | pagado | 19 | 19 |
| — | null | 0 | — |

**recurring_services** (15): Chile `CL` 13 y Uruguay `null` 2.

**Resultado Mensual de septiembre 2026.** Lo calculé con un SQL independiente, con la misma regla que `computeMonthlyResult` en `web/src/lib/reporting.ts`:
- **ventas:** no anuladas, con las NC en negativo, según el período efectivo;
- **costos:** directos y generales, sin los cubiertos por pool;
- **personal;**
- **ciclos recurrentes:** facturados o cobrados, con su costo fijo o su parte del pool.

Todo en moneda de la empresa, con la tasa guardada en cada documento.

| Empresa | Moneda | Ventas netas | Costos directos | Margen directo | Costos generales | Resultado |
|---|---|---|---|---|---|---|
| Chile | CLP | 13.443.699 | 908.182 | 12.535.517 | 0 | **12.535.517** |
| Inmasoft Uruguay | CLP | 0 | 0 | 0 | 0 | **0** |
| Uruguay | UYU | 11.768,70 | 1.600,64 | 10.168,06 | 0 | **10.168,06** |

No hay líneas sin tasa. Hash de `sales_documents` sin `payment_status` ni `paid_at`: `50f764796aa971e37093eadfb7843a78`.

### Paso 6 — Simulación con rollback

Mecanismo: `begin;`, después el contenido completo de la migración y al final un bloque `DO` que junta los resultados y hace `RAISE EXCEPTION`, lo que revierte todo. Lo probé antes con un esquema de prueba: existía dentro de la transacción y no después.

| Verificación | Resultado |
|---|---|
| Corre sin error | Sí. |
| Mapeo | pagado 145 → pagado, no_aplica 8 → pagado, vencido 19 → impago y por_vencer 10 → impago. **Total: pagado 153 e impago 29**, igual a lo esperado. |
| Fuera de pagado/impago o null | 0. La columna queda `NOT NULL` con default `'impago'`. |
| Impagas con `paid_at` | 0. `paid_at` no cambia en ninguna fila. |
| Otros campos de `sales_documents` | 0 filas cambian. Siguen siendo 182. |
| `companies.country` | Uruguay pasa de `Uruguay` a `UY`, Chile sigue en `CL` e Inmasoft Uruguay queda en `null` (aceptado). 0 valores no nulos fuera de UY/CL. |
| Otros campos de `companies` | Solo en "Uruguay": `updated_at` y `updated_by`, que pasa a `null` (aceptado). |
| `recurring_services.country` | Uruguay: 2 pasan de null a `UY`. Chile: 13 siguen en `CL`. Quedan 0 null y no cambia ningún otro campo. |

### Paso 7 — Qué se rompía en la ventana (app de `c03bb8b` + esquema nuevo)

Nada fallaba al escribir. Lo que se veía mal:
- **Badge:** mostraba `impago` crudo.
- **Filtro de cobro:** solo "Pagado" funcionaba.
- **Pendientes:** "Facturas vencidas" y "Ventas sin factura pendientes" quedaban vacías.
- **Vista previa de Nubox:** mostraba cambios falsos ("impago → por_vencer"). El import en sí funcionaba, porque la RPC nueva traduce los estados viejos.

La ventana duró ~80 s. En ese lapso no hubo cambios de datos: el hash de `sales_documents` sin los campos de pago dio igual que antes, y el mapeo contra el backup es exacto.

## Fase B — Backup y cómo restaurar

**Esquema `backup_20261015`** en prod, creado en una sola transacción. **No lo borré**: queda para que lo borres vos.

| Tabla | Filas | ¿Coincide con prod al crearla? |
|---|---|---|
| `sales_documents` | 182 | Sí (conteo y hash de todas las filas) |
| `companies` | 3 | Sí (conteo y hash) |
| `recurring_services` | 15 | Sí (conteo y hash) |
| `function_defs` *(extra)* | 7 | Definición (`pg_get_functiondef`) y permisos de cada función que la migración reemplazó |
| `constraint_defs` *(extra)* | 1 | El CHECK anterior de `payment_status` |

- **Acceso:** `revoke all` del esquema y de sus tablas para `public`, `anon` y `authenticated`. Verificado: sin USAGE ni SELECT para `anon` ni para `authenticated`.
- **Permisos anteriores de las funciones:** las 7 tenían EXECUTE para `anon`. La migración se lo quitó (ver paso 17).

### Restaurar `payment_status` y `paid_at`

```sql
begin;
alter table public.sales_documents drop constraint sales_documents_payment_status_check;
alter table public.sales_documents
  alter column payment_status drop not null,
  alter column payment_status drop default;          -- antes: nullable y sin default

alter table public.sales_documents disable trigger user;
update public.sales_documents s
set payment_status = b.payment_status, paid_at = b.paid_at
from backup_20261015.sales_documents b
where b.id = s.id
  and (s.payment_status is distinct from b.payment_status or s.paid_at is distinct from b.paid_at);
-- Ventas creadas DESPUÉS del deploy (no están en el backup) pueden estar en 'impago',
-- valor que el CHECK viejo no admite. Hay que decidir a qué pasarlas antes de volver a ponerlo, p. ej.:
-- update public.sales_documents set payment_status = null
--   where payment_status = 'impago' and id not in (select id from backup_20261015.sales_documents);
alter table public.sales_documents enable trigger user;

alter table public.sales_documents add constraint sales_documents_payment_status_check
  check (payment_status is null
         or payment_status in ('pagado', 'por_vencer', 'vencido', 'no_aplica', 'pendiente'));
  -- = backup_20261015.constraint_defs
commit;
```

### Restaurar `country` (y, si querés, `updated_at`/`updated_by` de la empresa)

```sql
begin;
alter table public.companies disable trigger user;
update public.companies c
set country = b.country, updated_at = b.updated_at, updated_by = b.updated_by
from backup_20261015.companies b
where b.id = c.id
  and (c.country is distinct from b.country or c.updated_by is distinct from b.updated_by);
alter table public.companies enable trigger user;

alter table public.recurring_services disable trigger user;
update public.recurring_services r
set country = b.country
from backup_20261015.recurring_services b
where b.id = r.id and r.country is distinct from b.country;
alter table public.recurring_services enable trigger user;
commit;
```

### Volver a la versión anterior de las funciones (aparte)

La fuente exacta es `backup_20261015.function_defs`: `select signature, definition from backup_20261015.function_defs;`. Cada `definition` es un `CREATE OR REPLACE FUNCTION` completo para ejecutar tal cual. También están en las migraciones anteriores:

| Función | Versión anterior en |
|---|---|
| `mark_sales_document_paid(uuid, date, text)` | `20260920010000_sales_nubox_import_payment_status.sql` |
| `mark_sales_document_pending(uuid)` | `20260920010000_sales_nubox_import_payment_status.sql` |
| `create_manual_sale_without_invoice(uuid, uuid, date, numeric, numeric, text)` | `20260920010000_sales_nubox_import_payment_status.sql` |
| `import_nubox_documents_batch(uuid, jsonb)` | `20261004020000_nubox_adopt_ventas_sin_factura.sql` |
| `import_sales_rows_batch(uuid, jsonb)` | `20260914010000_batch_import_sales_rows.sql` |
| `create_import_batch(uuid, text, int)` | La última definición literal está en `20260913050000_epic4_story1_import_sales.sql`. Si el bloqueo "solo Chile" se agregó de otra forma, la fuente correcta es `function_defs`. |
| `create_cost_import_batch(uuid, text, int)` | `20260915060000_import_purchase_invoices.sql` (misma salvedad) |

La función nueva no existía antes: `drop function public.set_sales_documents_payment_status(uuid[], text, date);`.

No conviene devolverle EXECUTE a `anon`. Si se restaura, hay que restaurar también el código de `c03bb8b`, porque la app nueva usa la RPC nueva y los dos estados.

## Fase C — Deploy

- `db push --linked --dry-run` listó solo `20261014010000`.
- `db push --linked` la aplicó sin error (exit 0).
- Merge `dev` → `main` sin squash: `82286cb` ("Merge dev into main: deploy a prod 2026-10-15 …"), pusheado a `origin/main`.
- Vercel `dpl_B9LNGFefmAMc6ZngNxzWpxW2EJ1a` quedó **Ready** a la primera; no hizo falta redeploy.

## Fase D — Verificación (solo lectura)

| # | Verificación | Resultado |
|---|---|---|
| 13 | Migraciones | **63/63.** `migration list` muestra 63 aplicadas; `schema_migrations` tiene 63 y la última es `20261014010000`. |
| 14 | payment_status | **OK.**<ul><li>Solo `pagado` 153 e `impago` 29 (Chile: 134 pagadas y 29 impagas; Uruguay: 19 pagadas), sin null. Coincide con la simulación.</li><li>El CHECK quedó en `('pagado','impago')` y la columna es NOT NULL.</li><li>0 impagas con `paid_at`.</li><li>`paid_at` no cambió en ninguna venta respecto del backup (0 diferencias).</li><li>El mapeo contra el backup es exacto.</li><li>Siguen siendo 182 ventas, y el hash sin los campos de pago es igual al de antes (`50f764796aa971e37093eadfb7843a78`).</li></ul> |
| 15 | companies.country | **OK.** Chile `CL`, Uruguay `UY`, Inmasoft Uruguay `null` (aceptado). 0 valores no nulos fuera de UY/CL. Servicios recurrentes: Uruguay `UY` 2 y Chile `CL` 13. |
| 16 | Resultado Mensual sep 2026 | **Idéntico** al del paso 5 (comparación automática del resultado completo): Chile 12.535.517 CLP, Uruguay 10.168,06 UYU, Inmasoft Uruguay 0. |
| 17 | RPC | **OK.** Existen `set_sales_documents_payment_status(uuid[],text,date)`, `mark_sales_document_paid`, `mark_sales_document_pending`, `import_nubox_documents_batch`, `import_sales_rows_batch`, `create_import_batch` y `create_cost_import_batch`, más `create_manual_sale_without_invoice`. **Ninguna tiene EXECUTE para `anon`**; todas lo tienen para `authenticated`. |
| 18 | `/login` | **200** en `https://inma-erp.vercel.app/login`. |

## Cierre

- La CLI quedó relinkeada a DEV y está verificada (ver arriba).
- Se borró el worktree temporal de `main`.
- Este reporte se commitea en `dev`, se pushea, y después `dev` se mergea a `main` otra vez para que queden iguales.

## Para revisar en el navegador

- Ventas: columna y filtro Pagada/Impaga, y un marcado masivo de prueba (revertilo después).
- Una venta de Inmasoft UY (ahora "Uruguay") en USD con el resumen multimoneda.
- Dashboard Chile: septiembre igual al de antes (12.535.517 CLP de resultado operativo).
- Pendientes: "Revisar pago" y "Ventas sin factura impagas".
- Nuevo ícono en el login y la barra lateral.
