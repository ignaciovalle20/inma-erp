-- Nuevo tipo de servicio recurrente "Mnto Web" (mantenimiento mensual de
-- sitios web): 'web_maintenance'. Se agrega al check de recurring_services
-- y al de recurring_service_cost_pools; este último tampoco tenía 'domain'
-- (lo agregó 20261016010000 solo en recurring_services), y el formulario de
-- pools ofrece todos los tipos, así que se agrega también.

alter table public.recurring_services drop constraint recurring_services_service_type_check;
alter table public.recurring_services
  add constraint recurring_services_service_type_check
    check (service_type in ('ms_licenses', 'hosting', 'starlink', 'server', 'domain', 'web_maintenance', 'other'));

alter table public.recurring_service_cost_pools drop constraint recurring_service_cost_pools_service_type_check;
alter table public.recurring_service_cost_pools
  add constraint recurring_service_cost_pools_service_type_check
    check (service_type in ('ms_licenses', 'hosting', 'starlink', 'server', 'domain', 'web_maintenance', 'other'));
