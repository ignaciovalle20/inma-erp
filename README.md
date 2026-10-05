# INMA ERP

ERP interno de gestión para Inmasoft (Chile y Uruguay). Fuente de verdad para **rentabilidad de gestión**: ganancia real mensual y margen por proyecto, cliente y área de negocio.

> Este proyecto se gestiona con metodología BMAD (Breakthrough Method for Agile AI-Driven Development). El contexto funcional y técnico completo vive en [`docs/prd.md`](docs/prd.md) y [`docs/architecture.md`](docs/architecture.md). Las épicas y su desglose en historias se gestionan como issues de GitHub (label `epic` / `story`).

## Alcance V1

Calcular resultado mensual y rentabilidad por proyecto/cliente/área para Inmasoft Chile y Uruguay, con ingresos y costos cargados manualmente (+ importación CSV/Excel para Chile). **Fuera de alcance V1**: bancos, conciliación bancaria, emisión tributaria, CRM completo, tickets e inventario.

## Stack

- Next.js 16 + TypeScript + App Router
- Supabase Cloud (PostgreSQL, Auth, Storage, RLS)
- GitHub (código + migraciones SQL versionadas)
- Hosting: Vercel (deploy automático desde GitHub)

## Entornos

Hay dos proyectos de Supabase. El esquema vive en el repo como migraciones (`supabase/migrations`) y es lo único que se aplica a la base: nada de cambios de esquema a mano desde el Dashboard.

| Entorno | Rama | Vercel | Proyecto Supabase (ref) |
|---|---|---|---|
| Desarrollo / pruebas | `dev` | Preview | dev (`sczgankronafrxybpvnh`) |
| Producción | `main` | Production | prod (`jxkfpkgyvjiyufmfxsfp`) |

**Variables.** `web/.env.example` lista las tres que usa la app (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`). Localmente se copia a `web/.env.local` con los valores del proyecto **dev**. En Vercel se cargan por entorno: *Production* con las claves de prod y *Preview* con las de dev, para que un preview nunca toque producción. Ninguna clave ni contraseña se guarda en el repo. Las claves de los proveedores de IA no van en variables: viven en la tabla `ai_assistant_settings` de cada proyecto, así que dev necesita las suyas.

### Flujo para un cambio de esquema

Los comandos se corren desde `web/` (el CLI de Supabase está como devDependency y encuentra `supabase/` en la raíz).

1. **Crear la migración** en la rama `dev` y escribir el SQL. Nunca se edita una migración ya aplicada: se crea otra.

   ```bash
   npx supabase migration new nombre_descriptivo
   ```

2. **Push a dev.** Con el workflow activo lo hace solo al pushear `dev`. A mano:

   ```bash
   npx supabase link --project-ref sczgankronafrxybpvnh
   npx supabase db push --dry-run
   npx supabase db push
   ```

3. **Probar en el preview** de Vercel de la rama `dev` (usa el proyecto dev).
4. **Merge a `main`** por pull request.
5. **Push a prod.** Con el workflow activo se aplica al pushear `main`. A mano, con el mismo cuidado:

   ```bash
   npx supabase link --project-ref jxkfpkgyvjiyufmfxsfp
   npx supabase db push --dry-run
   npx supabase db push
   ```

Reglas:

- El CLI recuerda el último proyecto enlazado (`supabase/.temp/project-ref`). **Antes de cada `db push`, confirmar a cuál apunta.**
- Una migración se aplica a dev y a prod solo desde el código que ya está en `dev`/`main`. No aplicar a prod una migración de una rama que aún no se mergea: `db push` fallará después con "Remote migration versions not found in local migrations directory".
- Preferir migraciones aditivas y código compatible con el esquema viejo y el nuevo, para poder migrar antes de mergear sin romper la versión que corre.
- No usar `db reset`, ni `--include-seed`, ni `migration repair` contra prod.

### Datos de prueba y usuarios en dev

`supabase/seed.sql` carga datos inventados: empresas de Chile y Uruguay, 2 clientes, 2 proveedores, 3 trabajos, ingresos y costos en CLP/UYU/USD. Es idempotente y **aborta si la base tiene empresas que no son de prueba**, así que no corre en prod.

Las cuentas no se crean por código (ver la migración de auth): se provisionan desde el Dashboard y no hay contraseñas en el repo.

1. En el proyecto **dev**: *Authentication → Users → Add user → Create new user*, con un correo y una contraseña que elijas, y marcar *Auto Confirm User*.
2. Cargar los datos de prueba (`--include-seed` solo contra dev):

   ```bash
   npx supabase link --project-ref sczgankronafrxybpvnh
   npx supabase db push --include-seed
   ```

   El seed da acceso *admin* a las dos empresas de prueba a todos los usuarios que ya existan.
3. Si el usuario se crea **después** del seed, darle acceso ejecutando esto en el *SQL Editor* de dev:

   ```sql
   insert into public.company_memberships (user_id, company_id, role)
   select u.id, c.id, 'admin'
   from auth.users u
   cross join public.companies c
   where c.id in ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002')
   on conflict (user_id, company_id) do nothing;
   ```

### Workflow de migraciones (GitHub Actions)

`.github/workflows/db-migrations.yml` aplica las migraciones: push a `dev` → proyecto dev, push a `main` → proyecto prod. Está **inactivo** hasta que:

1. Se creen en GitHub (*Settings → Environments*) los environments `dev` y `production`.
2. En cada uno se carguen los secrets `SUPABASE_ACCESS_TOKEN` (token personal de una cuenta con acceso a ese proyecto) y `SUPABASE_DB_PASSWORD` (contraseña de la base de ese proyecto).
3. Recomendado: en `production`, *Required reviewers*, para que un merge a `main` espere una aprobación antes de tocar prod.
4. Se cree la variable de repo (*Settings → Secrets and variables → Actions → Variables*) `DB_MIGRATIONS_ENABLED` con valor `true`.

También se puede lanzar a mano (*Run workflow*) desde `dev` o `main`.

## Documentación

- [`docs/manual-usuario.md`](docs/manual-usuario.md) — Manual de usuario: qué hace el ERP y cómo se usa cada módulo
- [`docs/prd.md`](docs/prd.md) — Product Requirements Document (alcance, lógica financiera, reglas de negocio, criterio de "V1 lista")
- [`docs/architecture.md`](docs/architecture.md) — Arquitectura técnica, modelo de datos, reglas de integridad/seguridad
- [`docs/decisiones-abiertas.md`](docs/decisiones-abiertas.md) — Decisiones pendientes a resolver antes de construir reportes

## Estado

Proyecto en etapa de definición de esquema de base de datos y migraciones (Épica 1). Ver [issues](../../issues) para el detalle de épicas y avance.
