# PRD — INMA ERP V1

## 1. Resumen ejecutivo

Inmasoft puede conocer lo facturado, pero no dispone de un cálculo único y confiable de cuánto gana realmente cada mes ni cuánto margen deja cada cliente o proyecto. La V1 debe convertirse en la **fuente de verdad para rentabilidad de gestión**, sin reemplazar la contabilidad tributaria ni transformarse en un ERP generalista.

**Principio rector:** no confundir facturación, margen directo, resultado operacional y flujo de caja. La V1 se concentra en el resultado económico de gestión; los bancos quedan para una etapa posterior.

## 2. Alcance funcional V1

| Incluido | Objetivo |
|---|---|
| Empresas | Gestionar Inmasoft Chile e Inmasoft Uruguay con moneda y configuración propias |
| Clientes y proveedores | Ficha única para evitar duplicados y consolidar rentabilidad |
| Áreas de negocio | Clasificación configurable: Microsoft 365, hosting, desarrollo, soporte TI, redes, seguridad/CCTV, GPS, energía solar, otros |
| Proyectos | Ingreso previsto/real, costos, estado y margen acumulado y por período |
| Ingresos | Carga manual en ambas empresas; Chile además con importación CSV/Excel |
| Costos y gastos | Carga manual, importación opcional, clasificación directa/general, distribución entre proyectos/clientes |
| Servicios recurrentes | Precio, costo esperado, periodicidad, vigencia y cliente asociado |
| Personal / mano de obra | Costo mensual y asignación de costo/horas a proyectos |
| Reportes | Resultado mensual, rentabilidad por cliente/proyecto/área, presupuestado vs. real |
| Importaciones | Vista previa, validación, detección de duplicados, historial y trazabilidad del archivo origen |

**Fuera de alcance V1:** movimientos bancarios, conciliación, flujo de caja, emisión de facturas, nómina/remuneraciones completa, CRM, tickets, inventario avanzado, portal de clientes, contabilidad fiscal completa.

## 3. Lógica financiera acordada

| Nivel | Fórmula / interpretación |
|---|---|
| Ventas netas | Importe sin impuestos recuperables (se conserva impuesto y total del documento) |
| Margen directo | Ventas netas − costos directos atribuibles a la venta/proyecto |
| Resultado operacional | Margen directo − gastos generales y costos de estructura del período |
| Resultado de gestión ajustado | Resultado operacional +/− ajustes definidos por la empresa (opcional) |
| Rentabilidad de proyecto | Ingresos reconocidos − todos los costos atribuibles, con resultado acumulado y por período |

### Reglas de negocio clave

- Un costo vacío **no** equivale a costo cero. Distinguir "costo cero confirmado" de "costo pendiente".
- Factura, ingreso, costo y pago son entidades diferentes (aunque V1 no use bancos, el modelo no debe mezclarlas).
- IVA/impuestos recuperables no son ganancia ni gasto operativo.
- Costos compartidos deben poder distribuirse por porcentaje o monto entre proyecto, cliente, área y gasto general.
- No duplicar costos entre línea de venta y documento de proveedor importado.
- Proyectos multi-mes requieren resultado acumulado y regla de reconocimiento por período (no solo fecha de factura).

## 4. Modalidad de ingreso de datos por empresa

| Empresa | Ventas | Costos/gastos | Regla |
|---|---|---|---|
| Chile | Importación CSV/Excel + carga manual | Carga manual + importación opcional | Nunca depender solo del archivo; todo registro debe poder crearse/editarse manualmente con auditoría |
| Uruguay | Carga manual | Carga manual | La interfaz manual es el flujo principal, debe ser rápida para uso cotidiano |

El importador de Chile convierte columnas del archivo fuente a un formato interno estable, con vista previa, validaciones de fecha/moneda/cliente, detección de duplicados y registro del lote. Excel/CSV es interfaz de entrada/salida; la fuente de verdad es PostgreSQL en Supabase.

## 5. Hallazgos del Excel histórico (FINANZAS INMASOFT 2026)

Usado como **dataset de validación**, no como modelo físico de base de datos:

- 123 registros de ventas (ene–jun 2026): historial suficiente para validar la V1 contra datos reales.
- 34 ventas con costo vacío (25 de Chile ≈ CLP 4.019.976): el margen actual puede sobreestimar ganancia si el vacío se lee como cero.
- 110/123 márgenes cargados manualmente: el ERP debe **calcular** el margen, nunca depender de un valor escrito a mano.
- Chile: ventas netas ≈ CLP 30,14 MM; costos ≈ CLP 13,90 MM; margen registrado ≈ CLP 16,24 MM (margen sobre costos cargados, no ganancia comprobada).
- Hojas DASH/EJERCICIO con fórmulas inconsistentes, valores manuales y `#REF!`: se requiere un único motor de resultados.
- Hoja "Lo Espejo" mezcla rentabilidad de proyecto con cobros/transferencias/deuda/intereses: separar economía de proyecto de movimientos financieros.
- Servicios recurrentes (Microsoft 365, hosting, soporte, Starlink) se repiten mes a mes: conviene modelarlos explícitamente.

## 6. Criterio de "V1 lista"

Para un mes real, debe ser posible:

- Registrar/importar todos los ingresos de Chile y Uruguay sin duplicados.
- Registrar costos directos, gastos generales y costos de personal con estado de completitud visible.
- Asignar costos a proyecto/cliente/área o dejarlos explícitamente como gasto general.
- Obtener ventas netas, margen directo y resultado operacional del mes.
- Abrir cualquier cifra del dashboard y llegar a los documentos que la componen (drill-down).
- Ver rentabilidad acumulada de un proyecto y rentabilidad agregada por cliente y área.
- Detectar fácilmente "costos pendientes" para impedir que una venta incompleta aparezca como ganancia plena.

## 7. Roadmap por etapas (base de las épicas)

1. Base técnica — migraciones SQL, RLS, usuarios, empresas y permisos
2. Maestros — clientes, proveedores, áreas y proyectos (CRUD + validaciones)
3. Ingresos manuales — alta/edición de ventas Chile/Uruguay
4. Costos y asignaciones — compras/gastos, distribución a proyectos/clientes
5. Importador Chile — CSV/Excel con mapeo, preview, validación, dedupe, historial
6. Recurrentes y personal — servicios recurrentes y costo de mano de obra
7. Motor de rentabilidad — funciones únicas para resultado mensual/cliente/proyecto/área
8. Validación histórica — cargar un mes real de Chile y Uruguay, comparar y resolver diferencias
9. Publicación inicial — Next.js en WHM/cPanel + Supabase Cloud + HTTPS

Ver `docs/decisiones-abiertas.md` para temas a resolver antes de construir reportes.
