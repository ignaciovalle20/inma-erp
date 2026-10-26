# QA de técnicos (respaldo, documentos y vínculo) y del reset de formularios — 2026-10-27

Rama `test/tecnicos-qa` (desde `dev` con `fix/form-reset-services-personnel` mergeado). Todo contra **inma-erp-dev** (`sczgankronafrxybpvnh`); prod no se tocó. Cambio bajo prueba: `docs/tecnicos-respaldo-documentos-2026-10-26.md`.

## Conclusión

**Listo para prod**, aplicando las **dos** migraciones en orden (`20261026010000`, `20261027010000`) con la verificación de la sección 6. Hay tres puntos para tener presentes (sección 4): el desplazamiento de "directos" a "generales" en el Resultado mensual cuando una factura cubre cargos de varios trabajos (el total no cambia), el mes en que cuenta el costo después de vincular, y que la corrección de rentabilidad por cliente/área también cambia las cifras de los repartos ya existentes. Ninguno descuadra totales; los tres están probados y documentados.

## 1. Qué se probó

Datos de prueba con prefijo `QA-`, creados y borrados por cada test; al final no queda ninguno (sección 5).

| # | Caso | Dónde | Resultado |
|---|---|---|---|
| 0 | Instantánea de dev antes y después (cargos, pagos, costos por mes y por trabajo, huellas md5) | `docs/verificacion-tecnicos-prod.sql` | Idéntica |
| 1 | Boleta, retención por año (14,5 / 15,25 / 16 / 17 %), desde líquido y desde bruto, montos 1, 999, 375.000, 1.000.001; bruto − retención = líquido | unitario + integración (base = pantalla para 1–1.500 y montos grandes, 4 años) | OK tras el fix 1 |
| 2 | Factura desde neto y desde total (total 100.000 → neto 84.034 + IVA 15.966); neto + IVA = total | unitario + integración | OK |
| 3 | Input: "375000", "375.000", con espacios/pegado; rechaza negativos, cero, texto, decimales | unitario | OK |
| 4 | Un cargo de cada respaldo; corrección sin respaldo → factura → boleta → sin respaldo: costo, a pagar, estado y costo propio en cada paso | integración | OK |
| 5 | Cargo con pago: no se corrige ni borra ("ya tiene pagos aplicados…"); vinculado: tampoco ("vinculado a un documento: desvinculalo antes…") | integración | OK |
| 6 | Un abono que cubre cargos de los tres respaldos; saldo 44.000; no se paga una boleta por encima del líquido | integración | OK |
| 7 | Factura de 3 cargos de 3 trabajos: costo y margen de cada trabajo, total del mes (antes de importar = después de vincular), Resultado mensual y rentabilidad por cliente, proyecto y área | integración | OK tras el fix 2 |
| 8 | Boleta de 2 cargos del mismo trabajo: costo directo de ese trabajo | integración | OK |
| 9 | Cargo de mayo, documento de junio: dónde cuenta el costo antes y después | integración | Documentado (4.2) |
| 10 | Documento asignado a mano o repartido → vínculo reemplaza sin duplicar; asignado a servicios (solo o mixto) → **rechazado** | integración + e2e | OK tras el fix 3 |
| 11 | Desvincular y volver a vincular a otros cargos | integración | OK |
| 12 | Borrar un documento vinculado: los cargos vuelven a su costo propio y a "pendiente" | integración | OK |
| 13 | Tolerancia: 1 CLP por cargo vincula; 2 CLP por cargo no, con la diferencia | integración | OK |
| 14 | Inválidos: otro técnico, otro respaldo, nota de crédito, cargo ya vinculado, cargo de otra empresa, sin membresía (RLS en RPCs y tablas), insertar un vínculo a mano | integración | OK |
| 15 | Nota de crédito de un proveedor técnico: no se sugiere ni vincula y sigue restando | integración | OK |
| 16 | RUT con/sin puntos y guion, "k" minúscula → el mismo proveedor; RUT de otro técnico → error; quitar un RUT con documentos vinculados | integración | OK (4.4) |
| 17 | Mismo CSV dos veces: sin documentos ni sugerencias duplicadas | integración | OK |
| 18 | Sugerencias: única → sí; dos combinaciones → no; >15 candidatos → no; descartada → no vuelve; "Confirmar todas" con una inválida → vincula las demás y avisa | integración | OK |
| 19 | Tablero: "Técnico pagado" + "Sin respaldo", "Documento pendiente"; regla de cierre | e2e + integración | OK (4.5) |
| 20 | Asistente IA y MCP (`get_technician_balances`, mismas herramientas) | integración | OK |
| 21 | Uruguay: cargo, pagos y cuenta corriente como antes; sin respaldo ni RUT | integración + e2e | OK |
| 22 | Editar asignación, Asignar a servicios y asignación de Personal: 3+ filas distintas, guardar, recargar, editar, guardar, recargar | e2e | OK |
| 23 | 390 px: formulario de cargo con desglose, pantalla de vínculo y "Vincular documento" sin scroll horizontal | e2e | OK |
| — | Specs e2e que dependían del seed (`project-checklist-notes`, `projects-list-search`) | reescritos con datos `QA-` propios | OK |
| — | Re-correr las migraciones | dev, en transacción revertida | 4.6 |

