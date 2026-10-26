# Técnicos: respaldo de cada cargo y vínculo con facturas y boletas (Chile) — 2026-10-26

Rama `feature/tecnicos-respaldo-documentos` (desde `dev`). Migración aplicada **solo en dev** (`inma-erp-dev`, `sczgankronafrxybpvnh`). Prod no se tocó.

## 1. Qué problema resuelve

Un cargo de técnico creaba su propio costo directo (`create_technician_charge`). Al importar después la factura o boleta del técnico desde Nubox entraba como otro costo general y, al asignarla al trabajo, el costo quedaba **duplicado**. Ahora, en empresas de Chile, cargo y documento son una sola cosa contable: el cargo sigue en la cuenta corriente (lo que se le debe y los pagos), y cuando llega el documento, **el documento pasa a ser el costo** de los trabajos de esos cargos. Uruguay sigue exactamente como antes.

## 2. Cambios de esquema (`supabase/migrations/20261026010000_technician_backing_documents.sql`)

| Objeto | Cambio |
|---|---|
| `normalize_tax_id(text)` | RUT sin puntos, guion ni espacios, DV en mayúscula. |
| `company_is_chile(uuid)` | `companies.country` CL / Chile. |
| `boleta_withholding_rates` (nueva) | Retención de boleta por año: 2025 14,5 %, 2026 15,25 %, 2027 16 %, 2028 17 % (un año sin fila usa el último anterior; antes de 2025 da error). RLS: lectura para autenticados. |
| `boleta_withholding_rate(date)`, `technician_backing_amounts(...)` | Fórmulas de costo / a pagar (las mismas que `web/src/lib/technicians.ts`: `backedChargeAmounts`). |
| `personnel.default_backing` (nueva) | "Respaldo habitual": `factura` / `boleta` / `none`. Migrada desde `payment_document` (`factura`→factura, `boleta_honorarios`→boleta, null→none). `payment_document` **se mantiene** (la ficha de Uruguay la sigue usando; en Chile la app la mantiene igual a `default_backing`). |
| `technician_suppliers` (nueva) | Técnico ↔ proveedor (RUT). Varios por técnico; `supplier_id` único. RLS select/insert/delete por membresía; guard: misma empresa, técnico `contractor`, empresa de Chile; no se quita un RUT con documentos vinculados. **Backfill**: proveedores cuyo RUT normalizado coincide con `personnel.tax_id` de un único técnico. |
| Trigger `suppliers_link_technician` | Un proveedor nuevo (importación, alta manual) con el RUT de un técnico (el de su ficha o el de otro proveedor ya vinculado) queda vinculado solo. |
| `technician_charges` | `cost_document_id` **nullable** (null mientras hay documento vinculado). Nuevas: `backing` (`factura`/`boleta`/`none`, null en Uruguay), `entered_as` (`amount`/`net`/`total`/`liquid`/`gross`), `withholding_rate`. `document_status` suma `no_aplica`. Se reemplaza `net_amount <= amount` por: boleta ⇒ `net_amount >= amount`; resto ⇒ `net_amount <= amount`. `amount` = a pagar, `net_amount` = costo del trabajo. |
| `technician_charges_guard` (reemplazada) | Además de lo anterior: respaldo solo en Chile; `no_aplica` ⇔ sin respaldo; con factura/boleta, `recibida` ⇔ documento vinculado; el costo propio debe cuadrar (total = a pagar, salvo boleta: total = bruto). Excepción acotada por flags transaccionales (`inma.technician_document_link`, `inma.technician_charge_edit`). |
| Constraint trigger diferido `technician_charges_cost_source` | Al commit, cada cargo tiene **exactamente un** costo: el propio o un documento vinculado. |
| `technician_charge_documents` (nueva) | Cargo ↔ documento (`charge_id` único; un documento cubre varios cargos). Solo se escribe desde `link_/unlink_technician_document` (guard: sin el flag, ni el service role puede insertar/borrar). |
| `technician_document_suggestions` (nueva) | Sugerencias de Conciliar (`pending` / `dismissed`), una por documento. |
| Guards nuevos | `cost_documents_guard_technician_link` (no cambia trabajo/clasificación), `cost_allocations_guard_technician_link` (ni alta, ni cambio, ni baja de reparto) y `cost_service_allocations_guard_technician_link` mientras el documento está vinculado. |
| RPCs nuevas (invoker) | `create_backed_technician_charge`, `link_technician_document(doc, cargos[], reemplazar)`, `unlink_technician_document(doc)`, `link_technician_tax_id(técnico, rut, nombre)`. |
| RPCs nuevas (definer, como las existentes de corrección) | `update_backed_technician_charge` (reescribe el costo propio y su línea; mismo motivo que `update_technician_charge`). |
| RPCs modificadas | `update_technician_charge` y `set_technician_charge_document`: solo cargos sin respaldo (Uruguay / previos); `delete_technician_charge`: rechaza un cargo vinculado; `delete_cost_document`: si el documento está vinculado, primero desvincula (devuelve `unlinked_charges`). |

