# Auditoría técnica — INMA ERP (20/09/2026)

Continúa el relevamiento del 15/09 (`relevamiento-tecnico-funcional-2026-09-15-e28a503.md`, no versionado) (commit `e28a503`). Revisa el estado actual de la rama `feature/ventas-nubox-cobro` (incluye `main` con 4.1 y todo 4.2) y suma lo que apareció desde entonces: importador de Nubox, MCP, tablero de trabajos y la carga del histórico real (1.735 documentos, sep 2022 – sep 2026).

## Alcance y método

**Hecho en esta auditoría**
- `tsc --noEmit`, `eslint`, `vitest` (136 tests), `npm audit --omit=dev` y `npm outdated`.
- Búsquedas estáticas sobre `web/src` y `supabase/migrations`: manejo de errores, consultas sin paginar, verificación de sesión en Server Actions y rutas, uso de `service_role`, índices, secretos y datos reales en lo versionado (incluido todo el historial de git).
- Pruebas contra la app corriendo con el histórico real: coherencia entre Ventas y Resumen, entradas malformadas en 9 rutas y tiempos de respuesta.
- Revisión manual del MCP (`lib/mcp/*`, `api/mcp/route.ts`) y de las RPC que usa.

**No hecho**
- No se ejecutó `next build` (el servidor de desarrollo usa `.next`), ni EXPLAIN, ni pruebas de carga.
- Los tiempos son del servidor de **desarrollo**: sirven para comparar pantallas entre sí, no como valor de producción.
- No se re-verificaron a fondo los hallazgos del relevamiento anterior sobre motor financiero multimoneda (H01, H02, H04–H09, H11), integridad SQL/concurrencia (H14–H22) ni IA (H23–H28). Figuran como "no re-verificado".

Marcas: **Verificado** = reproducido o medido aquí. **Deducido** = sale del código/SQL, no se ejecutó. Prioridad: P1 alto, P2 medio, P3 bajo.

## Resumen ejecutivo

1. **La base y el código se desincronizan y nada lo detecta (P1).** Las migraciones se pegan a mano en el SQL Editor y no hay CI. Hoy pasó: la base tenía el esquema de 4.1 y `main` aún no lo tenía, así que los proyectos nuevos se guardaban pero no se veían, sin ningún error.
2. **El MCP no puede confirmar gastos ni ventas (P1, deducido).** Usa `service_role`, donde `auth.uid()` es nulo, y las RPC que llama exigen usuario autenticado.
3. **El tope de 1.000 filas de la API sigue cortando datos en varias pantallas (P1).** En 4.2 se corrigió en Ventas, el detalle del lote y el resultado de la importación; quedan Costos y otros lugares.
4. **La importación de Nubox se rompe a ~2.700 filas (P2, verificado, corregido):** el límite de 1 MB de las Server Actions es menor que lo que declara el propio importador (5.000).
5. **Un mes mal formado (`period=2026-13`) rompe 5 pantallas (P2, verificado, corregido).**
6. **El repo es público (P2).** Contiene documentación interna y migraciones. Además, un comentario mío nombraba a un cliente real (corregido en `4abfc71`, sin subir).
7. **Buenas noticias:** 0 vulnerabilidades en dependencias de producción, `tsc` limpio, las cifras de Ventas y Resumen coinciden al peso con el CSV, y el aislamiento del MCP tiene un único punto de control claro.

## Estado de los hallazgos del relevamiento anterior

| ID | Tema | Estado | Evidencia |
|---|---|---|---|
| H03 | Notas de crédito sumaban como venta | **Corregido** | Mayo 2026: Ventas = Resumen = $7.482.788, con una N/C sin emparejar ($6.579.278) restada en ambos |
| H12 | `exchange_rate_snapshots` sin política de UPDATE | **Corregido** | Migración `20260919010000` (ya en `main`) |
| H30 | Dependencias desactualizadas, `tsc` fallaba | **Corregido** | `tsc` sin errores |
| H31 | Sin tests / lint falla | **Parcial** | 136 tests (Nubox, ventas, pendientes, cobertura financiera), pero sin CI y lint con 2 errores |
| H06 | Errores de consulta → vacío/cero | **Parcial** | Ventas, Pendientes, historial y resultado de importación ahora muestran el error. `console.error` sin propagar: `dal.ts` 45, `reporting.ts` 23, `mcp/tools.ts` 14 |
| H29 | Tope de 1.000 filas | **Parcial** | Ver A02 |
| H10 | "Total del mes" de Costos suma todo | **Abierto** | `costs/page.tsx:78-150` sigue usando `getCostDocuments(id, {})` sin filtro de mes |
| H13 | Parser de importes elimina comas | **Abierto** | `sales/import/actions.ts:96` (importador genérico, relevante para Uruguay): `"1234,5"` → 12345 |
| H34 | Mes sin validar | **Abierto, verificado** | Ver A06 |
| H33 | CSV en memoria / límite de Server Actions | **Abierto, verificado** | Ver A05 |
| H01, H02, H04–H09, H11, H14–H28, H32 | Motor financiero, integridad, IA, roles | **No re-verificado** | Sin cambios conocidos |

