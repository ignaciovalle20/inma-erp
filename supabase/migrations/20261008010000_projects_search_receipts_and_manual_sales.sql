-- Projects search: the document number also finds the job's receipts
-- (boletas) and manual sales, not only its invoices.
--
-- list_projects (20261006010000) is recreated with the same signature and
-- result; only the sales-document branch of the search changes:
--   - document types: invoice, receipt, manual (credit notes stay out: a
--     credit note's number is not how anyone looks a job up);
--   - annulled documents stay out: voided ones, as before, and now also an
--     invoice annulled by a credit note (annulled_by_document_id).
-- The partial trigram index follows the new predicate.
--
-- Additive and re-runnable: one index swapped, one function replaced.
-- Nothing in clients changes.

drop index if exists public.sales_documents_invoice_number_search_idx;

create index if not exists sales_documents_number_search_idx
  on public.sales_documents using gin (public.search_normalize(document_number) extensions.gin_trgm_ops)
  where document_type in ('invoice', 'receipt', 'manual') and project_id is not null;

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
    -- Invoices, receipts and manual sales of the job; never credit notes
    -- nor annulled documents (voided, or an invoice a credit note annuls).
    select sd.project_id
    from public.sales_documents sd, pattern
    where pattern.needle is not null
      and sd.company_id = p_company_id
      and sd.document_type in ('invoice', 'receipt', 'manual')
      and sd.project_id is not null
      and not sd.voided
      and sd.annulled_by_document_id is null
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
  'Projects list screen: Activos / Finalizados / Todos tabs and accent-insensitive search over job, client, alias, quote number and the number of its invoices, receipts and manual sales (not credit notes, not annulled). RLS-scoped (security invoker).';

-- create or replace keeps the existing grants; restated so this file
-- stands on its own (Supabase grants new functions to anon explicitly,
-- see 20260922080000).
revoke execute on function public.list_projects(uuid, text, text, integer, integer, integer) from public, anon;
grant execute on function public.list_projects(uuid, text, text, integer, integer, integer) to authenticated, service_role;