**Backfill de cargos (Chile)**: toman el respaldo habitual de su técnico, **sin cambiar ningún monto**; los de sin respaldo quedan `no_aplica`, los de factura/boleta `pendiente`. En dev: 7 sin respaldo, 3 factura (de esos, 2 estaban "recibida" a mano). Verificado antes/después: los 10 cargos de dev tienen exactamente el mismo `amount`, `net_amount`, costo propio y pagos (snapshot comparado).

## 3. Código

- `web/src/lib/technicians.ts`: respaldo, modos de ingreso, retención, `backedChargeAmounts`, `linkAmountCheck`, `uniqueChargeCombination` / `proposeTechnicianSuggestions` (sugerencias), `no_aplica` en los resúmenes.
- `web/src/lib/technicianDal.ts`: cargos con respaldo y documento vinculado; RUT del técnico; documentos del técnico; contexto de vínculo; sugerencias pendientes.
- `web/src/lib/technicianDocumentSuggestions.ts`: búsqueda de sugerencias (importación, Conciliar, RUT nuevo).
- Pantallas: ficha (Respaldo habitual + RUT vinculados), cargo (respaldo, modo de ingreso, desglose en vivo), sección Técnicos del trabajo, cuenta corriente (KPI, desglose, "Documentos recibidos"), `costs/[id]/technician` (vínculo desde el documento), `technician-charges/[id]/document` (desde el cargo), Conciliar ("Documentos de técnicos sugeridos"), resumen de importación, bloqueo de Asignar / Dividir / Editar asignación / Asignar a servicios, tablero.
- Asistente IA: `get_technician_balances` usa el saldo (a pagar − pagos): sin cambios de significado. El MCP no lee técnicos.

## 4. Bug "Editar asignación" (todas las filas con el mismo destino)

**Causa**: React 19 resetea un `<form action={...}>` cuando termina la acción. Los `<select>` de destino son controlados, pero el reset del DOM los vuelve a su opción por defecto — la primera no deshabilitada, es decir **el primer destino de la lista** — y como el estado de React no cambió, no se re-sincronizan. En la base estaba todo bien; al recargar se veía bien.

**Fix**: `costs/[costDocumentId]/allocate/form.tsx` despacha la acción desde `onSubmit` dentro de `startTransition` (sin reset del form). Test: `web/e2e/cost-allocation-save-keeps-rows.spec.ts` (4 filas, 4 trabajos distintos, se verifican tras guardar, tras guardar de nuevo y tras recargar).

**Mismo riesgo, no tocado** (fuera de alcance): `costs/[id]/services/form.tsx` ("Asignar a servicios") y `personnel/[id]/costs/[costId]/allocate/form.tsx` usan el mismo patrón (`<form action>` + `<select>` controlado + se quedan en la página).

## 5. Decisiones tomadas por mi cuenta (lo más conservador)