## Hallazgos nuevos

### A01 — Migraciones manuales, sin CI ni orden de despliegue · P1 · Verificado · **CI agregado (PR #122); el orden de migraciones sigue pendiente**
- No existe `.github/workflows`. Vercel solo compila y despliega; las migraciones se aplican a mano y sin registro de cuáles están aplicadas.
- Consecuencia real de hoy: la migración de 4.1 cambió los estados de proyecto (`active` → `en_ejecucion`) y el código de `main`, que filtraba por `active`, dejó de mostrar proyectos nuevos. Los previews de Vercel usan la misma base, así que también los afectaba.
- **Recomendación:** (1) workflow de GitHub con `tsc`, `eslint` y `vitest` en cada PR; (2) usar la CLI de Supabase (`supabase db push`) o, como mínimo, un registro de migraciones aplicadas; (3) regla de orden: código compatible con ambos esquemas antes de migrar, o migrar recién cuando el PR se mergea; (4) proyecto de pruebas separado del de producción.

### A02 — Tope de 1.000 filas que sigue cortando datos · P1 · Verificado (config) / Deducido (efecto)
- `supabase/config.toml` declara `max_rows = 1000`; la API devuelve 1.000 filas como máximo sin avisar.
- Ya cubierto con lectura por páginas: listado de Ventas, detalle del lote, resultado de importación, facturas a emparejar y facturas por trabajo.
- Sin cubrir (consultas sobre `sales_documents`, `cost_documents`, `cost_allocations`, etc. en `dal.ts`, `reporting.ts` y `mcp/tools.ts`): las de rangos de varios meses y los acumulados por trabajo. Con ~400 documentos de venta por año hoy no se nota; la carga del histórico de costos o dos años más de ventas lo va a hacer visible como cifras bajas sin error.
- **Recomendación:** llevar el helper de paginación (`fetchAllPages`, hoy en `dal.ts`) a las consultas que suman, o mover las sumas a SQL (`sum` agrupado), que además es más rápido.

### A03 — El MCP no puede crear gastos ni ventas · P1 · Deducido
- `confirmMcpDraft` llama `create_cost_document` y `create_sales_document` con el cliente `service_role`. Ambas RPC hacen `v_user_id := auth.uid()` y `raise exception 'Authentication required ...'` si es nulo (`20260913020000:211-220`, `20260913100000:93-102`), y con `service_role` es nulo.
- Efecto esperado: "No se pudo crear el gasto/la venta" al confirmar, siempre. Los borradores de proyecto sí funcionan (insert directo).
- No se pudo comprobar contra la base (no hay token MCP ni la clave de servicio en este entorno).
- **Recomendación:** probarlo con un token real; si falla, pasar el usuario a la RPC (parámetro explícito validado con la membresía) o firmar un JWT del usuario para el cliente. Agregar un test de integración.

### A04 — Confirmación de borradores MCP no atómica · P2 · Deducido · **Corregido**
- Se lee `consumed_at`, se ejecuta la RPC y recién después se marca el borrador (`mcp/tools.ts:793-837`), sin mirar el resultado del `update`. Dos confirmaciones simultáneas o un reintento tras respuesta perdida pueden crear el documento dos veces.
- **Recomendación:** `update ... set consumed_at = now() where id = ... and consumed_at is null returning id` antes de crear, y abortar si no devuelve fila.

### A05 — Límite de 1 MB de Server Actions vs. el tope de 5.000 filas · P2 · Verificado · **Corregido**
- `next.config.ts` no configura `serverActions.bodySizeLimit` (default 1 MB). El paso de confirmar reenvía todas las filas del archivo: 1.786 filas = 674 KB, unas 386 bytes por fila, así que el límite se alcanza a ~2.700 filas. El importador acepta hasta 5.000.
- Hoy funciona (1.786), pero una reimportación completa dentro de unos años, o un archivo con más filas, falla con un error opaco de tamaño.
- **Recomendación:** subir el límite (documentado en `node_modules/next/dist/docs/`) o, mejor, no reenviar las filas: guardar el archivo analizado en el servidor y confirmar por identificador. Ajustar el tope declarado.

### A06 — `period=2026-13` rompe pantallas · P2 · Verificado · **Corregido**
- La validación es solo por forma (`YYYY-MM`). Con mes 13 fallan: Ventas, Resumen, Proyectos, Costos y Resultado mensual (aparece la pantalla de error de la aplicación), y la exportación responde 500.
- **Recomendación:** un único helper que valide el mes (01–12) y caiga al mes actual; usarlo en todas las pantallas y en `monthRange`.

