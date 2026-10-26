-- Técnicos externos, Chile: the backing of each charge (factura / boleta de
-- honorarios / sin respaldo) and the link between a charge and the purchase
-- document that backs it (docs/plan-sistema-v3.md, F1;
-- docs/tecnicos-respaldo-documentos-2026-10-26.md).
--
-- The problem: create_technician_charge creates the charge's own direct cost
-- document. When the technician's factura or boleta is later imported from
-- Nubox it lands as one more general cost, and assigning it to the job counts
-- the same work twice. From now on, in Chilean companies, charge and document
-- are one cost:
--
--   * The charge keeps what it is for the cuenta corriente: what INMA owes
--     the technician (`amount`, "a pagar") and what was paid on it.
--   * The cost of the job is `net_amount`. While no document is linked it is
--     carried by the charge's own direct cost document, as before.
--   * Linking the document (link_technician_document) deletes the charge's
--     own cost document and imputes the purchase document to the charges'
--     jobs by each charge's cost: one job -> a direct cost of that job; several
--     -> fixed-amount cost_allocations. Unlinking restores both sides.
--
-- What changes:
--   * personnel.default_backing ("Respaldo habitual"): factura / boleta /
--     none. It only pre-fills each new charge. payment_document stays for
--     Uruguay, whose technicians work exactly as before.
--   * technician_suppliers: the RUTs (suppliers) of a technician. A technician
--     may have several (personal RUT for boletas, company RUT for facturas); a
--     supplier belongs to one technician at most. Backfilled by RUT, and a
--     supplier created later with a technician's RUT is linked by itself.
--   * technician_charges: backing, entered_as, withholding_rate; document
--     status 'no_aplica' for charges without backing; cost_document_id
--     nullable (null while a purchase document is linked). net_amount <=
--     amount does not hold for boletas (the cost is the gross, what is paid
--     is the net of retención), so the check depends on the backing.
--   * boleta_withholding_rates: the retención of a boleta de honorarios by
--     year (2025 14,5 %, 2026 15,25 %, 2027 16 %, 2028 onwards 17 %).
--   * technician_charge_documents: charge <-> purchase document. One document
--     covers one or more charges of the same technician; a charge is linked to
--     one document at most.
--   * technician_document_suggestions: proposed links (Conciliar), never
--     applied on their own.
--   * Guards: while a document is linked, nothing else may assign it to a
--     job, split it or allocate it to services, and a linked charge cannot
--     change its amounts or be deleted. delete_cost_document unlinks first.
--
-- Uruguay (and any company that is not Chilean): backing stays null on every
-- charge and nothing here applies; create_technician_charge and
-- update_technician_charge keep working as before for them.
--
-- Existing charges of Chilean companies take the backing of their
-- technician's usual one, and keep their amounts (no amount is recomputed).
-- Their document status is aligned with the new rule: 'no_aplica' without
-- backing; 'pendiente' with factura or boleta, since no document is linked yet
-- (a charge marked "recibida" by hand was never tied to a document: linking it
-- is what avoids the duplicate cost).
--
-- Every new RPC is invoker: the caller's own RLS grants apply, plus the
-- guard triggers. The two flags they set (inma.technician_document_link,
-- inma.technician_charge_edit) are transaction-local and cannot be set
-- through the API.

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- A RUT without dots, hyphen or spaces, check digit in upper case:
-- "12.345.678-k" -> "12345678K". Null when nothing is left.
create or replace function public.normalize_tax_id(p_tax_id text)
returns text
language sql
immutable
as $$
  select nullif(upper(regexp_replace(coalesce(p_tax_id, ''), '[^0-9A-Za-z]', '', 'g')), '');
$$;

