-- A job (projects row) gets its own currency. Until now a job had none:
-- its quote (quoted_amount, project_quotes.quoted_amount) and cost budget
-- were implicitly in the company's currency, so a Uruguayan company could
-- only create jobs in UYU.
--
-- The allowed currencies follow the company's configuration, the same rule
-- as web/src/lib/companyConfig.ts: Chile CLP only, Uruguay USD or UYU, a
-- company with no known country any of CLP/UYU/USD.
--
-- 1. projects.currency (not null), filled with the company's currency for
--    every existing job. A trigger fills it on insert when it is not given
--    (every existing caller), checks it against the company's currencies,
--    and refuses to change it once the job has movements (sales, costs,
--    technician charges, payroll): its quote amounts would silently change
--    meaning.
-- 2. create_project_with_quote takes p_currency (default null = the
--    company's currency). The 12-argument version is replaced by the
--    13-argument one, so calls with the old named arguments still resolve.
-- 3. create_manual_sale_without_invoice records the sale in the job's
--    currency instead of the company's.
-- 4. project_quote_billing_summary: what is billed is expressed in the
--    job's currency (each allocation converted with its document's stored
--    rate, or the snapshot of its date), never added 1:1 across currencies.
--    New column `currency` (appended) says which.
--
-- Additive: one column, a trigger, replaced functions and view.

-- ---------------------------------------------------------------------
-- 1. projects.currency
-- ---------------------------------------------------------------------
alter table public.projects add column if not exists currency text;

alter table public.projects disable trigger user;
update public.projects p
set currency = c.currency
from public.companies c
where c.id = p.company_id and p.currency is null;
alter table public.projects enable trigger user;

alter table public.projects alter column currency set not null;

alter table public.projects drop constraint if exists projects_currency_check;
alter table public.projects add constraint projects_currency_check check (currency in ('CLP', 'UYU', 'USD'));

comment on column public.projects.currency is
  'Currency of the job: its quote (quoted_amount, project_quotes.quoted_amount) and cost budget are in it. One of the company''s currencies (company_document_currencies). Reports convert from it, never add it 1:1.';

-- Same rule as companyConfig().documentCurrencies in the app.
create or replace function public.company_document_currencies(p_company_id uuid)
returns text[]
language sql
stable
set search_path = public
as $$
  select case
    when upper(btrim(coalesce(c.country, ''))) in ('CL', 'CHILE') then array['CLP']
    when upper(btrim(coalesce(c.country, ''))) in ('UY', 'URUGUAY') then array['USD', 'UYU']
    else array['CLP', 'UYU', 'USD']
  end
  from public.companies c
  where c.id = p_company_id;
$$;

comment on function public.company_document_currencies(uuid) is
  'Currencies a document or job of the company may be in: Chile CLP, Uruguay USD/UYU, unknown country CLP/UYU/USD (web/src/lib/companyConfig.ts).';

revoke execute on function public.company_document_currencies(uuid) from public, anon;
grant execute on function public.company_document_currencies(uuid) to authenticated, service_role;

-- True when the job already has something recorded against it.
create or replace function public.project_has_movements(p_project_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (select 1 from public.sales_documents where project_id = p_project_id and not voided)
    or exists (
      select 1 from public.sales_allocations a
      join public.project_quotes q on q.id = a.project_quote_id
      where q.project_id = p_project_id
    )
    or exists (select 1 from public.cost_documents where project_id = p_project_id)
    or exists (select 1 from public.cost_allocations where project_id = p_project_id)
    or exists (select 1 from public.technician_charges where project_id = p_project_id)
    or exists (select 1 from public.work_allocations where project_id = p_project_id);
$$;

revoke execute on function public.project_has_movements(uuid) from public, anon;
grant execute on function public.project_has_movements(uuid) to authenticated, service_role;

create or replace function public.projects_set_currency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_allowed text[];
begin
  if new.currency is null and tg_op = 'INSERT' then
    select currency into new.currency from public.companies where id = new.company_id;
  end if;

  new.currency := upper(btrim(new.currency));

  if tg_op = 'UPDATE' and new.currency is not distinct from old.currency then
    return new;
  end if;

  v_allowed := public.company_document_currencies(new.company_id);
  if v_allowed is null or not (new.currency = any (v_allowed)) then
    raise exception 'project_currency_not_allowed: la moneda % no está habilitada para esta empresa (%)',
      new.currency, array_to_string(coalesce(v_allowed, '{}'), ', ');
  end if;

  if tg_op = 'UPDATE' and public.project_has_movements(new.id) then
    raise exception 'project_currency_locked: el trabajo ya tiene ventas, costos o cargos registrados; su moneda no se puede cambiar';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_set_currency on public.projects;
create trigger projects_set_currency
  before insert or update on public.projects
  for each row
  execute function public.projects_set_currency();

-- ---------------------------------------------------------------------
-- 2. create_project_with_quote with p_currency
-- ---------------------------------------------------------------------
drop function if exists public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, numeric, text, boolean
);

