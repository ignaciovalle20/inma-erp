-- A technician's factura or boleta applied to several charges, each with its
-- amount (FAC-EL 257: neto 2.147.053 over 4 jobs).
--
-- The screen only offered charges with the document's backing, so a job loaded
-- "sin respaldo" could not be chosen, and link_technician_document only took a
-- set of whole charges adding up to the net. The only way out was to split the
-- document as a general cost. Now apply_technician_document takes
-- [{ charge_id, amount, entered_as }]:
--
--   * amount is the net applied to that charge (bruto for a boleta): less than
--     its cost is a partial application, and the rest stays pending for another
--     document. A charge may have several documents, a document several charges.
--   * A charge "sin respaldo" chosen for a document takes the document's backing
--     (technician_charge_take_backing): entered_as says whether its amount was
--     the neto or the total (a boleta: bruto or líquido). It may already be paid.
--   * A difference between the sum and the document's net is allowed only with
--     p_accept_difference. What is left of the net stays a general cost of the
--     document (reports count net - technician_linked_amount), as the rounding
--     tolerance already did.
--   * document_status is 'recibida' exactly when the charge is fully covered.
--
-- link_technician_document stays: Conciliar confirms suggestions with it, whole
-- charges of the same backing that add up. Unlinking a document does not give a
-- charge back its "sin respaldo": it stays pending of a document.

alter table public.technician_charge_documents
  drop constraint technician_charge_documents_charge_id_key;

alter table public.technician_charge_documents
  add constraint technician_charge_documents_charge_document_key unique (charge_id, cost_document_id);

create index technician_charge_documents_charge_id_idx on public.technician_charge_documents (charge_id);

comment on column public.technician_charge_documents.cost_amount is
  'The net (bruto for a boleta) of the document applied to this charge: its cost, or part of it.';

-- At commit: with factura or boleta, 'recibida' exactly when fully covered.
create or replace function public.technician_charges_check_cost_source()
returns trigger
language plpgsql
as $$
declare
  v_charge_id uuid;
  v_charge public.technician_charges;
  v_links integer;
  v_applied numeric;
