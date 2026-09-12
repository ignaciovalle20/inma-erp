# INMA ERP

ERP interno de gestión para Inmasoft (Chile y Uruguay). Fuente de verdad para **rentabilidad de gestión**: ganancia real mensual y margen por proyecto, cliente y área de negocio.

> Este proyecto se gestiona con metodología BMAD (Breakthrough Method for Agile AI-Driven Development). El contexto funcional y técnico completo vive en [`docs/prd.md`](docs/prd.md) y [`docs/architecture.md`](docs/architecture.md). Las épicas y su desglose en historias se gestionan como issues de GitHub (label `epic` / `story`).

## Alcance V1

Calcular resultado mensual y rentabilidad por proyecto/cliente/área para Inmasoft Chile y Uruguay, con ingresos y costos cargados manualmente (+ importación CSV/Excel para Chile). **Fuera de alcance V1**: bancos, conciliación bancaria, emisión tributaria, CRM completo, tickets e inventario.

## Stack

- Next.js 16 + TypeScript + App Router
- Supabase Cloud (PostgreSQL, Auth, Storage, RLS)
- GitHub (código + migraciones SQL versionadas)
- Publicación inicial: WHM/cPanel · migración futura: VPS + Docker

## Documentación

- [`docs/prd.md`](docs/prd.md) — Product Requirements Document (alcance, lógica financiera, reglas de negocio, criterio de "V1 lista")
- [`docs/architecture.md`](docs/architecture.md) — Arquitectura técnica, modelo de datos, reglas de integridad/seguridad
- [`docs/decisiones-abiertas.md`](docs/decisiones-abiertas.md) — Decisiones pendientes a resolver antes de construir reportes

## Estado

Proyecto en etapa de definición de esquema de base de datos y migraciones (Épica 1). Ver [issues](../../issues) para el detalle de épicas y avance.
