-- MS licenses split per invoice (fix-ms-invoice 2026-11, audit/INFORME_MATEMATICA_2026-11.md §9).
--
-- The split proposed by 20261108020000 added up every Intcomex (Chile) / TGM
-- (Uruguay) document of the month that was not assigned to a job. Intcomex
-- also bills hardware and other general costs, so the proposal took them as
-- licenses (January 2026: the licenses invoice FAC-EL 3628064 has a net of
-- 298.762 and the month's proposal was 1.065.257).
--
-- Now a pool can be tied to ONE cost document, its licenses invoice:
--   * recurring_service_cost_pools.cost_document_id: the invoice the pool
--     splits; the pool's total is that invoice's net.
--   * covered_by_cost_pool_id: a pool with an invoice covers only that
--     invoice. A pool without one (typed by hand) keeps the month rule of
--     20261020010000.
--   * create_ms_license_pool_for_invoice(document, allow_second): "Es factura
--     de licencias MS -> repartir". A second licenses invoice of the same
--     supplier and month needs allow_second (a re-billing, for example).
--   * ms_license_invoices(company): the supplier's documents from 2026-01, the
--     ones already split, and the suggested licenses invoice of each
--     supplier-month that has none (not assigned, net closest to the last
--     licenses invoice of the supplier; without one, the first of the month).
--   * undo_recurring_service_cost_pool(pool): "Deshacer reparto" (members
--     have no DELETE on pools or shares).
--   * reallocate_recurring_service_cost_pool: a pool with an invoice takes
--     that invoice's current net before splitting again.
--   * An invoice that has its split cannot be assigned to a job, split with
--     cost_allocations, moved to another month or currency, or deleted until
--     its split is undone (its cost would be counted twice or nowhere).
--   * The month's summing functions (ms_license_pool_months,
--     create_ms_license_pool_for_month) are dropped.
--
-- Data: the existing MS pools that cover exactly one document whose net is
-- the pool's total get that document as their invoice (prod: Chile 2026-11,
-- FAC-EL 3800929, 1.036.626). Same coverage, same amounts; updated_at and the
-- exchange rate are left as they were (user triggers off).

-- ---------------------------------------------------------------------
-- 1. The pool's invoice
-- ---------------------------------------------------------------------
alter table public.recurring_service_cost_pools
  add column cost_document_id uuid references public.cost_documents (id);

comment on column public.recurring_service_cost_pools.cost_document_id is
  'The MS licenses invoice this pool splits (its net is the pool''s total). Null: a pool typed by hand, which covers the month''s supplier invoices (20261020010000).';

-- One pool per month and type stays the rule for pools typed by hand; with an
-- invoice, one pool per invoice (a month may have a re-billing).
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.recurring_service_cost_pools'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (company_id, service_type, period)';
  if v_name is not null then
    execute format('alter table public.recurring_service_cost_pools drop constraint %I', v_name);
  end if;
end;
$$;

create unique index recurring_service_cost_pools_month_without_invoice_key
  on public.recurring_service_cost_pools (company_id, service_type, period)
  where cost_document_id is null;

create unique index recurring_service_cost_pools_cost_document_id_key
  on public.recurring_service_cost_pools (cost_document_id)
  where cost_document_id is not null;

-- The invoice is an MS licenses document of the pool's company, month and currency.
create or replace function public.recurring_service_cost_pools_validate_document()
returns trigger
language plpgsql
as $$
declare
  v_doc public.cost_documents;
begin
  if new.cost_document_id is null then
    return new;
  end if;

  select * into v_doc from public.cost_documents where id = new.cost_document_id;
  if v_doc.id is null
    or v_doc.company_id <> new.company_id
    or new.service_type <> 'ms_licenses'
    or v_doc.currency <> new.currency
    or coalesce(v_doc.recognized_period, date_trunc('month', v_doc.document_date)::date) <> new.period
  then
    raise exception 'The invoice of an MS licenses pool must be of the pool''s company, month and currency';
  end if;

  return new;
end;
$$;

create trigger recurring_service_cost_pools_validate_document
  before insert or update of cost_document_id, company_id, service_type, currency, period
  on public.recurring_service_cost_pools
  for each row execute function public.recurring_service_cost_pools_validate_document();

-- ---------------------------------------------------------------------
-- 2. Existing pools: their single invoice (before the coverage rule changes)
-- ---------------------------------------------------------------------
alter table public.recurring_service_cost_pools disable trigger user;

do $$
declare
  v_linked integer;
  v_left integer;