create or replace function public.company_is_chile(p_company_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce((
    select upper(btrim(coalesce(c.country, ''))) in ('CL', 'CHILE')
    from public.companies c
    where c.id = p_company_id
  ), false);
$$;

-- ---------------------------------------------------------------------
-- boleta_withholding_rates: retención of a boleta de honorarios by year
-- ---------------------------------------------------------------------
create table public.boleta_withholding_rates (
  year integer primary key check (year between 2000 and 2100),
  rate numeric not null check (rate > 0 and rate < 1)
);

comment on table public.boleta_withholding_rates is
  'Retención of a boleta de honorarios by year (Chile). A year without a row uses the latest earlier one.';

insert into public.boleta_withholding_rates (year, rate) values
  (2025, 0.145),
  (2026, 0.1525),
  (2027, 0.16),
  (2028, 0.17);

alter table public.boleta_withholding_rates enable row level security;

create policy "Signed-in users can read the boleta withholding rates"
  on public.boleta_withholding_rates
  for select
  to authenticated
  using (true);

grant select on public.boleta_withholding_rates to authenticated, service_role;

create or replace function public.boleta_withholding_rate(p_date date)
returns numeric
language plpgsql
stable
as $$
declare
  v_rate numeric;
begin
  select r.rate into v_rate
  from public.boleta_withholding_rates r
  where r.year <= extract(year from p_date)::integer
  order by r.year desc
  limit 1;

  if v_rate is null then
    raise exception 'No hay tasa de retención de boleta para el año %', extract(year from p_date)::integer;
  end if;

  return v_rate;
end;
$$;

-- The amounts of a charge with backing, from what was typed (CLP, whole pesos).
-- Same formulas as web/src/lib/technicians.ts (backedChargeAmounts):
--   none:    one amount, cost = what is paid.
--   factura: net -> IVA = round(net * 19 %), total = net + IVA;
--            total -> net = round(total / 1.19). Cost = net, a pagar = total.
--   boleta:  líquido -> bruto = round(líquido / (1 - tasa));
--            bruto -> retención = round(bruto * tasa), líquido = bruto - retención.
--            Cost = bruto, a pagar = líquido. The retención is the SII's,
--            declared by INMA: shown, never owed to the technician.
create or replace function public.technician_backing_amounts(
  p_backing text,
  p_entered_as text,
  p_value numeric,
  p_charge_date date,
  out payable numeric,
  out cost numeric,
  out vat_rate numeric,
  out withholding_rate numeric
)
language plpgsql
stable
as $$
begin
  if p_value is null or p_value <= 0 then
    raise exception 'El monto tiene que ser mayor a cero';
  end if;
  if p_value <> trunc(p_value) then
    raise exception 'El monto va en pesos enteros';
  end if;
  if p_charge_date is null then
    raise exception 'A charge date is required';
  end if;

  vat_rate := 0;
  withholding_rate := null;

  if p_backing = 'none' then
    if p_entered_as is distinct from 'amount' then
      raise exception 'Un cargo sin respaldo se ingresa con un solo monto';
    end if;
    payable := p_value;
    cost := p_value;
  elsif p_backing = 'factura' then
    vat_rate := 0.19;
    if p_entered_as = 'net' then
      cost := p_value;
      payable := p_value + round(p_value * vat_rate);
    elsif p_entered_as = 'total' then
      payable := p_value;
      cost := round(p_value / (1 + vat_rate));
    else
      raise exception 'Una factura se ingresa por neto o por total con IVA';
    end if;
  elsif p_backing = 'boleta' then
    withholding_rate := public.boleta_withholding_rate(p_charge_date);
    if p_entered_as = 'liquid' then
      payable := p_value;
      cost := round(p_value / (1 - withholding_rate));
    elsif p_entered_as = 'gross' then
      cost := p_value;
      payable := p_value - round(p_value * withholding_rate);
    else
      raise exception 'Una boleta se ingresa por líquido o por bruto';
    end if;
  else
    raise exception 'Respaldo inválido: %', coalesce(p_backing, 'vacío');
  end if;

  if cost <= 0 or payable <= 0 then
    raise exception 'The charge amount is too small';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- personnel.default_backing ("Respaldo habitual")
-- ---------------------------------------------------------------------
alter table public.personnel
  add column default_backing text not null default 'none'
    check (default_backing in ('factura', 'boleta', 'none'));

comment on column public.personnel.default_backing is
  'Chile: the usual backing of an external technician''s charges (factura, boleta, none); pre-fills each new charge.';

alter table public.personnel disable trigger personnel_set_updated_at;

update public.personnel
set default_backing = case payment_document
  when 'factura' then 'factura'
  when 'boleta_honorarios' then 'boleta'
  else 'none'
end
where payment_document is not null;

alter table public.personnel enable trigger personnel_set_updated_at;

-- ---------------------------------------------------------------------
-- technician_suppliers: the RUTs of a technician
-- ---------------------------------------------------------------------
create table public.technician_suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  personnel_id uuid not null references public.personnel (id) on delete cascade,
  supplier_id uuid not null unique references public.suppliers (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);

create index technician_suppliers_company_id_idx on public.technician_suppliers (company_id);
create index technician_suppliers_personnel_id_idx on public.technician_suppliers (personnel_id);

alter table public.technician_suppliers enable row level security;

create policy "Members can view their company's technician suppliers"
  on public.technician_suppliers
  for select
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_suppliers.company_id and cm.user_id = auth.uid()
    )
  );

create policy "Members can link suppliers to their company's technicians"
  on public.technician_suppliers
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_suppliers.company_id and cm.user_id = auth.uid()
    )
  );

create policy "Members can unlink suppliers from their company's technicians"
  on public.technician_suppliers
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_suppliers.company_id and cm.user_id = auth.uid()
    )
  );

grant select, insert, delete on public.technician_suppliers to authenticated, service_role;

