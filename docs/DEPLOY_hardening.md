# Deploy a prod — hardening 2026-11

Rama `hardening/2026-11`, mergeada en `dev`. Probada en dev (`sczgankronafrxybpvnh`) el 2026-10-30. **Prod (`jxkfpkgyvjiyufmfxsfp`) todavía no tiene nada de esto.**

## Qué trae

| Pieza | Dónde | Efecto |
|---|---|---|
| `20261030010000_revoke_public_execute_trigger_functions` | migración | `revoke execute … from public, anon` en `seed_default_business_areas()` y en las 2 funciones de trigger de `20261029010000`. Con eso, la verificación "anon sin EXECUTE" queda limpia en las 8 funciones. Los triggers siguen disparando, porque Postgres no chequea EXECUTE al disparar. |
| `20261030020000_import_dedup_unique_indexes` | migración | Índices únicos: clave natural de costos importados (empresa + proveedor + código de tipo + folio, sin "Importar igual"), `import_row_id` único en ventas y costos, y `(import_batch_id, row_number)` en `cost_import_rows`. Los 3 importadores (`import_sales_rows_batch`, `import_nubox_documents_batch`, `import_cost_rows_batch`) insertan con `ON CONFLICT DO NOTHING`: una fila que pierde la carrera queda como "duplicado" y no como error. |
| `20261030030000_rls_initplan_helpers` | migración | Helpers `is_company_member(uuid)` / `is_company_admin(uuid)` (STABLE, SECURITY DEFINER), y 119 políticas reescritas para usarlos o para usar `(select auth.uid())`. Las reglas son las mismas. |
| Cifrado de API keys de IA | `web/src/lib/ai/keyCrypto.ts`, `settings.ts`, `settings/ai/actions.ts`, `web/scripts/encrypt-ai-keys.mjs` | `user_ai_settings.api_key` se guarda como `enc:v1:…` (AES-256-GCM) con la clave `AI_SETTINGS_ENCRYPTION_KEY`, y solo se descifra en el servidor. Una fila vieja en claro se sigue leyendo hasta correr el script. |

**No incluido:**
- **Índice único en `import_rows (import_batch_id, row_number)`:** prod tiene 18 pares repetidos, todos del lote `5072cfa8`, el import único de UY 2026 por script, que numeró las filas por hoja. Crear el índice fallaría. Las ventas igual quedan deduplicadas por el índice único de folio que ya existía (`sales_documents_company_type_number_key`).
- **Ventas sin folio:** no tienen clave natural en la base (se comparan por cliente + fecha + total). Siguen como estaban.

Por qué cifrado en el servidor y no Supabase Vault:
- **Una sola variable.** Es una variable de entorno por proyecto de Supabase; no hacen falta funciones `SECURITY DEFINER` para leer `vault.decrypted_secrets` ni permisos sobre el esquema `vault`.
- **Sin service role.** El código no tiene que usarlo para leer la key, cosa que el repo restringe a propósito (`lib/supabase/service.ts`).
- **Backups seguros.** Los backups JSON y los dumps solo contienen el texto cifrado.

El costo es que la clave vive en Vercel: si se pierde o se cambia, cada usuario vuelve a guardar su key en Ajustes → IA.

## Pasos para prod (en este orden)

Todos los comandos de base usan `--linked --project-ref jxkfpkgyvjiyufmfxsfp`. No re-enlazar la CLI: sigue apuntando a dev.

### 1. Precheck (solo lectura)

Las 5 consultas tienen que dar 0 (el 2026-10-30 dieron 0):

```sql
select
  (select count(*) from (select 1 from public.cost_documents where document_number is not null and source = 'import' and not duplicate_override group by company_id, supplier_id, coalesce(source_document_type, ''), document_number having count(*) > 1) x) as cost_key_dups,
  (select count(*) from (select 1 from public.sales_documents where import_row_id is not null group by import_row_id having count(*) > 1) x) as sales_import_row_dups,
  (select count(*) from (select 1 from public.cost_documents where import_row_id is not null group by import_row_id having count(*) > 1) x) as cost_import_row_dups,
  (select count(*) from (select 1 from public.cost_import_rows where row_number >= 0 group by import_batch_id, row_number having count(*) > 1) x) as cost_rows_dups,
  (select count(*) from (select 1 from public.sales_documents where document_number is not null group by company_id, document_type, document_number having count(*) > 1) x) as sales_key_dups;
```

Si alguna no da 0: no seguir. Revisar esas filas, y en su caso sacar ese índice de la migración.

### 2. Backup y huella

