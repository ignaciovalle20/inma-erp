# Arquitectura técnica — INMA ERP

## Stack decidido

```
PC de desarrollo (VS Code + Codex)
        |
        v
     GitHub (código + migraciones)
        |
   +----+----------------------+
   |                           |
   v                           v
Next.js (Vercel)          Supabase Cloud
front + servidor          - PostgreSQL
                           - Auth
                           - Storage
                           - API / RLS
```

| Componente | Rol |
|---|---|
| VS Code | Entorno local de desarrollo |
| Codex | Agente para implementar cambios, ejecutar pruebas y refactorizar |
| GitHub | Versionado de código y migraciones. No almacenar datos financieros ni secretos |
| Next.js + TypeScript | Aplicación web, formularios, reportes y lógica de servidor (App Router) |
| Supabase | PostgreSQL, autenticación, Storage y políticas de acceso (RLS) — backend, no compite con Vercel |
| Vercel | Hosting y deploy de la app Next.js, con integración nativa a GitHub (deploy automático por push/PR) |
| Docker | Preparación futura para migrar solo Supabase a infraestructura propia, si se decide independencia total (Vercel seguiría alojando el frontend) |

## Modelo de datos recomendado

| Tabla | Propósito mínimo |
|---|---|
| `companies` | Empresa, país, identificación fiscal, moneda base, activa/inactiva |
| `profiles` / `company_memberships` | Usuario, rol y empresas a las que puede acceder |
| `clients` | Cliente único, identificación fiscal, país, estado, metadatos |
| `suppliers` | Proveedor único y datos fiscales/comerciales |
| `business_areas` | Áreas configurables de negocio |
| `projects` | Cliente, empresa, área, nombre, fechas, estado, presupuesto, responsable |
| `sales_documents` | Cabecera de factura/boleta/nota de crédito/registro manual |
| `sales_lines` | Detalle por servicio/producto (varias líneas por documento) |
| `cost_documents` | Compras, honorarios, gastos, documentos de proveedor |
| `cost_lines` | Detalle del costo |
| `cost_allocations` | Distribución de un costo entre proyectos, clientes, áreas o gasto general |
| `recurring_services` | Servicio periódico, cliente, precio, costo esperado, periodicidad, vigencia |
| `personnel_costs` | Costo mensual de personal/socio, base para asignaciones |
| `work_allocations` | Horas o costo asignado a proyecto |
| `currencies` / `exchange_rates` | Moneda original, fecha y tipo de cambio para consolidación |
| `import_batches` / `import_rows` | Trazabilidad de CSV/Excel, errores, control de duplicados |
| `management_periods` | Períodos mensuales, futuro mecanismo de cierre/bloqueo |

**Diseño multiempresa y multimoneda:** toda entidad financiera pertenece explícitamente a una empresa. Cada transacción conserva importe y moneda original; la conversión para reportes consolidados es derivada, nunca sobrescribe el origen.

## Estructura funcional de pantallas

```
Dashboard      Gestión           Ingresos                Costos                    Reportes                  Configuración
- Resultado    - Empresas        - Documentos de venta    - Compras y gastos        - Resultado mensual       - Usuarios y roles
  mensual      - Clientes        - Carga manual            - Costos generales        - Presupuestado vs real   - Monedas
- Rent. x      - Proveedores     - Importar CSV/Excel      - Costos recurrentes      - Rent. por cliente       - Categorías/reglas
  cliente      - Proyectos         (Chile)                 - Personal / mano de obra - Rent. por proyecto
- Rent. x      - Áreas de negocio                          - Asignaciones de costos  - Rent. por área
  proyecto
- Rent. x área
```

## Reglas de integridad, auditoría y seguridad

- RLS (Row Level Security) por empresa: un usuario solo consulta/modifica empresas autorizadas.
- Nunca usar `service_role` ni claves administrativas en el navegador. Secretos fuera del repositorio.
- Conservar source/origen e identificador externo de documentos importados (evitar duplicados).
- Registrar usuario y timestamps de creación/modificación en entidades sensibles.
- Permitir correcciones con trazabilidad; evitar eliminar silenciosamente documentos ya incluidos en reportes.
- Mostrar registros incompletos: costos pendientes, proyectos sin asignación, clientes sin normalizar, documentos con errores.
- No considerar "cero" cuando el dato está ausente — usar estados explícitos (`pending` / `confirmed` / `not_applicable`).
- Antes de usar datos reales: repositorio privado, revisión de `.gitignore`, backup de Supabase y política de recuperación.

## Publicación e independencia futura (resumen)

1. El frontend se publica en Vercel desde el inicio (deploy automático conectado a GitHub); no requiere migración de hosting a corto plazo.
2. Si en el futuro se busca independencia total del backend, migrar PostgreSQL/Auth/Storage de Supabase a infraestructura propia (VPS + Docker), tratándolo como proyecto separado — Vercel seguiría sirviendo el frontend.
3. Mantener siempre migraciones SQL y configuración reproducible en GitHub, sin importar dónde corra el backend.
