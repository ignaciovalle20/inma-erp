-- Costs of recurring services (prompt_costos_servicios_recurrentes.md,
-- docs/servicios-recurrentes-costos.md).
--
-- 1. "Costo esperado" (expected_cost) goes away: its value moves to the
--    fixed cost where the service had none (non-pool services only).
-- 2. The fixed cost gets its own frequency (fixed_monthly_cost ->
--    fixed_cost + cost_periodicity), independent of how the service is
--    sold, and the service can name its supplier.
-- 3. recurring_service_cost_periods: one row per service and cost period
--    (each month, or each anniversary for an annual cost), with the expected
--    amount as a snapshot of the fixed cost.
-- 4. cost_service_allocations: purchase invoices (cost_documents) allocated
--    to cost periods, the model of sales_allocations. A cost document
--    allocated to services is neither a job's cost, nor split with
--    cost_allocations, nor covered by the MS licenses pool.
-- MS licenses pools (uses_cost_pool) are untouched: a pooled service has no
-- cost periods.

-- ---------------------------------------------------------------------
-- 1. expected_cost -> fixed cost
-- ---------------------------------------------------------------------
-- expected_cost was the cost per billing period: for an annual service it
-- was the cost of the year (e.g. an annual hosting sold at 79.990 with an
-- expected cost of 50.000). Its frequency is therefore the service's own.
alter table public.recurring_services
  add column cost_periodicity text not null default 'monthly'
    check (cost_periodicity in ('monthly', 'annual'));

-- updated_at stays as it was: this is a data move, not an edit.
alter table public.recurring_services disable trigger recurring_services_set_updated_at;

update public.recurring_services
set fixed_monthly_cost = expected_cost,
    cost_periodicity = periodicity
where fixed_monthly_cost is null
  and expected_cost > 0
  and not uses_cost_pool;

-- A domain is bought for a year.
update public.recurring_services
set cost_periodicity = 'annual'
where service_type = 'domain'
  and expected_cost = 0;

alter table public.recurring_services enable trigger recurring_services_set_updated_at;

alter table public.recurring_services drop column expected_cost;

-- ---------------------------------------------------------------------
-- 2. fixed_cost, cost_periodicity, supplier
-- ---------------------------------------------------------------------
alter table public.recurring_services rename column fixed_monthly_cost to fixed_cost;

comment on column public.recurring_services.fixed_cost is
  'Fixed cost of the service, net of VAT, per cost period (cost_periodicity). Pre-fills each cost period''s expected amount; an invoice allocated to the period replaces it.';
comment on column public.recurring_services.cost_periodicity is
  'How often the fixed cost is paid: monthly (every month the service is active) or annual (each anniversary of start_date). Independent of periodicity (how it is sold).';

alter table public.recurring_services
  add constraint recurring_services_fixed_cost_non_negative check (fixed_cost is null or fixed_cost >= 0);

alter table public.recurring_services
  add column supplier_id uuid references public.suppliers (id);

create index recurring_services_supplier_id_idx
  on public.recurring_services (supplier_id)
  where supplier_id is not null;

-- Same company, and an active supplier when it is chosen (a supplier that
-- becomes inactive later stays on the service).
create or replace function public.recurring_services_validate_supplier()
returns trigger
language plpgsql
as $$
declare
  v_supplier record;
begin
  if new.supplier_id is null then
    return new;
  end if;

  select company_id, active into v_supplier
  from public.suppliers
  where id = new.supplier_id;

  if v_supplier.company_id is null or v_supplier.company_id <> new.company_id then
    raise exception 'supplier_id must belong to the same company as the recurring service';
  end if;

  if (tg_op = 'INSERT' or new.supplier_id is distinct from old.supplier_id) and not v_supplier.active then
    raise exception 'El proveedor elegido está inactivo';
  end if;

  return new;
end;
$$;

create trigger recurring_services_validate_supplier
  before insert or update on public.recurring_services
  for each row
  execute function public.recurring_services_validate_supplier();

-- The calendar day where the company operates (America/Santiago for CL,
-- America/Montevideo otherwise), like list_projects / todayForCountry.
create or replace function public.company_local_date(p_company_id uuid)
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone coalesce(
    (select case upper(coalesce(c.country, '')) when 'CL' then 'America/Santiago' else 'America/Montevideo' end
     from public.companies c where c.id = p_company_id),
    'America/Montevideo'
  ))::date;
