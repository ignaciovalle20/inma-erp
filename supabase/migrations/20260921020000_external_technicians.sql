-- F1 (docs/plan-sistema-v3.md): external technicians ("técnicos externos")
--
-- INMA pays freelance technicians per job, not a monthly salary, so they do
-- not fit `personnel_costs` (one amount per person per month) nor
-- `work_allocations` (a slice of that monthly amount). They get their own
-- model:
--
--   * `personnel.type` gains 'contractor', plus the data the ficha needs
--     (tax id, the document they issue, usual rates, payment details).
--   * `technician_charges`: what a technician charges for ONE job. Each charge
--     creates a linked direct cost document (`cost_document_id`), so every
--     report keeps reading `cost_documents` and none of them changes: the
--     charge is a direct cost of its job, at its net amount (IVA is not a
--     cost when the technician's document includes it).
--   * `technician_payments` + `technician_payment_applications`: a payment
--     ("abono") can cover several charges of the same technician. The balance
--     ("saldo") is  sum(charges) - sum(applications).
--
-- Corrections: cost documents are immutable (see
-- cost_documents_protect_financial_fields), so a charge loaded wrong cannot be
-- fixed with a plain UPDATE. `update_technician_charge` and
-- `delete_technician_charge` are the ONLY security definer functions here, on
-- purpose: they must touch rows the caller has no policy for (cost_lines has no
-- UPDATE/DELETE policy, cost_documents no DELETE policy). Each one checks
-- auth.uid() and company membership itself, refuses when the charge already has
-- a payment applied, and opens a narrow exception in the protect trigger for
-- exactly that one cost document. Everything else is invoker, like the rest of
-- the codebase: the caller's own RLS grant applies.
--
-- Payments cannot be edited: delete the payment and record it again.
--
-- Additive: no existing row or function changes behaviour, except the protect
-- trigger, which only gains the exception described above.

-- ---------------------------------------------------------------------
-- personnel: the 'contractor' type and the technician's ficha
-- ---------------------------------------------------------------------
alter table public.personnel drop constraint if exists personnel_type_check;

alter table public.personnel
  add constraint personnel_type_check check (type in ('employee', 'partner', 'contractor'));

alter table public.personnel
  add column tax_id text,
  add column payment_document text check (payment_document in ('boleta_honorarios', 'factura')),
  add column default_rates jsonb not null default '{}'::jsonb,
  add column payment_details text,
  add constraint personnel_default_rates_object_check check (jsonb_typeof(default_rates) = 'object');

-- A contractor has no monthly cost record: their money is in charges.
create or replace function public.personnel_costs_reject_contractors()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.personnel p
    where p.id = new.personnel_id
      and p.type = 'contractor'
  ) then
    raise exception 'External technicians have no monthly cost: load their charges per job instead';
  end if;

  return new;
end;
$$;

create trigger personnel_costs_reject_contractors
  before insert or update of personnel_id on public.personnel_costs
  for each row
  execute function public.personnel_costs_reject_contractors();

-- ---------------------------------------------------------------------
-- technician_charges
-- ---------------------------------------------------------------------
-- amount:       what the technician charges for the job (what INMA owes).
-- vat_included: the amount already includes IVA. Then the cost of the job is
--               the net (amount / (1 + rate)) and the IVA is not a cost;
--               otherwise the whole amount is the cost and there is no IVA.
-- vat_rate:     the rate used, kept on the row (0.19 Chile, 0.22 Uruguay) so a
--               later rate change never rewrites history.
-- net_amount:   the cost of the job, computed in the database.
create table public.technician_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  project_id uuid not null references public.projects (id),
  personnel_id uuid not null references public.personnel (id),
  cost_document_id uuid not null unique references public.cost_documents (id),
  description text,
  charge_date date not null,
  amount numeric not null check (amount > 0),
  vat_included boolean not null,
  vat_rate numeric not null check (vat_rate >= 0 and vat_rate < 1),
  net_amount numeric not null check (net_amount > 0),
  document_status text not null default 'pendiente' check (document_status in ('pendiente', 'recibida')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  constraint technician_charges_net_within_amount_check check (net_amount <= amount)
);

create index technician_charges_company_id_idx on public.technician_charges (company_id);
create index technician_charges_project_id_idx on public.technician_charges (project_id);
create index technician_charges_personnel_id_idx on public.technician_charges (personnel_id);

