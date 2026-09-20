-- Fecha "gestionar desde" de la empresa (docs/plan-sistema-v3.md, B1).
--
-- Desde esta fecha el ERP se gestiona completo (cada factura con trabajo,
-- notas de crédito emparejadas, cobro al día). Lo anterior es historial: sigue
-- sumando en ventas y reportes, pero Pendientes no lo lista ni lo pide. La
-- fecha solo filtra lo que se muestra; no cambia ningún dato.
--
-- Migración aditiva: una columna nueva que admite nulo (nulo = sin límite, se
-- muestra todo). No cambia ni borra nada existente, así que se puede aplicar
-- antes de mergear el código que la usa sin romper la versión actual.
--
-- La edita un administrador desde "Editar empresa": la política de UPDATE de
-- companies (solo admins) ya cubre la columna nueva.

alter table public.companies
  add column management_start_date date;

comment on column public.companies.management_start_date is
  'Pendientes solo muestra documentos con document_date >= esta fecha. Nulo = sin límite.';

-- Chile empieza a gestionarse el 1/1/2026. Otras empresas quedan sin límite.
update public.companies
set management_start_date = date '2026-01-01'
where upper(coalesce(country, '')) = 'CL'
  and management_start_date is null;