$$;

-- ---------------------------------------------------------------------
-- 3. recurring_service_cost_periods
-- ---------------------------------------------------------------------
create table public.recurring_service_cost_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  recurring_service_id uuid not null references public.recurring_services (id) on delete cascade,
  -- Day 1 of the month (annual cost: the month of the anniversary).
  period date not null check (extract(day from period) = 1),
  -- Snapshot of fixed_cost when created; editable. Net of VAT.
  expected_amount numeric not null default 0 check (expected_amount >= 0),
  currency text not null check (currency in ('CLP', 'UYU', 'USD')),
  exchange_rate numeric,
  exchange_rate_period date,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  constraint recurring_service_cost_periods_service_period_unique unique (recurring_service_id, period)
);

create index recurring_service_cost_periods_company_period_idx
  on public.recurring_service_cost_periods (company_id, period);

create trigger recurring_service_cost_periods_set_updated_at
  before update on public.recurring_service_cost_periods
  for each row
  execute function public.set_updated_at();

alter table public.recurring_service_cost_periods enable row level security;

create policy "Members can view recurring service cost periods"
  on public.recurring_service_cost_periods
  for select
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = recurring_service_cost_periods.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create recurring service cost periods"
  on public.recurring_service_cost_periods
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = recurring_service_cost_periods.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update recurring service cost periods"
  on public.recurring_service_cost_periods
  for update
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = recurring_service_cost_periods.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = recurring_service_cost_periods.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete recurring service cost periods"
  on public.recurring_service_cost_periods
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = recurring_service_cost_periods.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Same company as its service; the currency is always the service's.
create or replace function public.recurring_service_cost_periods_validate()
returns trigger
language plpgsql
as $$
declare
  v_service record;
begin
  select company_id, currency into v_service
  from public.recurring_services
  where id = new.recurring_service_id;

  if v_service.company_id is null or v_service.company_id <> new.company_id then
    raise exception 'recurring_service_id must belong to the same company as the cost period';
  end if;

  new.currency := v_service.currency;
  return new;
end;
$$;

create trigger recurring_service_cost_periods_validate
  before insert or update on public.recurring_service_cost_periods
  for each row
  execute function public.recurring_service_cost_periods_validate();

-- Stored exchange rate of the period's month, like every other document
-- (20261004030000).
create or replace function public.recurring_service_cost_periods_set_exchange_rate()
returns trigger
language plpgsql
as $$
declare
  v_company_currency text;
begin
  select currency into v_company_currency from public.companies where id = new.company_id;
  select r.rate, r.period into new.exchange_rate, new.exchange_rate_period
  from public.document_exchange_rate(
    v_company_currency, new.currency, new.period,
    case when tg_op = 'UPDATE' then old.currency end,
    case when tg_op = 'UPDATE' then old.period end,
    case when tg_op = 'UPDATE' then old.exchange_rate end,
    case when tg_op = 'UPDATE' then old.exchange_rate_period end,
    tg_op = 'INSERT'
  ) r;
  return new;
end;
$$;

create trigger recurring_service_cost_periods_zz_set_exchange_rate
  before insert or update on public.recurring_service_cost_periods
  for each row
  execute function public.recurring_service_cost_periods_set_exchange_rate();

-- Creates every missing cost period of the active, non-pooled services that
-- have a fixed cost or a supplier, from max(start, January 2026) through
-- p_until's month (default: today where the company operates), never past
-- end_date. Monthly cost: every month; annual cost: each anniversary of
-- start_date (the month it falls in). Idempotent; never touches existing
-- periods. Returns how many it created.
create or replace function public.generate_recurring_service_cost_periods(
  p_company_id uuid default null,
  p_service_id uuid default null,
  p_until date default null
)
returns integer
language plpgsql
set search_path = public
as $$
declare
  c_first_month constant date := date '2026-01-01';
  v_service record;
  v_until date;
  v_month date;
  v_years int;
  v_anniversary date;
  v_count int := 0;
  v_new uuid;
