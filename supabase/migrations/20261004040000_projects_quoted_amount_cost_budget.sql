-- projects.budget meant two things at once (docs/verificacion-contable-2026-10-04.md,
-- P05 -> point 4): the quote of the sale (what Nubox invoices are matched
-- against, the balance still to invoice) and the cost budget (the dashboard's
-- "Vs. presupuesto" badge = costs - budget). Almost every job showed "Bajo
-- presupuesto" because its costs were compared with its sale price.
--
-- - quoted_amount: the quote (net sale). Filled from budget, which is what
--   every screen labelled "Monto (neto) cotizado".
-- - cost_budget: the cost budget. New and empty: no job had one.
-- - budget stays, unused by the app from now on (not dropped yet: a later
--   migration can drop it once production has run with the new columns).
--
-- create_project_with_quote gets a new signature with p_quoted_amount and
-- p_cost_budget. The old one (p_budget) stays for any caller still on the
-- previous app version during a deploy: it now writes p_budget as the quote.
-- Nothing writes budget any more.
--
-- Additive: two nullable columns, a data copy into the new column only, a
-- new function overload and a replaced function body.

alter table public.projects add column if not exists quoted_amount numeric;
alter table public.projects add column if not exists cost_budget numeric;

comment on column public.projects.quoted_amount is
  'Quote of the job (net sale amount): balance still to invoice in Nubox. Replaces budget.';
comment on column public.projects.cost_budget is
  'Cost budget of the job: the "Vs. presupuesto" badge compares accumulated costs with it.';
comment on column public.projects.budget is
  'DEPRECATED (2026-10-04): copied into quoted_amount; no longer read or written by the app. To be dropped in a later migration.';

alter table public.projects drop constraint if exists projects_quoted_amount_check;
alter table public.projects add constraint projects_quoted_amount_check check (quoted_amount is null or quoted_amount >= 0) not valid;
alter table public.projects drop constraint if exists projects_cost_budget_check;
alter table public.projects add constraint projects_cost_budget_check check (cost_budget is null or cost_budget >= 0) not valid;

-- Copy without touching updated_at/updated_by (user triggers off).
alter table public.projects disable trigger user;
update public.projects set quoted_amount = budget where quoted_amount is null and budget is not null;
alter table public.projects enable trigger user;

-- ---------------------------------------------------------------------
-- New signature
-- ---------------------------------------------------------------------
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
  p_invoiceable boolean
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
  uuid, uuid, uuid, text, text, text, date, date, numeric, numeric, text, boolean
) from public, anon;
grant execute on function public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, numeric, text, boolean
) to authenticated;

-- ---------------------------------------------------------------------
-- Old signature: p_budget is the quote.
-- ---------------------------------------------------------------------
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
    p_budget, null::numeric, p_responsible, p_invoiceable
  );
end;
$$;

revoke execute on function public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, text, boolean
) from public, anon;
grant execute on function public.create_project_with_quote(
  uuid, uuid, uuid, text, text, text, date, date, numeric, text, boolean
) to authenticated;

notify pgrst, 'reload schema';
