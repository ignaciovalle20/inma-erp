-- SOLO DEV. Deja la FAC-EL 257 como está en prod (repartida como costo general entre
-- 4 trabajos) y carga los 4 cargos, para probar 02_correccion_fac257.sql de punta a
-- punta. Dev es una copia vieja de prod: no tiene el RUT de la empresa vinculado, ni
-- los trabajos Redes y Tintas, ni el técnico con el nombre nuevo. Idempotente.

begin;

do $$
declare
  c_company uuid := '6daad6e3-ff4c-4026-aa3d-4f8290e10724';
  c_personnel uuid := '93fde9b2-5ba5-4257-a540-220286a92e3f';
  v_user_id uuid;
  v_supplier uuid;
  v_document public.cost_documents;
  v_base public.projects;
  v_project uuid;
  v_target record;
  v_allocations jsonb := '[]'::jsonb;
  v_index integer := 0;
begin
  -- En prod ese técnico se llama Luis Fuentes: esta guarda evita correr esto ahí.
  if not exists (select 1 from public.personnel where id = c_personnel and name = 'Luis sin F') then
    raise exception 'Este script es solo para dev';
  end if;

  select cm.user_id into v_user_id
  from public.company_memberships cm
  where cm.company_id = c_company and cm.role = 'admin'
  order by cm.created_at
  limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id, 'role', 'authenticated')::text, true);

  select id into v_supplier from public.suppliers where company_id = c_company and tax_id = '76577457-8';
  if not exists (select 1 from public.technician_suppliers where supplier_id = v_supplier) then
    insert into public.technician_suppliers (company_id, personnel_id, supplier_id, created_by)
    values (c_company, c_personnel, v_supplier, v_user_id);
  end if;

  select * into v_document
  from public.cost_documents
  where company_id = c_company and source_document_type = 'FAC-EL' and document_number = '257';
  if v_document.id is null or v_document.net_amount <> 2147053 then
    raise exception 'La FAC-EL 257 de dev no es la esperada';
  end if;
  if exists (select 1 from public.technician_charge_documents where cost_document_id = v_document.id) then
    return;
  end if;

  select * into v_base from public.projects where company_id = c_company and name = 'STARLINK La Ligua';

  for v_target in
    select * from (values
      ('Redes en colegios del interior', 'total', 2000000::numeric, 1680672::numeric),
      ('STARLINK La Ligua', 'total', 400000::numeric, 336134::numeric),
      ('Tintas Wind', 'total', 45000::numeric, 37815::numeric),
      ('Control de acceso HIK', 'net', 92432::numeric, 92432::numeric)
    ) as t (project_name, entered_as, value, net)
  loop
    select id into v_project from public.projects where company_id = c_company and name = v_target.project_name;
    if v_project is null then
      insert into public.projects (company_id, client_id, business_area_id, name, status, created_by, updated_by)
      values (c_company, v_base.client_id, v_base.business_area_id, v_target.project_name, 'en_ejecucion', v_user_id, v_user_id)
      returning id into v_project;
    end if;

    if not exists (
      select 1 from public.technician_charges
      where personnel_id = c_personnel and project_id = v_project and net_amount = v_target.net
    ) then
      perform public.create_backed_technician_charge(
        v_project, c_personnel, 'Cargo de prueba FAC-EL 257', '2026-06-15', 'factura', v_target.entered_as, v_target.value
      );
    end if;

    v_allocations := v_allocations || jsonb_build_object(
      'target_type', 'project', 'target_id', v_project, 'method', 'fixed_amount', 'value', v_target.net, 'position', v_index
    );
    v_index := v_index + 1;
  end loop;

  perform public.set_cost_document_allocations(v_document.id, v_allocations, '[]'::jsonb);
end;
$$;

commit;

select d.document_number, d.net_amount, d.total_amount, d.classification,
       (select count(*) from public.cost_allocations a where a.cost_document_id = d.id) as filas_reparto,
       (select sum(a.amount) from public.cost_allocations a where a.cost_document_id = d.id) as suma_reparto
from public.cost_documents d
where d.source_document_type = 'FAC-EL' and d.document_number = '257';