Con la misma receta de `docs/deploy-prod-2026-10-29-auditoria.md` §2: datos JSON por tabla, `schema.json` del catálogo y huella count + md5 por tabla, en `G:\INMA-ERP-backups\prod-<fecha>-hardening\`. `schema.json` guarda las 121 políticas y las 3 funciones de import originales, y es la base para un rollback. Además, la línea base de RLS del paso 5.

### 3. Variable nueva en Vercel (antes de mergear a `main`)

`AI_SETTINGS_ENCRYPTION_KEY` (Settings → Environment Variables, tipo *Sensitive*):

| Entorno | Valor |
|---|---|
| Production | Uno **nuevo**: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Guardarlo también en el gestor de contraseñas: sin él no se pueden leer las keys. |
| Preview | El mismo de `web/.env.local` (dev). La key de IA que hay en dev ya está cifrada con ese valor. |

Sin la variable, guardar una key en Ajustes → IA da "No se pudo guardar la configuración" y el asistente no puede leer las keys cifradas. Lo que no falla es leer filas viejas en claro.

### 4. Migraciones

```bash
npx supabase migration list --linked --project-ref jxkfpkgyvjiyufmfxsfp
```
```bash
npx supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp --dry-run
```

Tienen que figurar exactamente las 3 migraciones de arriba, y prod tiene que tener 80 aplicadas. Después:

```bash
npx supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp
```

### 5. Verificaciones (SELECT)

```sql
select
  (select count(*) filter (where has_function_privilege('anon', f, 'execute')) from unnest(array[
    'public.update_technician_charge(uuid,text,date,numeric,boolean,numeric)', 'public.seed_default_business_areas()',
    'public.create_company(text,text,text,text)', 'public.update_import_batch_counts(uuid)',
    'public.update_cost_import_batch_counts(uuid)', 'public.delete_technician_charge(uuid)',
    'public.technician_payment_check_balanced_on_delete()', 'public.client_aliases_validate_company_refs()']::regprocedure[]) f) as anon_exec_of_8,           -- 0
  (select count(*) from pg_policies where schemaname = 'public') as policies,                                                              -- 121
  (select count(*) from pg_policies where schemaname = 'public' and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'auth\.uid\(\)'
     and (coalesce(qual, '') || coalesce(with_check, '')) !~ 'SELECT auth\.uid\(\)') as bare_auth_uid,                                    -- 0
  (select count(*) from pg_indexes where indexname in ('cost_documents_import_natural_key', 'sales_documents_import_row_id_key',
     'cost_documents_import_row_id_key', 'cost_import_rows_batch_row_key')) as new_unique,                                                  -- 4
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity) as tables_without_rls; -- 0
```

Para comprobar que las reglas de RLS no cambiaron, contar las filas visibles por usuario y tabla antes del paso 4 y después, y comparar. En dev dieron 0 diferencias en 86 pares usuario × tabla. Por cada usuario de `company_memberships`, más uno inexistente:

```sql
do $$
declare t text; n bigint; res text := '';
begin
  perform set_config('request.jwt.claims', json_build_object('sub', '<user_id>', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  for t in select tablename from pg_tables where schemaname = 'public' order by 1 loop
    execute format('select count(*) from public.%I', t) into n;
    res := res || n::text || ',';
  end loop;
  raise exception 'RLSCOUNTS%', res;   -- aborta: no escribe nada
end $$;
```

Por último, la huella después del push tiene que ser igual a la de antes. Las migraciones no cambian datos.

### 6. Código

Mergear `dev` en `main` (`--no-ff`, desde un worktree temporal), pushear y esperar el deploy de Vercel. El estado se sigue en `https://api.github.com/repos/ignaciovalle20/inma-erp/commits/<sha>/status`.

### 7. Cifrar las keys existentes (prod tiene 1)

Desde `web/`, en una terminal propia, con las variables de **prod**: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y la `AI_SETTINGS_ENCRYPTION_KEY` de Production. Las variables explícitas tienen prioridad sobre `web/.env.local`.

```bash
node scripts/encrypt-ai-keys.mjs
```
```bash
node scripts/encrypt-ai-keys.mjs --apply
```

La primera corrida no escribe nada: solo muestra el proyecto y los conteos. La segunda termina con `Left in clear: 0. Not decryptable with this key: 0.`. El script nunca imprime una key.

### 8. Smoke

- Con sesión: Ajustes → IA muestra la key como guardada, y el asistente responde.
- Importar dos veces el mismo CSV de compras: la segunda vez todas las filas quedan como "duplicado".
- Resumen, Ventas, Costos, Proyectos y Servicios recurrentes cargan igual que antes, sin errores.

## Rollback

- **Código:** revertir el merge en `main`. La app vieja lee `api_key` como texto, así que las keys ya cifradas dejan de funcionar hasta volver a guardarlas. Por eso conviene correr el paso 7 recién con el código nuevo estable.
- **Migraciones** (no cambian datos):
  - `drop index` de los 4 índices nuevos y recrear `sales_documents_import_row_id_idx` y `cost_documents_import_row_id_idx` (definidos en `20261029010000`).
  - Recrear las 3 funciones de import y las 119 políticas desde `schema.json` del backup.
  - `drop function public.is_company_member(uuid), public.is_company_admin(uuid)`, después de las políticas.
  - `grant execute … to public` en las 3 funciones de trigger.
