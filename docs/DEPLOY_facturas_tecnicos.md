# Deploy a prod: facturas de técnicos y repartos sobre el neto

Probado en dev (`sczgankronafrxybpvnh`) el 2026-11-01. **Prod (`jxkfpkgyvjiyufmfxsfp`) todavía no tiene nada de esto:** sigue en 87 migraciones.

## Migraciones nuevas

| Migración | Qué hace | Cambia datos en prod |
|---|---|---|
| `20261101010000_cost_allocations_on_net` | Los repartos y las filas de servicios pasan a ser partes del neto | Sí: convierte 8 importes fijos de 3 documentos (`audit/2026-11-01-facturas-tecnicos/README.md`). Los reportes no se mueven más que el redondeo |
| `20261101020000_technician_document_application` | `apply_technician_document`, aplicación parcial, un cargo con varios documentos | No |

## Pasos, en este orden

1. Backup y huella, con la receta de `docs/deploy-prod-2026-10-29-auditoria.md` §2.
2. Revisar que figuren estas 2 migraciones:

```bash
npx supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp --dry-run
```

3. Aplicarlas:

```bash
npx supabase db push --linked --project-ref jxkfpkgyvjiyufmfxsfp
```

4. Mergear `dev` en `main` enseguida y esperar el deploy de Vercel. **Entre el paso 3 y este, la pantalla vieja de "Editar asignación" falla al guardar** (valida contra el neto y sigue enviando el total) y muestra importes más chicos en los repartos. No se pierde nada, pero conviene hacerlo con poco uso.
5. Comprobar que `01_diagnostico.sql` dé 0 en el chequeo R1.
6. Dejar la FAC-EL 257: ver `audit/2026-11-01-facturas-tecnicos/README.md`. Faltan 3 de sus 4 cargos en prod.

## Smoke

- Editar asignación de una factura con IVA: "Por repartir (neto)" muestra el neto.
- Un trabajo: la lista de gastos suma lo mismo que su figura de Costos.
- Documento de un técnico: aparecen sus cargos de todos los trabajos, también los sin respaldo. La suma compara netos.
- Con una diferencia, el botón pide confirmarla. Un monto menor al del cargo queda como "Parcial".

## Rollback

- **Código:** revertir el merge en `main`. Hay que revertir también `20261101010000`: el código viejo espera importes con IVA.
- **`20261101010000`:** recrear `set_cost_allocations` y `set_cost_document_allocations` desde `schema.json` del backup, y volver a poner los importes de `cost_allocations` desde `data.json`.
- **`20261101020000`:** `drop function` de `apply_technician_document` y `technician_charge_take_backing`, y recrear desde `schema.json` `technician_charges_check_cost_source`, `unlink_technician_document` y `update_backed_technician_charge`. La restricción `unique (charge_id)` solo se puede volver a crear si ningún cargo tiene dos documentos.
- **Un cargo sin respaldo que tomó una factura** no vuelve solo a "sin respaldo" al desvincular: sus montos se restauran desde `data.json`.
