-- Técnicos (Chile): the cost of a linked charge counts in the month of the
-- CHARGE; the factura / boleta only backs it (docs/qa-tecnicos-2026-10-27.md,
-- 2026-10-28 change).
--
-- Until now link_technician_document deleted each charge's own cost document
-- and imputed the purchase document to the jobs, so the cost moved to the
-- document's month; a document covering charges of May and June had all of
-- it in its own month. A document has one recognized period and its
-- cost_allocations follow it, so neither can put each part in its charge's
-- month. The rule that already does that for recurring services is used
-- instead: a general document whose cost is carried elsewhere counts only
-- the rest (reporting.ts generalNet subtracts service_allocated_amount; the
-- service cost periods carry their part in their own month). Now:
--
--   * each charge KEEPS its own direct cost document (its job, its date, its
--     cost), linked or not -- linking never moves a cost;
--   * the purchase document stays a general cost with no assignment, and
--     technician_linked_amount(cost_documents) is what its linked charges
--     carry: reports count net_amount - service_allocated_amount -
--     technician_linked_amount (0, or the rounding the tolerance allowed);
--   * linking still removes an assignment the document had (asked first) and
--     still refuses one allocated to services; unlinking only removes the
--     links (the charges never lost their cost).
--
-- Links made with the previous rule (charge without its own document, the
-- document assigned to the jobs) are converted below: the charge gets its
-- own document back and the document loses the assignment the link made.
-- Dev and prod have none outside tests at the time of writing.
--
-- Idempotent: create or replace, and the conversion only touches rows of the
-- previous rule.

-- ---------------------------------------------------------------------
-- What the linked charges of a document carry
-- ---------------------------------------------------------------------
create or replace function public.technician_linked_amount(public.cost_documents)
returns numeric
language sql
stable
as $$
  select coalesce(sum(l.cost_amount), 0)
  from public.technician_charge_documents l
  where l.cost_document_id = $1.id;
$$;

revoke execute on function public.technician_linked_amount(public.cost_documents) from public, anon;
grant execute on function public.technician_linked_amount(public.cost_documents) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- technician_charges_guard: same as 20261026010000, the charge always with
-- its own cost document; with factura or boleta, the status is pendiente or
-- recibida (recibida exactly when linked, checked at commit below).
-- ---------------------------------------------------------------------
create or replace function public.technician_charges_guard()
returns trigger
language plpgsql
as $$
declare
  v_project_company_id uuid;
  v_personnel_company_id uuid;
  v_personnel_type text;
  v_document public.cost_documents;
  v_linking boolean := coalesce(current_setting('inma.technician_document_link', true), '') = 'on';
  v_edit_key text := coalesce(current_setting('inma.technician_charge_edit', true), '');
  v_editing boolean := false;
  v_expected_total numeric;
