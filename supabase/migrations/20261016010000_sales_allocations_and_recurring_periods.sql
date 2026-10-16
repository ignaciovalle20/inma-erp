-- Recurring services, periods and invoice allocations
-- (prompt_servicios_recurrentes_asignaciones.md).
--
-- 1. recurring_services: `price` becomes the reference amount
--    (`reference_amount`, nullable): it only projects and pre-fills
--    periods. Pricing can be fixed or per unit (MS licenses: unit price x
--    quantity). Domains are their own service type (annual, Hosting area).
-- 2. Periods: the existing recurring_service_occurrences table IS the
--    period table (one row per service + period, unique, 1st of the month
--    or of the year). It is adapted, not duplicated: `amount` keeps being
--    the expected amount (snapshot of the reference when the period is
--    created), `quantity` is new (per-unit services, editable per period),
--    `status` keeps the manual state (clients without invoice: pending
--    collection / collected), `note` is the period's notes.
-- 3. sales_allocations: a sales document (whole, the exports carry no
--    lines) is split by hand among recurring service periods and job
--    quotes. Several invoices can feed one period or quote.
-- 4. Summary views per document, per period and per quote.
-- 5. Automatic suggestions by net amount (imports and the UI).
-- 6. The MS licenses pool splits by the amount actually billed per period.
-- 7. Existing links (cycle <-> invoice, document <-> job) become confirmed
--    allocations, and the old link columns are kept in sync both ways so
--    every screen and report that reads them keeps working.

-- ---------------------------------------------------------------------
-- 1. recurring_services: reference amount, pricing mode, domains
-- ---------------------------------------------------------------------
alter table public.recurring_services rename column price to reference_amount;
alter table public.recurring_services alter column reference_amount drop not null;

comment on column public.recurring_services.reference_amount is
  'Reference amount per period: only projects and pre-fills new periods (expected amount). Per-unit services: unit_price x default_quantity.';

alter table public.recurring_services
  add column pricing_mode text not null default 'fixed'
    check (pricing_mode in ('fixed', 'per_unit')),
  add column unit_price numeric check (unit_price is null or unit_price >= 0),
  add column default_quantity numeric check (default_quantity is null or default_quantity >= 0);

alter table public.recurring_services
  add constraint recurring_services_per_unit_fields
    check (pricing_mode <> 'per_unit' or (unit_price is not null and default_quantity is not null));

alter table public.recurring_services drop constraint recurring_services_service_type_check;
alter table public.recurring_services
  add constraint recurring_services_service_type_check
    check (service_type in ('ms_licenses', 'hosting', 'starlink', 'server', 'domain', 'other'));

-- A domain renews once a year (its renewal date is due_month/due_day).
alter table public.recurring_services
  add constraint recurring_services_domain_is_annual
    check (service_type is distinct from 'domain' or periodicity = 'annual');

-- Per unit: the reference amount is always unit price x default quantity.
create or replace function public.recurring_services_apply_pricing()
returns trigger
language plpgsql
as $$
begin
  if new.pricing_mode = 'per_unit' then
    new.reference_amount := round(
      new.unit_price * new.default_quantity,
      case when new.currency = 'CLP' then 0 else 2 end
    );
  else
    new.unit_price := null;
    new.default_quantity := null;
  end if;
  return new;
end;
$$;

-- Named to sort after recurring_services_apply_company_country (which can
-- force the currency to CLP), so the rounding uses the final currency.
create trigger recurring_services_zz_apply_pricing
  before insert or update on public.recurring_services
  for each row
  execute function public.recurring_services_apply_pricing();

-- ---------------------------------------------------------------------
-- 2. Periods (recurring_service_occurrences)
-- ---------------------------------------------------------------------
alter table public.recurring_service_occurrences
  add column quantity numeric check (quantity is null or quantity >= 0);

comment on column public.recurring_service_occurrences.amount is
  'Expected amount of the period: snapshot of the service reference amount when the period was created (per unit: unit price x quantity). What was billed comes from sales_allocations.';
comment on column public.recurring_service_occurrences.quantity is
  'Units billed this period (per-unit services, e.g. MS licenses). Changing it recomputes the expected amount.';

-- Changing the quantity of a per-unit period recomputes its expected
-- amount, unless the same update sets the amount explicitly.
create or replace function public.recurring_service_occurrences_apply_quantity()
returns trigger
language plpgsql
as $$
declare
  v_service record;
begin
  if new.quantity is not distinct from old.quantity or new.amount is distinct from old.amount then
    return new;
  end if;

  select pricing_mode, unit_price into v_service
  from public.recurring_services
  where id = new.recurring_service_id;

  if v_service.pricing_mode = 'per_unit' and new.quantity is not null then
    new.amount := round(
      v_service.unit_price * new.quantity,
      case when new.currency = 'CLP' then 0 else 2 end
    );
  end if;

  return new;
end;
$$;

create trigger recurring_service_occurrences_apply_quantity
  before update of quantity on public.recurring_service_occurrences
  for each row
  execute function public.recurring_service_occurrences_apply_quantity();

-- Generation: same rules as before (20261003010000 / 20261005010000), the
-- expected amount now comes from the reference amount (0 when the service
-- has none), and per-unit periods start with the default quantity.
create or replace function public.generate_recurring_service_occurrences_for_month(
  p_month date,
  p_company_id uuid default null,
  p_service_id uuid default null
)
returns table (occurrence_id uuid, service_id uuid, occurrence_period date)
language plpgsql
set search_path = public
as $$
declare
  c_first_month constant date := date '2026-01-01';
  v_month date := date_trunc('month', p_month)::date;
  v_service record;
  v_period date;
  v_period_end date;
  v_due_month int;
  v_last_day int;
  v_due_date date;
  v_new_id uuid;
begin
  -- The first month managed in the ERP.
  if v_month < c_first_month then
    return;
  end if;

  for v_service in
    select *
    from public.recurring_services
    where status = 'active'
      and (p_company_id is null or company_id = p_company_id)
      and (p_service_id is null or id = p_service_id)
  loop
    if v_service.periodicity = 'monthly' then
      -- Anticipado bills the month itself; vencido the one that closed.
      v_period := v_month;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 month')::date;
      end if;
      v_period_end := (v_period + interval '1 month - 1 day')::date;
      v_due_month := extract(month from v_month)::int;
    else
      -- Annual: only in its due month.
      if v_service.due_month is null
         or v_service.due_month <> extract(month from v_month)::int then
        continue;
      end if;
      v_period := date_trunc('year', v_month)::date;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 year')::date;
      end if;
      v_period_end := (v_period + interval '1 year - 1 day')::date;
      v_due_month := v_service.due_month;
    end if;

    -- Active on any day of the period being generated.
    if v_service.start_date > v_period_end
       or (v_service.end_date is not null and v_service.end_date < v_period) then
      continue;
    end if;

    -- Due within the month being generated; day 1 when not configured.
    v_last_day := extract(
      day from (make_date(extract(year from v_month)::int, v_due_month, 1) + interval '1 month - 1 day')
    )::int;
    v_due_date := make_date(
      extract(year from v_month)::int,
      v_due_month,
      least(coalesce(v_service.due_day, 1), v_last_day)
    );

    v_new_id := null;

    insert into public.recurring_service_occurrences (
      recurring_service_id,
      period,
      invoice_due_date,
      collection_due_date,
      amount,
      quantity,
      currency,
      status
    )
    values (
      v_service.id,
      v_period,
      v_due_date,
      v_due_date,
      coalesce(v_service.reference_amount, 0),
      case when v_service.pricing_mode = 'per_unit' then v_service.default_quantity end,
      v_service.currency,
      case when v_service.requires_invoice then 'pending_invoice' else 'pending_collection' end
    )
    on conflict (recurring_service_id, period) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      occurrence_id := v_new_id;
      service_id := v_service.id;
      occurrence_period := v_period;
      return next;
    end if;
  end loop;
