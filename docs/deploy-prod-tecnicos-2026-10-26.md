# Deploy a prod — técnicos: respaldo, vínculo con facturas y boletas, mes del cargo (2026-10-26)

- **Prod:** `jxkfpkgyvjiyufmfxsfp` (`inma-erp-sa-east-1`). Todos los comandos usaron `--linked --project-ref jxkfpkgyvjiyufmfxsfp`; la CLI **no se re-enlazó** y siguió linkeada a DEV (`sczgankronafrxybpvnh`) todo el tiempo (más seguro que enlazar prod y volver).
- **Código:** `main` = `9b12087` (merge de `dev` `319c588`). Vercel producción: **Ready** 13:56:42 UTC (`https://vercel.com/nachovalle20-8464s-projects/inma-erp/CfiichyAjJy8MZUBTm9ZxrqSLqeL`).
- **Resultado:** migraciones aplicadas, **ningún monto cambió**, solo las diferencias esperadas (sección 3). No hizo falta restaurar.

## 1. Migraciones aplicadas (en orden)

| Migración | Qué hace |
|---|---|
| `20261026010000_technician_backing_documents` | Respaldo de cada cargo, RUT de técnicos, vínculo cargo ↔ documento, sugerencias, retención de boletas (`docs/tecnicos-respaldo-documentos-2026-10-26.md`) |
| `20261027010000_technician_link_refuses_service_allocations` | Un documento asignado a servicios recurrentes no se vincula (`docs/qa-tecnicos-2026-10-27.md`) |
| `20261028010000_technician_link_charge_month` | El costo de un cargo vinculado cuenta en el mes del cargo; el documento solo lo respalda |

Aplicadas 13:54:34–13:54:41 UTC (10:54 hora Chile), sin error. Prod pasó de 76 a **79** (= dev).

## 2. Antes de aplicar

- `migration list` contra prod: 76 aplicadas, pendientes exactamente las 3 de arriba, ninguna solo-remota.
- Las 5 funciones que la primera migración reemplaza (`technician_charges_guard`, `update_technician_charge`, `delete_technician_charge`, `set_technician_charge_document`, `delete_cost_document`) tenían en prod el mismo cuerpo que su última migración (comparado sin saltos de línea `\r`): no se pisó ningún cambio hecho a mano.
- Dry-run del push: las 3 migraciones, en orden.
- Precheck (`docs/verificacion-tecnicos-prod-precheck.sql`): 15 cargos de Chile — 3 toman **factura** (de "Luis con F"), 12 **sin respaldo**; 2 de factura marcados "recibida" a mano vuelven a "pendiente"; 0 boletas con IVA; 0 proveedores para vincular por RUT (ningún técnico tiene RUT cargado); 0 RUT ambiguos.

### Respaldo