begin
  for v_service in
    select *
    from public.recurring_services
    where status = 'active'
      and not uses_cost_pool
      and (fixed_cost is not null or supplier_id is not null)
      and (p_company_id is null or company_id = p_company_id)
      and (p_service_id is null or id = p_service_id)
  loop
    v_until := date_trunc('month', coalesce(p_until, public.company_local_date(v_service.company_id)))::date;

    if v_service.cost_periodicity = 'monthly' then
      v_month := greatest(date_trunc('month', v_service.start_date)::date, c_first_month);
      while v_month <= v_until
            and (v_service.end_date is null or v_month <= v_service.end_date) loop
        v_new := null;
        insert into public.recurring_service_cost_periods (
          company_id, recurring_service_id, period, expected_amount, currency
        )
        values (
          v_service.company_id, v_service.id, v_month, coalesce(v_service.fixed_cost, 0), v_service.currency
        )
        on conflict (recurring_service_id, period) do nothing
        returning id into v_new;
        if v_new is not null then v_count := v_count + 1; end if;
        v_month := (v_month + interval '1 month')::date;
      end loop;
    else
      v_years := 0;
      loop
        v_anniversary := (v_service.start_date + make_interval(years => v_years))::date;
        v_month := date_trunc('month', v_anniversary)::date;
        exit when v_month > v_until;
        exit when v_service.end_date is not null and v_anniversary > v_service.end_date;
        if v_month >= c_first_month then
          v_new := null;
          insert into public.recurring_service_cost_periods (
            company_id, recurring_service_id, period, expected_amount, currency
          )
          values (
            v_service.company_id, v_service.id, v_month, coalesce(v_service.fixed_cost, 0), v_service.currency
          )
          on conflict (recurring_service_id, period) do nothing
          returning id into v_new;
          if v_new is not null then v_count := v_count + 1; end if;
        end if;
        v_years := v_years + 1;
      end loop;
    end if;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. cost_service_allocations
-- ---------------------------------------------------------------------
create table public.cost_service_allocations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  cost_document_id uuid not null references public.cost_documents (id) on delete cascade,
  cost_period_id uuid not null references public.recurring_service_cost_periods (id) on delete cascade,
  -- Net, in the cost document's currency.
  amount numeric not null check (amount > 0),
  status text not null default 'confirmed' check (status in ('suggested', 'confirmed')),
  suggestion_reason text check (suggestion_reason in ('exact', 'same_amount_batch', 'proportional')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid(),
  constraint cost_service_allocations_document_period_unique unique (cost_document_id, cost_period_id)
);

create index cost_service_allocations_company_idx on public.cost_service_allocations (company_id);
create index cost_service_allocations_period_idx on public.cost_service_allocations (cost_period_id);

create trigger cost_service_allocations_set_updated_at
  before update on public.cost_service_allocations
  for each row
  execute function public.set_updated_at();

alter table public.cost_service_allocations enable row level security;

create policy "Members can view their company's cost service allocations"
  on public.cost_service_allocations
  for select
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = cost_service_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create cost service allocations for their company"
  on public.cost_service_allocations
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = cost_service_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's cost service allocations"
  on public.cost_service_allocations
  for update
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = cost_service_allocations.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = cost_service_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete their company's cost service allocations"
  on public.cost_service_allocations
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.company_memberships cm
      where cm.company_id = cost_service_allocations.company_id
        and cm.user_id = auth.uid()
    )
  );

-- What a cost document has allocated to services (confirmed), in its own
-- currency. Computed column: reports read it like covered_by_cost_pool_id.
create or replace function public.service_allocated_amount(public.cost_documents)
returns numeric
language sql
stable
as $$
  select coalesce(sum(a.amount), 0)
  from public.cost_service_allocations a
  where a.cost_document_id = $1.id
    and a.status = 'confirmed';
$$;