create trigger technician_charges_set_updated_at
  before update on public.technician_charges
  for each row
  execute function public.set_updated_at();

alter table public.technician_charges enable row level security;

create policy "Members can view their company's technician charges"
  on public.technician_charges
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_charges.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create technician charges for their company"
  on public.technician_charges
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_charges.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Only document_status can change through this policy (the guard trigger below
-- enforces it); editing and deleting go through the two definer RPCs.
create policy "Members can update their company's technician charges"
  on public.technician_charges
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_charges.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_charges.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Cross-company validation plus consistency with the linked cost document, so
-- a charge can never disagree with the cost that reports read.
create or replace function public.technician_charges_guard()
returns trigger
language plpgsql
as $$
declare
  v_project_company_id uuid;
  v_personnel_company_id uuid;
  v_personnel_type text;
  v_document public.cost_documents;
  v_editing boolean :=
    coalesce(current_setting('inma.technician_charge_edit', true), '') = new.cost_document_id::text;
begin
  if tg_op = 'UPDATE' then
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
    ) then
      raise exception 'A technician charge can only have its document status changed; use update_technician_charge to correct it';
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

  select * into v_document from public.cost_documents where id = new.cost_document_id;
  if not found
    or v_document.company_id <> new.company_id
    or v_document.project_id is distinct from new.project_id
    or v_document.classification <> 'direct'
    or v_document.net_amount <> new.net_amount
    or v_document.total_amount <> new.amount
  then
    raise exception 'The technician charge does not match its cost document';
  end if;

  return new;
end;
$$;

create trigger technician_charges_guard
  before insert or update on public.technician_charges
  for each row
  execute function public.technician_charges_guard();

-- Now that technician_charges exists: a person with charges stays a contractor,
-- and a person with monthly costs cannot become one.
create or replace function public.personnel_guard_contractor_type()
returns trigger
language plpgsql
as $$
begin
  if new.type = 'contractor'
    and exists (select 1 from public.personnel_costs where personnel_id = new.id)
  then
    raise exception 'This person already has monthly costs: it cannot become an external technician';
  end if;

  if old.type = 'contractor'
    and exists (select 1 from public.technician_charges where personnel_id = new.id)
  then
    raise exception 'This technician already has charges: its type cannot change';
  end if;

  return new;
end;
$$;

create trigger personnel_guard_contractor_type
  before update of type on public.personnel
  for each row
  when (old.type is distinct from new.type)
  execute function public.personnel_guard_contractor_type();

-- ---------------------------------------------------------------------
-- technician_payments / technician_payment_applications
-- ---------------------------------------------------------------------
create table public.technician_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  personnel_id uuid not null references public.personnel (id),
  payment_date date not null,
  amount numeric not null check (amount > 0),
  method text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);

create index technician_payments_company_id_idx on public.technician_payments (company_id);
create index technician_payments_personnel_id_idx on public.technician_payments (personnel_id);

create table public.technician_payment_applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  payment_id uuid not null references public.technician_payments (id) on delete cascade,
  charge_id uuid not null references public.technician_charges (id),
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  unique (payment_id, charge_id)
);

create index technician_payment_applications_company_id_idx
  on public.technician_payment_applications (company_id);
create index technician_payment_applications_charge_id_idx
  on public.technician_payment_applications (charge_id);

alter table public.technician_payments enable row level security;
alter table public.technician_payment_applications enable row level security;

create policy "Members can view their company's technician payments"
  on public.technician_payments
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_payments.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create technician payments for their company"
  on public.technician_payments
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_payments.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Deleting a payment cascades to its applications (referential actions bypass
-- row security), which is why the applications table has no DELETE policy: an
-- application can only disappear together with its payment.
create policy "Members can delete their company's technician payments"
  on public.technician_payments
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_payments.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can view their company's technician payment applications"
  on public.technician_payment_applications
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_payment_applications.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create technician payment applications for their company"
  on public.technician_payment_applications
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = technician_payment_applications.company_id
        and cm.user_id = auth.uid()
    )
  );

create or replace function public.technician_payments_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  v_personnel_company_id uuid;
  v_personnel_type text;
