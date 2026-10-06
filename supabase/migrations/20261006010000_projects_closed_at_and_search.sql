-- Projects list: search + a separate view for finished jobs.
--
-- The projects list is going to grow a lot (every Nubox quote becomes a
-- job), so the list screen gets:
--   - tabs Activos / Finalizados / Todos, Finalizados ordered by the date
--     the job was closed, with a year picker and server-side pages;
--   - one search box over the job name, client name, client aliases, quote
--     numbers and the numbers of the job's invoices, case- and
--     accent-insensitive, across every status.
--
-- "Finished" = the terminal statuses of the kanban lifecycle
-- (docs/cambios-flujo-v2.md 4.1): finalizado (done, maybe not paid off
-- yet), cerrado and cancelado. The active ones are por_cotizar,
-- en_ejecucion and en_espera (list_projects is the one place the app
-- splits them).
--
-- Additive: one nullable column, a trigger, a backfill of that column only,
-- two extensions, indexes and two read-only functions. Nothing in clients
-- changes (no column, index or row).

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
-- projects.closed_at
-- ---------------------------------------------------------------------
alter table public.projects add column if not exists closed_at timestamptz;

comment on column public.projects.closed_at is
  'When the job entered a terminal status (finalizado, cerrado, cancelado); null while active. Kept by the projects_set_closed_at trigger.';

-- Moving between two terminal statuses (finalizado -> cerrado once it is
-- paid off) keeps the original date: the job finished when it first left
-- the active statuses. Going back to an active status clears it.
create or replace function public.projects_set_closed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('finalizado', 'cerrado', 'cancelado') then
    if tg_op = 'INSERT' then
      new.closed_at := coalesce(new.closed_at, now());
    elsif old.status in ('finalizado', 'cerrado', 'cancelado') then
      new.closed_at := coalesce(new.closed_at, old.closed_at, now());
    else
      new.closed_at := now();
    end if;
  else
    new.closed_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists projects_set_closed_at on public.projects;
create trigger projects_set_closed_at
  before insert or update on public.projects
  for each row
  execute function public.projects_set_closed_at();

-- Backfill for jobs that are already finished: the date of their latest
-- invoice if they have one (noon UTC, so the calendar day is the same in
-- Chile and Uruguay), otherwise updated_at, otherwise created_at. User
-- triggers off so updated_at/updated_by are not touched.
alter table public.projects disable trigger user;

update public.projects p
set closed_at = coalesce(
  (
    select (max(sd.document_date) + time '12:00') at time zone 'UTC'
    from public.sales_documents sd
    where sd.project_id = p.id
      and sd.document_type = 'invoice'
      and not sd.voided
  ),
  p.updated_at,
  p.created_at
)
where p.status in ('finalizado', 'cerrado', 'cancelado')
  and p.closed_at is null;

alter table public.projects enable trigger user;

create index if not exists projects_company_status_closed_at_idx
  on public.projects (company_id, status, closed_at desc);

-- ---------------------------------------------------------------------
-- Search normalization + trigram indexes
-- ---------------------------------------------------------------------
-- unaccent() is only STABLE (it reads a dictionary that could change), so
-- it cannot back an index on its own. The two-argument form with a fixed
-- dictionary is the usual immutable wrapper.
create or replace function public.search_normalize(p_value text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, p_value));
$$;

comment on function public.search_normalize(text) is
  'Lowercase, accent-free text for search (list_projects and its trigram indexes).';

create index if not exists projects_name_search_idx
  on public.projects using gin (public.search_normalize(name) extensions.gin_trgm_ops);
create index if not exists client_aliases_external_name_search_idx
  on public.client_aliases using gin (public.search_normalize(external_name) extensions.gin_trgm_ops);
create index if not exists project_quotes_quote_number_search_idx
  on public.project_quotes using gin (public.search_normalize(quote_number) extensions.gin_trgm_ops);
create index if not exists sales_documents_invoice_number_search_idx
  on public.sales_documents using gin (public.search_normalize(document_number) extensions.gin_trgm_ops)
  where document_type = 'invoice' and project_id is not null;

