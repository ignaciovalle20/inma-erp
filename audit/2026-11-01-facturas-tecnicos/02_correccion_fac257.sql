-- Deja la FAC-EL 257 (LUIS FUENTES CATRIN E.I.R.L., neto 2.147.053, total 2.554.993)
-- como costo del técnico, aplicada a sus 4 cargos, en lugar del reparto como costo
-- general (que además cuenta dos veces el costo de Redes).
--
-- Idempotente y en una sola transacción. Todo o nada:
--   * Si ya está vinculada, o no existe, no hace nada.
--   * Si falta alguno de los 4 cargos, NO toca nada y lo lista. No inventa cargos:
--     se cargan desde la pantalla del documento o desde cada trabajo.
--   * Un cargo cuenta si es del técnico, de ese trabajo, sin cubrir, con factura o
--     sin respaldo, y su neto da el esperado (±1 peso). Sin respaldo, su monto se
--     lee como total con IVA, lo que no cambia lo que se le paga.
--
-- Requiere las migraciones 20261101010000 y 20261101020000.
-- APLICADO EN DEV. EN PROD NO SE EJECUTÓ: ver README.md.

begin;

drop table if exists pg_temp.fac257_reporte;
create temp table fac257_reporte (orden serial, paso text, detalle jsonb);

do $$
declare
  v_document public.cost_documents;
  v_personnel_id uuid;
  v_user_id uuid;
  v_target record;
  v_charge record;
  v_items jsonb := '[]'::jsonb;
  v_missing integer := 0;
  v_result jsonb;
begin
  select * into v_document
  from public.cost_documents d
  where d.source_document_type = 'FAC-EL'
    and d.document_number = '257'
    and d.net_amount = 2147053
    and d.supplier_id in (select s.id from public.suppliers s where s.tax_id = '76577457-8');

  if v_document.id is null then
    insert into fac257_reporte (paso, detalle) values ('SIN CAMBIOS', '{"motivo": "no existe la FAC-EL 257 de ese proveedor"}');
    return;
  end if;

  if exists (select 1 from public.technician_charge_documents l where l.cost_document_id = v_document.id) then
    insert into fac257_reporte (paso, detalle) values ('SIN CAMBIOS', '{"motivo": "ya está vinculada a cargos"}');
    return;
  end if;

  select ts.personnel_id into v_personnel_id
  from public.technician_suppliers ts
  where ts.supplier_id = v_document.supplier_id;
  if v_personnel_id is null then
    insert into fac257_reporte (paso, detalle) values ('SIN CAMBIOS', '{"motivo": "el proveedor no está vinculado a un técnico"}');
    return;
  end if;

  for v_target in
    select * from (values
      ('Redes en colegios del interior', 1680672::numeric),
      ('STARLINK La Ligua', 336134::numeric),
      ('Tintas Wind', 37815::numeric),
      ('Control de acceso HIK', 92432::numeric)
    ) as t (project_name, expected_net)
  loop
    select c.id, c.charge_date, c.backing, costs.net as net into v_charge
    from public.technician_charges c
    join public.projects p on p.id = c.project_id
    cross join lateral (
      select case when c.backing = 'factura' then c.net_amount else round(c.amount / 1.19) end as net
    ) costs
    where c.personnel_id = v_personnel_id
      and p.company_id = v_document.company_id
      and p.name = v_target.project_name
      and (c.backing = 'factura' or c.backing = 'none' or c.backing is null)
      and not exists (select 1 from public.technician_charge_documents l where l.charge_id = c.id)
      and abs(costs.net - v_target.expected_net) <= 1
    order by abs(costs.net - v_target.expected_net), c.charge_date
    limit 1;

    if v_charge.id is null then
      v_missing := v_missing + 1;
      insert into fac257_reporte (paso, detalle)
      select 'FALTA EL CARGO', jsonb_build_object(
        'trabajo', v_target.project_name,
        'neto_esperado', v_target.expected_net,
        'cargos_del_tecnico_en_ese_trabajo', coalesce((
          select jsonb_agg(jsonb_build_object('fecha', c.charge_date, 'respaldo', c.backing, 'neto', c.net_amount, 'a_pagar', c.amount))
          from public.technician_charges c
          join public.projects p on p.id = c.project_id
          where c.personnel_id = v_personnel_id and p.name = v_target.project_name and p.company_id = v_document.company_id
        ), '[]'::jsonb)
      );
    else
      v_items := v_items || jsonb_build_object(
        'charge_id', v_charge.id,
        'amount', v_charge.net,
        'entered_as', case when v_charge.backing = 'factura' then null else 'total' end
      );
      insert into fac257_reporte (paso, detalle)
      values ('CARGO ENCONTRADO', jsonb_build_object('trabajo', v_target.project_name, 'fecha', v_charge.charge_date, 'respaldo', v_charge.backing, 'neto', v_charge.net));
    end if;
  end loop;

  if v_missing > 0 then
    insert into fac257_reporte (paso, detalle)
    values ('SIN CAMBIOS', jsonb_build_object('motivo', 'faltan cargos: cargalos y volvé a correr este script', 'faltan', v_missing));
    return;
  end if;

  -- apply_technician_document necesita un usuario: quien cargó el documento, si
  -- sigue siendo miembro, o un admin de la empresa.
  select cm.user_id into v_user_id
  from public.company_memberships cm
  where cm.company_id = v_document.company_id
  order by (cm.user_id = v_document.created_by) desc nulls last, (cm.role = 'admin') desc, cm.created_at
  limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_id, 'role', 'authenticated')::text, true);

  v_result := public.apply_technician_document(v_document.id, v_items, true, false);
  insert into fac257_reporte (paso, detalle) values ('VINCULADA', v_result);
end;
$$;

commit;

select paso, detalle from fac257_reporte order by orden;