1. **`payment_document` no se borra**: Uruguay lo sigue usando y borrarlo rompería el código en producción entre la migración y el deploy. En Chile la ficha escribe `default_backing` y deja `payment_document` igual.
2. **`backing` null** = Uruguay y cargos creados por el formulario anterior (p. ej. durante la ventana entre migración y deploy). Esos cargos siguen con el formulario y el botón "recibida" de antes.
3. **Cargos de factura/boleta marcados "recibida" a mano** pasan a "pendiente" en la migración: nunca tuvieron un documento vinculado y vincularlo es justamente lo que evita el duplicado. Desde ahora, con respaldo, "recibida" ⇔ documento vinculado (ya no se marca a mano). En dev afectó a 2 cargos.
4. Un cargo de un técnico con respaldo habitual **boleta** pero cargado "con IVA incluido" (costo < a pagar) se migra como **factura** (una boleta no tiene IVA y su costo nunca es menor que lo pagado). En dev: 0 casos. El aviso de la migración (`raise notice`) dice cuántos.
5. Solo se vinculan documentos **importados** FAC-EL / FAC-EE (factura) y BOL-HE / BOL-TE (boleta); no notas de crédito ni gastos cargados a mano.
6. Tolerancia: 1 CLP por cargo, en el vínculo y en las sugerencias.
7. Reparto entre varios trabajos: importes fijos sobre el **total** del documento (como guarda "Editar asignación"), proporcionales al costo de cada cargo; el último trabajo absorbe el redondeo. Los reportes los leen como neto (net/total), así cada trabajo queda con el costo de su cargo.
8. Un documento vinculado a cargos de **varios** trabajos queda como costo **general repartido** (mecanismo de "Dividir"); en el Resultado mensual aparece en la línea de costos generales, no en directos. El total del mes es el mismo. Con un solo trabajo queda como costo directo.
9. **Mes del costo**: después del vínculo manda la fecha del documento (los costos propios, fechados en el cargo, se borran). Si la factura es de un mes posterior a los cargos, el costo se mueve a ese mes. Sin cambio cuando son del mismo mes (caso de la prueba 4).
10. Sugerencias: si hay **más de 15 cargos candidatos** no se sugiere nada (no se puede garantizar que la combinación sea única). Una sugerencia **descartada** no se vuelve a proponer. Un cargo ya incluido en una sugerencia pendiente no se ofrece a otro documento. Los documentos ya asignados a mano **sí** se sugieren (Confirmar pide confirmación porque reemplaza la asignación).
11. "Corregir el cargo ahí mismo" cuando no cuadra: el link **Corregir** de cada cargo abre su formulario y al guardar vuelve a la pantalla del vínculo (no es edición en línea).
12. Un cargo vinculado no muestra formulario de corrección (solo el aviso y el link al vínculo). La RPC admite corregir descripción y fecha de un cargo vinculado si no cambian los montos.
13. No se vincula un cargo cuyo costo propio tenga comprobantes adjuntos (la app no los crea para cargos; se informa el error).
14. La regla de cierre automático del trabajo (F3) todavía no existe; `summarizeByProject` ya trata "no aplica" como OK para cuando se implemente.
15. CLI de Supabase: su divisor de sentencias cortó una función con `... case ... end` seguido de salto de línea y `then`; se reescribió con una variable. Vale para prod también (mismo archivo).

## 6. Pruebas

- **Unitarias** (`npm test`): 56 archivos, 645 tests, verdes. Nuevas en `technicians.test.ts`: boleta 375.000 líquido ⇄ 442.478 bruto (retención 67.478), factura 100.000 ⇄ 119.000, sin respaldo, retención por año, RUT, tolerancia, sugerencias (única / dos combinaciones / fecha / respaldo / >15), resúmenes con "no aplica".
- **Integración** (`npm run test:integration`, contra dev): 13 archivos, 112 tests verdes (9 omitidos por diseño, `qaFase2b`). Nuevo `technicianDocuments.integration.test.ts` con los 11 casos pedidos (boleta, factura, sin respaldo, factura de 300.000 a 3 trabajos con total del mes igual al de antes de importarla, reemplazo de asignación manual, montos que no cuadran, desvincular, sugerencias con 1 y 2 combinaciones, técnico con 2 RUT, Uruguay, consistencia de todos los cargos de la base) más el borrado de un documento vinculado.
- **E2E** (`npm run build` + `npx playwright test`, contra dev): nuevos `cost-allocation-save-keeps-rows.spec.ts` (bug de "Editar asignación") y `technician-backing-documents.spec.ts` (desglose en vivo, vínculo desde el trabajo, pantallas bloqueadas, cuenta corriente, Uruguay), verdes. Suite completa: 45 + los 8 de los dos specs corregidos verdes. Dos specs viejos ya fallaban en `dev` por textos que cambiaron y se actualizaron acá: `recurring-service-costs` (la columna "Importe neto" ahora es "Neto") y `recurring-services-location` (la pestaña "Períodos"). **Siguen fallando, sin relación con esta rama**: `project-checklist-notes.spec.ts` y `projects-list-search.spec.ts`, porque usan la empresa demo de `supabase/seed.sql` (`a0000000-…-0001`), que dev ya no tiene desde que es copia de prod (2026-10-17); fallan en el `beforeAll` (FK de `company_memberships`). Hay que reescribirlos con empresas descartables como los demás specs.
- Lint y typecheck sin errores.