-- A document allocated to services is not "covered by the MS pool": its
-- cost is the services' (one place only). Same body as 20261004050000
-- plus that exclusion.
create or replace function public.covered_by_cost_pool_id(public.cost_documents)
returns uuid
language sql
stable
as $function$
  select p.id
  from public.recurring_service_cost_pools p
  where p.company_id = $1.company_id
    and p.service_type = 'ms_licenses'
    and p.period = coalesce($1.recognized_period, date_trunc('month', $1.document_date)::date)
    and not exists (
      select 1 from public.cost_service_allocations a
      where a.cost_document_id = $1.id and a.status = 'confirmed'
    )
    -- Never a document attributed to a job or area outside the licenses area.
    and not exists (
      select 1
      from public.projects pr
      where pr.id = $1.project_id
        and not public.is_ms_licenses_area(pr.business_area_id)
    )
    and not exists (
      select 1
      from public.cost_allocations ca
      left join public.projects pr on pr.id = ca.project_id
      where ca.cost_document_id = $1.id
        and (
          (ca.business_area_id is not null and not public.is_ms_licenses_area(ca.business_area_id))
          or (ca.project_id is not null and not public.is_ms_licenses_area(pr.business_area_id))
        )
    )
    and (
      (p.supplier_id is not null and p.supplier_id = $1.supplier_id)
      or exists (
        select 1
        from public.projects pr
        where pr.id = $1.project_id
          and public.is_ms_licenses_area(pr.business_area_id)
      )
      or exists (
        select 1
        from public.cost_allocations ca
        left join public.projects pr on pr.id = ca.project_id
        where ca.cost_document_id = $1.id
          and (
            public.is_ms_licenses_area(ca.business_area_id)
            or public.is_ms_licenses_area(pr.business_area_id)
          )
      )
    )
  order by p.created_at, p.id
  limit 1;
$function$;

-- Same company everywhere; the document is a general cost without a job,
-- without cost_allocations and not covered by the MS pool; a pooled
-- service never takes invoices this way; confirmed allocations never add
-- up to more than the document's net (half a peso / cent of rounding).
create or replace function public.cost_service_allocations_validate()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_doc public.cost_documents;
  v_period record;
  v_other numeric;
  v_tolerance numeric;
begin
  select * into v_doc from public.cost_documents where id = new.cost_document_id;

  if v_doc.id is null then
    raise exception 'Cost document not found';
  end if;

  if v_doc.company_id <> new.company_id then
    raise exception 'cost_document_id must belong to the same company as the allocation';
  end if;

  select cp.company_id, rs.uses_cost_pool into v_period
  from public.recurring_service_cost_periods cp
  join public.recurring_services rs on rs.id = cp.recurring_service_id
  where cp.id = new.cost_period_id;

  if v_period.company_id is distinct from new.company_id then
    raise exception 'cost_period_id must belong to the same company as the allocation';
  end if;

  if v_period.uses_cost_pool then
    raise exception 'Un servicio con pool de licencias no recibe facturas por esta vía';
  end if;

  if v_doc.project_id is not null or v_doc.classification <> 'general' then
    raise exception 'Este costo ya está asignado a un trabajo: no se puede asignar además a servicios';
  end if;

  if exists (select 1 from public.cost_allocations ca where ca.cost_document_id = v_doc.id) then
    raise exception 'Este costo ya está dividido entre trabajos, clientes o áreas: no se puede asignar además a servicios';
  end if;

  if new.status = 'confirmed' and public.covered_by_cost_pool_id(v_doc) is not null then
    raise exception 'Este costo está cubierto por el reparto de licencias MS: no se puede asignar además a servicios';
  end if;

  if new.status = 'confirmed' then
    select coalesce(sum(a.amount), 0) into v_other
    from public.cost_service_allocations a
    where a.cost_document_id = new.cost_document_id
      and a.status = 'confirmed'
      and a.id <> new.id;

    v_tolerance := case when v_doc.currency = 'CLP' then 0.5 else 0.005 end;

    if v_other + new.amount > v_doc.net_amount + v_tolerance then
      raise exception 'Las asignaciones a servicios (%) superan el neto del costo (%)',
        v_other + new.amount, v_doc.net_amount;
    end if;
  end if;

  return new;
end;
$$;

create trigger cost_service_allocations_validate
  before insert or update on public.cost_service_allocations
  for each row
  execute function public.cost_service_allocations_validate();

-- The other direction: a document allocated to services can't then go to a
-- job or be split. Its pending suggestions go away when it does.
create or replace function public.cost_documents_guard_service_allocations()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.project_id is not null or new.classification <> 'general')
     and exists (
       select 1 from public.cost_service_allocations a
       where a.cost_document_id = new.id and a.status = 'confirmed'
     ) then
    raise exception 'Este costo está asignado a servicios recurrentes: quitá esas asignaciones antes de asignarlo a un trabajo';
  end if;

  if new.project_id is not null or new.classification <> 'general' then
    delete from public.cost_service_allocations a
    where a.cost_document_id = new.id and a.status = 'suggested';
  end if;

  return new;
end;
$$;

