# QA fase 2b: servicios recurrentes con datos reales

2026-10-03 (fecha de referencia del QA: 3/10/2026) · rama `dev` @ `0bc22e5` + cambios de este QA · Supabase **DEV** `sczgankronafrxybpvnh` (verificado en `web/.env.local` y en `supabase/.temp/project-ref` antes de escribir nada). Nada se ejecutó contra prod.

## Resumen

- Se cargaron los 10 servicios como copias en dos empresas nuevas, **TEST_QA CL** y **TEST_QA UY**, con un cliente `TEST_QA <nombre>` por servicio. No se tocó ninguna empresa real.
- Se crearon con la **server action real** (`createRecurringService`), con la sesión de un usuario miembro real (`test_qa_fase2b@example.test`, rol admin en las dos empresas). Así se probaron el trigger de país/moneda, la validación de moneda de UY, RLS y el generador. No se hizo ningún insert directo.
- **1 bug encontrado, causado por la mejora nueva y corregido:** el tablero de septiembre no mostraba los servicios mes vencido (Trimant y Fabian), y por eso la Deuda de UY quedaba en 2 ciclos en vez de 4.
- Con el fix aplicado en dev, **las 9 verificaciones pasan** en una corrida desde cero.

## Datos cargados

Inicio del contrato `2025-01-01` en todos (son servicios que ya están corriendo). Todos los anuales se cargaron como anticipados, porque no se indicó la modalidad.

| # | Empresa | Servicio | Tipo | Periodicidad / vence | Modalidad | Monto | Moneda guardada | Req. factura | Notas |
|---|---|---|---|---|---|---|---|---|---|
| 1 | CL | Terror aventura – Plan Medio | Hosting | anual · 31/05 | anticipado | 59.900 | CLP (auto) | sí | "Plan Medio - 59.900 + iva + dominio 1 año" |
| 2 | CL | Colegio Numancia – Plan Grande | Hosting | anual · 30/09 | anticipado | 50.000 | CLP (auto) | sí | |
| 3 | CL | IVCB – Plan Básico | Hosting | anual · 26/04 | anticipado | 50.000 | CLP (auto) | sí | "Facturar por plan basico. VCB INVERSIONES S.A. 77.108.223-8" |
| 4 | CL | Microsoft 365 – Razo – mes adelantado | Licencias MS | mensual · día 10 | anticipado | 50.000 | CLP (auto) | sí | "23 STD / 3 XCH 2 / 10 XCH 1 / 2 PowerBI" |
| 5 | UY | zerboinvest.com – plan grande | Hosting | anual · 31/12 | anticipado | 100 | USD | no | "Contacto: Tomas Zerbini" ¹ |
| 6 | UY | preservativoshappyyou.com.ar – plan medio – argentino | Hosting | anual · 28/02 | anticipado | 100 | USD | no | "cliente de chess" |
| 7 | UY | omega21.com.uy – plan básico | Hosting | anual · 30/11 | anticipado | 2.000 | UYU | sí | |
| 8 | UY | leonestufas.uy – plan básico | Hosting | anual · 30/06 | anticipado | 2.000 | UYU | no | "+598 94 239 567" |
| 9 | UY | Microsoft 365 – Trimant – mes vencido | Licencias MS | mensual · día 5 | vencido | 100 | USD | sí | |
| 10 | UY | Microsoft 365 – Fabian – mes vencido | Licencias MS | mensual · día 10 | vencido | 100 | USD | sí | "2 licencias STD" |

¹ El servicio no tiene campo "contacto", así que el contacto quedó en las notas.

**País/moneda:** en CL los servicios se enviaron sin moneda, como lo hace el formulario ("Chile · CLP", sin selector), y todos quedaron `country = CL`, `currency = CLP`. En UY, cada servicio se intentó guardar primero **sin moneda** (el placeholder vacío del selector): la acción lo rechazó con "Elegí la moneda: USD o UYU." y no guardó nada. Después se guardó con la moneda indicada y quedó `country = UY`.

## Resultado de cada verificación