En `G:\INMA-ERP-dumps\prod-2026-10-26-tecnicos\` (fuera del repo):

| Archivo | Contenido |
|---|---|
| `data.json` | Las 39 tablas `public` (6.773 filas), cada una verificada contra su `count(*)`. Incluye `mcp_access_tokens` y `user_ai_settings`: **no compartir**; borrarlo cuando no haga falta. |
| `counts.json` | Filas por tabla. |
| `schema.json` | Historial de migraciones (76), las 121 funciones (`pg_get_functiondef`), columnas, constraints, índices, triggers, policies y vistas de `public`, antes del deploy. |
| `precheck.json`, `verificacion-antes.json`, `verificacion-despues.json` | Salidas de los dos scripts de `docs/`. |

**No es un `pg_dump`:** en esta máquina no hay `pg_dump`, `psql` ni Docker (que usa `supabase db dump`), y `pg_dump` necesita la contraseña de la base, que por regla no pasa por el chat. Se usó la receta de los deploys anteriores (datos por tabla en JSON vía la API + esquema desde el catálogo). Para restaurar habría que: revertir `main` al commit anterior (`f61616b`), aplicar una migración inversa (borrar las tablas y columnas nuevas y recrear las 5 funciones desde `schema.json`) y volver a cargar `document_status` de `technician_charges` desde `data.json`. Si se quiere además un `pg_dump` (necesita PostgreSQL o Docker instalados y la cadena de conexión de prod, que tiene la contraseña), hacerlo a mano desde una terminal propia o usar el backup diario del Dashboard de Supabase (Database → Backups).

## 3. Después: comparación y diferencias

`docs/verificacion-tecnicos-prod.sql` antes y después:

| Qué | Resultado |
|---|---|
| Cargos (15): monto a pagar, costo, pagado, costo propio (neto y total), empresa, técnico, trabajo, fecha | **Idénticos** |
| Pagos por técnico (3) | **Idénticos** |
| Costos por empresa y mes de 2026 (13) | **Idénticos** |
| Costo de cada trabajo en 2026 (14) | **Idénticos** |
| Huellas md5 de `cost_documents` (1.597), `cost_lines`, `cost_allocations` (6), `cost_service_allocations` (16), aplicaciones de pagos (6) | **Idénticas** |

Diferencias encontradas (todas esperadas, ninguna en montos):

1. **Cargos de factura que vuelven de "recibida" a "pendiente": 2** (de "Luis con F"). El tercero de factura ya estaba pendiente y sigue así.
2. **Cargos sin respaldo: 12** pasan de respaldo vacío a "sin respaldo" y su documento a **"no aplica"** (8 estaban "recibida" y 4 "pendiente"). Es la regla pedida para los cargos sin respaldo; no tienen documento que vincular y no cuentan como pendientes. No cambia ningún monto.
3. **Rentabilidad por cliente y por área en meses con repartos entre trabajos** (fix de reportes, va con el código, no con las migraciones). Prod tiene 6 repartos a trabajos, todos en Chile; desde este deploy cada uno suma también al cliente y al área de su trabajo:

   | Mes | Trabajo | Cliente | Área | Neto que ahora suma |
   |---|---|---|---|---:|
   | 2026-06 | Control de acceso HIK | Empresa Constructora ECMOVIAL limitada | Instalaciones | 92.431 |
   | 2026-06 | Redes en colegios del interior | FUNDACION ANGLO AMERICAN | Instalaciones | 1.680.672 |
   | 2026-06 | STARLINK La Ligua | EBCO S.A. | Instalaciones | 336.134 |
   | 2026-06 | Tintas Wind | Trei Inmobiliaria SPA | Visita tecnica | 37.815 |
   | 2026-10 | CCTV 16ch Arlegui | sociedad romero hermanos limitada | Instalaciones | 331.923 |
   | 2026-10 | Instalacion casa Jose, red seguridad y acceso | Empresa Constructora ECMOVIAL limitada | Instalaciones | 1.492.830 |

   El Resultado mensual, los costos por trabajo y los totales no cambian.

## 4. Estado en prod después del deploy

- **Cargos pendientes de vincular (factura o boleta sin documento), por técnico:**

  | Técnico | Respaldo | Cargos | A pagar | Costo |
  |---|---|---:|---:|---:|
  | Luis con F | Factura | 3 | 1.188.000 | 998.319 |

  Los demás técnicos con cargos (Javier Herrera 1, Luis sin F 10, Ricardo Ruiz 1) son sin respaldo: "no aplica".
- **Sugerencias en Conciliar:** 0 de documentos de técnicos y 0 de facturas a servicios. No puede haber sugerencias de técnicos todavía: ningún técnico tiene RUT vinculado (0 en `technician_suppliers`). Al agregar el RUT de un técnico en su ficha se buscan solas.
- Vínculos: 0. RUT vinculados: 0. Retención de boletas: 2025 14,5 %, 2026 15,25 %, 2027 16 %, 2028 17 %.

## 5. Smoke test

- `https://inma-erp.vercel.app/login` responde 200 ("INMA ERP"); `/`, `/companies`, `/companies/…/personnel` y `/companies/…/sales/reconcile` redirigen a `/login` (307) sin error.
- Contra la base de prod, en solo lectura, las consultas de cada pantalla con sus columnas y funciones nuevas: Personal (7 personas, con `default_backing`), cargos con respaldo y vínculos (15, todos con costo propio), cuenta corriente (6 aplicaciones de pago), RUT (0), Conciliar (0), Resultado mensual de octubre (25 documentos de Chile con `technician_linked_amount`), y el cálculo de la boleta (líquido 375.000 → bruto 442.478, tasa 15,25 %).
- **No verificado por mí:** abrir las pantallas con sesión iniciada. No puedo iniciar sesión en prod ni crear usuarios ahí (y el pedido era no crear datos). Para cerrarlo, abrir con tu usuario: Personal → "Luis con F" → Cuenta corriente; un trabajo con sus cargos; Ventas → Conciliar; Reportes → Resultado mensual. Las cuatro deberían cargar sin el aviso de "Datos incompletos".

## 6. Pendientes

1. Borrar `G:\INMA-ERP-dumps\prod-2026-10-26-tecnicos\` cuando ya no haga falta (tiene datos sensibles).
2. Cargar el **RUT** de cada técnico en su ficha (Personal → Editar → "Agregar RUT"): sin eso no se reconocen sus facturas ni hay sugerencias.
3. Vincular las facturas de los 3 cargos de "Luis con F" cuando estén importadas.
4. De deploys anteriores, siguen abiertos: dos notas de crédito de Starlink sin corregir (`deploy-prod-2026-10-25.md`).