## 7. Cómo aplicar a prod

Prod está en 76 migraciones (= dev antes de esta rama). Esta rama agrega **una**: `20261026010000_technician_backing_documents.sql`.

1. `supabase migration list --linked --project-ref jxkfpkgyvjiyufmfxsfp`: confirmar 76/76 y solo esta pendiente.
2. Backup + fingerprint (receta de `deploy-prod-2026-10-25.md`): como mínimo `personnel`, `technician_charges`, `technician_payments`, `technician_payment_applications`, `cost_documents`, `cost_lines`, `suppliers`. Guardar un snapshot por cargo: `id, amount, net_amount, cost_document_id, net/total del costo propio, suma pagada`.
3. Revisar antes qué va a pasar (solo lectura):
   - cargos de Chile por respaldo habitual de su técnico y `document_status` (cuántos "recibida" pasan a "pendiente");
   - cargos de técnicos con boleta y `net_amount < amount` (pasarán a factura);
   - proveedores cuyo RUT normalizado coincide con el de un técnico (vínculos automáticos) y si alguno coincide con dos técnicos (no se vincula).
4. Aplicar la migración **justo antes de mergear** a `main` (regla del plan): `db push` vinculado a prod. Leer el `NOTICE` (conteos).
5. Verificar después:
   - mismo snapshot por cargo (montos y pagos idénticos);
   - toda fila con `cost_document_id` tiene costo propio con `net_amount = charge.net_amount` y `total = amount` (o `= net_amount` si es boleta); ninguna sin costo ni vínculo (consulta del caso 11 del test de integración);
   - `technician_suppliers` con los vínculos esperados;
   - Resultado mensual de octubre igual antes y después.
6. Merge `dev` → `main` y seguir el deploy de Vercel.

Rollback: la migración es aditiva salvo el backfill de `backing`/`document_status` y los vínculos de proveedores; con el backup se pueden restaurar `document_status` de los cargos. No hay montos que restaurar.

## 8. Cómo resolver un duplicado ya cargado (desde la UI)

Caso: el cargo del técnico existe en el trabajo y además la factura/boleta importada se asignó a mano al mismo trabajo.

1. **Personal → técnico → Editar**: en "RUT / proveedores vinculados", **Agregar RUT** con el RUT que emitió el documento (o elegir el proveedor existente). Revisar arriba que el **Respaldo habitual** sea el correcto.
2. **El cargo**: en el trabajo, sección **Técnicos**, la columna Respaldo dice factura o boleta. Si dice otra cosa (p. ej. "Sin respaldo", porque el técnico no tenía documento definido), **Corregir** y elegir el respaldo y el monto como figura en el documento (factura: neto o total con IVA; boleta: líquido o bruto). El costo del cargo tiene que ser el neto (factura) o el bruto (boleta) del documento. Un cargo con pagos aplicados no se corrige: si hace falta, borrar el pago en la cuenta corriente, corregir y volver a registrarlo (vincular, en cambio, sí se puede con pagos).
3. En la misma fila, **Vincular documento** → **Elegir** la factura/boleta (muestra su asignación actual).
4. En la pantalla del vínculo: marcar el/los cargos que cubre (debe decir **Cuadra**), tildar **Reemplazar la asignación actual** y **Vincular**.
5. Listo: el trabajo queda con un solo costo (el documento), el cargo "Recibida" y el documento listado en **Documentos recibidos** de la cuenta corriente.