end;
$$;

-- Legacy Epic 5.1 entry generator (no caller in the app any more): kept
-- working on the renamed column.
create or replace function public.generate_recurring_service_entry(p_recurring_service_id uuid, p_period date)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_service public.recurring_services;
  v_document public.sales_documents;
  v_period_start date;
  v_amount numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required to generate a recurring service entry';
  end if;

  if p_period is null then
    raise exception 'A period is required';
  end if;

  select * into v_service
  from public.recurring_services
  where id = p_recurring_service_id;

  if v_service is null then
    raise exception 'Recurring service not found';
  end if;

  if not v_service.active then
    raise exception 'Recurring service is not active';
  end if;

  if v_service.periodicity = 'annual' then
    v_period_start := date_trunc('year', p_period)::date;
  else
    v_period_start := date_trunc('month', p_period)::date;
  end if;

  if v_period_start < v_service.start_date then
    raise exception 'Cannot generate before the service start date';
  end if;

  if v_service.end_date is not null and v_period_start > v_service.end_date then
    raise exception 'Cannot generate after the service end date';
  end if;

  if exists (
    select 1 from public.sales_documents
    where recurring_service_id = p_recurring_service_id
      and recurring_period = v_period_start
  ) then
    raise exception 'This period has already been generated for this service';
  end if;

  v_amount := coalesce(v_service.reference_amount, 0);

  insert into public.sales_documents (
    company_id, client_id, document_type, document_date, currency,
    net_amount, tax_amount, total_amount, source,
    recurring_service_id, recurring_period, created_by, updated_by
  )
  values (
    v_service.company_id, v_service.client_id, 'manual', v_period_start, v_service.currency,
    v_amount, 0, v_amount, 'recurring',
    v_service.id, v_period_start, v_user_id, v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (sales_document_id, description, amount, created_by, updated_by)
  values (v_document.id, v_service.name, v_amount, v_user_id, v_user_id);

  return v_document;
end;
$$;

-- Periods are managed from September 2026: creates every missing period
-- of the company's active services from then through p_until's month
-- (idempotent, never touches existing periods). Called when the module
-- opens, so periods appear on their own going forward.
create or replace function public.ensure_recurring_service_periods(
  p_company_id uuid,
  p_until date default null
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_month date := date '2026-09-01';
  v_until date := date_trunc('month', coalesce(p_until, current_date))::date;
  v_count int := 0;
  v_created int;
begin
  while v_month <= v_until loop
    select count(*) into v_created
    from public.generate_recurring_service_occurrences_for_month(v_month, p_company_id, null);
    v_count := v_count + v_created;
    v_month := (v_month + interval '1 month')::date;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. project_quotes: quoted amount per quote + placeholder quotes
-- ---------------------------------------------------------------------
-- quoted_amount: what that quote is for (null = use the job's
-- quoted_amount when this is the job's main quote, see the view below).
-- placeholder: a quote created by the system so a job without a quote
-- number can still receive allocations (allocations target quotes).
alter table public.project_quotes
  add column quoted_amount numeric check (quoted_amount is null or quoted_amount >= 0),
  add column placeholder boolean not null default false;

-- The quote a job's sales go to by default: its oldest real quote, else
-- its placeholder, which is created when missing.
create or replace function public.project_default_quote_id(p_project_id uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_company_id uuid;
  v_number text := 'S/C-' || upper(left(p_project_id::text, 8));
begin
  select q.id into v_id
  from public.project_quotes q
  where q.project_id = p_project_id
  order by q.placeholder, q.created_at, q.id
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  select company_id into v_company_id from public.projects where id = p_project_id;

  if v_company_id is null then
    raise exception 'Job not found';
  end if;

  insert into public.project_quotes (project_id, company_id, quote_number, placeholder)
  values (p_project_id, v_company_id, v_number, true)
  on conflict (company_id, quote_number) do nothing
  returning id into v_id;

  if v_id is null then
    select q.id into v_id
    from public.project_quotes q
    where q.company_id = v_company_id and q.quote_number = v_number;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. sales_allocations
-- ---------------------------------------------------------------------
create table public.sales_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  sales_document_id uuid not null references public.sales_documents (id) on delete cascade,
  -- The period table is recurring_service_occurrences (see section 2).
  recurring_service_period_id uuid references public.recurring_service_occurrences (id) on delete cascade,
  project_quote_id uuid references public.project_quotes (id) on delete cascade,
  amount numeric not null check (amount > 0),
  status text not null default 'confirmed' check (status in ('suggested', 'confirmed')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  constraint sales_allocations_exactly_one_target
    check (num_nonnulls(recurring_service_period_id, project_quote_id) = 1)
);

-- One allocation per document and destination: a re-imported document
-- never gets a second one.
create unique index sales_allocations_document_period_unique
  on public.sales_allocations (sales_document_id, recurring_service_period_id)
  where recurring_service_period_id is not null;
create unique index sales_allocations_document_quote_unique
  on public.sales_allocations (sales_document_id, project_quote_id)
  where project_quote_id is not null;

create index sales_allocations_company_id_idx on public.sales_allocations (company_id);
create index sales_allocations_period_idx
  on public.sales_allocations (recurring_service_period_id)
  where recurring_service_period_id is not null;
create index sales_allocations_quote_idx
  on public.sales_allocations (project_quote_id)
  where project_quote_id is not null;

create trigger sales_allocations_set_updated_at
  before update on public.sales_allocations
  for each row
  execute function public.set_updated_at();

alter table public.sales_allocations enable row level security;

create policy "Members can view their company's sales allocations"
  on public.sales_allocations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create sales allocations for their company"
  on public.sales_allocations
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's sales allocations"
  on public.sales_allocations
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_allocations.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete their company's sales allocations"
  on public.sales_allocations
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = sales_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Same company everywhere, an allocatable document (not a credit note,
-- not voided or annulled), a live period, and never more than the
-- document's net in total (rounding tolerance: half a peso / half a cent).
create or replace function public.sales_allocations_validate()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_doc record;
  v_target_company_id uuid;
  v_period_status text;
  v_other numeric;
  v_tolerance numeric;
begin
  select id, company_id, net_amount, currency, document_type, voided, annulled_by_document_id
  into v_doc
  from public.sales_documents
  where id = new.sales_document_id;

  if v_doc.id is null then
    raise exception 'Sales document not found';
  end if;

  if v_doc.company_id <> new.company_id then
    raise exception 'sales_document_id must belong to the same company as the allocation';
  end if;

  if v_doc.document_type = 'credit_note' then
    raise exception 'A credit note cannot be allocated';
  end if;

  if v_doc.voided or v_doc.annulled_by_document_id is not null then
    raise exception 'A voided or annulled document cannot be allocated';
  end if;

  if new.recurring_service_period_id is not null then
    select rs.company_id, o.status into v_target_company_id, v_period_status
    from public.recurring_service_occurrences o
    join public.recurring_services rs on rs.id = o.recurring_service_id
    where o.id = new.recurring_service_period_id;

    if v_period_status = 'void' then
      raise exception 'A voided period cannot receive allocations';
    end if;
  else
    select company_id into v_target_company_id
    from public.project_quotes
    where id = new.project_quote_id;
  end if;

  if v_target_company_id is distinct from new.company_id then
    raise exception 'The allocation target must belong to the same company as the document';
  end if;

  if tg_op = 'INSERT'
     or new.amount > old.amount
     or new.sales_document_id <> old.sales_document_id then
    select coalesce(sum(a.amount), 0) into v_other
    from public.sales_allocations a
    where a.sales_document_id = new.sales_document_id
      and a.id <> new.id;

    v_tolerance := case when v_doc.currency = 'CLP' then 0.5 else 0.005 end;

    if v_other + new.amount > v_doc.net_amount + v_tolerance then
      raise exception 'The allocations of a document cannot exceed its net amount (% of %)',
        v_other + new.amount, v_doc.net_amount;
    end if;
  end if;

  return new;
end;
$$;

create trigger sales_allocations_validate
  before insert or update on public.sales_allocations
  for each row
  execute function public.sales_allocations_validate();

-- ---------------------------------------------------------------------
-- 5. Keeping the old link columns in sync
-- ---------------------------------------------------------------------
-- What a period has billed, in its own currency (confirmed allocations of
-- documents in that currency).
create or replace function public.recurring_service_period_billed_amount(p_occurrence_id uuid)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(sum(a.amount), 0)
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  join public.recurring_service_occurrences o on o.id = a.recurring_service_period_id
  where a.recurring_service_period_id = p_occurrence_id
    and a.status = 'confirmed'
    and sd.currency = o.currency;
$$;

-- Re-derives a period's invoice link and state from its confirmed
-- allocations, so the month board, Deuda and the reports (which read
-- sales_document_id / status) agree with the allocations:
-- * none: a period that was linked goes back to pending (one marked by
--   hand without an invoice is left alone);
-- * some: linked to the document with the largest share; collected when
--   every allocated document is paid, otherwise invoiced. A period already
--   collected by hand stays collected unless the change comes from a
--   document's payment status (p_from_payment).
create or replace function public.refresh_recurring_service_occurrence_billing(
  p_occurrence_id uuid,
  p_from_payment boolean default false
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_occ record;
  v_count int;
  v_unpaid int;
  v_first_date date;
  v_last_paid date;
  v_main uuid;
  v_status text;
begin
  select o.id, o.status, o.sales_document_id, o.invoiced_at, o.collected_at, rs.requires_invoice
  into v_occ
  from public.recurring_service_occurrences o
  join public.recurring_services rs on rs.id = o.recurring_service_id
  where o.id = p_occurrence_id;

  if v_occ.id is null or v_occ.status = 'void' then
    return;
  end if;

  select
    count(*),
    count(*) filter (where sd.payment_status <> 'pagado'),
    min(sd.document_date),
    max(sd.paid_at)
  into v_count, v_unpaid, v_first_date, v_last_paid
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  where a.recurring_service_period_id = p_occurrence_id
    and a.status = 'confirmed';

  if v_count = 0 then
    if v_occ.sales_document_id is not null then
      update public.recurring_service_occurrences
      set sales_document_id = null,
          status = case when v_occ.requires_invoice then 'pending_invoice' else 'pending_collection' end,
          invoiced_at = null,
          collected_at = null
      where id = p_occurrence_id;
    end if;
    return;
  end if;

  select a.sales_document_id into v_main
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  where a.recurring_service_period_id = p_occurrence_id
    and a.status = 'confirmed'
  order by a.amount desc, sd.document_date, a.created_at, a.id
  limit 1;

  v_status := case
    when v_unpaid = 0 then 'collected'
    when v_occ.status = 'collected' and not p_from_payment then 'collected'
    else 'invoiced'
  end;

  update public.recurring_service_occurrences
  set sales_document_id = v_main,
      status = v_status,
      invoiced_at = coalesce(invoiced_at, v_first_date),
      collected_at = case
        when v_status = 'collected' then coalesce(collected_at, v_last_paid, v_first_date)
        else null
      end,
      link_review = null
  where id = p_occurrence_id
    and (
      sales_document_id is distinct from v_main
      or status is distinct from v_status
      or invoiced_at is null
      or (v_status = 'collected' and collected_at is null)
      or (v_status <> 'collected' and collected_at is not null)
      or link_review is not null
    );
end;
$$;

-- A document's job (sales_documents.project_id, read by every
-- profitability report) follows its confirmed quote allocations: the job
-- with the largest share, or none once it has no quote allocation at all.
create or replace function public.sync_sales_document_project(p_sales_document_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_doc record;
  v_project_id uuid;
  v_area_id uuid;
  v_has_quote_allocations boolean;
begin
  select id, project_id, voided, annulled_by_document_id into v_doc
  from public.sales_documents
  where id = p_sales_document_id;

  if v_doc.id is null or v_doc.voided or v_doc.annulled_by_document_id is not null then
    return;
  end if;

  select exists (
    select 1 from public.sales_allocations a
    where a.sales_document_id = p_sales_document_id and a.project_quote_id is not null
  ) into v_has_quote_allocations;

  select q.project_id into v_project_id
  from public.sales_allocations a
  join public.project_quotes q on q.id = a.project_quote_id
  where a.sales_document_id = p_sales_document_id
    and a.status = 'confirmed'
  group by q.project_id
  order by sum(a.amount) desc, q.project_id
  limit 1;

  if v_project_id is null and v_has_quote_allocations then
    -- Only suggestions so far: leave the current job as it is.
    return;
  end if;

  if v_project_id is not distinct from v_doc.project_id then
    return;
  end if;

  if v_project_id is not null then
    select business_area_id into v_area_id from public.projects where id = v_project_id;
  end if;

  update public.sales_documents
  set project_id = v_project_id,
      business_area_id = coalesce(v_area_id, business_area_id)
  where id = p_sales_document_id;
end;
$$;

create or replace function public.sales_allocations_refresh_targets()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.recurring_service_period_id is not null
     and (tg_op = 'DELETE' or old.recurring_service_period_id is distinct from new.recurring_service_period_id) then
    perform public.refresh_recurring_service_occurrence_billing(old.recurring_service_period_id, false);
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.recurring_service_period_id is not null then
    perform public.refresh_recurring_service_occurrence_billing(new.recurring_service_period_id, false);
  end if;

  if (tg_op in ('UPDATE', 'DELETE') and old.project_quote_id is not null) then
    perform public.sync_sales_document_project(old.sales_document_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.project_quote_id is not null
     and (tg_op = 'INSERT' or old.sales_document_id <> new.sales_document_id or old.project_quote_id is null) then
    perform public.sync_sales_document_project(new.sales_document_id);
  end if;

  return null;
end;
$$;

create trigger sales_allocations_refresh_targets
  after insert or update or delete on public.sales_allocations
  for each row
  execute function public.sales_allocations_refresh_targets();

-- A document that is voided or annulled by a credit note loses its
-- allocations; one allocated whole to a single destination follows a
-- corrected net amount; a payment status change re-derives its periods.
create or replace function public.sales_documents_sync_allocations()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_occurrence_id uuid;
begin
  if (new.voided and not old.voided)
     or (new.annulled_by_document_id is not null and old.annulled_by_document_id is null) then
    delete from public.sales_allocations where sales_document_id = new.id;
    return null;
  end if;

  if new.net_amount is distinct from old.net_amount and new.net_amount > 0 then
    update public.sales_allocations a
    set amount = new.net_amount
    where a.sales_document_id = new.id
      and a.amount = old.net_amount
      and (select count(*) from public.sales_allocations a2 where a2.sales_document_id = new.id) = 1;
  end if;

  if new.payment_status is distinct from old.payment_status
     or new.paid_at is distinct from old.paid_at then
    for v_occurrence_id in
      select distinct a.recurring_service_period_id
      from public.sales_allocations a
      where a.sales_document_id = new.id
        and a.status = 'confirmed'
        and a.recurring_service_period_id is not null
    loop
      perform public.refresh_recurring_service_occurrence_billing(v_occurrence_id, true);
    end loop;
  end if;

  return null;
end;
$$;

create trigger sales_documents_sync_allocations
  after update of payment_status, paid_at, voided, annulled_by_document_id, net_amount
  on public.sales_documents
  for each row
  execute function public.sales_documents_sync_allocations();

-- The other direction (created after the backfill below): code that still
-- links a cycle to an invoice through recurring_service_occurrences.
-- sales_document_id, or a document to a job through
-- sales_documents.project_id, gets the matching confirmed allocation.
-- Only for direct writes (trigger depth 1): writes made by the triggers
-- above are their own consequence.
create or replace function public.recurring_service_occurrences_sync_allocations()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_company_id uuid;
  v_net numeric;
  v_taken numeric;
  v_amount numeric;
begin
  if pg_trigger_depth() > 1 or new.sales_document_id is not distinct from old.sales_document_id then
    return null;
  end if;

  if old.sales_document_id is not null then
    delete from public.sales_allocations a
    where a.recurring_service_period_id = new.id
      and a.sales_document_id = old.sales_document_id;
  end if;

  if new.sales_document_id is null then
    return null;
  end if;

  -- Already allocated (a suggestion becomes confirmed).
  update public.sales_allocations a
  set status = 'confirmed'
  where a.recurring_service_period_id = new.id
    and a.sales_document_id = new.sales_document_id
    and a.status = 'suggested';

  if exists (
    select 1 from public.sales_allocations a
    where a.recurring_service_period_id = new.id
      and a.sales_document_id = new.sales_document_id
  ) then
    return null;
  end if;

  select sd.company_id, sd.net_amount into v_company_id, v_net
  from public.sales_documents sd
  where sd.id = new.sales_document_id
    and not sd.voided
    and sd.annulled_by_document_id is null
    and sd.document_type <> 'credit_note';

  if v_company_id is null then
    return null;
  end if;

  select coalesce(sum(a.amount), 0) into v_taken
  from public.sales_allocations a
  where a.sales_document_id = new.sales_document_id;

  v_amount := case
    when new.amount > 0 then least(new.amount, v_net - v_taken)
    else v_net - v_taken
  end;

  if v_amount > 0 then
    insert into public.sales_allocations (
      company_id, sales_document_id, recurring_service_period_id, amount, status
    )
    values (v_company_id, new.sales_document_id, new.id, v_amount, 'confirmed');
  end if;

  return null;
end;
$$;

create or replace function public.sales_documents_sync_project_allocation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_quote_id uuid;
  v_taken numeric;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  if tg_op = 'UPDATE' and new.project_id is not distinct from old.project_id then
    return null;
  end if;

  if new.document_type = 'credit_note' or new.voided or new.annulled_by_document_id is not null then
    return null;
  end if;

  delete from public.sales_allocations a
  using public.project_quotes q
  where a.sales_document_id = new.id
    and a.project_quote_id = q.id
    and (new.project_id is null or q.project_id <> new.project_id);

  if new.project_id is null then
    return null;
  end if;

  if exists (
    select 1
    from public.sales_allocations a
    join public.project_quotes q on q.id = a.project_quote_id
    where a.sales_document_id = new.id and q.project_id = new.project_id
  ) then
    return null;
  end if;

  select coalesce(sum(a.amount), 0) into v_taken
  from public.sales_allocations a
  where a.sales_document_id = new.id;

  if new.net_amount - v_taken > 0 then
    v_quote_id := public.project_default_quote_id(new.project_id);
    insert into public.sales_allocations (company_id, sales_document_id, project_quote_id, amount, status)
    values (new.company_id, new.id, v_quote_id, new.net_amount - v_taken, 'confirmed');
  end if;

  return null;
end;
$$;

-- A real quote added to a job takes over what its placeholder received.
create or replace function public.project_quotes_take_over_placeholder()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.placeholder then
    return null;
  end if;

  update public.sales_allocations a
  set project_quote_id = new.id
  from public.project_quotes q
  where a.project_quote_id = q.id
    and q.project_id = new.project_id
    and q.placeholder
    and not exists (
      select 1 from public.sales_allocations a2
      where a2.sales_document_id = a.sales_document_id and a2.project_quote_id = new.id
    );

  return null;
end;
$$;

create trigger project_quotes_take_over_placeholder
  after insert on public.project_quotes
  for each row
  execute function public.project_quotes_take_over_placeholder();

-- ---------------------------------------------------------------------
-- 6. Summary views (security_invoker: RLS of the caller applies)
-- ---------------------------------------------------------------------
create view public.sales_document_allocation_summary
with (security_invoker = true) as
select
  sd.id as sales_document_id,
  sd.company_id,
  sd.client_id,
  sd.document_type,
  sd.document_number,
  sd.document_date,
  sd.currency,
  sd.net_amount,
  sd.payment_status,
  coalesce(sum(a.amount) filter (where a.status = 'confirmed'), 0) as confirmed_amount,
  coalesce(sum(a.amount) filter (where a.status = 'suggested'), 0) as suggested_amount,
  coalesce(sum(a.amount), 0) as allocated_amount,
  sd.net_amount - coalesce(sum(a.amount), 0) as unallocated_amount,
  count(a.id) filter (where a.status = 'suggested') as suggested_count,
  count(a.id) as allocation_count
from public.sales_documents sd
left join public.sales_allocations a on a.sales_document_id = sd.id
where not sd.voided
  and sd.annulled_by_document_id is null
  and sd.document_type <> 'credit_note'
group by sd.id;

-- billing_status: pending_invoice (nothing billed: the expected amount is
-- only an estimate), invoiced (billed, or owed when the client has no
-- invoice, not paid yet), paid, void.
create view public.recurring_service_period_summary
with (security_invoker = true) as
select
  o.id as recurring_service_period_id,
  o.recurring_service_id,
  rs.company_id,
  rs.client_id,
  rs.service_type,
  rs.requires_invoice,
  o.period,
  o.invoice_due_date,
  o.currency,
  o.quantity,
  o.amount as expected_amount,
  coalesce(b.billed_amount, 0) as billed_amount,
  coalesce(b.suggested_amount, 0) as suggested_amount,
  coalesce(b.billed_amount, 0) - o.amount as difference,
  coalesce(b.confirmed_count, 0) as confirmed_count,
  coalesce(b.suggested_count, 0) as suggested_count,
  o.status,
  case
    when o.status = 'void' then 'void'
    when coalesce(b.confirmed_count, 0) > 0 then
      case when b.unpaid_count = 0 or o.status = 'collected' then 'paid' else 'invoiced' end
    when o.status = 'collected' then 'paid'
    when o.status in ('invoiced', 'pending_collection') then 'invoiced'
    else 'pending_invoice'
  end as billing_status
from public.recurring_service_occurrences o
join public.recurring_services rs on rs.id = o.recurring_service_id
left join lateral (
  select
    sum(a.amount) filter (where a.status = 'confirmed' and sd.currency = o.currency) as billed_amount,
    sum(a.amount) filter (where a.status = 'suggested' and sd.currency = o.currency) as suggested_amount,
    count(*) filter (where a.status = 'confirmed') as confirmed_count,
    count(*) filter (where a.status = 'suggested') as suggested_count,
    count(*) filter (where a.status = 'confirmed' and sd.payment_status <> 'pagado') as unpaid_count
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  where a.recurring_service_period_id = o.id
) b on true;

-- quoted_amount: the quote's own, else the job's quoted_amount for its
-- main quote (the one project_default_quote_id picks) when no other quote
-- of the job carries an amount of its own.
create view public.project_quote_billing_summary
with (security_invoker = true) as
select
  q.id as project_quote_id,
  q.project_id,
  q.company_id,
  q.quote_number,
  q.placeholder,
  quoted.quoted_amount,
  coalesce(b.billed_amount, 0) as billed_amount,
  coalesce(b.suggested_amount, 0) as suggested_amount,
  case
    when quoted.quoted_amount > 0
      then round(100 * coalesce(b.billed_amount, 0) / quoted.quoted_amount, 1)
  end as billed_pct
from public.project_quotes q
join public.projects p on p.id = q.project_id
cross join lateral (
  select coalesce(
    q.quoted_amount,
    case
      when q.id = (
        select q2.id from public.project_quotes q2
        where q2.project_id = q.project_id
        order by q2.placeholder, q2.created_at, q2.id
        limit 1
      )
      and not exists (
        select 1 from public.project_quotes q3
        where q3.project_id = q.project_id and q3.id <> q.id and q3.quoted_amount is not null
      )
      then p.quoted_amount
    end
  ) as quoted_amount
) quoted
left join lateral (
  select
    sum(a.amount) filter (where a.status = 'confirmed') as billed_amount,
    sum(a.amount) filter (where a.status = 'suggested') as suggested_amount
  from public.sales_allocations a
  where a.project_quote_id = q.id
) b on true;

-- ---------------------------------------------------------------------
-- 7. Automatic suggestions
-- ---------------------------------------------------------------------
-- For each document of the company (all, or the ones given) that has no
-- allocation yet: when its net amount matches exactly ONE destination of
-- the same client -- a pending period invoiced that month, or a quote
-- whose open balance is that amount -- a 'suggested' allocation for 100%
-- is created. With no single match, a hosting period plus that client's
-- domain period of the same month adding up to the net are suggested
-- together. Documents that already have allocations are never touched,
-- so re-importing the same documents never duplicates anything.
create or replace function public.suggest_sales_allocations(
  p_company_id uuid,
  p_sales_document_ids uuid[] default null
)
returns table (
  sales_document_id uuid,
  recurring_service_period_id uuid,
  project_quote_id uuid,
  amount numeric
)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_company_currency text;
  v_doc record;
  v_tolerance numeric;
  v_month date;
  v_period_ids uuid[];
  v_quote_ids uuid[];
  v_pair record;
  v_pairs int;
  v_hosting_id uuid;
  v_domain_id uuid;
  v_domain_amount numeric;
  c_note constant text := 'Sugerida por monto';
begin
  select c.currency into v_company_currency from public.companies c where c.id = p_company_id;

  if v_company_currency is null then
    return;
  end if;

  for v_doc in
    select sd.id, sd.client_id, sd.net_amount, sd.currency, sd.document_date
    from public.sales_documents sd
    where sd.company_id = p_company_id
      and (p_sales_document_ids is null or sd.id = any (p_sales_document_ids))
      and sd.document_type in ('invoice', 'receipt', 'manual')
      and not sd.voided
      and sd.annulled_by_document_id is null
      and sd.client_id is not null
      and sd.net_amount > 0
      and not exists (select 1 from public.sales_allocations a where a.sales_document_id = sd.id)
    order by sd.document_date, sd.document_number nulls last, sd.id
  loop
    v_tolerance := case when v_doc.currency = 'CLP' then 0.5 else 0.005 end;
    v_month := date_trunc('month', v_doc.document_date)::date;

    select coalesce(array_agg(o.id), '{}') into v_period_ids
    from public.recurring_service_occurrences o
    join public.recurring_services rs on rs.id = o.recurring_service_id
    where rs.company_id = p_company_id
      and rs.client_id = v_doc.client_id
      and o.status = 'pending_invoice'
      and o.currency = v_doc.currency
      and date_trunc('month', coalesce(o.invoice_due_date, o.period))::date = v_month
      and abs(o.amount - v_doc.net_amount) <= v_tolerance
      and not exists (select 1 from public.sales_allocations a where a.recurring_service_period_id = o.id);

    v_quote_ids := '{}';
    if v_doc.currency = v_company_currency then
      select coalesce(array_agg(qs.project_quote_id), '{}') into v_quote_ids
      from public.project_quote_billing_summary qs
      join public.projects p on p.id = qs.project_id
      where qs.company_id = p_company_id
        and p.client_id = v_doc.client_id
        and p.status <> 'cancelado'
        and qs.quoted_amount is not null
        and qs.quoted_amount - qs.billed_amount - qs.suggested_amount > v_tolerance
        and abs(qs.quoted_amount - qs.billed_amount - qs.suggested_amount - v_doc.net_amount) <= v_tolerance;
    end if;

    if cardinality(v_period_ids) + cardinality(v_quote_ids) = 1 then
      if cardinality(v_period_ids) = 1 then
        insert into public.sales_allocations (
          company_id, sales_document_id, recurring_service_period_id, amount, status, notes
        )
        values (p_company_id, v_doc.id, v_period_ids[1], v_doc.net_amount, 'suggested', c_note);

        sales_document_id := v_doc.id;
        recurring_service_period_id := v_period_ids[1];
        project_quote_id := null;
        amount := v_doc.net_amount;
        return next;
      else
        insert into public.sales_allocations (
          company_id, sales_document_id, project_quote_id, amount, status, notes
        )
        values (p_company_id, v_doc.id, v_quote_ids[1], v_doc.net_amount, 'suggested', c_note);

        sales_document_id := v_doc.id;
        recurring_service_period_id := null;
        project_quote_id := v_quote_ids[1];
        amount := v_doc.net_amount;
        return next;
      end if;
    elsif cardinality(v_period_ids) + cardinality(v_quote_ids) = 0 then
      -- Hosting and its domain billed together on one invoice.
      v_pairs := 0;
      v_hosting_id := null;
      v_domain_id := null;
      v_domain_amount := null;
      for v_pair in
        with pending as (
          select o.id, o.amount, rs.service_type
          from public.recurring_service_occurrences o
          join public.recurring_services rs on rs.id = o.recurring_service_id
          where rs.company_id = p_company_id
            and rs.client_id = v_doc.client_id
            and rs.service_type in ('hosting', 'domain')
            and o.status = 'pending_invoice'
            and o.currency = v_doc.currency
            and date_trunc('month', coalesce(o.invoice_due_date, o.period))::date = v_month
            and o.amount > 0
            and not exists (select 1 from public.sales_allocations a where a.recurring_service_period_id = o.id)
        )
        select h.id as hosting_id, d.id as domain_id, d.amount as domain_amount
        from pending h
        join pending d on d.service_type = 'domain'
        where h.service_type = 'hosting'
          and abs(h.amount + d.amount - v_doc.net_amount) <= v_tolerance
        limit 2
      loop
        v_pairs := v_pairs + 1;
        if v_pairs = 1 then
          v_hosting_id := v_pair.hosting_id;
          v_domain_id := v_pair.domain_id;
          v_domain_amount := v_pair.domain_amount;
        end if;
      end loop;

      if v_pairs = 1 and v_doc.net_amount - v_domain_amount > 0 then
        insert into public.sales_allocations (
          company_id, sales_document_id, recurring_service_period_id, amount, status, notes
        )
        values
          (p_company_id, v_doc.id, v_hosting_id, v_doc.net_amount - v_domain_amount, 'suggested', c_note || ' (hosting + dominio)'),
          (p_company_id, v_doc.id, v_domain_id, v_domain_amount, 'suggested', c_note || ' (hosting + dominio)');

        sales_document_id := v_doc.id;
        recurring_service_period_id := v_hosting_id;
        project_quote_id := null;
        amount := v_doc.net_amount - v_domain_amount;
        return next;

        recurring_service_period_id := v_domain_id;
        amount := v_domain_amount;
        return next;
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.suggest_sales_allocations_for_import_batch(p_import_batch_id uuid)
returns table (
  sales_document_id uuid,
  recurring_service_period_id uuid,
  project_quote_id uuid,
  amount numeric
)
language plpgsql
set search_path = public
as $$
declare
  v_company_id uuid;
  v_document_ids uuid[];
begin
  select b.company_id into v_company_id
  from public.import_batches b
  where b.id = p_import_batch_id;

  if v_company_id is null then
    return;
  end if;

  select coalesce(array_agg(distinct ir.sales_document_id), '{}') into v_document_ids
  from public.import_rows ir
  where ir.import_batch_id = p_import_batch_id
    and ir.sales_document_id is not null;

  return query
    select s.sales_document_id, s.recurring_service_period_id, s.project_quote_id, s.amount
    from public.suggest_sales_allocations(v_company_id, v_document_ids) s;
end;
$$;

-- The Nubox import used to link cycles directly here; it now only
-- suggests (kept for any caller of the old name). Payments reach the
-- periods through sales_documents_sync_allocations.
create or replace function public.match_recurring_service_occurrences_for_import_batch(p_import_batch_id uuid)
returns table (occurrence_id uuid, sales_document_id uuid, matched_action text)
language plpgsql
set search_path = public
as $$
begin
  return query
    select s.recurring_service_period_id, s.sales_document_id, 'suggested'::text
    from public.suggest_sales_allocations_for_import_batch(p_import_batch_id) s
    where s.recurring_service_period_id is not null;
end;
$$;

-- Retroactive linking of past Chilean cycles (20261005010000): unchanged,
-- except that cycles and documents that already have allocations are out.
create or replace function public.match_recurring_service_occurrences_to_invoices(
  p_company_id uuid default null,
  p_service_id uuid default null,
  p_until date default current_date
)
returns table (occurrence_id uuid, result text, sales_document_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_row record;
  v_status text;
begin
  for v_row in
    with cycles as (
      select
        o.id,
        o.status,
        o.amount,
        o.currency,
        o.link_review,
        rs.client_id,
        rs.company_id,
        date_trunc('month', coalesce(o.invoice_due_date, o.period))::date as invoice_month
      from public.recurring_service_occurrences o
      join public.recurring_services rs on rs.id = o.recurring_service_id
      join public.companies c on c.id = rs.company_id
      where o.sales_document_id is null
        and o.status in ('pending_invoice', 'invoiced', 'collected')
        and o.link_review is distinct from 'dismissed'
        and rs.requires_invoice
        and upper(coalesce(c.country, '')) = 'CL'
        and (p_company_id is null or rs.company_id = p_company_id)
        and (p_service_id is null or rs.id = p_service_id)
        and not exists (select 1 from public.sales_allocations a where a.recurring_service_period_id = o.id)
        -- Past cycles only: due up to the end of p_until's month.
        and coalesce(o.invoice_due_date, o.period)
            < (date_trunc('month', coalesce(p_until, current_date)) + interval '1 month')::date
    ),
    candidates as (
      select cy.id as occ_id, sd.id as doc_id
      from cycles cy
      join public.sales_documents sd
        on sd.company_id = cy.company_id
       and sd.client_id = cy.client_id
       and sd.document_type = 'invoice'
       and not sd.voided
       and sd.annulled_by_document_id is null
       and sd.currency = cy.currency
       and date_trunc('month', sd.document_date)::date = cy.invoice_month
       and abs(sd.net_amount - cy.amount) <= 0.02 * abs(cy.amount)
      where not exists (
        select 1 from public.recurring_service_occurrences o2
        where o2.sales_document_id = sd.id
      )
        and not exists (select 1 from public.sales_allocations a2 where a2.sales_document_id = sd.id)
    ),
    per_occ as (
      select occ_id, count(*) as n, min(doc_id::text)::uuid as doc_id
      from candidates
      group by occ_id
    ),
    per_doc as (
      select doc_id, count(*) as n
      from candidates
      group by doc_id
    )
    select
      cy.id,
      cy.status,
      cy.link_review,
      coalesce(po.n, 0) as n,
      po.doc_id,
      coalesce(pd.n, 0) as doc_claims
    from cycles cy
    left join per_occ po on po.occ_id = cy.id
    left join per_doc pd on pd.doc_id = po.doc_id
    order by cy.invoice_month, cy.id
  loop
    if v_row.n = 1 and v_row.doc_claims = 1 then
      v_status := public.link_recurring_service_occurrence_to_invoice(v_row.id, v_row.doc_id);
      occurrence_id := v_row.id;
      result := 'linked_' || v_status;
      sales_document_id := v_row.doc_id;
      return next;
    elsif v_row.n > 1 or v_row.doc_claims > 1 then
      if v_row.link_review is distinct from 'multiple' then
        update public.recurring_service_occurrences set link_review = 'multiple' where id = v_row.id;
      end if;
      occurrence_id := v_row.id;
      result := 'review_multiple';
      sales_document_id := null;
      return next;
    elsif v_row.status = 'pending_invoice' then
      if v_row.link_review is distinct from 'no_match' then
        update public.recurring_service_occurrences set link_review = 'no_match' where id = v_row.id;
      end if;
      occurrence_id := v_row.id;
      result := 'review_no_match';
      sales_document_id := null;
      return next;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Replace a document's allocations in one go (the invoice editor)
-- ---------------------------------------------------------------------
-- p_allocations: [{ "target_type": "period" | "quote", "target_id": uuid,
-- "amount": number, "status": "suggested" | "confirmed", "notes": text }].
create or replace function public.set_sales_allocations(
  p_sales_document_id uuid,
  p_allocations jsonb
)
returns setof public.sales_allocations
language plpgsql
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_doc record;
  v_item jsonb;
  v_amount numeric;
  v_total numeric := 0;
  v_type text;
  v_status text;
  v_tolerance numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required to allocate a sales document';
  end if;

  select id, company_id, net_amount, currency, document_type, voided, annulled_by_document_id
  into v_doc
  from public.sales_documents
  where id = p_sales_document_id
  for update;

  if v_doc.id is null then
    raise exception 'Sales document not found';
  end if;

  if v_doc.document_type = 'credit_note' or v_doc.voided or v_doc.annulled_by_document_id is not null then
    raise exception 'This document cannot be allocated';
  end if;

  if jsonb_typeof(coalesce(p_allocations, '[]'::jsonb)) <> 'array' then
    raise exception 'Allocations must be a list';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_amount := (v_item ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Every allocation needs an amount greater than zero';
    end if;
    v_type := v_item ->> 'target_type';
    if v_type not in ('period', 'quote') or nullif(v_item ->> 'target_id', '') is null then
      raise exception 'Every allocation needs a destination';
    end if;
    v_total := v_total + v_amount;
  end loop;

  v_tolerance := case when v_doc.currency = 'CLP' then 0.5 else 0.005 end;
  if v_total > v_doc.net_amount + v_tolerance then
    raise exception 'The allocations (%) exceed the net amount of the document (%)', v_total, v_doc.net_amount;
  end if;

  delete from public.sales_allocations where sales_document_id = p_sales_document_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_type := v_item ->> 'target_type';
    v_status := coalesce(nullif(v_item ->> 'status', ''), 'confirmed');
    if v_status not in ('suggested', 'confirmed') then
      raise exception 'Unknown allocation status %', v_status;
    end if;

    insert into public.sales_allocations (
      company_id, sales_document_id, recurring_service_period_id, project_quote_id,
      amount, status, notes, created_by, updated_by
    )
    values (
      v_doc.company_id,
      p_sales_document_id,
      case when v_type = 'period' then (v_item ->> 'target_id')::uuid end,
      case when v_type = 'quote' then (v_item ->> 'target_id')::uuid end,
      (v_item ->> 'amount')::numeric,
      v_status,
      nullif(btrim(coalesce(v_item ->> 'notes', '')), ''),
      v_user_id,
      v_user_id
    );
  end loop;

  -- A document left without any quote allocation leaves its job.
  perform public.sync_sales_document_project(p_sales_document_id);

  return query
    select * from public.sales_allocations where sales_document_id = p_sales_document_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. MS licenses pool: split by what each period actually billed (the
--    expected amount while it has not been billed yet)
-- ---------------------------------------------------------------------
create or replace function public.allocate_recurring_service_cost_pool(p_cost_pool_id uuid)
returns setof public.recurring_service_cost_allocations
language plpgsql
as $$
declare
  v_pool public.recurring_service_cost_pools;
  v_scale numeric;
  v_total_client_amount numeric;
  v_total_units numeric;
begin
  select * into v_pool
  from public.recurring_service_cost_pools
  where id = p_cost_pool_id;

  if v_pool is null then
    raise exception 'Cost pool not found';
  end if;

  if v_pool.total_expense_amount < 0 then
    raise exception 'The cost pool total cannot be negative';
  end if;

  if exists (
    select 1 from public.recurring_service_cost_allocations
    where cost_pool_id = p_cost_pool_id
  ) then
    raise exception 'This cost pool has already been allocated';
  end if;

  select coalesce(sum(greatest(coalesce(
    nullif(public.recurring_service_period_billed_amount(o.id), 0), o.amount), 0)), 0)
  into v_total_client_amount
  from public.recurring_service_occurrences o
  join public.recurring_services rs on rs.id = o.recurring_service_id
  where rs.company_id = v_pool.company_id
    and rs.service_type = v_pool.service_type
    and o.period = v_pool.period
    and o.currency = v_pool.currency
    and o.status <> 'void';

  if v_total_client_amount = 0 then
    raise exception 'No occurrences found to allocate this cost pool against';
  end if;

  -- CLP: whole pesos; UYU / USD: cents (mirrors web/src/lib/currencies.ts).
  v_scale := case when v_pool.currency = 'CLP' then 1 else 100 end;
  v_total_units := v_pool.total_expense_amount * v_scale;

  insert into public.recurring_service_cost_allocations (
    cost_pool_id,
    occurrence_id,
    allocated_amount,
    currency
  )
  with cohort as (
    select
      o.id,
      greatest(coalesce(nullif(public.recurring_service_period_billed_amount(o.id), 0), o.amount), 0) as amount
    from public.recurring_service_occurrences o
    join public.recurring_services rs on rs.id = o.recurring_service_id
    where rs.company_id = v_pool.company_id
      and rs.service_type = v_pool.service_type
      and o.period = v_pool.period
      and o.currency = v_pool.currency
      and o.status <> 'void'
  ),
  exact as (
    select id, amount, v_total_units * amount / v_total_client_amount as units
    from cohort
  ),
  floored as (
    select id, amount, floor(units) as base, units - floor(units) as fraction
    from exact
  ),
  ranked as (
    select
      floored.*,
      row_number() over (order by (amount > 0) desc, fraction desc, amount desc, id) as rank
    from floored
  ),
  leftover as (
    select v_total_units - sum(base) as units from floored
  )
  select
    p_cost_pool_id,
    ranked.id,
    (
      ranked.base
      -- one whole unit each to the largest remainders
      + case when ranked.amount > 0 and ranked.rank <= floor(leftover.units) then 1 else 0 end
      -- a total with more decimals than the currency's: the sub-unit rest
      -- goes to the first-ranked part, so the sum stays exact
      + case when ranked.rank = 1 then leftover.units - floor(leftover.units) else 0 end
    ) / v_scale,
    v_pool.currency
  from ranked
  cross join leftover;

  return query
    select * from public.recurring_service_cost_allocations
    where cost_pool_id = p_cost_pool_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 10. Backfill: existing links become confirmed allocations
-- ---------------------------------------------------------------------
-- a) Cycle <-> invoice (recurring_service_occurrences.sales_document_id).
--    One document linked to several cycles is split in proportion to
--    their expected amounts, the last one taking the rounding rest, so
--    the document is allocated at exactly 100%.
insert into public.sales_allocations (
  company_id, sales_document_id, recurring_service_period_id, amount, status, notes
)
with linked as (
  select
    o.id as occurrence_id,
    greatest(o.amount, 0) as occurrence_amount,
    sd.id as document_id,
    sd.company_id,
    sd.net_amount,
    case when sd.currency = 'CLP' then 0 else 2 end as decimals,
    count(*) over (partition by sd.id) as n,
    sum(greatest(o.amount, 0)) over (partition by sd.id) as total_amount,
    row_number() over (partition by sd.id order by o.period, o.id) as rn
  from public.recurring_service_occurrences o
  join public.sales_documents sd on sd.id = o.sales_document_id
  where o.status <> 'void'
    and not sd.voided
    and sd.annulled_by_document_id is null
    and sd.document_type <> 'credit_note'
    and sd.net_amount > 0
),
shares as (
  select
    linked.*,
    case
      when n = 1 then net_amount
      when total_amount > 0 then round(net_amount * occurrence_amount / total_amount, decimals)
      else round(net_amount / n, decimals)
    end as share
  from linked
),
final as (
  select
    shares.*,
    case
      when rn = n then net_amount - coalesce(
        sum(share) over (partition by document_id order by rn rows between unbounded preceding and 1 preceding),
        0
      )
      else share
    end as final_amount
  from shares
)
select company_id, document_id, occurrence_id, final_amount, 'confirmed', 'Migrada del vínculo ciclo ↔ factura'
from final
where final_amount > 0;

-- b) Documents generated by the old Epic 5.1 button
--    (sales_documents.recurring_service_id + recurring_period).
insert into public.sales_allocations (
  company_id, sales_document_id, recurring_service_period_id, amount, status, notes
)
select sd.company_id, sd.id, o.id, sd.net_amount, 'confirmed', 'Migrada del documento generado por el servicio'
from public.sales_documents sd
join public.recurring_service_occurrences o
  on o.recurring_service_id = sd.recurring_service_id
 and o.period = sd.recurring_period
where sd.recurring_service_id is not null
  and o.status <> 'void'
  and not sd.voided
  and sd.annulled_by_document_id is null
  and sd.document_type <> 'credit_note'
  and sd.net_amount > 0
  and not exists (select 1 from public.sales_allocations a where a.sales_document_id = sd.id)
  and not exists (select 1 from public.sales_allocations a where a.recurring_service_period_id = o.id);

-- c) Document <-> job (sales_documents.project_id): to the job's main
--    quote (a placeholder one when the job has no quote number), for
--    whatever the document still has unallocated.
insert into public.sales_allocations (
  company_id, sales_document_id, project_quote_id, amount, status, notes
)
select
  sd.company_id,
  sd.id,
  public.project_default_quote_id(sd.project_id),
  sd.net_amount - coalesce((
    select sum(a.amount) from public.sales_allocations a where a.sales_document_id = sd.id
  ), 0),
  'confirmed',
  'Migrada del vínculo factura ↔ trabajo'
from public.sales_documents sd
where sd.project_id is not null
  and not sd.voided
  and sd.annulled_by_document_id is null
  and sd.document_type <> 'credit_note'
  and sd.net_amount - coalesce((
    select sum(a.amount) from public.sales_allocations a where a.sales_document_id = sd.id
  ), 0) > 0;

-- The reverse-direction triggers, now that the backfill is in.
create trigger recurring_service_occurrences_sync_allocations
  after update of sales_document_id on public.recurring_service_occurrences
  for each row
  execute function public.recurring_service_occurrences_sync_allocations();

create trigger sales_documents_sync_project_allocation
  after insert or update of project_id on public.sales_documents
  for each row
  execute function public.sales_documents_sync_project_allocation();

-- Periods from September 2026 through next month for every active service.
select public.ensure_recurring_service_periods(c.id, (current_date + interval '1 month')::date)
from public.companies c;

-- ---------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------
grant select, insert, update, delete on public.sales_allocations to authenticated, service_role;
grant select on public.sales_document_allocation_summary to authenticated, service_role;
grant select on public.recurring_service_period_summary to authenticated, service_role;
grant select on public.project_quote_billing_summary to authenticated, service_role;

revoke execute on function public.ensure_recurring_service_periods(uuid, date) from public, anon;
grant execute on function public.ensure_recurring_service_periods(uuid, date) to authenticated, service_role;

revoke execute on function public.project_default_quote_id(uuid) from public, anon;
grant execute on function public.project_default_quote_id(uuid) to authenticated, service_role;

revoke execute on function public.recurring_service_period_billed_amount(uuid) from public, anon;
grant execute on function public.recurring_service_period_billed_amount(uuid) to authenticated, service_role;

revoke execute on function public.refresh_recurring_service_occurrence_billing(uuid, boolean) from public, anon;
grant execute on function public.refresh_recurring_service_occurrence_billing(uuid, boolean) to authenticated, service_role;

revoke execute on function public.sync_sales_document_project(uuid) from public, anon;
grant execute on function public.sync_sales_document_project(uuid) to authenticated, service_role;

revoke execute on function public.suggest_sales_allocations(uuid, uuid[]) from public, anon;
grant execute on function public.suggest_sales_allocations(uuid, uuid[]) to authenticated, service_role;

revoke execute on function public.suggest_sales_allocations_for_import_batch(uuid) from public, anon;
grant execute on function public.suggest_sales_allocations_for_import_batch(uuid) to authenticated, service_role;

revoke execute on function public.set_sales_allocations(uuid, jsonb) from public, anon;
grant execute on function public.set_sales_allocations(uuid, jsonb) to authenticated, service_role;