create or replace function public.technician_suppliers_guard()
returns trigger
language plpgsql
as $$
declare
  v_personnel public.personnel;
  v_supplier_company_id uuid;
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from public.technician_charge_documents l
      join public.cost_documents cd on cd.id = l.cost_document_id
      where cd.supplier_id = old.supplier_id
    ) then
      raise exception 'Hay documentos de este proveedor vinculados a cargos del técnico: desvinculalos antes de quitar el RUT';
    end if;
    return old;
  end if;

  select * into v_personnel from public.personnel where id = new.personnel_id;
  select company_id into v_supplier_company_id from public.suppliers where id = new.supplier_id;

  if v_personnel.id is null or v_personnel.company_id <> new.company_id
    or v_supplier_company_id is distinct from new.company_id then
    raise exception 'The technician and the supplier must belong to the same company';
  end if;
  if v_personnel.type <> 'contractor' then
    raise exception 'Only external technicians have linked suppliers';
  end if;
  if not public.company_is_chile(new.company_id) then
    raise exception 'Los RUT de técnicos se vinculan solo en empresas de Chile';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- technician_charges: backing, entered_as, withholding_rate, no_aplica
-- ---------------------------------------------------------------------
alter table public.technician_charges
  alter column cost_document_id drop not null,
  add column backing text check (backing in ('factura', 'boleta', 'none')),
  add column entered_as text check (entered_as in ('amount', 'net', 'total', 'liquid', 'gross')),
  add column withholding_rate numeric check (withholding_rate > 0 and withholding_rate < 1),
  drop constraint technician_charges_net_within_amount_check,
  drop constraint technician_charges_document_status_check,
  add constraint technician_charges_document_status_check
    check (document_status in ('pendiente', 'recibida', 'no_aplica')),
  -- Boleta: the cost (bruto) is at least what is paid (líquido). Otherwise
  -- the cost is at most what is paid (the IVA of a factura is not a cost).
  add constraint technician_charges_backing_amounts_check check (
    (backing = 'boleta' and net_amount >= amount)
    or (backing is distinct from 'boleta' and net_amount <= amount)
  ),
  add constraint technician_charges_withholding_only_boleta_check
    check (withholding_rate is null or backing = 'boleta');

comment on column public.technician_charges.amount is
  'What INMA owes the technician for this job ("a pagar"): total with IVA for a factura, líquido for a boleta.';
comment on column public.technician_charges.net_amount is
  'The cost of the job: the net of a factura, the gross (bruto) of a boleta.';
comment on column public.technician_charges.backing is
  'Chile: factura, boleta or none ("sin respaldo"). Null in companies that do not record it (Uruguay) and in charges created by the previous form.';
comment on column public.technician_charges.entered_as is
  'How the amount was typed: amount (sin respaldo), net / total (factura), liquid / gross (boleta).';
comment on column public.technician_charges.withholding_rate is
  'Boleta: the retención rate of the charge''s year (boleta_withholding_rates).';
comment on column public.technician_charges.cost_document_id is
  'The charge''s own direct cost document; null while a purchase document is linked (technician_charge_documents).';

-- Backfill (no amount changes): Chilean charges take their technician's usual
-- backing. A boleta has no IVA, so a charge loaded "con IVA incluido" by a
-- technician whose usual document is the boleta is a factura (its cost is
-- below what is paid, which a boleta can never be).
alter table public.technician_charges disable trigger technician_charges_guard;
alter table public.technician_charges disable trigger technician_charges_set_updated_at;

create temporary table technician_charge_backfill on commit drop as
select
  tc.id,
  tc.document_status as old_status,
  case
    when p.default_backing = 'boleta' and tc.net_amount < tc.amount then 'factura'
    else p.default_backing
  end as backing
from public.technician_charges tc
join public.personnel p on p.id = tc.personnel_id
where public.company_is_chile(tc.company_id);

do $$
declare
  v_none int;
  v_backed int;
  v_reset int;
  v_boleta_with_vat int;
begin
  select count(*) filter (where b.backing = 'none'),
         count(*) filter (where b.backing <> 'none'),
         count(*) filter (where b.backing <> 'none' and b.old_status = 'recibida'),
         count(*) filter (where b.backing = 'factura' and p.default_backing = 'boleta')
  into v_none, v_backed, v_reset, v_boleta_with_vat
  from technician_charge_backfill b
  join public.technician_charges tc on tc.id = b.id
  join public.personnel p on p.id = tc.personnel_id;

  raise notice 'Technician charges (Chile): % without backing (no_aplica), % with factura/boleta (pendiente; % were marked recibida by hand; % boleta technicians'' charges with IVA taken as factura)',
    v_none, v_backed, v_reset, v_boleta_with_vat;
end;
$$;

update public.technician_charges tc
set backing = b.backing,
    document_status = case when b.backing = 'none' then 'no_aplica' else 'pendiente' end
from technician_charge_backfill b
where b.id = tc.id;

alter table public.technician_charges enable trigger technician_charges_set_updated_at;
alter table public.technician_charges enable trigger technician_charges_guard;

-- ---------------------------------------------------------------------
-- technician_charge_documents: charge <-> purchase document
-- ---------------------------------------------------------------------
create table public.technician_charge_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  charge_id uuid not null unique references public.technician_charges (id),
  cost_document_id uuid not null references public.cost_documents (id),
  -- The charge's cost when it was linked: what the document imputes to its job.
  cost_amount numeric not null check (cost_amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);

