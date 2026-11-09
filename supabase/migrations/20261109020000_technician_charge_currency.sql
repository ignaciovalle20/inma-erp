-- Currency of a technician charge (2026-11-09).
--
-- Until now a charge had no currency: it was always the company's, and so was
-- its own cost document (create_technician_charge). A Uruguayan job billed in
-- USD could only carry its technicians in UYU. Now:
--
-- 1. technician_charges.currency (not null, CLP/UYU/USD), filled with the
--    company's currency for every existing charge (every existing charge's
--    cost document is in it). When an insert does not say it, it is the
--    company's (technician_charges_guard), so Chile's create_backed_* and any
--    older caller keep working unchanged.
-- 2. technician_charges_guard: the currency must be one of the company's
--    (company_document_currencies: Chile CLP only, Uruguay USD/UYU), equal to
--    the currency of the charge's own cost document, and it only changes
--    through the edit RPC.
-- 3. create_technician_charge, create_unbacked_technician_charge and
--    update_uruguay_technician_charge take p_currency (default null = the
--    company's, or the charge's own on an update). Each old signature is
--    replaced by the new one, so calls with the old named or positional
--    arguments still resolve. The cost document is created / corrected in
--    the charge's currency, so reports convert it like any other document.
--
-- Additive: one column, replaced functions. Re-runnable.

-- ---------------------------------------------------------------------
-- 1. technician_charges.currency
-- ---------------------------------------------------------------------
alter table public.technician_charges add column if not exists currency text;

-- A plain backfill: no trigger may rewrite updated_at/updated_by or re-check
-- the rows (the column is new; nothing else changes).
alter table public.technician_charges disable trigger user;
update public.technician_charges t
set currency = c.currency
from public.companies c
where c.id = t.company_id and t.currency is null;
alter table public.technician_charges enable trigger user;

alter table public.technician_charges alter column currency set not null;

alter table public.technician_charges drop constraint if exists technician_charges_currency_check;
alter table public.technician_charges add constraint technician_charges_currency_check
  check (currency in ('CLP', 'UYU', 'USD'));

comment on column public.technician_charges.currency is
  'Currency of the charge (amount, net_amount, what is paid) and of its own cost document. One of the company''s currencies (company_document_currencies); the company''s when not given.';

-- ---------------------------------------------------------------------
-- 2. technician_charges_guard (same as 20261108020000, plus the currency)
-- ---------------------------------------------------------------------
create or replace function public.technician_charges_guard()
returns trigger
language plpgsql
as $function$
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
  -- Not given: the company's currency (every caller before 20261109020000).
  if new.currency is null then
    select currency into new.currency from public.companies where id = new.company_id;
  end if;

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
      or new.currency is distinct from old.currency
    ) then
      raise exception 'A technician charge can only have its document status changed; use update_technician_charge to correct it';
    end if;

    if new.document_status is distinct from old.document_status
      and new.backing is not null and not v_linking and not v_editing then
      raise exception 'El documento de un cargo con respaldo se marca vinculando la factura o boleta';
    end if;
  end if;

  if not (new.currency = any (coalesce(public.company_document_currencies(new.company_id), array[]::text[]))) then
    raise exception 'La moneda % no es una de las de la empresa', new.currency;
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

  -- Factura and boleta de honorarios are Chile's; "sin respaldo" exists in
  -- every company (fix-math 2026-11: Uruguay too).
  if new.backing in ('factura', 'boleta') and not public.company_is_chile(new.company_id) then
    raise exception 'El respaldo con factura o boleta de los cargos se registra solo en empresas de Chile';
  end if;

  if new.backing = 'none' then
    if new.document_status <> 'no_aplica' then
      raise exception 'A charge without backing has no document (no_aplica)';
    end if;
    if new.vat_included or new.amount <> new.net_amount then
      raise exception 'Un cargo sin respaldo es exactamente lo pagado, sin IVA';
    end if;
  elsif new.document_status not in ('pendiente', 'recibida') then
    raise exception 'The document status must be pendiente or recibida';
  end if;

  if new.cost_document_id is null then
    raise exception 'A technician charge needs its own cost document';
  end if;

  -- Its own cost: a direct cost of its job at its cost, in its currency. The
  -- total of the document is what is paid, except for a boleta (gross, like
  -- an imported boleta).
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
    or v_document.currency <> new.currency
  then
    raise exception 'The technician charge does not match its cost document';
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- 3. The Uruguay RPCs take p_currency
-- ---------------------------------------------------------------------