create trigger cost_documents_guard_service_allocations
  before update of project_id, classification on public.cost_documents
  for each row
  execute function public.cost_documents_guard_service_allocations();

create or replace function public.cost_allocations_guard_service_allocations()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.cost_service_allocations a
    where a.cost_document_id = new.cost_document_id and a.status = 'confirmed'
  ) then
    raise exception 'Este costo está asignado a servicios recurrentes: quitá esas asignaciones antes de dividirlo';
  end if;

  delete from public.cost_service_allocations a
  where a.cost_document_id = new.cost_document_id and a.status = 'suggested';

  return new;
end;
$$;

create trigger cost_allocations_guard_service_allocations
  before insert on public.cost_allocations
  for each row
  execute function public.cost_allocations_guard_service_allocations();

-- Replaces every service allocation of a cost document in one go (the
-- editor). p_allocations: [{ "cost_period_id": uuid, "amount": number,
-- "status": "suggested"|"confirmed", "suggestion_reason": text, "notes": text }].
create or replace function public.set_cost_service_allocations(
  p_cost_document_id uuid,
  p_allocations jsonb
)
returns setof public.cost_service_allocations
language plpgsql
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_doc public.cost_documents;
  v_item jsonb;
  v_amount numeric;
  v_total numeric := 0;
  v_status text;
  v_tolerance numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication required to allocate a cost document';
  end if;

  select * into v_doc
  from public.cost_documents
  where id = p_cost_document_id
  for update;

  if v_doc.id is null then
    raise exception 'Cost document not found';
  end if;

  if jsonb_typeof(coalesce(p_allocations, '[]'::jsonb)) <> 'array' then
    raise exception 'Allocations must be a list';
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_amount := (v_item ->> 'amount')::numeric;
    if v_amount is null or v_amount <= 0 then
      raise exception 'Cada asignación necesita un monto mayor que cero';
    end if;
    if nullif(v_item ->> 'cost_period_id', '') is null then
      raise exception 'Cada asignación necesita un período de costo';
    end if;
    v_status := coalesce(nullif(v_item ->> 'status', ''), 'confirmed');
    if v_status not in ('suggested', 'confirmed') then
      raise exception 'Unknown allocation status %', v_status;
    end if;
    if v_status = 'confirmed' then
      v_total := v_total + v_amount;
    end if;
  end loop;

  v_tolerance := case when v_doc.currency = 'CLP' then 0.5 else 0.005 end;
  if v_total > v_doc.net_amount + v_tolerance then
    raise exception 'Las asignaciones a servicios (%) superan el neto del costo (%)', v_total, v_doc.net_amount;
  end if;

  delete from public.cost_service_allocations where cost_document_id = p_cost_document_id;

  insert into public.cost_service_allocations (
    company_id, cost_document_id, cost_period_id, amount, status, suggestion_reason, notes, created_by, updated_by
  )
  select
    v_doc.company_id,
    p_cost_document_id,
    (item ->> 'cost_period_id')::uuid,
    (item ->> 'amount')::numeric,
    coalesce(nullif(item ->> 'status', ''), 'confirmed'),
    nullif(item ->> 'suggestion_reason', ''),
    nullif(btrim(coalesce(item ->> 'notes', '')), ''),
    v_user_id,
    v_user_id
  from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) as item;

  return query
    select * from public.cost_service_allocations where cost_document_id = p_cost_document_id;
end;
$$;

-- What each cost period costs: its confirmed invoices, or its expected
-- amount while it has none (an estimate).
create view public.recurring_service_cost_period_summary
with (security_invoker = true) as
select
  cp.id as cost_period_id,
  cp.recurring_service_id,
  cp.company_id,
  rs.client_id,
  rs.supplier_id,
  rs.business_area_id,
  rs.uses_cost_pool,
  cp.period,
  cp.currency,
  cp.expected_amount,
  coalesce(b.confirmed_amount, 0) as invoiced_amount,
  coalesce(b.suggested_amount, 0) as suggested_amount,
  coalesce(b.confirmed_count, 0) as confirmed_count,
  coalesce(b.suggested_count, 0) as suggested_count,
  case when coalesce(b.confirmed_count, 0) > 0 then 'invoiced' else 'estimated' end as cost_status