begin
  with covered as (
    select p.id as pool_id, p.total_expense_amount, p.currency,
           count(d.id) as documents,
           min(d.id::text)::uuid as document_id,
           sum(d.net_amount) as net
    from public.recurring_service_cost_pools p
    join public.cost_documents d
      on d.company_id = p.company_id
     and public.covered_by_cost_pool_id(d) = p.id
    where p.service_type = 'ms_licenses'
      and p.cost_document_id is null
    group by p.id, p.total_expense_amount, p.currency
  )
  update public.recurring_service_cost_pools p
  set cost_document_id = c.document_id
  from covered c
  where p.id = c.pool_id
    and c.documents = 1
    and abs(c.net - c.total_expense_amount) < case when c.currency = 'CLP' then 0.5 else 0.005 end;
  get diagnostics v_linked = row_count;

  select count(*) into v_left
  from public.recurring_service_cost_pools
  where service_type = 'ms_licenses' and cost_document_id is null;

  raise notice 'MS pools tied to their invoice: %, left without one: %', v_linked, v_left;
end;
$$;

alter table public.recurring_service_cost_pools enable trigger user;

-- ---------------------------------------------------------------------
-- 3. Coverage: a pool with an invoice covers that invoice only
-- ---------------------------------------------------------------------
create or replace function public.covered_by_cost_pool_id(public.cost_documents)
returns uuid
language sql
stable
as $function$
  select p.id
  from public.recurring_service_cost_pools p
  where p.company_id = $1.company_id
    and p.service_type = 'ms_licenses'
    and (
      p.cost_document_id = $1.id
      or (
        -- A pool typed by hand: the month rule of 20261020010000.
        p.cost_document_id is null
        and p.period = coalesce($1.recognized_period, date_trunc('month', $1.document_date)::date)
        and not exists (
          select 1 from public.cost_service_allocations a
          where a.cost_document_id = $1.id and a.status = 'confirmed'
        )
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
      )
    )
  order by (p.cost_document_id is not null) desc, p.created_at, p.id
  limit 1;
$function$;

-- ---------------------------------------------------------------------
-- 4. An invoice with its split stays as it was split
-- ---------------------------------------------------------------------
create or replace function public.cost_documents_guard_ms_license_pool()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.recurring_service_cost_pools p where p.cost_document_id = old.id
  ) then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Esta factura tiene su reparto de licencias MS: deshacé el reparto (Costos → Reparto licencias MS) antes de eliminarla';
  end if;

  if new.company_id is distinct from old.company_id
    or new.project_id is distinct from old.project_id
    or new.classification is distinct from old.classification
    or new.currency is distinct from old.currency
    or coalesce(new.recognized_period, date_trunc('month', new.document_date)::date)
       is distinct from coalesce(old.recognized_period, date_trunc('month', old.document_date)::date)
  then
    raise exception 'Esta factura tiene su reparto de licencias MS: deshacé el reparto antes de cambiarle el trabajo, la moneda o el mes';
  end if;

  return new;
end;
$$;

create trigger cost_documents_guard_ms_license_pool
  before update or delete on public.cost_documents
  for each row execute function public.cost_documents_guard_ms_license_pool();

create or replace function public.cost_allocations_guard_ms_license_pool()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.recurring_service_cost_pools p where p.cost_document_id = new.cost_document_id
  ) then
    raise exception 'Esta factura tiene su reparto de licencias MS: deshacé el reparto antes de dividirla o asignarla';
  end if;
  return new;
end;
$$;

create trigger cost_allocations_guard_ms_license_pool
  before insert or update of cost_document_id on public.cost_allocations
  for each row execute function public.cost_allocations_guard_ms_license_pool();

-- ---------------------------------------------------------------------
-- 5. The supplier's invoices and the suggested licenses invoice
-- ---------------------------------------------------------------------
drop function if exists public.create_ms_license_pool_for_month(uuid, date);
drop function if exists public.ms_license_pool_months(uuid);