create or replace function public.create_project_with_quote(
  p_company_id uuid,
  p_client_id uuid,
  p_business_area_id uuid,
  p_name text,
  p_status text,
  p_quote_number text,
  p_start_date date,
  p_end_date date,
  p_quoted_amount numeric,
  p_cost_budget numeric,
  p_responsible text,
  p_invoiceable boolean,
  p_currency text default null
)
returns public.projects
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects;
  v_quote_number text := nullif(btrim(coalesce(p_quote_number, '')), '');
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a project';
  end if;

  if coalesce(p_status, 'en_ejecucion') <> 'por_cotizar' and v_quote_number is null then
    raise exception 'A quote number is required unless the job status is por_cotizar';
  end if;

  insert into public.projects (
    company_id,
    client_id,
    business_area_id,
    name,
    start_date,
    end_date,
    status,
    quoted_amount,
    cost_budget,
    responsible,
    invoiceable,
    currency,
    created_by,
    updated_by
  )
  values (
    p_company_id,
    p_client_id,
    p_business_area_id,
    p_name,
    p_start_date,
    p_end_date,
    coalesce(p_status, 'en_ejecucion'),
    p_quoted_amount,
    p_cost_budget,
    p_responsible,
    coalesce(p_invoiceable, true),
    nullif(btrim(coalesce(p_currency, '')), ''),
    v_user_id,
    v_user_id
  )
  returning * into v_project;

  if v_quote_number is not null then
    insert into public.project_quotes (project_id, company_id, quote_number, created_by, updated_by)
    values (v_project.id, p_company_id, v_quote_number, v_user_id, v_user_id);
  end if;

  return v_project;
end;
$$;

revoke execute on function public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, numeric, text, boolean, text
) from public, anon;
grant execute on function public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, numeric, text, boolean, text
) to authenticated;

-- Old signature (p_budget is the quote): now calls the 13-argument one.
create or replace function public.create_project_with_quote(
  p_company_id uuid,
  p_client_id uuid,
  p_business_area_id uuid,
  p_name text,
  p_status text,
  p_quote_number text,
  p_start_date date,
  p_end_date date,
  p_budget numeric,
  p_responsible text,
  p_invoiceable boolean
)
returns public.projects
language plpgsql
as $$
begin
  return public.create_project_with_quote(
    p_company_id, p_client_id, p_business_area_id, p_name, p_status,
    p_quote_number, p_start_date, p_end_date,
    p_budget, null::numeric, p_responsible, p_invoiceable, null::text
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Venta sin factura: in the job's currency
-- ---------------------------------------------------------------------
create or replace function public.create_manual_sale_without_invoice(
  p_company_id uuid,
  p_project_id uuid,
  p_document_date date,
  p_net_amount numeric,
  p_tax_amount numeric,
  p_description text
)
returns public.sales_documents
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_project public.projects;
  v_currency text;
  v_tax numeric := coalesce(p_tax_amount, 0);
  v_document public.sales_documents;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a sale';
  end if;

  if p_document_date is null then
    raise exception 'The sale date is required';
  end if;

  if p_net_amount is null or p_net_amount <= 0 then
    raise exception 'The net amount must be greater than zero';
  end if;

  if v_tax < 0 then
    raise exception 'The tax amount must be non-negative';
  end if;

  select * into v_project
  from public.projects
  where id = p_project_id and company_id = p_company_id;

  if v_project.id is null then
    raise exception 'Job not found';
  end if;

  v_currency := v_project.currency;
  if v_currency is null then
    select currency into v_currency from public.companies where id = p_company_id;
  end if;

  insert into public.sales_documents (
    company_id, client_id, project_id, business_area_id,
    document_type, document_date, currency,
    net_amount, tax_amount, total_amount,
    payment_status, payment_status_updated_at,
    source, created_by, updated_by
  )
  values (
    p_company_id, v_project.client_id, v_project.id, v_project.business_area_id,
    'manual', p_document_date, v_currency,
    p_net_amount, v_tax, p_net_amount + v_tax,
    'impago', now(),
    'manual', v_user_id, v_user_id
  )
  returning * into v_document;

  insert into public.sales_lines (
    sales_document_id, description, amount, created_by, updated_by
  )
  values (
    v_document.id,
    coalesce(nullif(btrim(coalesce(p_description, '')), ''), 'Venta sin factura'),
    p_net_amount,
    v_user_id,
    v_user_id
  );

  return v_document;
end;
$$;

revoke execute on function public.create_manual_sale_without_invoice(uuid, uuid, date, numeric, numeric, text) from public, anon;
grant execute on function public.create_manual_sale_without_invoice(uuid, uuid, date, numeric, numeric, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Billed per quote, in the job's currency
-- ---------------------------------------------------------------------
-- Each allocation is in its document's currency. Same currency as the job:
-- as is. Job in the company's currency: the document's stored rate (units
-- of the company currency per unit of the document's). Otherwise the
-- snapshot of the document's date (exchange_rate_on). No rate: left out of
-- the sum rather than added 1:1.
create or replace view public.project_quote_billing_summary
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
  end as billed_pct,
  p.currency
from public.project_quotes q
join public.projects p on p.id = q.project_id
join public.companies c on c.id = p.company_id
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
    sum(a.amount * fx.rate) filter (where a.status = 'confirmed') as billed_amount,
    sum(a.amount * fx.rate) filter (where a.status = 'suggested') as suggested_amount
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  cross join lateral (
    select case
      when sd.currency = p.currency then 1::numeric
      when p.currency = c.currency and sd.exchange_rate is not null then sd.exchange_rate
      else (select r.rate from public.exchange_rate_on(sd.currency, p.currency, sd.document_date) r)
    end as rate
  ) fx
  where a.project_quote_id = q.id
) b on true;

grant select on public.project_quote_billing_summary to authenticated, service_role;

notify pgrst, 'reload schema';
