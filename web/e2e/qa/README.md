# QA con volumen (opt-in)

Carga unos 300 proyectos de prueba en **inma-erp-dev** y corre una QA en el navegador sobre el listado de proyectos (buscador, pestañas, `closed_at`) y el detalle (checklist y notas, permisos, pantallas existentes, tiempos de carga).

No corre con `npm run test:e2e`: `playwright.config.ts` ignora `e2e/qa` salvo con `QA_VOLUME=1`.

**Solo dev.** El seed y la spec abortan antes de conectarse si `NEXT_PUBLIC_SUPABASE_URL` (de `web/.env.local`) no es el proyecto `sczgankronafrxybpvnh`. Necesitan `SUPABASE_SERVICE_ROLE_KEY` de dev.

## Qué crea

- Dos empresas `zz-qa-<tag> …`: la de QA, con clientes con tildes y ñ, alias, 300 proyectos 2025–2026 en todos los estados, cotizaciones, documentos de venta (facturas, boletas, notas de crédito, ventas manuales, anulados), checklists y notas. La otra empresa sirve para probar el aislamiento.
- Tres usuarios `zz-qa-<tag>-…@example.test` (dueño, segundo miembro, usuario de otra empresa).
- `e2e/qa/.qa-state.json` con los ids y las contraseñas de esos usuarios descartables (está en `.gitignore` y la limpieza lo borra).

## Cómo correrlo

Desde `web/`, en bash, con un build de producción hecho:

```bash
npm run build
```

```bash
QA_VOLUME=1 node e2e/qa/seed-volume.mjs seed
```

```bash
QA_VOLUME=1 npx playwright test e2e/qa
```

```bash
QA_VOLUME=1 QA_MOBILE=1 npx playwright test e2e/qa
```

En PowerShell: `$env:QA_VOLUME = "1"` (y `$env:QA_MOBILE = "1"` para móvil) antes de los mismos comandos.

La spec modifica los datos (estados, checklist, notas). Para repetirla, o para pasar de escritorio a móvil, limpia y vuelve a sembrar.

Solo los tiempos de carga, sin el resto (no modifica nada):

```bash
QA_VOLUME=1 npx playwright test e2e/qa -g "load timings"
```

## Limpieza

```bash
QA_VOLUME=1 node e2e/qa/seed-volume.mjs cleanup
```

Borra **todo** lo que se llame `zz-qa-*` (empresas con sus filas en cada tabla que tiene `company_id`, y los usuarios), aunque el seed haya quedado a medias, y luego el archivo de estado. No toca nada más.