Archivos de pruebas nuevos: `web/src/lib/__tests__/integration/qaTechnicians.integration.test.ts` (19 casos), `web/e2e/qa-tecnicos.spec.ts` (6), casos nuevos en `web/src/lib/__tests__/technicians.test.ts`.

## 2. Bugs encontrados y cómo se corrigieron

1. **La vista previa del cargo podía diferir en 1 peso de lo guardado.** `backedChargeAmounts` (JS) usaba punto flotante: 100 × 0,145 = 14,4999… → retención 14, mientras la base (numeric) guarda 15. Pasaba con muchos montos de boleta desde el bruto. Ahora calcula con enteros exactos (tasas en centésimas de punto y división redondeada como `round()` de numeric). Prueba: todos los montos de 1 a 200.000 contra la fórmula exacta, y la base vs. la pantalla en los 4 años. Lo guardado siempre fue correcto (lo calcula la base); solo cambiaba lo que se veía antes de guardar.
2. **Rentabilidad por cliente y por área no sumaba los repartos a trabajos.** En `getProfitabilityBreakdown` (`web/src/lib/reporting.ts`) una asignación a un **trabajo** quedaba en el trabajo y no subía a su cliente ni a su área (los costos directos y la mano de obra sí). Con una factura de técnico vinculada a cargos de varios trabajos, los clientes y áreas perdían ese costo; ya pasaba con cualquier "Dividir" entre trabajos. Ahora sube igual que un costo directo (cada fila de reparto apunta a uno solo de trabajo/cliente/área, así que no se cuenta dos veces). El golden contable de integración sigue igual.
3. **Vincular un documento asignado a servicios recurrentes duplicaba en silencio.** El vínculo reemplazaba la asignación a servicios, y el período del servicio, al quedar sin factura, vuelve a contar su **costo estimado**: el mes sumaba el técnico y además el estimado. Ahora (`supabase/migrations/20261027010000_technician_link_refuses_service_allocations.sql`) se rechaza con `SERVICES` aunque se pida reemplazar, también si es mixto (servicios + reparto); la pantalla de vínculo lo explica con un link a "Editar la asignación", las sugerencias lo saltean y Conciliar no lo ofrece para confirmar.
4. **Dos specs e2e dependían de la empresa demo del seed**, que dev no tiene: reescritos con empresas `QA-` propias (y un segundo miembro para el autor de las notas).
5. Dos specs con textos viejos (ya corregidos el 26) y la limpieza del test de integración (no borraba los `project_quotes` que crea una venta): corregidos.

## 3. Cambios de esta rama

- Migración nueva `20261027010000_technician_link_refuses_service_allocations.sql` (solo `create or replace` de `link_technician_document`; idempotente). Aplicada en dev.
- `web/src/lib/technicians.ts` (aritmética exacta, código `SERVICES`), `technicianDal.ts` (`assignment.services`, sugerencias no válidas si hay servicios), `technicianDocumentSuggestions.ts` (saltea documentos asignados a servicios), `reporting.ts` (fix 2), pantalla de vínculo (aviso de servicios).
- `docs/verificacion-tecnicos-prod.sql` y `docs/verificacion-tecnicos-prod-precheck.sql` (sección 6).
- Tests: los mencionados en 1; `web/e2e/helpers/devSession.ts` acepta prefijo `QA-` y cuenta usuarios en minúsculas.

## 4. Comportamiento decidido donde no estaba definido