-- create_technician_charge: same as 20260921020000, the currency given or the company's.
drop function if exists public.create_technician_charge(uuid, uuid, text, date, numeric, boolean, numeric);

create or replace function public.create_technician_charge(
  p_project_id uuid,
  p_personnel_id uuid,
  p_description text,
  p_charge_date date,
  p_amount numeric,
  p_vat_included boolean,
  p_vat_rate numeric,
  p_currency text default null
)
returns public.technician_charges
language plpgsql
as $function$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_currency text;
  v_name text;
  v_personnel_company_id uuid;
  v_personnel_type text;
  v_net numeric;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_document public.cost_documents;
  v_charge public.technician_charges;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a technician charge';
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

  select p.company_id, c.currency into v_company_id, v_currency
  from public.projects p
  join public.companies c on c.id = p.company_id
  where p.id = p_project_id;

  if v_company_id is null then
    raise exception 'Project not found';
  end if;

  v_currency := coalesce(nullif(btrim(coalesce(p_currency, '')), ''), v_currency);
  if not (v_currency = any (coalesce(public.company_document_currencies(v_company_id), array[]::text[]))) then
    raise exception 'La moneda % no es una de las de la empresa', v_currency;
  end if;

  select company_id, type, name into v_personnel_company_id, v_personnel_type, v_name
  from public.personnel
  where id = p_personnel_id;

  if v_personnel_company_id is null or v_personnel_company_id <> v_company_id then
    raise exception 'Technician not found';
  end if;
  if v_personnel_type <> 'contractor' then
    raise exception 'Only external technicians can have technician charges';
  end if;

  v_net := public.technician_charge_net(p_amount, p_vat_included, p_vat_rate, v_currency);
  if v_net <= 0 then
    raise exception 'The charge amount is too small';
  end if;

  -- The cost of the job: a direct, confirmed cost document at the net amount.
  v_document := public.create_cost_document(
    v_company_id,
    null,
    p_project_id,
    'direct',
    p_charge_date,
    v_currency,
    p_amount - v_net,
    jsonb_build_array(
      jsonb_build_object(
        'description', 'Técnico: ' || v_name || coalesce(' — ' || v_description, ''),
        'amount', v_net
      )
    )
  );

  update public.cost_documents
  set category = 'labor', updated_by = v_user_id
  where id = v_document.id;

  insert into public.technician_charges (
    company_id, project_id, personnel_id, cost_document_id, description,
    charge_date, amount, vat_included, vat_rate, net_amount, currency, created_by, updated_by
  )
  values (
    v_company_id, p_project_id, p_personnel_id, v_document.id, v_description,
    p_charge_date, p_amount, p_vat_included, p_vat_rate, v_net, v_currency, v_user_id, v_user_id
  )
  returning * into v_charge;

  return v_charge;
end;
$function$;

revoke execute on function public.create_technician_charge(uuid, uuid, text, date, numeric, boolean, numeric, text) from public, anon;
grant execute on function public.create_technician_charge(uuid, uuid, text, date, numeric, boolean, numeric, text) to authenticated, service_role;

-- create_unbacked_technician_charge: same as 20261108020000, passing the currency.
drop function if exists public.create_unbacked_technician_charge(uuid, uuid, text, date, numeric);

create or replace function public.create_unbacked_technician_charge(
  p_project_id uuid,
  p_personnel_id uuid,
  p_description text,
  p_charge_date date,
  p_amount numeric,
  p_currency text default null
)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_company_id uuid;
  v_charge public.technician_charges;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required to create a technician charge';
  end if;

  select company_id into v_company_id from public.projects where id = p_project_id;
  if v_company_id is null or not public.is_company_member(v_company_id) then
    raise exception 'Project not found';
  end if;
  if public.company_is_chile(v_company_id) then
    raise exception 'En Chile el cargo sin respaldo se registra con create_backed_technician_charge';
  end if;

  v_charge := public.create_technician_charge(p_project_id, p_personnel_id, p_description, p_charge_date, p_amount, false, 0, p_currency);

  perform set_config('inma.technician_charge_edit', 'charge:' || v_charge.id::text, true);
  update public.technician_charges
  set backing = 'none', entered_as = 'amount', document_status = 'no_aplica'
  where id = v_charge.id
  returning * into v_charge;
  perform set_config('inma.technician_charge_edit', '', true);

  return v_charge;