create index technician_charge_documents_company_id_idx on public.technician_charge_documents (company_id);
create index technician_charge_documents_cost_document_id_idx on public.technician_charge_documents (cost_document_id);

alter table public.technician_charge_documents enable row level security;

create policy "Members can view their company's technician charge documents"
  on public.technician_charge_documents
  for select
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_charge_documents.company_id and cm.user_id = auth.uid()
    )
  );

create policy "Members can link technician charge documents for their company"
  on public.technician_charge_documents
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_charge_documents.company_id and cm.user_id = auth.uid()
    )
  );

create policy "Members can unlink their company's technician charge documents"
  on public.technician_charge_documents
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_charge_documents.company_id and cm.user_id = auth.uid()
    )
  );

grant select, insert, delete on public.technician_charge_documents to authenticated, service_role;

-- Links are written only by link_technician_document / unlink_technician_document,
-- which also move the cost: a bare insert or delete would count it twice or lose it.
create or replace function public.technician_charge_documents_guard()
returns trigger
language plpgsql
as $$
declare
  v_charge public.technician_charges;
  v_document public.cost_documents;
begin
  if coalesce(current_setting('inma.technician_document_link', true), '') <> 'on' then
    raise exception 'Use link_technician_document / unlink_technician_document to link or unlink a technician document';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  select * into v_charge from public.technician_charges where id = new.charge_id;
  select * into v_document from public.cost_documents where id = new.cost_document_id;
  if v_charge.id is null or v_document.id is null
    or v_charge.company_id <> new.company_id or v_document.company_id <> new.company_id then
    raise exception 'A charge and its document must belong to the same company';
  end if;

  return new;
end;
$$;

create trigger technician_charge_documents_guard
  before insert or delete on public.technician_charge_documents
  for each row
  execute function public.technician_charge_documents_guard();

create trigger technician_suppliers_guard
  before insert or update or delete on public.technician_suppliers
  for each row
  execute function public.technician_suppliers_guard();

-- Backfill: the suppliers whose RUT is a Chilean technician's RUT (a supplier
-- matching two technicians is left alone: it can only belong to one).
insert into public.technician_suppliers (company_id, personnel_id, supplier_id, created_by)
select s.company_id, min(p.id::text)::uuid, s.id, null
from public.suppliers s
join public.personnel p
  on p.company_id = s.company_id
  and p.type = 'contractor'
  and public.normalize_tax_id(p.tax_id) = public.normalize_tax_id(s.tax_id)
where public.normalize_tax_id(s.tax_id) is not null
  and public.company_is_chile(s.company_id)
group by s.company_id, s.id
having count(distinct p.id) = 1;

-- A supplier created with a technician's RUT (the purchases import, the
-- suppliers screen) is linked to that technician by itself: same RUT as the
-- technician's own, or as another supplier already linked to them.
create or replace function public.suppliers_link_technician()
returns trigger
language plpgsql
as $$
declare
  v_tax_id text := public.normalize_tax_id(new.tax_id);
  v_candidates uuid[];
begin
  if v_tax_id is null or not public.company_is_chile(new.company_id) then
    return null;
  end if;

  select array_agg(distinct candidate) into v_candidates
  from (
    select p.id as candidate
    from public.personnel p
    where p.company_id = new.company_id
      and p.type = 'contractor'
      and public.normalize_tax_id(p.tax_id) = v_tax_id
    union
    select ts.personnel_id
    from public.technician_suppliers ts
    join public.suppliers s on s.id = ts.supplier_id
    where ts.company_id = new.company_id
      and s.id <> new.id
      and public.normalize_tax_id(s.tax_id) = v_tax_id
  ) found;

  if cardinality(v_candidates) = 1 then
    insert into public.technician_suppliers (company_id, personnel_id, supplier_id)
    values (new.company_id, v_candidates[1], new.id)
    on conflict (supplier_id) do nothing;
  end if;

  return null;
end;
$$;

create trigger suppliers_link_technician
  after insert on public.suppliers
  for each row
  execute function public.suppliers_link_technician();

-- ---------------------------------------------------------------------
-- technician_document_suggestions (Conciliar)
-- ---------------------------------------------------------------------
create table public.technician_document_suggestions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  cost_document_id uuid not null unique references public.cost_documents (id) on delete cascade,
  personnel_id uuid not null references public.personnel (id) on delete cascade,
  charge_ids uuid[] not null check (cardinality(charge_ids) > 0),
  -- dismissed: "Descartar"; the document is not suggested again.
  status text not null default 'pending' check (status in ('pending', 'dismissed')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);

create index technician_document_suggestions_company_id_idx on public.technician_document_suggestions (company_id);

alter table public.technician_document_suggestions enable row level security;

create policy "Members can view their company's technician document suggestions"
  on public.technician_document_suggestions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_document_suggestions.company_id and cm.user_id = auth.uid()
    )
  );

create policy "Members can create technician document suggestions for their company"
  on public.technician_document_suggestions
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_document_suggestions.company_id and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's technician document suggestions"
  on public.technician_document_suggestions
  for update
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_document_suggestions.company_id and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_document_suggestions.company_id and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete their company's technician document suggestions"
  on public.technician_document_suggestions
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = technician_document_suggestions.company_id and cm.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.technician_document_suggestions to authenticated, service_role;

