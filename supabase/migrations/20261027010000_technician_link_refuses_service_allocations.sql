-- link_technician_document: a document allocated to recurring services is
-- not linked (QA of 2026-10-27, docs/qa-tecnicos-2026-10-27.md).
--
-- 20261026010000 replaced ANY assignment of the document when the screen
-- confirmed it, services included. But a recurring service's cost period
-- without a confirmed invoice goes back to counting its expected cost: taking
-- the invoice away from the service would add that expected cost to the
-- month on top of the technician's cost, silently. Now a document with a
-- confirmed allocation to services (alone or mixed with a split) is refused
-- with SERVICES: the person removes that allocation first ("Asignar a
-- servicios" / "Editar asignación"), on purpose. Suggested (unconfirmed)
-- service allocations are still dropped, as before.
--
-- Same body as 20261026010000 otherwise. Idempotent (create or replace).
create or replace function public.link_technician_document(
  p_cost_document_id uuid,
  p_charge_ids uuid[],
  p_replace_allocations boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_backing text;
  v_personnel_id uuid;
  v_charge public.technician_charges;
  v_count integer := 0;
  v_cost_sum numeric := 0;
  v_allocated boolean;
  v_project record;
  v_project_count integer;
  v_decimals integer;
  v_share numeric;
  v_share_sum numeric := 0;
  v_index integer := 0;
  v_old_document_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required to link a technician document';
  end if;

  select * into v_document from public.cost_documents where id = p_cost_document_id for update;
  if v_document.id is null then
    raise exception 'NOT_ELIGIBLE: Documento no encontrado';
  end if;

  if not public.company_is_chile(v_document.company_id) then
    raise exception 'NOT_ELIGIBLE: Los documentos se vinculan a cargos de técnico solo en empresas de Chile';
  end if;

  if v_document.document_type <> 'invoice'
    or coalesce(v_document.source_document_type, '') not in ('FAC-EL', 'FAC-EE', 'BOL-HE', 'BOL-TE')
    or v_document.net_amount <= 0
  then
    raise exception 'NOT_ELIGIBLE: Solo una factura (FAC-EL, FAC-EE) o boleta (BOL-HE, BOL-TE) importada se vincula a cargos de técnico';
  end if;
  v_backing := case when v_document.source_document_type like 'FAC-%' then 'factura' else 'boleta' end;

  if exists (select 1 from public.technician_charges tc where tc.cost_document_id = p_cost_document_id) then
    raise exception 'NOT_ELIGIBLE: Este gasto es el costo propio de un cargo de técnico';
  end if;

  if exists (select 1 from public.technician_charge_documents l where l.cost_document_id = p_cost_document_id) then
    raise exception 'ALREADY_LINKED: Este documento ya está vinculado a cargos: desvinculalo primero';
  end if;

  if exists (
    select 1 from public.cost_service_allocations a
    where a.cost_document_id = p_cost_document_id and a.status = 'confirmed'
  ) then
    raise exception 'SERVICES: Este documento está asignado a servicios recurrentes: quitá esa asignación (Asignar a servicios o Editar asignación) antes de vincularlo a cargos de técnico';
  end if;

  select ts.personnel_id into v_personnel_id
  from public.technician_suppliers ts
  where ts.supplier_id = v_document.supplier_id;
  if v_personnel_id is null then
    raise exception 'NO_TECHNICIAN: El proveedor de este documento no está vinculado a ningún técnico: agregá su RUT en la ficha del técnico';
  end if;

  if p_charge_ids is null or cardinality(p_charge_ids) = 0 then
    raise exception 'CHARGES: Elegí al menos un cargo';
  end if;

  -- In id order, like the payments: two links over the same charges cannot deadlock.
  for v_charge in
    select * from public.technician_charges where id = any (p_charge_ids) order by id for update
  loop
    if v_charge.company_id <> v_document.company_id or v_charge.personnel_id <> v_personnel_id then
      raise exception 'CHARGES: Todos los cargos tienen que ser del técnico del documento';
    end if;
    if v_charge.backing is distinct from v_backing then
      raise exception 'CHARGES: El cargo del % tiene otro respaldo (%): el documento es una %',
        to_char(v_charge.charge_date, 'DD/MM/YYYY'),
        coalesce(case v_charge.backing when 'none' then 'sin respaldo' else v_charge.backing end, 'sin registrar'),
        v_backing;
    end if;
    if v_charge.cost_document_id is null then
      raise exception 'CHARGES: El cargo del % ya está vinculado a otro documento', to_char(v_charge.charge_date, 'DD/MM/YYYY');
    end if;
    if exists (select 1 from public.cost_document_attachments a where a.cost_document_id = v_charge.cost_document_id) then
      raise exception 'CHARGES: El costo del cargo del % tiene comprobantes adjuntos: no se puede reemplazar por el documento',
        to_char(v_charge.charge_date, 'DD/MM/YYYY');
    end if;
    v_count := v_count + 1;
    v_cost_sum := v_cost_sum + v_charge.net_amount;
  end loop;

  if v_count <> (select count(distinct id) from unnest(p_charge_ids) as t (id)) then
    raise exception 'CHARGES: Algún cargo no se encontró';
  end if;

  if abs(v_cost_sum - v_document.net_amount) > v_count then
    raise exception 'AMOUNT_MISMATCH: Los costos de los cargos suman % y el neto del documento es %: diferencia %',
      v_cost_sum, v_document.net_amount, v_document.net_amount - v_cost_sum;
  end if;

  v_allocated := v_document.classification <> 'general'
    or v_document.project_id is not null
    or exists (select 1 from public.cost_allocations ca where ca.cost_document_id = p_cost_document_id);
  if v_allocated and not coalesce(p_replace_allocations, false) then
    raise exception 'ALLOCATED: Este documento ya está asignado a un trabajo o repartido: confirmá que el vínculo reemplace esa asignación';
  end if;

  perform set_config('inma.technician_document_link', 'on', true);

  -- The assignment it had goes away (and a suggestion to services, unconfirmed).
  delete from public.cost_service_allocations where cost_document_id = p_cost_document_id;
  delete from public.cost_allocations where cost_document_id = p_cost_document_id;
  if v_document.classification <> 'general' or v_document.project_id is not null then
    update public.cost_documents
    set classification = 'general', project_id = null, updated_by = v_user_id
    where id = p_cost_document_id;
  end if;

  -- Each charge: its own cost goes, the document takes its place.
  for v_charge in
    select * from public.technician_charges where id = any (p_charge_ids) order by id
  loop
    v_old_document_id := v_charge.cost_document_id;

    insert into public.technician_charge_documents (company_id, charge_id, cost_document_id, cost_amount, created_by)
    values (v_document.company_id, v_charge.id, p_cost_document_id, v_charge.net_amount, v_user_id);

    update public.technician_charges
    set cost_document_id = null, document_status = 'recibida', updated_by = v_user_id
    where id = v_charge.id;

    update public.cost_documents set duplicate_of_cost_document_id = null
    where duplicate_of_cost_document_id = v_old_document_id;
    delete from public.cost_lines where cost_document_id = v_old_document_id;
    delete from public.cost_documents where id = v_old_document_id;
  end loop;

  -- The document, imputed to the jobs of the charges by their costs.
  select count(distinct project_id) into v_project_count
  from public.technician_charges
  where id = any (p_charge_ids);

  if v_project_count = 1 then
    update public.cost_documents
    set classification = 'direct',
        project_id = (select project_id from public.technician_charges where id = p_charge_ids[1]),
        updated_by = v_user_id
    where id = p_cost_document_id;
  else
    v_decimals := case when v_document.currency = 'CLP' then 0 else 2 end;
    for v_project in
      select project_id, sum(net_amount) as cost, min(charge_date) as first_date
      from public.technician_charges
      where id = any (p_charge_ids)
      group by project_id
      order by min(charge_date), project_id
    loop
      v_index := v_index + 1;
      v_share := case
        when v_index = v_project_count then v_document.total_amount - v_share_sum
        else round(v_document.total_amount * v_project.cost / v_cost_sum, v_decimals)
      end;
      v_share_sum := v_share_sum + v_share;

      insert into public.cost_allocations (
        cost_document_id, project_id, method, amount, position, created_by, updated_by
      ) values (
        p_cost_document_id, v_project.project_id, 'fixed_amount', v_share, v_index - 1, v_user_id, v_user_id
      );
    end loop;
  end if;

  -- Suggestions about this document or these charges are settled.
  delete from public.technician_document_suggestions s
  where s.cost_document_id = p_cost_document_id or s.charge_ids && p_charge_ids;

  perform set_config('inma.technician_document_link', 'off', true);

  return jsonb_build_object(
    'cost_document_id', p_cost_document_id,
    'charges', v_count,
    'projects', v_project_count,
    'replaced_allocation', v_allocated
  );
end;
$$;

revoke execute on function public.link_technician_document(uuid, uuid[], boolean) from public, anon;
grant execute on function public.link_technician_document(uuid, uuid[], boolean) to authenticated, service_role;