-- Every document of the MS licenses supplier (is_ms_licenses_supplier) from
-- 2026-01, the first month managed in the ERP:
--   assigned: to a job, split (cost_allocations) or allocated to services;
--   pool_*: the split it has, when it is a licenses invoice;
--   legacy_pool_id: a pool typed by hand for its month (it covers the month);
--   reference_net: net of the supplier's last licenses invoice before its month;
--   suggested: the licenses invoice of a supplier-month that has none yet:
--     not assigned, net > 0, the closest to reference_net (without one, the
--     first of the month), then the earliest.
create or replace function public.ms_license_invoices(p_company_id uuid)
returns table (
  cost_document_id uuid,
  period date,
  currency text,
  supplier_id uuid,
  supplier_name text,
  document_type text,
  document_number text,
  document_date date,
  net_amount numeric,
  assigned boolean,
  pool_id uuid,
  pool_total numeric,
  pool_allocated boolean,
  legacy_pool_id uuid,
  reference_net numeric,
  suggested boolean
)
language sql
stable
as $$
  with docs as (
    select
      d.id,
      coalesce(d.recognized_period, date_trunc('month', d.document_date)::date) as period,
      d.currency,
      d.supplier_id,
      s.name as supplier_name,
      d.document_type,
      d.document_number,
      d.document_date,
      d.net_amount,
      (
        d.project_id is not null
        or exists (select 1 from public.cost_allocations ca where ca.cost_document_id = d.id)
        or exists (
          select 1 from public.cost_service_allocations a
          where a.cost_document_id = d.id and a.status = 'confirmed'
        )
      ) as assigned,
      p.id as pool_id,
      p.total_expense_amount as pool_total,
      exists (select 1 from public.recurring_service_cost_allocations x where x.cost_pool_id = p.id) as pool_allocated
    from public.cost_documents d
    join public.suppliers s on s.id = d.supplier_id
    left join public.recurring_service_cost_pools p on p.cost_document_id = d.id
    where d.company_id = p_company_id
      and public.is_ms_licenses_supplier(d.supplier_id)
      and coalesce(d.recognized_period, date_trunc('month', d.document_date)::date) >= date '2026-01-01'
  ),
  legacy as (
    select distinct on (lp.period) lp.period, lp.id
    from public.recurring_service_cost_pools lp
    where lp.company_id = p_company_id
      and lp.service_type = 'ms_licenses'
      and lp.cost_document_id is null
    order by lp.period, lp.created_at, lp.id
  ),
  with_reference as (
    select
      docs.*,
      l.id as legacy_pool_id,
      (
        select m.net_amount from docs m
        where m.pool_id is not null
          and m.supplier_id = docs.supplier_id
          and m.currency = docs.currency
          and m.period < docs.period
        order by m.period desc, m.document_date desc, m.id
        limit 1
      ) as reference_net,
      exists (
        select 1 from docs m
        where m.pool_id is not null and m.supplier_id = docs.supplier_id and m.period = docs.period
      ) as month_has_invoice
    from docs
    left join legacy l on l.period = docs.period
  ),
  eligible as (
    select w.*,
      (not w.assigned and w.pool_id is null and w.net_amount > 0
        and not w.month_has_invoice and w.legacy_pool_id is null) as is_candidate
    from with_reference w
  ),
  ranked as (
    select e.*,
      row_number() over (
        partition by e.supplier_id, e.period, e.is_candidate
        order by
          case when e.reference_net is null then null else abs(e.net_amount - e.reference_net) end nulls last,
          e.document_date,
          e.id
      ) as rank
    from eligible e
  )
  select
    r.id, r.period, r.currency, r.supplier_id, r.supplier_name, r.document_type, r.document_number,
    r.document_date, r.net_amount, r.assigned, r.pool_id, r.pool_total, r.pool_allocated,
    r.legacy_pool_id, r.reference_net, (r.is_candidate and r.rank = 1)
  from ranked r
  order by r.period, r.document_date, r.id;
$$;