| Verificación esperada | Resultado | Detalle |
|---|---|---|
| Sept 2026 CL: Colegio Numancia (pendiente de facturar, vencido) y Razo (vence 10/09, vencido) | ✅ | Numancia: período 2026, vence 30/09, `pending_invoice`, vencido. Razo: período sep, vence 10/09, vencido. Nada más. |
| Sept 2026 UY: Trimant (vence 05/09) y Fabian (vence 10/09), vencidos, sin hosting | ❌ → **bug** → ✅ con el fix | Antes del fix el tablero de sept de UY estaba **vacío**. Con el fix: Trimant período ago, vence 05/09; Fabian período ago, vence 10/09; los dos vencidos. |
| Oct 2026: CL solo Razo (10/10); UY Trimant y Fabian | ✅ | Razo período oct, vence 10/10. Trimant y Fabian período sep, vencen 05/10 y 10/10. |
| Nov 2026: aparece omega21 (pendiente de facturar) | ✅ | omega21: período 2026, vence 30/11, `pending_invoice`, UYU. Además Trimant y Fabian (período oct) y Razo en CL. |
| Dic 2026: zerboinvest nace en pendiente de cobro | ✅ | zerboinvest: vence 31/12, `pending_collection` (requiere_factura = false). Además Trimant y Fabian (período nov) y Razo en CL. |
| preservativoshappyyou no genera nada en 2026, su primer ciclo es feb 2027; leonestufas → jun 2027, IVCB → abr 2027, Terror aventura → may 2027 | ✅ | Ningún ciclo de esos 4 en 2026. Generando ene–dic 2027 en una transacción revertida: 28/02/2027, 30/06/2027, 26/04/2027 y 31/05/2027. Los de preservativos y leonestufas nacen en `pending_collection`. |
| Los ciclos con requiere_factura = false nunca muestran "Facturado", solo "Cobrado" | ✅ | Se renderizó la tarjeta real (`OccurrenceCard`) de cada ciclo abierto sin factura: no aparece "Facturado" y sí "Cobrado". Además, el servidor rechaza `markOccurrenceInvoiced` sobre esos ciclos. Control: un ciclo con factura sí muestra "Facturado". |
| Totales de UY separados en USD y UYU | ✅ | Nov UY: `USD por facturar 200` y `UYU por facturar 2.000`, en filas separadas. Nunca se suman. |
| Deuda de UY al 3/10 = Trimant y Fabian (sept + oct), en USD | ❌ → **mismo bug** → ✅ con el fix | Antes del fix: solo los 2 ciclos de oct. Con el fix: Trimant 05/09 y Fabian 10/09 (vencidos) + Trimant 05/10 y Fabian 10/10. Los 4 en USD. Ver la observación 2 sobre qué pasa después de abrir nov/dic. |
| Razo sept facturado → cobrado: sale de Deuda; Razo oct sigue pendiente | ✅ | Después de Facturado y Cobrado, Razo sep ya no está en Deuda. Razo oct sigue en Deuda como `pending_invoice`. |
| Volver a correr la generación no crea nada | ✅ | Primera pasada: sep CL 2 / UY 2, oct 1 / 2, nov 1 / 3, dic 1 / 3 (15 ciclos). Segunda pasada sobre sep–dic: 0 en todos. |

## Bug encontrado y corregido

**Síntoma.** Los servicios mensuales **mes vencido** no generaban ciclo en el tablero de septiembre 2026. Trimant (vence 05/09) y Fabian (vence 10/09) no aparecían, y en la Deuda de UY faltaban esos 2 ciclos.

**Causa.** Lo introdujo la mejora nueva (`20261002010000`, decisión 6 de `docs/servicios-recurrentes-cambios.md`). `generate_recurring_service_occurrences_for_month` aplicaba el piso de sept-2026 dos veces:
- al mes del tablero, que es lo correcto;
- **al período facturado** de los mensuales.

El ciclo de septiembre de un servicio vencido factura agosto, así que se descartaba.

**Por qué es un bug y no un error de la expectativa:**
- `docs/plan-servicios-recurrentes.md` dice textualmente "vencido: la de septiembre factura agosto".
- La misma función ya aplicaba el piso al **mes de vencimiento** para los anuales (un anual vencido que vence en dic-2026 factura 2025 y sí se genera). Los mensuales quedaban con una regla distinta.
- Las fechas de Planner de esta prueba (Trimant 05/09, Fabian 10/09) son ciclos que vencen en septiembre, que es el primer mes gestionado en el ERP.

**Fix.**
- `supabase/migrations/20261003010000_recurring_service_occurrences_floor_on_due_month.sql`: reemplaza la función con la misma firma y los mismos permisos, y solo saca el piso por período. Ahora el piso es "ningún mes anterior a septiembre 2026", igual para mensuales y anuales. También vuelve a correr la generación de septiembre 2026 (`ON CONFLICT DO NOTHING`, no pisa ningún ciclo existente).
- `web/src/lib/__tests__/integration/recurringServiceOccurrences.integration.test.ts`: el caso de borde que fijaba la regla vieja ahora espera, para la corrida de sept de un vencido, período `2026-08-01` y vencimiento `2026-09-10`.
- Se actualizaron las decisiones 6 y 7 de `docs/servicios-recurrentes-cambios.md` y el comentario de `FIRST_BOARD_MONTH` (`web/src/lib/recurringServiceTypes.ts`).
- Aplicado en dev con `supabase db push --linked`. **Todavía no está en prod.**