end;
$function$;

revoke execute on function public.create_unbacked_technician_charge(uuid, uuid, text, date, numeric, text) from public, anon;
grant execute on function public.create_unbacked_technician_charge(uuid, uuid, text, date, numeric, text) to authenticated, service_role;

-- update_uruguay_technician_charge: same as 20261108020000; p_currency (null =
-- keep the charge's) moves the charge and its cost document together.
drop function if exists public.update_uruguay_technician_charge(uuid, text, date, numeric, boolean, boolean);

create or replace function public.update_uruguay_technician_charge(
  p_charge_id uuid,
  p_description text,
  p_charge_date date,
  p_amount numeric,
  p_vat_included boolean,
  p_unbacked boolean,
  p_currency text default null
)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user_id uuid := auth.uid();
  v_charge public.technician_charges;
  v_currency text;
  v_name text;
  v_net numeric;
  v_vat_included boolean := coalesce(p_vat_included, false) and not coalesce(p_unbacked, false);
  v_vat_rate numeric;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  v_charge := public.technician_charge_for_edit(p_charge_id);

  if public.company_is_chile(v_charge.company_id) then
    raise exception 'En Chile el cargo se corrige con update_backed_technician_charge';
  end if;
  if p_charge_date is null then
    raise exception 'A charge date is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'The charge amount must be greater than zero';
  end if;

  -- The rate the charge was loaded with (an unbacked one was created with 0):
  -- a later rate change never rewrites an old charge; Uruguay's 22 % otherwise.
  v_vat_rate := coalesce(nullif(v_charge.vat_rate, 0), 0.22);

  v_currency := coalesce(nullif(btrim(coalesce(p_currency, '')), ''), v_charge.currency);
  if not (v_currency = any (coalesce(public.company_document_currencies(v_charge.company_id), array[]::text[]))) then
    raise exception 'La moneda % no es una de las de la empresa', v_currency;
  end if;
  select name into v_name from public.personnel where id = v_charge.personnel_id;

  v_net := public.technician_charge_net(p_amount, v_vat_included, v_vat_rate, v_currency);
  if v_net <= 0 then
    raise exception 'The charge amount is too small';
  end if;

  perform set_config('inma.technician_charge_edit', v_charge.cost_document_id::text, true);

  update public.cost_documents
  set document_date = p_charge_date,
      currency = v_currency,
      net_amount = v_net,
      tax_amount = p_amount - v_net,
      total_amount = p_amount,
      updated_by = v_user_id
  where id = v_charge.cost_document_id;

  delete from public.cost_lines where cost_document_id = v_charge.cost_document_id;
  insert into public.cost_lines (cost_document_id, description, amount, created_by, updated_by)
  values (v_charge.cost_document_id, 'Técnico: ' || v_name || coalesce(' — ' || v_description, ''), v_net, v_user_id, v_user_id);

  update public.technician_charges
  set description = v_description,
      charge_date = p_charge_date,
      amount = p_amount,
      vat_included = v_vat_included,
      vat_rate = v_vat_rate,
      net_amount = v_net,
      currency = v_currency,
      backing = case when coalesce(p_unbacked, false) then 'none' end,
      entered_as = case when coalesce(p_unbacked, false) then 'amount' end,
      document_status = case
        when coalesce(p_unbacked, false) then 'no_aplica'
        when v_charge.document_status = 'no_aplica' then 'pendiente'
        else v_charge.document_status
      end,
      updated_by = v_user_id
  where id = p_charge_id
  returning * into v_charge;

  perform set_config('inma.technician_charge_edit', '', true);

  return v_charge;
end;
$function$;

revoke execute on function public.update_uruguay_technician_charge(uuid, text, date, numeric, boolean, boolean, text) from public, anon;
grant execute on function public.update_uruguay_technician_charge(uuid, text, date, numeric, boolean, boolean, text) to authenticated, service_role;