begin
  select company_id, type into v_personnel_company_id, v_personnel_type
  from public.personnel
  where id = new.personnel_id;

  if v_personnel_company_id is null or v_personnel_company_id <> new.company_id then
    raise exception 'personnel_id must belong to the same company as the technician payment';
  end if;
  if v_personnel_type <> 'contractor' then
    raise exception 'Only external technicians can receive technician payments';
  end if;

  return new;
end;
$$;

create trigger technician_payments_validate_company_refs
  before insert on public.technician_payments
  for each row
  execute function public.technician_payments_validate_company_refs();

-- An application must join a payment and a charge of the SAME technician and
-- company, and can never push a charge past what it is worth. The charge row is
-- locked first, so two payments hitting the same charge at once are serialized
-- and the second one sees the first one's applications.
create or replace function public.technician_payment_applications_guard()
returns trigger
language plpgsql
as $$
declare
  v_payment public.technician_payments;
  v_charge public.technician_charges;
  v_applied numeric;
begin
  select * into v_charge from public.technician_charges where id = new.charge_id for update;
  select * into v_payment from public.technician_payments where id = new.payment_id;

  if v_charge.id is null or v_payment.id is null then
    raise exception 'The payment or the charge was not found';
  end if;

  if v_charge.company_id <> new.company_id or v_payment.company_id <> new.company_id then
    raise exception 'A payment application must belong to the same company as its payment and charge';
  end if;

  if v_charge.personnel_id <> v_payment.personnel_id then
    raise exception 'A payment can only be applied to charges of the same technician';
  end if;

  select coalesce(sum(amount), 0) into v_applied
  from public.technician_payment_applications
  where charge_id = new.charge_id;

  if v_applied + new.amount > v_charge.amount then
    raise exception 'The payment applied to a charge (%) cannot exceed its amount (%)',
      v_applied + new.amount, v_charge.amount;
  end if;

  return new;
end;
$$;

create trigger technician_payment_applications_guard
  before insert on public.technician_payment_applications
  for each row
  execute function public.technician_payment_applications_guard();

-- A payment must be fully applied: at commit, its applications add up to its
-- amount. Deferred, because the payment is inserted before its applications.
create or replace function public.technician_payment_check_balanced()
returns trigger
language plpgsql
as $$
declare
  v_payment_id uuid;
  v_amount numeric;
  v_applied numeric;
begin
  -- Separate statements on purpose: a CASE naming both new.id and
  -- new.payment_id fails on whichever table lacks the column.
  if tg_table_name = 'technician_payments' then
    v_payment_id := new.id;
  else
    v_payment_id := new.payment_id;
  end if;

  select amount into v_amount from public.technician_payments where id = v_payment_id;
  if not found then
    return null;
  end if;

  select coalesce(sum(amount), 0) into v_applied
  from public.technician_payment_applications
  where payment_id = v_payment_id;

  if v_applied <> v_amount then
    raise exception 'The applications of a payment (%) must add up to its amount (%)', v_applied, v_amount;
  end if;

  return null;
end;
$$;

create constraint trigger technician_payments_balanced
  after insert on public.technician_payments
  deferrable initially deferred
  for each row
  execute function public.technician_payment_check_balanced();

create constraint trigger technician_payment_applications_balanced
  after insert on public.technician_payment_applications
  deferrable initially deferred
  for each row
  execute function public.technician_payment_check_balanced();

-- ---------------------------------------------------------------------
-- cost_documents: the one narrow exception to immutability
-- ---------------------------------------------------------------------
-- Same trigger as 20260915050000, plus: the financial fields of a cost
-- document may change when update_technician_charge has opened the exception
-- for exactly that document (a transaction-local setting holding its id) and
-- the document really is the cost of a technician charge.
create or replace function public.cost_documents_protect_financial_fields()
returns trigger
language plpgsql
as $$
declare
  v_confirming_provisional boolean := (old.status = 'provisional' and new.status = 'confirmed');
  v_editing_technician_charge boolean :=
    coalesce(current_setting('inma.technician_charge_edit', true), '') = old.id::text
    and exists (
      select 1
      from public.technician_charges tc
      where tc.cost_document_id = old.id
    );