create or replace function public.technician_document_suggestions_guard()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.cost_documents cd
    where cd.id = new.cost_document_id and cd.company_id = new.company_id
  ) or not exists (
    select 1 from public.personnel p
    where p.id = new.personnel_id and p.company_id = new.company_id
  ) then
    raise exception 'A suggestion must belong to the same company as its document and technician';
  end if;
  return new;
end;
$$;

create trigger technician_document_suggestions_guard
  before insert or update on public.technician_document_suggestions
  for each row
  execute function public.technician_document_suggestions_guard();

-- ---------------------------------------------------------------------
-- technician_charges_guard: same as 20260921020000, plus backing, the
-- linked document and the edit exception for a linked charge.
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
      or new.created_at is distinct from old.created_at
      or new.created_by is distinct from old.created_by
    then
      raise exception 'A technician charge cannot change its company, job, technician or cost document';
    end if;

    if new.cost_document_id is distinct from old.cost_document_id and not v_linking then
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

  -- The document status follows the backing: none -> no_aplica; factura or
  -- boleta -> recibida exactly when a document is linked.
  if new.backing is null and new.document_status not in ('pendiente', 'recibida') then
    raise exception 'The document status must be pendiente or recibida';
  end if;
  if new.backing = 'none' and new.document_status <> 'no_aplica' then
    raise exception 'A charge without backing has no document (no_aplica)';
  end if;
  if new.backing in ('factura', 'boleta') then
    if new.cost_document_id is null and new.document_status <> 'recibida' then
      raise exception 'A charge with a linked document has its document received';
    end if;
    if new.cost_document_id is not null and new.document_status <> 'pendiente' then
      raise exception 'A charge without a linked document has its document pending';
    end if;
  end if;

  if new.cost_document_id is not null then
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
  elsif new.backing is null or new.backing = 'none' then
    raise exception 'Only a charge with factura or boleta can have its cost in a linked document';
  end if;

  return new;
end;
$$;

-- At commit, every charge has exactly one cost: its own document or a link.
create or replace function public.technician_charges_check_cost_source()
returns trigger
language plpgsql
as $$
declare
  v_charge_id uuid;
  v_own uuid;
  v_found boolean;
  v_linked boolean;
begin
  if tg_table_name = 'technician_charges' then
    v_charge_id := new.id;
  elsif tg_op = 'DELETE' then
    v_charge_id := old.charge_id;
  else
    v_charge_id := new.charge_id;
  end if;

  select cost_document_id, true into v_own, v_found from public.technician_charges where id = v_charge_id;
  if not coalesce(v_found, false) then
    return null;
  end if;

  v_linked := exists (select 1 from public.technician_charge_documents l where l.charge_id = v_charge_id);
  if (v_own is not null) = v_linked then
    raise exception 'A technician charge must have exactly one cost: its own cost document or a linked document';
  end if;

  return null;
end;
$$;

create constraint trigger technician_charges_cost_source
  after insert or update on public.technician_charges
  deferrable initially deferred
  for each row
  execute function public.technician_charges_check_cost_source();

create constraint trigger technician_charge_documents_cost_source
  after insert or delete on public.technician_charge_documents
  deferrable initially deferred
  for each row
  execute function public.technician_charges_check_cost_source();

-- ---------------------------------------------------------------------
-- A linked document: no other assignment while the link exists
-- ---------------------------------------------------------------------
create or replace function public.cost_documents_guard_technician_link()
returns trigger
language plpgsql
as $$
begin
  if (new.classification is distinct from old.classification or new.project_id is distinct from old.project_id)
    and coalesce(current_setting('inma.technician_document_link', true), '') <> 'on'
    and exists (select 1 from public.technician_charge_documents l where l.cost_document_id = old.id)
  then
    raise exception 'Vinculada a cargos de técnico — desvinculá para cambiar';
  end if;
  return new;
end;
$$;

create trigger cost_documents_guard_technician_link
  before update of classification, project_id on public.cost_documents
  for each row
  execute function public.cost_documents_guard_technician_link();

create or replace function public.cost_allocations_guard_technician_link()
returns trigger
language plpgsql
as $$
declare
  v_document_id uuid := case when tg_op = 'DELETE' then old.cost_document_id else new.cost_document_id end;
begin
  if coalesce(current_setting('inma.technician_document_link', true), '') <> 'on'
    and exists (select 1 from public.technician_charge_documents l where l.cost_document_id = v_document_id)
  then
    raise exception 'Vinculada a cargos de técnico — desvinculá para cambiar';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger cost_allocations_guard_technician_link
  before insert or update or delete on public.cost_allocations
  for each row
  execute function public.cost_allocations_guard_technician_link();

create or replace function public.cost_service_allocations_guard_technician_link()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.technician_charge_documents l where l.cost_document_id = new.cost_document_id) then
    raise exception 'Vinculada a cargos de técnico — desvinculá para cambiar';
  end if;
  return new;