-- ---------------------------------------------------------------------
-- list_projects: the projects list screen
-- ---------------------------------------------------------------------
-- security invoker (the default): every table read goes through the
-- caller's RLS, and the explicit company filter keeps one company per
-- call, same as the rest of the app.
--
-- p_scope: 'activos' (name order, as the list always was), 'finalizados'
-- (closed_at desc) or 'todos' (active first, then finished). p_year only
-- applies to 'finalizados', as a calendar year in the company's time zone
-- (CL America/Santiago, otherwise America/Montevideo, like
-- todayForCountry). A non-blank p_query ignores p_scope and p_year:
-- search always covers every status. p_limit null = every row.
-- total_count is the number of rows before limit/offset.
create or replace function public.list_projects(
  p_company_id uuid,
  p_scope text default 'activos',
  p_query text default null,
  p_year integer default null,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  company_id uuid,
  client_id uuid,
  business_area_id uuid,
  name text,
  start_date date,
  end_date date,
  status text,
  quoted_amount numeric,
  cost_budget numeric,
  responsible text,
  invoiceable boolean,
  hold_reason text,
  closed_at timestamptz,
  client_name text,
  client_monthly boolean,
  business_area_name text,
  total_count bigint
)
language sql
stable
set search_path = ''
as $$
  with params as (
    select
      nullif(public.search_normalize(regexp_replace(btrim(coalesce(p_query, '')), '\s+', ' ', 'g')), '') as needle,
      coalesce(
        (
          select case c.country when 'CL' then 'America/Santiago' else 'America/Montevideo' end
          from public.companies c
          where c.id = p_company_id
        ),
        'America/Montevideo'
      ) as time_zone
  ),
  pattern as (
    select
      needle,
      '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' as value,
      time_zone
    from params
  ),
  -- One branch per searchable field, each able to use its own index.
  matches as (
    select p.id
    from public.projects p, pattern
    where pattern.needle is not null
      and p.company_id = p_company_id
      and public.search_normalize(p.name) like pattern.value
    union
    select p.id
    from public.projects p
    join public.clients c on c.id = p.client_id, pattern
    where pattern.needle is not null
      and p.company_id = p_company_id
      and public.search_normalize(c.name) like pattern.value
    union
    select p.id
    from public.client_aliases a
    join public.projects p on p.client_id = a.client_id, pattern
    where pattern.needle is not null
      and a.company_id = p_company_id
      and p.company_id = p_company_id
      and public.search_normalize(a.external_name) like pattern.value
    union
    select q.project_id
    from public.project_quotes q, pattern
    where pattern.needle is not null
      and q.company_id = p_company_id
      and public.search_normalize(q.quote_number) like pattern.value
    union
    select sd.project_id
    from public.sales_documents sd, pattern
    where pattern.needle is not null
      and sd.company_id = p_company_id
      and sd.document_type = 'invoice'
      and sd.project_id is not null
      and not sd.voided
      and public.search_normalize(sd.document_number) like pattern.value
  ),
  filtered as (
    select
      p.*,
      p.status in ('finalizado', 'cerrado', 'cancelado') as is_closed
    from public.projects p, pattern
    where p.company_id = p_company_id
      and (
        case
          when pattern.needle is not null then
            p.id in (select m.id from matches m)
          when p_scope = 'finalizados' then
            p.status in ('finalizado', 'cerrado', 'cancelado')
            and (
              p_year is null
              or (
                p.closed_at >= make_timestamptz(p_year, 1, 1, 0, 0, 0, pattern.time_zone)
                and p.closed_at < make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, pattern.time_zone)
              )
            )
          when p_scope = 'todos' then
            true
          else
            p.status not in ('finalizado', 'cerrado', 'cancelado')
        end
      )
  )
  select
    f.id,
    f.company_id,
    f.client_id,
    f.business_area_id,
    f.name,
    f.start_date,
    f.end_date,
    f.status,
    f.quoted_amount,
    f.cost_budget,
    f.responsible,
    f.invoiceable,
    f.hold_reason,
    f.closed_at,
    c.name as client_name,
    coalesce(c.monthly, false) as client_monthly,
    ba.name as business_area_name,
    count(*) over () as total_count
  from filtered f
  left join public.clients c on c.id = f.client_id
  left join public.business_areas ba on ba.id = f.business_area_id
  order by
    f.is_closed,
    case when f.is_closed then f.closed_at end desc nulls last,
    f.name,
    f.id
  limit p_limit
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.list_projects(uuid, text, text, integer, integer, integer) is
  'Projects list screen: Activos / Finalizados / Todos tabs and accent-insensitive search over job, client, alias, quote and invoice numbers. RLS-scoped (security invoker).';

-- Years that have finished jobs, newest first, for the Finalizados year
-- picker. Same time zone rule as list_projects.
create or replace function public.project_closed_years(p_company_id uuid)
returns setof integer
language sql
stable
set search_path = ''
as $$
  select distinct extract(
    year from p.closed_at at time zone coalesce(
      (
        select case c.country when 'CL' then 'America/Santiago' else 'America/Montevideo' end
        from public.companies c
        where c.id = p_company_id
      ),
      'America/Montevideo'
    )
  )::integer as year
  from public.projects p
  where p.company_id = p_company_id
    and p.status in ('finalizado', 'cerrado', 'cancelado')
    and p.closed_at is not null
  order by year desc;
$$;

comment on function public.project_closed_years(uuid) is
  'Calendar years (company time zone) with finished jobs, for the projects list year picker.';

-- Supabase grants EXECUTE on new functions to anon explicitly; revoking
-- PUBLIC alone does not remove it (see 20260922080000). Both functions are
-- RLS-scoped reads the logged-in app calls with the user's own client.
revoke execute on function public.list_projects(uuid, text, text, integer, integer, integer) from public, anon;
grant execute on function public.list_projects(uuid, text, text, integer, integer, integer) to authenticated, service_role;
revoke execute on function public.project_closed_years(uuid) from public, anon;
grant execute on function public.project_closed_years(uuid) to authenticated, service_role;