begin
  if new.company_id is distinct from old.company_id
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by
  then
    raise exception 'cost documents can never have their company or creation record changed';
  end if;

  if not v_confirming_provisional and not v_editing_technician_charge and (
    new.supplier_id is distinct from old.supplier_id
    or new.document_date is distinct from old.document_date
    or new.currency is distinct from old.currency
    or new.net_amount is distinct from old.net_amount
    or new.tax_amount is distinct from old.tax_amount
    or new.total_amount is distinct from old.total_amount
  ) then
    raise exception 'cost documents can only have their recognized period, trabajo assignment, or a provisional amount confirmed -- not these financial fields otherwise';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Helpers and RPCs
-- ---------------------------------------------------------------------
-- The cost of a charge. Same formula as web/src/lib/technicians.ts (chargeCost):
-- net = amount / (1 + rate) when the amount includes IVA, else the amount;
-- whole units in CLP (no fractional pesos), cents elsewhere.
create or replace function public.technician_charge_net(
  p_amount numeric,
  p_vat_included boolean,
  p_vat_rate numeric,
  p_currency text
)
returns numeric
language sql
immutable
as $$
  select case
    when p_vat_included then round(p_amount / (1 + p_vat_rate), case when p_currency = 'CLP' then 0 else 2 end)
    else p_amount
  end;
$$;

revoke execute on function public.technician_charge_net(numeric, boolean, numeric, text) from public;
grant execute on function public.technician_charge_net(numeric, boolean, numeric, text) to authenticated;

-- Loads a charge and makes sure the caller belongs to its company. Used by the
-- two definer RPCs, so a non-member gets the same answer as a missing charge.
create or replace function public.technician_charge_for_edit(p_charge_id uuid)
returns public.technician_charges
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_charge public.technician_charges;
begin
  if v_user_id is null then
    raise exception 'Authentication required to change a technician charge';
  end if;

  select company_id into v_company_id from public.technician_charges where id = p_charge_id;

  if v_company_id is null
    or not exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = v_company_id
        and cm.user_id = v_user_id
    )
  then
    raise exception 'Technician charge not found';
  end if;

  -- Lock it: a payment application locks the same row first, so either the
  -- payment lands before this check (and blocks the change) or after it.
  select * into v_charge from public.technician_charges where id = p_charge_id for update;

  if exists (
    select 1
    from public.technician_payment_applications a
    where a.charge_id = p_charge_id
  ) then
    raise exception 'This charge already has payments applied: delete those payments first';
  end if;

  return v_charge;
end;
$$;

-- Internal helper of the two definer RPCs below: not callable through the API.
revoke execute on function public.technician_charge_for_edit(uuid) from public, anon, authenticated;

create or replace function public.create_technician_charge(
  p_project_id uuid,
  p_personnel_id uuid,
  p_description text,
  p_charge_date date,
  p_amount numeric,
  p_vat_included boolean,
  p_vat_rate numeric
)
returns public.technician_charges
language plpgsql
as $$
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
    charge_date, amount, vat_included, vat_rate, net_amount, created_by, updated_by
  )
  values (
    v_company_id, p_project_id, p_personnel_id, v_document.id, v_description,
    p_charge_date, p_amount, p_vat_included, p_vat_rate, v_net, v_user_id, v_user_id
  )
  returning * into v_charge;

  return v_charge;
end;
$$;

revoke execute on function public.create_technician_charge(uuid, uuid, text, date, numeric, boolean, numeric) from public;
grant execute on function public.create_technician_charge(uuid, uuid, text, date, numeric, boolean, numeric) to authenticated;

create or replace function public.set_technician_charge_document(
  p_charge_id uuid,
  p_document_status text
)
returns public.technician_charges
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_charge public.technician_charges;
begin
  if v_user_id is null then
    raise exception 'Authentication required to change a technician charge';
  end if;

  if p_document_status is null or p_document_status not in ('pendiente', 'recibida') then
    raise exception 'The document status must be pendiente or recibida';
  end if;

  update public.technician_charges
  set document_status = p_document_status, updated_by = v_user_id
  where id = p_charge_id
  returning * into v_charge;

  if v_charge.id is null then
    raise exception 'Technician charge not found';
  end if;

  return v_charge;
end;
$$;

revoke execute on function public.set_technician_charge_document(uuid, text) from public;
grant execute on function public.set_technician_charge_document(uuid, text) to authenticated;

-- SECURITY DEFINER: corrects a charge loaded wrong. Rewrites the linked cost
-- document and its line. Only while the charge has no payment applied.
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