1. **Varios trabajos → "costos generales" en el Resultado mensual.** Una factura vinculada a cargos de varios trabajos queda repartida por importe (lo pedido: "asignaciones por importe"), que es como "Dividir": el Resultado mensual la muestra en **costos generales** y deja de estar en **directos**. El total de costos, el resultado operativo y la rentabilidad por trabajo, cliente y área no cambian (probado en el caso 7); sí cambia el "Margen directo" del mes. Con un solo trabajo queda como costo directo. Si se prefiere que el mes la siga contando como directa, es un cambio del Resultado mensual para los repartos entre trabajos (no del vínculo).
2. **Mes del costo.** Antes de vincular, el cargo cuenta en el mes del cargo y la factura importada (sin asignar) en el suyo. Después de vincular cuenta **solo en el mes del documento**: cargo de mayo + factura de junio → mayo 100.000 / junio 0 → (importada) mayo 100.000 / junio 100.000 → (vinculada) mayo 0 / junio 100.000. El costo acumulado del trabajo no cambia. Si un caso necesita el mes del cargo, el documento tiene "Reconocido en" (reasignar período).
3. **Tolerancia.** Con diferencia dentro de 1 CLP por cargo se vincula y manda el neto del documento: tres cargos de 100.001 con una factura de 300.000 dejan el mes en 300.000 y cada trabajo en ≈100.000; el cargo sigue mostrando su costo (100.001).
4. **Quitar un RUT** con documentos vinculados: rechazado ("desvinculalos antes de quitar el RUT"); sin documentos vinculados se quita. Una sugerencia pendiente de un documento de ese proveedor queda en Conciliar y, al confirmarla, falla con un mensaje claro (`NO_TECHNICIAN`).
5. **Regla de cierre del trabajo (F3)**: todavía no existe cierre automático. Lo que define "técnicos OK" (`summarizeByProject`) da `pagado` + `no_aplica` para un trabajo con un cargo sin respaldo pagado, o sea, no lo frena; el tablero lo muestra como "Técnico pagado · Sin respaldo".
6. **Re-correr la migración principal**: no es idempotente (crea tablas). Si se corre dos veces falla limpio en la primera sentencia que no puede repetir (`relation "boleta_withholding_rates" already exists`) y no deja nada (probado dentro de una transacción en dev). En la práctica el historial de migraciones de Supabase evita correrla dos veces. La segunda migración es idempotente.
7. **Asistente IA / MCP**: comparten la herramienta `get_technician_balances`; devuelve lo que se le debe a cada técnico (a pagar − pagado), que coincide con la cuenta corriente. No expone respaldo ni documentos (no se pidió).

## 5. Datos de dev

- Instantánea antes (paso 0) y después (paso 4) con `docs/verificacion-tecnicos-prod.sql`: **idénticas**. 10 cargos (montos, pagado, costo propio), pagos de 3 técnicos, 13 meses-empresa de 2026, 10 trabajos y las huellas md5 de `cost_documents` (1.799), `cost_lines`, `cost_allocations`, `cost_service_allocations` y aplicaciones de pagos.
- Restos de prueba: 0 empresas, clientes, proveedores, personas, trabajos y usuarios `QA-`, `zz-test-e2e-` o `TEST_`. Dos empresas `QA-` de corridas fallidas del test de integración habían quedado a mitad de limpieza y se borraron a mano (solo datos de prueba).

## 5b. Resultado de las suites

- Typecheck y lint: 0 errores (6 warnings previos, ninguno nuevo).
- Unitarios: 56 archivos, 649 tests, verdes.
- Integración (contra dev): 14 archivos, 131 tests verdes, 9 omitidos por diseño (`qaFase2b`).
- E2E (build limpio, contra dev): **64/64 verdes**, incluidos los dos specs que dependían del seed.

## 6. Cómo aplicar a prod

Prod está en 76; faltan **dos** migraciones, en este orden: `20261026010000_technician_backing_documents.sql` y `20261027010000_technician_link_refuses_service_allocations.sql`.

1. `supabase migration list --linked --project-ref jxkfpkgyvjiyufmfxsfp`: 76 aplicadas, esas dos pendientes.
2. Backup (receta de `deploy-prod-2026-10-25.md`).
3. Previa (solo lectura): `docs/verificacion-tecnicos-prod-precheck.sql` → cuántos cargos toman cada respaldo, cuántos "recibida" pasan a "pendiente", boletas con IVA que pasan a factura, proveedores que se vinculan por RUT y RUT ambiguos (no se vinculan).
4. Antes: `supabase db query --linked --project-ref jxkfpkgyvjiyufmfxsfp -f docs/verificacion-tecnicos-prod.sql --output-format json > antes.json`.
5. Aplicar las dos migraciones justo antes del merge a `main` (`db push`); leer el `NOTICE` de la primera.
6. Después: lo mismo a `despues.json` y comparar. Tienen que ser iguales `charges[*].{amount, net_amount, paid, own_net, own_total}` por id, `payments`, `months`, `projects` y las huellas de `cost_*` y pagos. Cambian a propósito `charges[*].backing` y `document_status`. Ejemplo de comparación:

   ```bash
   node -e "const r=f=>{const t=require('fs').readFileSync(f,'utf8');const v=JSON.parse(t.slice(t.indexOf('{'))).rows[0].verification;return typeof v==='string'?JSON.parse(v):v};const a=r('antes.json'),b=r('despues.json');const k=c=>c.map(x=>[x.id,x.amount,x.net_amount,x.paid,x.own_net,x.own_total].join());for(const s of ['payments','months','projects','fingerprint'])console.log(s,JSON.stringify(a[s])===JSON.stringify(b[s]));console.log('charges',JSON.stringify(k(a.charges))===JSON.stringify(k(b.charges)))"
   ```
7. Merge `dev` → `main`.
8. **Efecto visible del fix 2 en prod**: los meses con costos repartidos entre trabajos (prod tenía 2 filas de `cost_allocations`) suman ahora esos costos a la rentabilidad del cliente y del área del trabajo. Es una corrección; el resto de los reportes no cambia.