begin
  if tg_op = 'UPDATE' then
    v_editing := v_edit_key <> ''
      and (v_edit_key = coalesce(old.cost_document_id::text, '') or v_edit_key = 'charge:' || old.id::text);

    if new.company_id is distinct from old.company_id
      or new.project_id is distinct from old.project_id
      or new.personnel_id is distinct from old.personnel_id
      or new.cost_document_id is distinct from old.cost_document_id
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by
    then
      raise exception 'A technician charge cannot change its company, job, technician or cost document';
    end if;

    if not v_editing and (
      new.description is distinct from old.description
      or new.charge_date is distinct from old.charge_date
      or new.amount is distinct from old.amount
      or new.vat_included is distinct from old.vat_included
      or new.vat_rate is distinct from old.vat_rate
      or new.net_amount is distinct from old.net_amount
      or new.backing is distinct from old.backing
      or new.entered_as is distinct from old.entered_as
      or new.withholding_rate is distinct from old.withholding_rate
    ) then
      raise exception 'A technician charge can only have its document status changed; use update_technician_charge to correct it';
    end if;

    if new.document_status is distinct from old.document_status
      and new.backing is not null and not v_linking and not v_editing then
      raise exception 'El documento de un cargo con respaldo se marca vinculando la factura o boleta';
    end if;
  end if;

  select company_id into v_project_company_id from public.projects where id = new.project_id;
  if v_project_company_id is null or v_project_company_id <> new.company_id then
    raise exception 'project_id must belong to the same company as the technician charge';
  end if;

  select company_id, type into v_personnel_company_id, v_personnel_type
  from public.personnel
  where id = new.personnel_id;
  if v_personnel_company_id is null or v_personnel_company_id <> new.company_id then
    raise exception 'personnel_id must belong to the same company as the technician charge';
  end if;
  if v_personnel_type <> 'contractor' then
    raise exception 'Only external technicians can have technician charges';
  end if;

  if new.backing is not null and not public.company_is_chile(new.company_id) then
    raise exception 'El respaldo de los cargos se registra solo en empresas de Chile';
  end if;

  if new.backing = 'none' then
    if new.document_status <> 'no_aplica' then
      raise exception 'A charge without backing has no document (no_aplica)';
    end if;
  elsif new.document_status not in ('pendiente', 'recibida') then
    raise exception 'The document status must be pendiente or recibida';
  end if;

  if new.cost_document_id is null then
    raise exception 'A technician charge needs its own cost document';
  end if;

  -- Its own cost: a direct cost of its job at its cost. The total of the
  -- document is what is paid, except for a boleta (gross, like an imported boleta).
  v_expected_total := new.amount;
  if new.backing = 'boleta' then
    v_expected_total := new.net_amount;
  end if;

  select * into v_document from public.cost_documents where id = new.cost_document_id;
  if not found
    or v_document.company_id <> new.company_id
    or v_document.project_id is distinct from new.project_id
    or v_document.classification <> 'direct'
    or v_document.net_amount <> new.net_amount
    or v_document.total_amount <> v_expected_total
  then
    raise exception 'The technician charge does not match its cost document';
  end if;

  return new;
end;
$$;

-- At commit: a charge with factura or boleta has its document received
-- exactly when it is linked; one without backing (or Uruguay) is never linked.
create or replace function public.technician_charges_check_cost_source()
returns trigger
language plpgsql
as $$
declare
  v_charge_id uuid;
  v_charge public.technician_charges;
  v_linked boolean;
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

  v_linked := exists (select 1 from public.technician_charge_documents l where l.charge_id = v_charge_id);

  if v_linked and (v_charge.backing is null or v_charge.backing = 'none') then
    raise exception 'Only a charge with factura or boleta can have a linked document';
  end if;
  if v_charge.backing in ('factura', 'boleta') and (v_charge.document_status = 'recibida') <> v_linked then
    raise exception 'A charge with factura or boleta has its document received exactly when it is linked';
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- link_technician_document: same checks as 20261027010000; the charges keep
-- their own costs and the document becomes their backing.
-- ---------------------------------------------------------------------
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
    if exists (select 1 from public.technician_charge_documents l where l.charge_id = v_charge.id) then
      raise exception 'CHARGES: El cargo del % ya está vinculado a otro documento', to_char(v_charge.charge_date, 'DD/MM/YYYY');
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

  -- The assignment it had goes away (and a suggestion to services, unconfirmed):
  -- the charges carry the cost, each in its job and its month.
  delete from public.cost_service_allocations where cost_document_id = p_cost_document_id;
  delete from public.cost_allocations where cost_document_id = p_cost_document_id;
  if v_document.classification <> 'general' or v_document.project_id is not null then
    update public.cost_documents
    set classification = 'general', project_id = null, updated_by = v_user_id
    where id = p_cost_document_id;
  end if;

  for v_charge in
    select * from public.technician_charges where id = any (p_charge_ids) order by id
  loop
    insert into public.technician_charge_documents (company_id, charge_id, cost_document_id, cost_amount, created_by)
    values (v_document.company_id, v_charge.id, p_cost_document_id, v_charge.net_amount, v_user_id);

    update public.technician_charges
    set document_status = 'recibida', updated_by = v_user_id
    where id = v_charge.id;
  end loop;

  -- Suggestions about this document or these charges are settled.
  delete from public.technician_document_suggestions s
  where s.cost_document_id = p_cost_document_id or s.charge_ids && p_charge_ids;

  perform set_config('inma.technician_document_link', 'off', true);

  return jsonb_build_object(
    'cost_document_id', p_cost_document_id,
    'charges', v_count,
    'projects', (select count(distinct project_id) from public.technician_charges where id = any (p_charge_ids)),
    'replaced_allocation', v_allocated
  );