begin
  if tg_table_name = 'technician_charges' then
    v_charge_id := new.id;
  elsif tg_op = 'DELETE' then
    v_charge_id := old.charge_id;
  else
    v_charge_id := new.charge_id;
  end if;

  select * into v_charge from public.technician_charges where id = v_charge_id;
  if v_charge.id is null then
    return null;
  end if;

  select count(*), coalesce(sum(l.cost_amount), 0) into v_links, v_applied
  from public.technician_charge_documents l
  where l.charge_id = v_charge_id;

  if v_links > 0 and (v_charge.backing is null or v_charge.backing = 'none') then
    raise exception 'Only a charge with factura or boleta can have a linked document';
  end if;
  if v_applied > v_charge.net_amount then
    raise exception 'A charge cannot have more applied than its cost';
  end if;
  if v_charge.backing in ('factura', 'boleta')
    and (v_charge.document_status = 'recibida') <> (v_links > 0 and v_applied >= v_charge.net_amount)
  then
    raise exception 'A charge with factura or boleta has its document received exactly when it is fully covered';
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- A charge without backing takes the backing of the document that covers it.
-- Unlike a correction it may have payments: only a new amount below what was
-- already paid is refused. Same amounts and own cost document as
-- update_backed_technician_charge.
-- ---------------------------------------------------------------------
create or replace function public.technician_charge_take_backing(
  p_charge_id uuid,
  p_backing text,
  p_entered_as text
)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_charge public.technician_charges;
  v_amounts record;
  v_paid numeric;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Authentication required to change a technician charge';
  end if;

  select * into v_charge from public.technician_charges where id = p_charge_id for update;
  if v_charge.id is null or not exists (
    select 1 from public.company_memberships cm
    where cm.company_id = v_charge.company_id and cm.user_id = v_user_id
  ) then
    raise exception 'Technician charge not found';
  end if;

  if v_charge.backing is not null and v_charge.backing <> 'none' then
    raise exception 'CHARGES: El cargo del % ya tiene respaldo', to_char(v_charge.charge_date, 'DD/MM/YYYY');
  end if;
  if p_backing not in ('factura', 'boleta') then
    raise exception 'CHARGES: El respaldo tiene que ser factura o boleta';
  end if;
  if exists (select 1 from public.technician_charge_documents l where l.charge_id = p_charge_id) then
    raise exception 'CHARGES: El cargo del % ya está vinculado a un documento', to_char(v_charge.charge_date, 'DD/MM/YYYY');
  end if;

  select * into v_amounts from public.technician_backing_amounts(p_backing, p_entered_as, v_charge.amount, v_charge.charge_date);

  select coalesce(sum(a.amount), 0) into v_paid
  from public.technician_payment_applications a
  where a.charge_id = p_charge_id;
  if v_amounts.payable < v_paid then
    raise exception 'CHARGES: El cargo del % ya tiene pagado % y quedaría en %: revisá cómo se ingresó el monto',
      to_char(v_charge.charge_date, 'DD/MM/YYYY'), v_paid, v_amounts.payable;
  end if;

  select name into v_name from public.personnel where id = v_charge.personnel_id;

  perform set_config('inma.technician_charge_edit', v_charge.cost_document_id::text, true);

  update public.cost_documents
  set net_amount = v_amounts.cost,
      tax_amount = case when p_backing = 'boleta' then 0 else v_amounts.payable - v_amounts.cost end,
      total_amount = case when p_backing = 'boleta' then v_amounts.cost else v_amounts.payable end,
      updated_by = v_user_id
  where id = v_charge.cost_document_id;

  delete from public.cost_lines where cost_document_id = v_charge.cost_document_id;

  insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
  values (
    v_charge.cost_document_id,
    'Técnico: ' || v_name || coalesce(' — ' || v_charge.description, ''),
    v_amounts.cost,
    v_user_id,
    v_user_id
  );

  update public.technician_charges
  set amount = v_amounts.payable,
      vat_included = p_backing = 'factura',
      vat_rate = v_amounts.vat_rate,
      net_amount = v_amounts.cost,
      backing = p_backing,
      entered_as = p_entered_as,
      withholding_rate = v_amounts.withholding_rate,
      document_status = 'pendiente',
      updated_by = v_user_id
  where id = p_charge_id
  returning * into v_charge;

  perform set_config('inma.technician_charge_edit', '', true);

  return v_charge;
end;
$$;