end;
$$;

create trigger cost_service_allocations_guard_technician_link
  before insert or update on public.cost_service_allocations
  for each row
  execute function public.cost_service_allocations_guard_technician_link();

-- ---------------------------------------------------------------------
-- Charges with backing: create and correct
-- ---------------------------------------------------------------------
create or replace function public.create_backed_technician_charge(
  p_project_id uuid,
  p_personnel_id uuid,
  p_description text,
  p_charge_date date,
  p_backing text,
  p_entered_as text,
  p_value numeric
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
  v_amounts record;
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

  select p.company_id, c.currency into v_company_id, v_currency
  from public.projects p
  join public.companies c on c.id = p.company_id
  where p.id = p_project_id;

  if v_company_id is null then
    raise exception 'Project not found';
  end if;
  if not public.company_is_chile(v_company_id) then
    raise exception 'El respaldo de los cargos se registra solo en empresas de Chile';
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

  select * into v_amounts from public.technician_backing_amounts(p_backing, p_entered_as, p_value, p_charge_date);

  -- The cost of the job: a direct, confirmed cost document at the cost.
  v_document := public.create_cost_document(
    v_company_id,
    null,
    p_project_id,
    'direct',
    p_charge_date,
    v_currency,
    case when p_backing = 'boleta' then 0 else v_amounts.payable - v_amounts.cost end,
    jsonb_build_array(
      jsonb_build_object(
        'description', 'Técnico: ' || v_name || coalesce(' — ' || v_description, ''),
        'amount', v_amounts.cost
      )
    )
  );

  update public.cost_documents
  set category = 'labor', updated_by = v_user_id
  where id = v_document.id;

  insert into public.technician_charges (
    company_id, project_id, personnel_id, cost_document_id, description, charge_date,
    amount, vat_included, vat_rate, net_amount, document_status,
    backing, entered_as, withholding_rate, created_by, updated_by
  )
  values (
    v_company_id, p_project_id, p_personnel_id, v_document.id, v_description, p_charge_date,
    v_amounts.payable, p_backing = 'factura', v_amounts.vat_rate, v_amounts.cost,
    case when p_backing = 'none' then 'no_aplica' else 'pendiente' end,
    p_backing, p_entered_as, v_amounts.withholding_rate, v_user_id, v_user_id
  )
  returning * into v_charge;

  return v_charge;
end;
$$;

revoke execute on function public.create_backed_technician_charge(uuid, uuid, text, date, text, text, numeric) from public, anon;
grant execute on function public.create_backed_technician_charge(uuid, uuid, text, date, text, text, numeric) to authenticated, service_role;

-- SECURITY DEFINER, like update_technician_charge: rewrites the charge's own
-- cost document and its line (no member policy updates cost_lines). Only while
-- the charge has no payment applied. A linked charge keeps its amounts and
-- backing (unlink first); its description and date can still be corrected.
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
  v_currency text;
  v_name text;
  v_amounts record;
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

  if v_charge.cost_document_id is null then
    if p_backing is distinct from v_charge.backing
      or v_amounts.payable <> v_charge.amount
      or v_amounts.cost <> v_charge.net_amount
    then
      raise exception 'Este cargo está vinculado a un documento: desvinculalo antes de cambiar el monto o el respaldo';
    end if;

    perform set_config('inma.technician_charge_edit', 'charge:' || v_charge.id::text, true);
    update public.technician_charges
    set description = v_description,
        charge_date = p_charge_date,
        entered_as = p_entered_as,
        withholding_rate = v_amounts.withholding_rate,
        updated_by = v_user_id
    where id = p_charge_id
    returning * into v_charge;
    perform set_config('inma.technician_charge_edit', '', true);
    return v_charge;
  end if;

  select currency into v_currency from public.cost_documents where id = v_charge.cost_document_id;
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
      document_status = case when p_backing = 'none' then 'no_aplica' else 'pendiente' end,
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

-- update_technician_charge: same as 20260921020000, for charges without a
-- recorded backing only (Uruguay, and Chilean charges of the previous form).
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
  if v_charge.cost_document_id is null then
    raise exception 'Este cargo está vinculado a un documento: desvinculalo antes de cambiar el monto o el respaldo';
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

-- delete_technician_charge: same as 20260921020000, refusing a linked charge.
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

  if v_charge.cost_document_id is null then
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

-- set_technician_charge_document: same as 20260921020000, for charges without
-- a recorded backing only. With factura or boleta the document is received by
-- linking it; without backing there is none.
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

  if exists (select 1 from public.technician_charges where id = p_charge_id and backing is not null) then
    raise exception 'El documento de un cargo con respaldo se marca vinculando la factura o boleta';
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

-- ---------------------------------------------------------------------
-- link_technician_document / unlink_technician_document
-- ---------------------------------------------------------------------
-- Links an imported factura (FAC-EL, FAC-EE) or boleta (BOL-HE, BOL-TE) to
-- charges of the technician its supplier belongs to, with the same backing,
-- whose costs add up to the document's net (Neto + Exento; the bruto of a
-- boleta) within 1 peso per charge. Then, atomically:
--   * whatever assignment the document had (a job, a split, services) is
--     removed -- only with p_replace_allocations, after the screen asked;
--   * each charge's own cost document is deleted and the charge is marked
--     recibida;
--   * the document is imputed to the charges' jobs by each charge's cost:
--     one job -> a direct cost of it; several -> fixed-amount
--     cost_allocations (shares of the total, as "Editar asignación" stores
--     them; reports read them as net with net/total).
-- What is owed to the technician and the payments do not change.
-- Error messages start with a code the app reads: NOT_ELIGIBLE,
-- NO_TECHNICIAN, CHARGES, AMOUNT_MISMATCH, ALLOCATED, ALREADY_LINKED.
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
    or exists (select 1 from public.cost_allocations ca where ca.cost_document_id = p_cost_document_id)
    or exists (
      select 1 from public.cost_service_allocations a
      where a.cost_document_id = p_cost_document_id and a.status = 'confirmed'
    );
  if v_allocated and not coalesce(p_replace_allocations, false) then
    raise exception 'ALLOCATED: Este documento ya está asignado a un trabajo o repartido: confirmá que el vínculo reemplace esa asignación';
  end if;

  perform set_config('inma.technician_document_link', 'on', true);

  -- Whatever the document was assigned to goes away.
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