end;
$$;

revoke execute on function public.link_technician_document(uuid, uuid[], boolean) from public, anon;
grant execute on function public.link_technician_document(uuid, uuid[], boolean) to authenticated, service_role;

-- Undoes a link: the charges go back to "pendiente" (their costs never moved)
-- and the document is a general cost again, unassigned, counted whole.
create or replace function public.unlink_technician_document(p_cost_document_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required to unlink a technician document';
  end if;

  select * into v_document from public.cost_documents where id = p_cost_document_id for update;
  if v_document.id is null then
    raise exception 'Documento no encontrado';
  end if;

  if not exists (select 1 from public.technician_charge_documents l where l.cost_document_id = p_cost_document_id) then
    raise exception 'Este documento no está vinculado a cargos de técnico';
  end if;

  perform set_config('inma.technician_document_link', 'on', true);

  update public.technician_charges tc
  set document_status = 'pendiente', updated_by = v_user_id
  where tc.id in (select l.charge_id from public.technician_charge_documents l where l.cost_document_id = p_cost_document_id);
  get diagnostics v_count = row_count;

  delete from public.technician_charge_documents where cost_document_id = p_cost_document_id;

  perform set_config('inma.technician_document_link', 'off', true);

  return jsonb_build_object('cost_document_id', p_cost_document_id, 'charges', v_count);
end;
$$;

revoke execute on function public.unlink_technician_document(uuid) from public, anon;
grant execute on function public.unlink_technician_document(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- update_backed_technician_charge: same as 20261026010000, the charge always
-- with its own cost (so a new date moves its cost to that month, linked or
-- not). A linked charge keeps its amounts and backing (unlink first).
-- ---------------------------------------------------------------------
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
    v_status := 'recibida';
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

-- delete_technician_charge: same as 20261026010000, a linked charge is
-- recognized by its link (it keeps its own cost document now).
create or replace function public.delete_technician_charge(p_charge_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_charge public.technician_charges;
begin
  v_charge := public.technician_charge_for_edit(p_charge_id);

  if exists (select 1 from public.technician_charge_documents l where l.charge_id = p_charge_id) then
    raise exception 'Este cargo está vinculado a un documento: desvinculalo antes de eliminarlo';
  end if;

  if exists (
    select 1
    from public.cost_allocations ca
    where ca.cost_document_id = v_charge.cost_document_id
  ) then
    raise exception 'The cost of this charge has been split across jobs: undo that first';
  end if;

  delete from public.technician_document_suggestions s where p_charge_id = any (s.charge_ids);
  delete from public.technician_charges where id = p_charge_id;
  delete from public.cost_lines where cost_document_id = v_charge.cost_document_id;
  delete from public.cost_documents where id = v_charge.cost_document_id;
end;
$$;

-- update_technician_charge (charges without a recorded backing): same as
-- 20261026010000 without the linked check (those charges are never linked).
create or replace function public.update_technician_charge(
  p_charge_id uuid,
  p_description text,
  p_charge_date date,
  p_amount numeric,
  p_vat_included boolean,
  p_vat_rate numeric
)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_charge public.technician_charges;
  v_currency text;
  v_name text;
  v_net numeric;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  v_charge := public.technician_charge_for_edit(p_charge_id);

  if v_charge.backing is not null then
    raise exception 'Este cargo tiene respaldo (factura, boleta o sin respaldo): corregilo con update_backed_technician_charge';
  end if;

  if p_charge_date is null then
    raise exception 'A charge date is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'The charge amount must be greater than zero';
  end if;
  if p_vat_included is null then
    raise exception 'Say whether the amount includes IVA';
  end if;
  if p_vat_rate is null or p_vat_rate < 0 or p_vat_rate >= 1 then
    raise exception 'The IVA rate must be between 0 and 1';
  end if;

  select currency into v_currency from public.cost_documents where id = v_charge.cost_document_id;
  select name into v_name from public.personnel where id = v_charge.personnel_id;

  v_net := public.technician_charge_net(p_amount, p_vat_included, p_vat_rate, v_currency);
  if v_net <= 0 then
    raise exception 'The charge amount is too small';
  end if;

  perform set_config('inma.technician_charge_edit', v_charge.cost_document_id::text, true);

  update public.cost_documents
  set document_date = p_charge_date,
      net_amount = v_net,
      tax_amount = p_amount - v_net,
      total_amount = p_amount,
      updated_by = v_user_id
  where id = v_charge.cost_document_id;

  delete from public.cost_lines where cost_document_id = v_charge.cost_document_id;

  insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
  values (
    v_charge.cost_document_id,
    'Técnico: ' || v_name || coalesce(' — ' || v_description, ''),
    v_net,
    v_user_id,
    v_user_id
  );

  update public.technician_charges
  set description = v_description,
      charge_date = p_charge_date,
      amount = p_amount,
      vat_included = p_vat_included,
      vat_rate = p_vat_rate,
      net_amount = v_net,
      updated_by = v_user_id
  where id = p_charge_id
  returning * into v_charge;

  perform set_config('inma.technician_charge_edit', '', true);

  return v_charge;
end;
$$;

-- ---------------------------------------------------------------------
-- Conversion of links made with the previous rule
-- ---------------------------------------------------------------------
-- The guard refuses a new cost_document_id on purpose; it is off only while
-- each such charge gets its own document back (same amounts as the charge).
alter table public.technician_charges disable trigger technician_charges_guard;
alter table public.technician_charges disable trigger technician_charges_set_updated_at;

do $$
declare
  v_charge record;
  v_document_id uuid;
  v_converted int := 0;
begin
  perform set_config('inma.technician_document_link', 'on', true);

  for v_charge in
    select tc.*, p.name as personnel_name, cd.currency as document_currency
    from public.technician_charges tc
    join public.personnel p on p.id = tc.personnel_id
    join public.technician_charge_documents l on l.charge_id = tc.id
    join public.cost_documents cd on cd.id = l.cost_document_id
    where tc.cost_document_id is null
  loop
    insert into public.cost_documents (
      company_id, supplier_id, project_id, classification, category, document_date, currency,
      net_amount, tax_amount, total_amount, created_by, updated_by
    ) values (
      v_charge.company_id, null, v_charge.project_id, 'direct', 'labor', v_charge.charge_date, v_charge.document_currency,
      v_charge.net_amount,
      case when v_charge.backing = 'boleta' then 0 else v_charge.amount - v_charge.net_amount end,
      case when v_charge.backing = 'boleta' then v_charge.net_amount else v_charge.amount end,
      v_charge.created_by, v_charge.created_by
    )
    returning id into v_document_id;

    insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
    values (
      v_document_id,
      'Técnico: ' || v_charge.personnel_name || coalesce(' — ' || v_charge.description, ''),
      v_charge.net_amount,
      v_charge.created_by,
      v_charge.created_by
    );

    update public.technician_charges set cost_document_id = v_document_id where id = v_charge.id;
    v_converted := v_converted + 1;
  end loop;

  -- The documents of those links lose the assignment the link made.
  delete from public.cost_allocations ca
  using public.technician_charge_documents l
  where l.cost_document_id = ca.cost_document_id;

  update public.cost_documents cd
  set classification = 'general', project_id = null
  where cd.id in (select l.cost_document_id from public.technician_charge_documents l)
    and (cd.classification <> 'general' or cd.project_id is not null);

  perform set_config('inma.technician_document_link', 'off', true);
  raise notice 'Technician links of the previous rule converted: % charges', v_converted;
end;
$$;

-- Run the deferred checks of those updates now (an ALTER TABLE cannot run
-- with trigger events pending), with the new rule.
set constraints public.technician_charges_cost_source, public.technician_charge_documents_cost_source immediate;

alter table public.technician_charges enable trigger technician_charges_set_updated_at;
alter table public.technician_charges enable trigger technician_charges_guard;

-- Every charge has its own cost document again, always.
alter table public.technician_charges alter column cost_document_id set not null;

comment on column public.technician_charges.cost_document_id is
  'The charge''s own direct cost document: the cost of its job, in the month of the charge. A linked purchase document only backs it (technician_linked_amount).';
