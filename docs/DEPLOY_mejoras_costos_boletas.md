# Deploy a prod: mejoras de costos, RUT y boletas

Probado en dev (`sczgankronafrxybpvnh`) el 2026-10-30. **Prod (`jxkfpkgyvjiyufmfxsfp`) todavía no tiene nada de esto.** Va después de `docs/DEPLOY_hardening.md`, que tampoco está en prod: las migraciones de abajo se apoyan en las de ese deploy.

## Migraciones nuevas

| Migración | Qué hace | Cambia datos en prod |
|---|---|---|
| `20261031010000_unlink_cost_from_project_and_real_duplicates` | RPC `unassign_cost_document_from_project`. El importador deja de usar las marcas de borrado. | No |
| `20261031020000_rut_normalization_and_technician_links` | `normalize_tax_id` con el formato `12345678-K`, triggers de guardado y de vínculo. | Sí: `137658720` pasa a `13765872-0` (Luis Fuentes); vincula a EXEQUIAS CATRIN y CARLOS GUTIERREZ con su proveedor. |
| `20261031030000_boleta_withholding_amounts` | `withholding_amount` y `liquid_amount`, tasas 2020-2024, importador. | Sí: completa las 2 columnas nuevas en 20 boletas. `net_amount` y `total_amount` no cambian. |
| `20261031040000_search_documents` | RPC de búsqueda e índices trigram. | No |

## Pasos, en este orden

Todos los comandos corren desde `web/`. No re-enlazar la CLI: sigue apuntando a dev.

1. Deploy de hardening completo (`docs/DEPLOY_hardening.md`), incluida la variable `AI_SETTINGS_ENCRYPTION_KEY` en Vercel.
2. Backup, con la receta de `docs/deploy-prod-2026-10-29-auditoria.md` §2.
3. Revisar que figuren estas 4 migraciones:

```bash
npx supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp --dry-run
```

4. Aplicarlas:

```bash
npx supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp
```

5. Comprobar las boletas: `cuadra_archivo` tiene que dar `true` en todas.

```bash
npx supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp -f ../audit/2026-10-30-limpieza-costos/04_verificacion_boletas.sql -o json
```

6. Mergear `dev` en `main` y esperar el deploy de Vercel.
7. Decidir la limpieza de la BOL-HE 156 (`audit/2026-10-30-limpieza-costos/README.md`): baja 500.000 el costo general de julio 2026.

```bash
npx supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp -f ../audit/2026-10-30-limpieza-costos/02_limpieza.sql -o json
```

8. En Conciliar, tocar "Buscar sugerencias": el cargo de Luis Fuentes del 2026-07-06 debería proponer la BOL-HE 157.

## Revisar antes de importar compras en prod

Un documento borrado ya no bloquea el importador. La FAC-EL 257 se borró el 2026-10-29 y no volvió a entrar: si está en el archivo de Nubox que se importe, **se crea de nuevo**. Si no debe estar, hay que sacarla del archivo o borrarla después.

## Smoke

- Quitar un gasto de un trabajo: sigue en Costos, sin asignar. Volver a asignarlo.
- Borrar un documento importado y reimportarlo: entra como nuevo.
- Costos en un mes pasado: abrir un gasto y volver. El mes se mantiene.
- Buscar un folio viejo en Costos y en Ventas.

## Rollback

- **Código:** revertir el merge en `main`.
- **Migraciones:** `drop function` de las 3 RPC nuevas, `drop index` de los 6 índices de `20261031040000`, `drop trigger` de `suppliers_normalize_tax_id`, `personnel_normalize_tax_id` y `personnel_link_suppliers`, y `drop column` de `liquid_amount` y `withholding_amount`. Recrear `import_cost_rows_batch`, `cost_documents_protect_financial_fields`, `normalize_tax_id` y el trigger `suppliers_link_technician` desde `schema.json` del backup. Los RUT normalizados y los vínculos nuevos quedan: son correctos con cualquier versión.