from public.recurring_service_cost_periods cp
join public.recurring_services rs on rs.id = cp.recurring_service_id
left join lateral (
  select
    sum(a.amount) filter (where a.status = 'confirmed' and cd.currency = cp.currency) as confirmed_amount,
    sum(a.amount) filter (where a.status = 'suggested' and cd.currency = cp.currency) as suggested_amount,
    count(*) filter (where a.status = 'confirmed') as confirmed_count,
    count(*) filter (where a.status = 'suggested') as suggested_count
  from public.cost_service_allocations a
  join public.cost_documents cd on cd.id = a.cost_document_id
  where a.cost_period_id = cp.id
) b on true;

-- ---------------------------------------------------------------------
-- 5. When the service changes
-- ---------------------------------------------------------------------
-- A new fixed cost only re-estimates this month's and later periods that
-- have no invoice; past periods keep what they were. A new frequency drops
-- this month's and later periods without allocations so they are made
-- again with it. Periods are (re)generated after any change.
create or replace function public.recurring_services_sync_cost_periods()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_current_month date := date_trunc('month', public.company_local_date(new.company_id))::date;
begin
  if new.cost_periodicity is distinct from old.cost_periodicity then
    delete from public.recurring_service_cost_periods cp
    where cp.recurring_service_id = new.id
      and cp.period >= v_current_month
      and not exists (select 1 from public.cost_service_allocations a where a.cost_period_id = cp.id);
  elsif new.fixed_cost is distinct from old.fixed_cost then
    update public.recurring_service_cost_periods cp
    set expected_amount = coalesce(new.fixed_cost, 0)
    where cp.recurring_service_id = new.id
      and cp.period >= v_current_month
      and not exists (select 1 from public.cost_service_allocations a where a.cost_period_id = cp.id);
  end if;

  perform public.generate_recurring_service_cost_periods(new.company_id, new.id, null);
  return null;
end;
$$;

create trigger recurring_services_sync_cost_periods
  after update of fixed_cost, cost_periodicity, supplier_id, uses_cost_pool, status, start_date, end_date
  on public.recurring_services
  for each row
  execute function public.recurring_services_sync_cost_periods();

create or replace function public.recurring_services_create_cost_periods()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.generate_recurring_service_cost_periods(new.company_id, new.id, null);
  return null;
end;
$$;

create trigger recurring_services_create_cost_periods
  after insert on public.recurring_services
  for each row
  execute function public.recurring_services_create_cost_periods();

-- ---------------------------------------------------------------------
-- 6. Generation hooks: the module opening a month and the monthly cron
-- ---------------------------------------------------------------------
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
  -- Cost periods never go past today's month.
  perform public.generate_recurring_service_cost_periods(p_company_id, null, null);
  return v_count;
end;
$$;

create or replace function public.generate_due_recurring_service_occurrences()
returns table (occurrence_id uuid, service_id uuid, occurrence_period date)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.generate_recurring_service_cost_periods(null, null, null);
  return query
    select g.occurrence_id, g.service_id, g.occurrence_period
    from public.generate_recurring_service_occurrences_for_month(current_date, null, null) g;
end;
$$;

-- Backfill: cost periods from January 2026 through this month.
select public.generate_recurring_service_cost_periods(null, null, null);

-- ---------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------
grant select, insert, update, delete on public.recurring_service_cost_periods to authenticated, service_role;
grant select, insert, update, delete on public.cost_service_allocations to authenticated, service_role;
grant select on public.recurring_service_cost_period_summary to authenticated, service_role;

revoke execute on function public.generate_recurring_service_cost_periods(uuid, uuid, date) from public, anon;
grant execute on function public.generate_recurring_service_cost_periods(uuid, uuid, date) to authenticated, service_role;
revoke execute on function public.set_cost_service_allocations(uuid, jsonb) from public, anon;
grant execute on function public.set_cost_service_allocations(uuid, jsonb) to authenticated, service_role;
revoke execute on function public.company_local_date(uuid) from public, anon;
grant execute on function public.company_local_date(uuid) to authenticated, service_role;
revoke execute on function public.ensure_recurring_service_periods(uuid, date) from public, anon;
grant execute on function public.ensure_recurring_service_periods(uuid, date) to authenticated, service_role;
revoke execute on function public.generate_due_recurring_service_occurrences() from public, anon, authenticated;
grant execute on function public.generate_due_recurring_service_occurrences() to service_role;