revoke execute on function public.update_technician_charge(uuid, text, date, numeric, boolean, numeric) from public;
grant execute on function public.update_technician_charge(uuid, text, date, numeric, boolean, numeric) to authenticated;

-- SECURITY DEFINER: deletes a charge together with its cost document. Only
-- while the charge has no payment applied.
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

  if exists (
    select 1
    from public.cost_allocations ca
    where ca.cost_document_id = v_charge.cost_document_id
  ) then
    raise exception 'The cost of this charge has been split across jobs: undo that first';
  end if;

  delete from public.technician_charges where id = p_charge_id;
  delete from public.cost_lines where cost_document_id = v_charge.cost_document_id;
  delete from public.cost_documents where id = v_charge.cost_document_id;
end;
$$;

revoke execute on function public.delete_technician_charge(uuid) from public;
grant execute on function public.delete_technician_charge(uuid) to authenticated;

-- p_applications: [{ "charge_id": uuid, "amount": number }, ...], adding up to
-- p_amount. The guard triggers do the cross-row checks.
create or replace function public.record_technician_payment(
  p_personnel_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_method text,
  p_notes text,
  p_applications jsonb
)
returns public.technician_payments
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_payment public.technician_payments;
  v_application jsonb;
  v_applied numeric := 0;
  v_charge_ids uuid[] := '{}';
  v_charge_id uuid;
  v_application_amount numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required to record a technician payment';
  end if;

  if p_payment_date is null then
    raise exception 'A payment date is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'The payment amount must be greater than zero';
  end if;
  if p_applications is null or jsonb_typeof(p_applications) <> 'array' or jsonb_array_length(p_applications) = 0 then
    raise exception 'A payment must be applied to at least one charge';
  end if;

  select company_id into v_company_id from public.personnel where id = p_personnel_id;
  if v_company_id is null then
    raise exception 'Technician not found';
  end if;

  for v_application in select * from jsonb_array_elements(p_applications)
  loop
    if jsonb_typeof(v_application -> 'amount') is distinct from 'number' then
      raise exception 'Each application needs a numeric amount';
    end if;

    v_application_amount := (v_application ->> 'amount')::numeric;
    if v_application_amount <= 0 then
      raise exception 'Each application amount must be greater than zero';
    end if;

    v_charge_id := (v_application ->> 'charge_id')::uuid;
    if v_charge_id is null then
      raise exception 'Each application needs a charge_id';
    end if;
    if v_charge_id = any (v_charge_ids) then
      raise exception 'A charge can appear only once in a payment';
    end if;

    v_charge_ids := v_charge_ids || v_charge_id;
    v_applied := v_applied + v_application_amount;
  end loop;

  if v_applied <> p_amount then
    raise exception 'The applications (%) must add up to the payment amount (%)', v_applied, p_amount;
  end if;

  insert into public.technician_payments (company_id, personnel_id, payment_date, amount, method, notes, created_by)
  values (
    v_company_id,
    p_personnel_id,
    p_payment_date,
    p_amount,
    nullif(btrim(coalesce(p_method, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_user_id
  )
  returning * into v_payment;

  -- In id order, so two payments over the same charges lock them in the same
  -- order and cannot deadlock.
  for v_application in
    select t.elem
    from jsonb_array_elements(p_applications) as t (elem)
    order by (t.elem ->> 'charge_id')::uuid
  loop
    insert into public.technician_payment_applications (company_id, payment_id, charge_id, amount, created_by)
    values (
      v_company_id,
      v_payment.id,
      (v_application ->> 'charge_id')::uuid,
      (v_application ->> 'amount')::numeric,
      v_user_id
    );
  end loop;

  return v_payment;
end;
$$;

revoke execute on function public.record_technician_payment(uuid, date, numeric, text, text, jsonb) from public;
grant execute on function public.record_technician_payment(uuid, date, numeric, text, text, jsonb) to authenticated;

create or replace function public.delete_technician_payment(p_payment_id uuid)
returns void
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required to delete a technician payment';
  end if;

  delete from public.technician_payments where id = p_payment_id returning id into v_deleted;

  if v_deleted is null then
    raise exception 'Technician payment not found';
  end if;
end;
$$;

revoke execute on function public.delete_technician_payment(uuid) from public;
grant execute on function public.delete_technician_payment(uuid) to authenticated;