**Efecto del backfill en dev:** además de los 2 ciclos de TEST_QA, creó 1 ciclo en "Demo Uruguay SRL" ("MS Trimant", período ago, vence 05/09, pendiente de facturar).

**Efecto en prod cuando se aplique:** cada servicio mensual vencido activo va a ganar su ciclo de agosto 2026 (vence en septiembre) en "pendiente de facturar". Si esos ya se facturaron o cobraron por Planner, hay que marcarlos (o anularlos) en el tablero de septiembre. Pasa lo mismo si no se aplica el backfill, porque abrir el tablero de septiembre los genera igual.

## Observaciones (no son bugs, quedan a decisión)

1. **Diciembre no se puede abrir desde la UI el 3/10.** El tablero permite navegar como máximo hasta el mes siguiente (noviembre), por diseño (decisión 9). El ciclo de dic de zerboinvest se generó llamando la misma función del DAL que usa el tablero, que es la que corre el cron el 1/12.
2. **La Deuda incluye ciclos que todavía no vencen.** Muestra todos los ciclos abiertos de cualquier mes (decisión documentada). Después de abrir nov y dic, la Deuda de UY pasa de 4 a 10 ciclos: se suman Trimant/Fabian de nov y dic, omega21 y zerboinvest, con la etiqueta "vence en N días". Tomando "Deuda al 3/10" como lo vencido o con vencimiento hasta octubre, la expectativa se cumple. Si querés que Deuda muestre solo lo vencido, o que separe "vencido" de "por vencer", es un cambio chico en `getPendingRecurringServiceOccurrences` / `debtByClient`. No lo cambié porque contradice una decisión ya tomada.
3. **No hay campo de contacto en el servicio.** "Tomas Zerbini" quedó en las notas.
4. **Interfaz en el navegador:** la tarjeta se verificó renderizando el componente real. No se probó con login en el navegador, porque el login va contra Supabase con credenciales de usuario reales.

## Cómo reproducir

`web/src/lib/__tests__/integration/qaFase2b.integration.test.ts` (sin commitear) carga los datos y corre todas las verificaciones. **No borra los datos al final** y solo corre si se lo pide explícitamente:

```bash
QA_FASE2B=1 npx vitest run -c vitest.integration.config.ts qaFase2b
```

Es idempotente: reutiliza las empresas, los clientes, el usuario y los servicios que ya existen. Para repetir el chequeo de Deuda "al 3/10" desde cero, antes hay que borrar los ciclos de TEST_QA (si no, ya estarán los de nov/dic y Razo sep cobrado). Así se obtuvo la corrida final:

```sql
delete from recurring_service_occurrences o using recurring_services rs, companies c
where rs.id = o.recurring_service_id and c.id = rs.company_id and c.name in ('TEST_QA CL', 'TEST_QA UY');
```

Corridas: (1) antes del fix: 7/9 (fallan sept UY y Deuda UY); (2) con el fix, re-ejecutando sobre el estado anterior: fallas esperadas por estado previo; (3) con el fix, desde cero: **9/9**. También en verde con el fix: integración `recurringServiceOccurrences` + `recurringServicesMonthly` + `reportingRecurringServices` (29/29), unitarios (407/407) y `tsc` (sin errores nuevos; los únicos errores son los preexistentes de `zzAuditoria.integration.test.ts`, sin trackear).

## Estado que queda en dev

- `TEST_QA CL` (`03572306-675b-41c8-9801-e8dcc5db8c71`): 4 clientes, 4 servicios y 5 ciclos (Numancia 2026; Razo sep **cobrado**, oct, nov y dic pendientes).
- `TEST_QA UY` (`158ec454-306e-4a7f-bb74-90b6e8e44798`): 6 clientes, 6 servicios y 10 ciclos (Trimant/Fabian ago–nov, omega21 2026, zerboinvest 2026).
- Usuario `test_qa_fase2b@example.test`, miembro admin de las dos. Su contraseña es aleatoria, se regenera en cada corrida y no se guarda en ningún lado.
- Para ver las empresas en la interfaz con tu usuario hay que agregarte como miembro de las dos.