revoke execute on function public.technician_charge_take_backing(uuid, text, text) from public, anon;
grant execute on function public.technician_charge_take_backing(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- apply_technician_document: same checks as link_technician_document, each
-- charge with its amount.
-- ---------------------------------------------------------------------
create or replace function public.apply_technician_document(
  p_cost_document_id uuid,
  p_items jsonb,
  p_replace_allocations boolean default false,
  p_accept_difference boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_backing text;
  v_personnel_id uuid;
  v_item jsonb;
  v_charge public.technician_charges;
  v_amount numeric;
  v_applied numeric;
  v_sum numeric := 0;
  v_count integer := 0;
  v_converted integer := 0;
  v_ids uuid[];
  v_allocated boolean;
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

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'CHARGES: Elegí al menos un cargo';
  end if;

  select array_agg((item ->> 'charge_id')::uuid) into v_ids from jsonb_array_elements(p_items) as item;
  if cardinality(v_ids) <> (select count(distinct id) from unnest(v_ids) as t (id)) then
    raise exception 'CHARGES: Hay un cargo repetido';
  end if;

  perform set_config('inma.technician_document_link', 'on', true);

  -- In id order, like the payments: two links over the same charges cannot deadlock.
  for v_item in
    select item from jsonb_array_elements(p_items) as item order by item ->> 'charge_id'
  loop
    select * into v_charge from public.technician_charges where id = (v_item ->> 'charge_id')::uuid for update;
    if v_charge.id is null then
      raise exception 'CHARGES: Algún cargo no se encontró';
    end if;
    if v_charge.company_id <> v_document.company_id or v_charge.personnel_id <> v_personnel_id then
      raise exception 'CHARGES: Todos los cargos tienen que ser del técnico del documento';
    end if;

    if v_charge.backing is null or v_charge.backing = 'none' then
      v_charge := public.technician_charge_take_backing(v_charge.id, v_backing, v_item ->> 'entered_as');
      v_converted := v_converted + 1;
    elsif v_charge.backing <> v_backing then
      raise exception 'CHARGES: El cargo del % tiene otro respaldo (%): el documento es una %',
        to_char(v_charge.charge_date, 'DD/MM/YYYY'), v_charge.backing, v_backing;
    end if;

    select coalesce(sum(l.cost_amount), 0) into v_applied
    from public.technician_charge_documents l
    where l.charge_id = v_charge.id;

    if jsonb_typeof(v_item -> 'amount') is distinct from 'number' then
      raise exception 'CHARGES: Cada cargo necesita un monto a aplicar';
    end if;
    v_amount := (v_item ->> 'amount')::numeric;
    if v_amount <= 0 or v_amount <> trunc(v_amount) then
      raise exception 'CHARGES: El monto a aplicar va en pesos enteros y mayor a cero';
    end if;
    if v_amount > v_charge.net_amount - v_applied then
      raise exception 'CHARGES: Al cargo del % le quedan % por cubrir y se quiere aplicar %',
        to_char(v_charge.charge_date, 'DD/MM/YYYY'), v_charge.net_amount - v_applied, v_amount;
    end if;

    insert into public.technician_charge_documents (company_id, charge_id, cost_document_id, cost_amount, created_by)
    values (v_document.company_id, v_charge.id, p_cost_document_id, v_amount, v_user_id);

    if v_applied + v_amount >= v_charge.net_amount then
      update public.technician_charges
      set document_status = 'recibida', updated_by = v_user_id
      where id = v_charge.id;
    end if;

    v_sum := v_sum + v_amount;
    v_count := v_count + 1;
  end loop;

  if abs(v_sum - v_document.net_amount) > v_count and not coalesce(p_accept_difference, false) then
    raise exception 'AMOUNT_MISMATCH: Los cargos suman % y el neto del documento es %: diferencia %',
      v_sum, v_document.net_amount, v_document.net_amount - v_sum;
  end if;

  v_allocated := v_document.classification <> 'general'
    or v_document.project_id is not null
    or exists (select 1 from public.cost_allocations ca where ca.cost_document_id = p_cost_document_id);
  if v_allocated and not coalesce(p_replace_allocations, false) then
    raise exception 'ALLOCATED: Este documento ya está asignado a un trabajo o repartido: confirmá que el vínculo reemplace esa asignación';
  end if;

  -- The assignment it had goes away (and a suggestion to services, unconfirmed):
  -- the charges carry the cost, each in its job and its month.
  delete from public.cost_service_allocations where cost_document_id = p_cost_document_id;
  delete from public.cost_allocations where cost_document_id = p_cost_document_id;
  if v_document.classification <> 'general' or v_document.project_id is not null then
    update public.cost_documents
    set classification = 'general', project_id = null, updated_by = v_user_id
    where id = p_cost_document_id;
  end if;

  -- Suggestions about this document or these charges are settled.
  delete from public.technician_document_suggestions s
  where s.cost_document_id = p_cost_document_id or s.charge_ids && v_ids;

  perform set_config('inma.technician_document_link', 'off', true);

  return jsonb_build_object(
    'cost_document_id', p_cost_document_id,
    'charges', v_count,
    'projects', (select count(distinct project_id) from public.technician_charges where id = any (v_ids)),
    'applied', v_sum,
    'difference', v_document.net_amount - v_sum,
    'converted', v_converted,
    'replaced_allocation', v_allocated
  );
end;
$$;

revoke execute on function public.apply_technician_document(uuid, jsonb, boolean, boolean) from public, anon;
grant execute on function public.apply_technician_document(uuid, jsonb, boolean, boolean) to authenticated, service_role;

-- Undoes a link: each charge is pending again unless other documents still
-- cover it whole (their costs never moved); the document is a general cost
-- again, unassigned, counted whole.
create or replace function public.unlink_technician_document(p_cost_document_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_ids uuid[];
begin
  if v_user_id is null then
    raise exception 'Authentication required to unlink a technician document';
  end if;

  select * into v_document from public.cost_documents where id = p_cost_document_id for update;
  if v_document.id is null then
    raise exception 'Documento no encontrado';
  end if;

  select array_agg(l.charge_id) into v_ids
  from public.technician_charge_documents l
  where l.cost_document_id = p_cost_document_id;
  if v_ids is null then
    raise exception 'Este documento no está vinculado a cargos de técnico';
  end if;

  perform set_config('inma.technician_document_link', 'on', true);

  delete from public.technician_charge_documents where cost_document_id = p_cost_document_id;

  update public.technician_charges tc
  set document_status = 'pendiente', updated_by = v_user_id
  where tc.id = any (v_ids)
    and coalesce((select sum(l.cost_amount) from public.technician_charge_documents l where l.charge_id = tc.id), 0) < tc.net_amount;

  perform set_config('inma.technician_document_link', 'off', true);

  return jsonb_build_object('cost_document_id', p_cost_document_id, 'charges', cardinality(v_ids));
end;
$$;

revoke execute on function public.unlink_technician_document(uuid) from public, anon;
grant execute on function public.unlink_technician_document(uuid) to authenticated, service_role;

-- update_backed_technician_charge: same as 20261028010000; a linked charge
-- keeps its amounts, and its status says whether it is fully covered.
create or replace function public.update_backed_technician_charge(
  p_charge_id uuid,
  p_description text,
  p_charge_date date,
  p_backing text,
  p_entered_as text,
  p_value numeric
)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_charge public.technician_charges;
  v_name text;
  v_amounts record;
  v_linked boolean;
  v_status text;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  v_charge := public.technician_charge_for_edit(p_charge_id);

  if v_charge.backing is null then
    raise exception 'Este cargo se cargó sin respaldo registrado: corregilo con el formulario anterior';
  end if;
  if p_charge_date is null then
    raise exception 'A charge date is required';
  end if;

  select * into v_amounts from public.technician_backing_amounts(p_backing, p_entered_as, p_value, p_charge_date);

  v_linked := exists (select 1 from public.technician_charge_documents l where l.charge_id = p_charge_id);
  if v_linked and (
    p_backing is distinct from v_charge.backing
    or v_amounts.payable <> v_charge.amount
    or v_amounts.cost <> v_charge.net_amount
  ) then
    raise exception 'Este cargo está vinculado a un documento: desvinculalo antes de cambiar el monto o el respaldo';
  end if;

  v_status := 'pendiente';
  if p_backing = 'none' then
    v_status := 'no_aplica';
  elsif v_linked then
    v_status := v_charge.document_status;
  end if;

  select name into v_name from public.personnel where id = v_charge.personnel_id;

  perform set_config('inma.technician_charge_edit', v_charge.cost_document_id::text, true);

  update public.cost_documents
  set document_date = p_charge_date,
      net_amount = v_amounts.cost,
      tax_amount = case when p_backing = 'boleta' then 0 else v_amounts.payable - v_amounts.cost end,
      total_amount = case when p_backing = 'boleta' then v_amounts.cost else v_amounts.payable end,
      updated_by = v_user_id
  where id = v_charge.cost_document_id;

  delete from public.cost_lines where cost_document_id = v_charge.cost_document_id;

  insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
  values (
    v_charge.cost_document_id,
    'Técnico: ' || v_name || coalesce(' — ' || v_description, ''),
    v_amounts.cost,
    v_user_id,
    v_user_id
  );

  update public.technician_charges
  set description = v_description,
      charge_date = p_charge_date,
      amount = v_amounts.payable,
      vat_included = p_backing = 'factura',
      vat_rate = v_amounts.vat_rate,
      net_amount = v_amounts.cost,
      backing = p_backing,
      entered_as = p_entered_as,
      withholding_rate = v_amounts.withholding_rate,
      document_status = v_status,
      updated_by = v_user_id
  where id = p_charge_id
  returning * into v_charge;

  perform set_config('inma.technician_charge_edit', '', true);

  -- A pending suggestion built on the old amounts no longer holds.
  delete from public.technician_document_suggestions s
  where s.status = 'pending' and p_charge_id = any (s.charge_ids);

  return v_charge;
end;
$$;

revoke execute on function public.update_backed_technician_charge(uuid, text, date, text, text, numeric) from public, anon;
grant execute on function public.update_backed_technician_charge(uuid, text, date, text, text, numeric) to authenticated, service_role;