-- Undoes a link: each charge gets its own direct cost document back (same
-- amounts as the charge) and goes back to "pendiente"; the document loses
-- the assignment the link made and stays a general cost, unassigned.
create or replace function public.unlink_technician_document(p_cost_document_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_charge public.technician_charges;
  v_name text;
  v_own public.cost_documents;
  v_count integer := 0;
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

  for v_charge in
    select tc.*
    from public.technician_charges tc
    join public.technician_charge_documents l on l.charge_id = tc.id
    where l.cost_document_id = p_cost_document_id
    order by tc.id
    for update of tc
  loop
    select name into v_name from public.personnel where id = v_charge.personnel_id;

    v_own := public.create_cost_document(
      v_charge.company_id,
      null,
      v_charge.project_id,
      'direct',
      v_charge.charge_date,
      v_document.currency,
      case when v_charge.backing = 'boleta' then 0 else v_charge.amount - v_charge.net_amount end,
      jsonb_build_array(
        jsonb_build_object(
          'description', 'Técnico: ' || v_name || coalesce(' — ' || v_charge.description, ''),
          'amount', v_charge.net_amount
        )
      )
    );

    update public.cost_documents set category = 'labor', updated_by = v_user_id where id = v_own.id;

    update public.technician_charges
    set cost_document_id = v_own.id, document_status = 'pendiente', updated_by = v_user_id
    where id = v_charge.id;

    v_count := v_count + 1;
  end loop;

  delete from public.technician_charge_documents where cost_document_id = p_cost_document_id;

  delete from public.cost_allocations where cost_document_id = p_cost_document_id;
  if v_document.classification <> 'general' or v_document.project_id is not null then
    update public.cost_documents
    set classification = 'general', project_id = null, updated_by = v_user_id
    where id = p_cost_document_id;
  end if;

  perform set_config('inma.technician_document_link', 'off', true);

  return jsonb_build_object('cost_document_id', p_cost_document_id, 'charges', v_count);
end;
$$;

revoke execute on function public.unlink_technician_document(uuid) from public, anon;
grant execute on function public.unlink_technician_document(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- link_technician_tax_id: "Agregar RUT" in the technician's ficha
-- ---------------------------------------------------------------------
-- Finds the company's suppliers with that RUT (normalized) or creates one
-- (named p_supplier_name, else after the technician), and links them to the
-- technician. A RUT already linked to another technician is refused.
create or replace function public.link_technician_tax_id(
  p_personnel_id uuid,
  p_tax_id text,
  p_supplier_name text default null
)
returns setof public.technician_suppliers
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_tax_id text := public.normalize_tax_id(p_tax_id);
  v_personnel public.personnel;
  v_other text;
  v_supplier_ids uuid[];
  v_new_supplier_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required to link a RUT';
  end if;
  if v_tax_id is null then
    raise exception 'Ingresá un RUT';
  end if;

  select * into v_personnel from public.personnel where id = p_personnel_id;
  if v_personnel.id is null then
    raise exception 'Technician not found';
  end if;
  if v_personnel.type <> 'contractor' then
    raise exception 'Only external technicians have linked suppliers';
  end if;
  if not public.company_is_chile(v_personnel.company_id) then
    raise exception 'Los RUT de técnicos se vinculan solo en empresas de Chile';
  end if;

  select array_agg(s.id order by s.created_at) into v_supplier_ids
  from public.suppliers s
  where s.company_id = v_personnel.company_id
    and public.normalize_tax_id(s.tax_id) = v_tax_id;

  if v_supplier_ids is null then
    insert into public.suppliers (company_id, name, tax_id)
    values (
      v_personnel.company_id,
      coalesce(nullif(btrim(coalesce(p_supplier_name, '')), ''), v_personnel.name),
      btrim(p_tax_id)
    )
    returning id into v_new_supplier_id;
    v_supplier_ids := array[v_new_supplier_id];
  end if;

  select p.name into v_other
  from public.technician_suppliers ts
  join public.personnel p on p.id = ts.personnel_id
  where ts.supplier_id = any (v_supplier_ids)
    and ts.personnel_id <> p_personnel_id
  limit 1;
  if v_other is not null then
    raise exception 'Ese RUT ya está vinculado al técnico %', v_other;
  end if;

  insert into public.technician_suppliers (company_id, personnel_id, supplier_id, created_by)
  select v_personnel.company_id, p_personnel_id, unnest(v_supplier_ids), v_user_id
  on conflict (supplier_id) do nothing;

  return query
  select * from public.technician_suppliers ts
  where ts.supplier_id = any (v_supplier_ids)
  order by ts.created_at;
end;
$$;

revoke execute on function public.link_technician_tax_id(uuid, text, text) from public, anon;
grant execute on function public.link_technician_tax_id(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- delete_cost_document: same as 20261024050000, unlinking first a document
-- linked to technician charges (their own costs come back).
-- ---------------------------------------------------------------------
create or replace function public.delete_cost_document(p_cost_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_document public.cost_documents;
  v_paths text[];
  v_lines int;
  v_allocations int;
  v_service_allocations int;
  v_import_rows int;
  v_unlinked int := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required to delete a cost document';
  end if;

  select * into v_document from public.cost_documents where id = p_cost_document_id for update;
  if v_document.id is null then
    raise exception 'Gasto no encontrado';
  end if;

  if not exists (
    select 1 from public.company_memberships cm
    where cm.company_id = v_document.company_id and cm.user_id = v_user_id
  ) then
    raise exception 'No tenés acceso a este gasto';
  end if;

  if exists (select 1 from public.technician_charges tc where tc.cost_document_id = p_cost_document_id) then
    raise exception 'Este gasto es el cargo de un técnico (Mano de obra): corregilo o eliminalo desde la sección Técnicos del trabajo, para no descuadrar sus pagos.';
  end if;

  if exists (select 1 from public.technician_charge_documents l where l.cost_document_id = p_cost_document_id) then
    v_unlinked := (public.unlink_technician_document(p_cost_document_id) ->> 'charges')::int;
  end if;

  select coalesce(array_agg(a.storage_path order by a.created_at), '{}') into v_paths
  from public.cost_document_attachments a
  where a.cost_document_id = p_cost_document_id;

  update public.cost_import_rows r
  set cost_document_id = null,
      deleted_at = now(),
      deleted_by = v_user_id,
      deleted_supplier_id = v_document.supplier_id,
      deleted_document_date = v_document.document_date,
      deleted_total_amount = v_document.total_amount,
      deleted_source_document_type = v_document.source_document_type,
      deleted_document_number = v_document.document_number
  where r.cost_document_id = p_cost_document_id or r.id = v_document.import_row_id;
  get diagnostics v_import_rows = row_count;

  update public.cost_documents d
  set duplicate_of_cost_document_id = null
  where d.duplicate_of_cost_document_id = p_cost_document_id;

  delete from public.cost_service_allocations a where a.cost_document_id = p_cost_document_id;
  get diagnostics v_service_allocations = row_count;

  delete from public.cost_allocations a where a.cost_document_id = p_cost_document_id;
  get diagnostics v_allocations = row_count;

  delete from public.cost_lines l where l.cost_document_id = p_cost_document_id;
  get diagnostics v_lines = row_count;

  delete from public.cost_document_attachments a where a.cost_document_id = p_cost_document_id;

  delete from public.cost_documents d where d.id = p_cost_document_id;

  return jsonb_build_object(
    'company_id', v_document.company_id,
    'project_id', v_document.project_id,
    'attachments', to_jsonb(v_paths),
    'lines', v_lines,
    'allocations', v_allocations,
    'service_allocations', v_service_allocations,
    'import_rows', v_import_rows,
    'unlinked_charges', v_unlinked
  );
end;
$$;

revoke execute on function public.delete_cost_document(uuid) from public, anon;
grant execute on function public.delete_cost_document(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Grants of the helpers
-- ---------------------------------------------------------------------
revoke execute on function public.normalize_tax_id(text) from public, anon;
grant execute on function public.normalize_tax_id(text) to authenticated, service_role;
revoke execute on function public.company_is_chile(uuid) from public, anon;
grant execute on function public.company_is_chile(uuid) to authenticated, service_role;
revoke execute on function public.boleta_withholding_rate(date) from public, anon;
grant execute on function public.boleta_withholding_rate(date) to authenticated, service_role;
revoke execute on function public.technician_backing_amounts(text, text, numeric, date) from public, anon;
grant execute on function public.technician_backing_amounts(text, text, numeric, date) to authenticated, service_role;