### A07 — Repositorio público y datos reales · P2 · Verificado
- El repo `ignaciovalle20/inma-erp` figura como **Público**. Contiene documentos internos (`docs/`), el diseño del MCP y todas las migraciones.
- Datos de clientes: no hay RUT ni nombres de clientes reales en tests, fixtures ni CSV (verificado en el árbol y en todo el historial), con una excepción: un comentario de `nubox.ts` nombraba a un cliente real. Ya está corregido en el commit local `4abfc71`; el nombre queda en 2 commits antiguos del historial. `local/` está ignorado.
- `docs/cambios-flujo-v2.md` menciona un cliente por nombre ("EBCO", línea 103) y montos: es texto tuyo, lo señalo por si se hace público.
- **Recomendación:** pasar el repo a privado si no tiene motivo de ser público; si se mantiene público, revisar los documentos antes de cada PR.

### A08 — Sin verificación explícita de sesión ni roles en las escrituras · P2 · Verificado
- 27 de los 28 archivos de Server Actions no comprueban sesión ni membresía en el código: dependen del middleware (redirige a `/login`) y de RLS. Es coherente y las políticas cubren las tablas, pero no hay defensa en profundidad.
- Todas las escrituras están abiertas a cualquier miembro, sin importar el rol (`role` solo distingue `admin` para editar la empresa). Un miembro puede, por ejemplo, actualizar directamente `voided`, `document_number` o `payment_status` de una venta.
- **Recomendación:** decidir si hace falta un rol de solo lectura; centralizar en un helper `requireMember(companyId)` que además devuelva errores claros.

### A09 — Superficie del MCP · P2 · Verificado
- El token viaja también por `?token=` en la URL: queda en logs y historiales (decisión documentada en `lib/mcp/auth.ts`).
- Sin límite de frecuencia por token ni por IP.
- Un cuerpo JSON `null` hace fallar `const { id, method } = body` (500 en vez de error JSON-RPC).
- Punto a favor: hay un único control de acceso central (`assertMembership`, `mcp/tools.ts:278-337`) antes de tocar datos de una empresa, y el borrador toma la empresa desde la fila, no del pedido.
- **Recomendación:** aceptar solo el encabezado `Authorization` cuando el cliente lo permita, limitar frecuencia, validar la forma del cuerpo.

### A10 — Lint y calidad · P3 · Verificado
- 2 errores y 7 advertencias (los mismos de antes de 4.2): `setState` dentro de `useEffect` en `sales/quick/form.tsx:60` y `projects/[projectId]/quick-expense/form.tsx:66`, más variables sin usar en `dal.ts`.
- `npm audit --omit=dev`: 0 vulnerabilidades. Hay versiones más nuevas de `@anthropic-ai/sdk`, `@google/genai`, `openai`, `react` (19.3), y mayores de `typescript` (7), `eslint` (10) y `vitest` (5): actualizar los menores; los mayores con calma.

### A11 — Cobertura de pruebas · P2 · Verificado
- 136 tests en 7 archivos: importador de Nubox (parseo, clasificación, N/C, saldo, reconciliación), análisis y acciones, pendientes, vista de ventas y exportación, más 6 de cálculo financiero. Con el PR #121 se suman 8 tests del tablero.
- Sin pruebas de SQL/RLS, de las RPC (`import_nubox_documents_batch` se validó solo por sintaxis y con una corrida manual: la rama de reconciliación con ventas cargadas a mano no se ejecutó sobre datos) ni de extremo a extremo.
- **Recomendación:** una base de pruebas separada + pruebas de las RPC y de RLS (pgTAP o scripts con la CLI).

### A12 — Puntos abiertos de producto en 4.2 · P3
- **171 notas de crédito sin emparejar** (de 252): tienen varias facturas posibles del mismo monto o ninguna. Hoy se eligen a mano en Pendientes.
- **Boletas** (41 filas, unos $13,5 M netos en cuatro años) quedan fuera por no tener folio único.
- **"Revisar cobro en Nubox"** compara con la fecha más antigua del último archivo; con el histórico completo (2022) no lista nada. Conviene una regla por antigüedad de la deuda.
- **Facturas históricas sin trabajo** (~1.500): Pendientes solo lista las de los últimos 120 días y cuenta el resto. Los trabajos no tienen presupuesto para calzar por saldo en el histórico.

## Optimizaciones

Medidas en desarrollo con el histórico cargado, segunda visita:

| Pantalla | Respuesta | Tamaño | Comentario |
|---|---|---|---|
| Ventas (mes) | 0,8 s | 206 KB | Recalcula la rentabilidad de toda la empresa en cada visita para sacar gasto y ganancia |
| Ventas (todo el historial, 100 filas) | 3,4 s | 818 KB | 518 KB son datos de servidor para 100 filas (en desarrollo incluyen información de depuración: medir en producción) |
| Pendientes | 2,9 s | 707 KB | 242 filas, cada una con un selector de trabajos |
| Clientes | 2,2 s | 559 KB | 166 clientes sin paginar |
| Resumen | 3,6 s | 76 KB | Muchas consultas en serie/paralelo por período |
| Resultado mensual / Rentabilidad / Tablero | 1,7–2,0 s | 47–119 KB | ~1,4 s de espera del servidor |
| Proyectos, Costos | 0,4 s | 43–44 KB | Sin problema |

**Qué haría, en orden de retorno**
1. **Medir en producción** (Vercel) antes de tocar nada: los tamaños de desarrollo están inflados.
2. **Agregar en SQL en vez de descargar filas** para Resumen, Resultado mensual y Rentabilidad: menos datos, sin el tope de 1.000 y más rápido.
3. **Índices compuestos** hoy inexistentes: `sales_documents (company_id, document_date)`, `cost_documents (company_id, document_date)` y, según lo que muestre EXPLAIN, `sales_documents (company_id, voided, document_date)`. Hoy solo hay índices simples por `company_id`, `client_id` y `project_id`. Con 1.7 mil filas no duele; con costos históricos sí.
4. **Pendientes:** un solo selector compartido (o carga bajo demanda) en lugar de uno por fila.
5. **Ventas:** no calcular la rentabilidad de toda la empresa si la página no muestra filas con trabajo; cachear por período.
6. **Listas grandes** (Clientes, Proveedores): paginar o buscar en el servidor.
7. **Cachear** listas de apoyo que se piden en casi cada pantalla (clientes, áreas, proyectos para filtros).

## Plan recomendado

| # | Trabajo | Esfuerzo | Por qué primero |
|---|---|---|---|
| 1 | CI mínimo (tsc + lint + tests) y regla de orden de migraciones | Bajo | Evita repetir lo de hoy |
| 2 | Probar el MCP con un token real y corregir A03/A04 | Bajo–medio | Es una función que hoy probablemente no anda |
| 3 | Validar el mes en un helper único (A06) | Bajo | Rompe pantallas con una URL |
| 4 | Subir el límite de Server Actions o no reenviar filas (A05) | Bajo | Falla silenciosa en el crecimiento |
| 5 | Paginación/agregación SQL en Costos y reportes (A02, H10) | Medio | Cifras bajas sin error cuando crezcan los datos |
| 6 | Decidir repo privado y roles (A07, A08) | Bajo | Decisión de negocio |
| 7 | Índices y agregación SQL (optimizaciones 2–3) | Medio | Solo después de medir en producción |
| 8 | Proyecto de pruebas separado + pruebas de RPC/RLS (A11) | Medio–alto | Permite probar la reconciliación y el MCP sin tocar datos |

## Correcciones aplicadas después de la auditoría

| Hallazgo | Cambio | Verificación |
|---|---|---|
| A06 (mes inválido) | `MONTH_PATTERN` / `isValidMonth` en `lib/period.ts` (mes 01–12), usado en las 10 pantallas y acciones que leían un mes | Con `period=2026-13`, las 7 rutas que fallaban responden 200 sin error, y la exportación deja de dar 500. 13 tests |
| A05 (1 MB) | `experimental.serverActions.bodySizeLimit: "4mb"` (queda bajo los 4,5 MB que aceptan las funciones de Vercel) y tope del archivo de Nubox en 3 MB (5.000 filas ≈ 1,9 MB) | Configuración; el servidor de desarrollo se reinició para aplicarla |
| A04 (MCP no atómico) | `confirmMcpDraft` reserva el borrador con `update ... where consumed_at is null` antes de crear el documento y lo devuelve si la creación falla | 5 tests con una base simulada: orden reserva→creación, segunda confirmación no crea nada, fallo libera el borrador |
| A01 (sin CI) | Workflow `.github/workflows/ci.yml` en el PR #122 (`npm ci`, `next typegen`, `tsc`, lint, tests) y arreglo de los 2 errores de lint que lo habrían dejado en rojo | Corrió en GitHub sobre ese PR: pasó en 46 s. Falta mergearlo y marcar el chequeo como obligatorio en la protección de `main` |
| A07 (nombre de cliente en un comentario) | Reemplazado por un nombre inventado (`4abfc71`) | `git grep` |

Siguen abiertos el orden de migraciones de A01 (regla de despliegue y proyecto de pruebas separado), A02, A03 (el MCP quedó en pausa por decisión del equipo), A08–A12 y las optimizaciones. Los tests pasaron de 136 a 154.