revoke execute on function public.ms_license_invoices(uuid) from public, anon;
grant execute on function public.ms_license_invoices(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. "Es factura de licencias MS -> repartir"
-- ---------------------------------------------------------------------
-- The pool of one invoice, split at once with the same query as the preview
-- (recurring_service_cost_pool_shares): the parts add up exactly to the
-- invoice's net. Runs as the caller: RLS decides who can see the invoice and
-- create the pool. Errors start with a code the screen reads.
create or replace function public.create_ms_license_pool_for_invoice(
  p_cost_document_id uuid,
  p_allow_second boolean default false
)
returns uuid
language plpgsql
as $$
declare
  v_company_id uuid;
  v_invoice record;
  v_others text;
  v_pool_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required to split a cost pool';
  end if;

  select company_id into v_company_id from public.cost_documents where id = p_cost_document_id;
  if v_company_id is null then
    raise exception 'NOT_FOUND: No se encontró la factura';
  end if;

  select * into v_invoice
  from public.ms_license_invoices(v_company_id) i
  where i.cost_document_id = p_cost_document_id;

  if not found then
    raise exception 'NOT_SUPPLIER: Solo una factura de Intcomex (Chile) o TGM (Uruguay), de enero 2026 en adelante, se reparte como licencias MS';
  end if;
  if v_invoice.pool_id is not null then
    raise exception 'EXISTS: Esta factura ya tiene su reparto de licencias';
  end if;
  if v_invoice.assigned then
    raise exception 'ASSIGNED: Esta factura está asignada a un trabajo, dividida o asignada a servicios: quitá esa asignación antes de repartirla como licencias';
  end if;
  if v_invoice.net_amount <= 0 then
    raise exception 'NOT_POSITIVE: El neto de este documento es % (una nota de crédito resta): no hay costo que repartir', v_invoice.net_amount;
  end if;
  if v_invoice.legacy_pool_id is not null then
    raise exception 'LEGACY: Ese mes ya tiene un reparto cargado a mano, sin factura: deshacelo antes de repartir esta factura';
  end if;

  select string_agg(
           coalesce(nullif(i.document_number, ''), 'sin número') || ' por ' || i.net_amount::text || ' ' || i.currency,
           ', ' order by i.document_date)
  into v_others
  from public.ms_license_invoices(v_company_id) i
  where i.pool_id is not null
    and i.supplier_id = v_invoice.supplier_id
    and i.period = v_invoice.period;

  if v_others is not null and not coalesce(p_allow_second, false) then
    raise exception 'SECOND: % ya tiene una factura de licencias repartida en este mes (%). Si esta también es de licencias (por ejemplo, una refacturación), confirmalo',
      v_invoice.supplier_name, v_others;
  end if;

  perform public.prepare_recurring_service_cost_pool_cycles(v_company_id, 'ms_licenses', v_invoice.period);

  if not exists (
    select 1
    from public.recurring_service_cost_pool_shares(
      v_company_id, 'ms_licenses', v_invoice.period, v_invoice.currency, v_invoice.net_amount
    )
  ) then
    raise exception 'NO_CYCLES: Ningún servicio de licencias MS que use el pool tiene ciclo en ese mes, en %: no hay entre quiénes repartir', v_invoice.currency;
  end if;

  insert into public.recurring_service_cost_pools (
    company_id, service_type, period, total_expense_amount, currency, supplier_id, cost_document_id
  )
  values (
    v_company_id, 'ms_licenses', v_invoice.period, v_invoice.net_amount, v_invoice.currency,
    v_invoice.supplier_id, p_cost_document_id
  )
  returning id into v_pool_id;

  perform public.allocate_recurring_service_cost_pool(v_pool_id);

  return v_pool_id;
end;
$$;

revoke execute on function public.create_ms_license_pool_for_invoice(uuid, boolean) from public, anon;
grant execute on function public.create_ms_license_pool_for_invoice(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 7. "Deshacer reparto"
-- ---------------------------------------------------------------------
-- Deletes a pool and its shares: its invoice goes back to being a general
-- cost (or is free to be assigned) and its clients lose that cost. Members of
-- the pool's company only.
create or replace function public.undo_recurring_service_cost_pool(p_cost_pool_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required to undo a cost pool';
  end if;

  select company_id into v_company_id
  from public.recurring_service_cost_pools
  where id = p_cost_pool_id
  for update;

  if v_company_id is null or not public.is_company_member(v_company_id) then
    raise exception 'Cost pool not found';
  end if;

  delete from public.recurring_service_cost_allocations where cost_pool_id = p_cost_pool_id;
  delete from public.recurring_service_cost_pools where id = p_cost_pool_id;
end;
$$;

revoke execute on function public.undo_recurring_service_cost_pool(uuid) from public, anon;
grant execute on function public.undo_recurring_service_cost_pool(uuid) to authenticated, service_role;

comment on function public.undo_recurring_service_cost_pool(uuid) is
  'Deletes a cost pool and its shares ("Deshacer reparto", fix-ms-invoice 2026-11). Members of the pool''s company only.';

-- ---------------------------------------------------------------------
-- 8. "Volver a repartir" takes the invoice's current net
-- ---------------------------------------------------------------------
create or replace function public.reallocate_recurring_service_cost_pool(p_cost_pool_id uuid)
returns setof public.recurring_service_cost_allocations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_document_id uuid;
  v_net numeric;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required to split a cost pool';
  end if;

  select company_id, cost_document_id into v_company_id, v_document_id
  from public.recurring_service_cost_pools
  where id = p_cost_pool_id
  for update;

  if v_company_id is null or not public.is_company_member(v_company_id) then
    raise exception 'Cost pool not found';
  end if;

  if v_document_id is not null then
    select net_amount into v_net from public.cost_documents where id = v_document_id;
    if v_net is null or v_net <= 0 then
      raise exception 'The invoice of this pool has no positive net to split';
    end if;
    update public.recurring_service_cost_pools
    set total_expense_amount = v_net
    where id = p_cost_pool_id and total_expense_amount is distinct from v_net;
  end if;

  delete from public.recurring_service_cost_allocations where cost_pool_id = p_cost_pool_id;

  return query select * from public.allocate_recurring_service_cost_pool(p_cost_pool_id);
end;
$$;

revoke execute on function public.reallocate_recurring_service_cost_pool(uuid) from public, anon;
grant execute on function public.reallocate_recurring_service_cost_pool(uuid) to authenticated, service_role;

comment on function public.reallocate_recurring_service_cost_pool(uuid) is
  'Deletes the shares of an MS licenses pool and splits it again among every cycle of its month (audit 2026-11, M-01); a pool with an invoice first takes that invoice''s current net (fix-ms-invoice 2026-11). Members of the pool''s company only.';
