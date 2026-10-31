-- Search of cost and sales documents over the whole history, in the database.
--
-- Costos and Ventas only offered a month at a time and no text search: finding
-- a folio meant guessing its month. These two functions take the search to
-- Postgres and return one page of ids plus the total, so the app only reads the
-- rows it shows. Same shape as list_projects: one branch per searchable field,
-- each able to use its own trigram index. Invoker, so RLS keeps it to the caller's
-- companies. A search covers every month and status, voided documents included.

create index if not exists cost_documents_number_search_idx
  on public.cost_documents using gin (public.search_normalize(document_number) extensions.gin_trgm_ops)
  where document_number is not null;

create index if not exists sales_documents_any_number_search_idx
  on public.sales_documents using gin (public.search_normalize(document_number) extensions.gin_trgm_ops)
  where document_number is not null;

create index if not exists suppliers_name_search_idx
  on public.suppliers using gin (public.search_normalize(name) extensions.gin_trgm_ops);

create index if not exists clients_name_search_idx
  on public.clients using gin (public.search_normalize(name) extensions.gin_trgm_ops);

create index if not exists cost_documents_company_date_idx
  on public.cost_documents (company_id, document_date desc, id);

create index if not exists sales_documents_company_date_idx
  on public.sales_documents (company_id, document_date desc, id);

-- p_sort: 'date' or 'total'. Page of ids in that order, with the total on each row.
create or replace function public.search_cost_documents(
  p_company_id uuid,
  p_query text,
  p_sort text default 'date',
  p_ascending boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (id uuid, total_count bigint)
language sql
stable
set search_path to ''
as $function$
  with params as (
    select nullif(public.search_normalize(regexp_replace(btrim(coalesce(p_query, '')), '\s+', ' ', 'g')), '') as needle
  ),
  pattern as (
    select needle,
           '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' as value,
           regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g') as digits
    from params
  ),
  matches as (
    select d.id
    from public.cost_documents d, pattern
    where pattern.needle is not null
      and d.company_id = p_company_id
      and d.document_number is not null
      and public.search_normalize(d.document_number) like pattern.value
    union
    -- "BOL-HE 156": the type and the folio written together.
    select d.id
    from public.cost_documents d, pattern
    where pattern.needle is not null
      and d.company_id = p_company_id
      and d.document_number is not null
      and public.search_normalize(coalesce(d.source_document_type, '') || ' ' || d.document_number) like pattern.value
    union
    select d.id
    from public.suppliers s
    join public.cost_documents d on d.supplier_id = s.id, pattern
    where pattern.needle is not null
      and s.company_id = p_company_id
      and d.company_id = p_company_id
      and public.search_normalize(s.name) like pattern.value
    union
    -- The RUT, written with or without dots and hyphen.
    select d.id
    from public.suppliers s
    join public.cost_documents d on d.supplier_id = s.id, pattern
    where pattern.needle is not null
      and s.company_id = p_company_id
      and d.company_id = p_company_id
      and length(pattern.digits) >= 6
      and regexp_replace(coalesce(s.tax_id, ''), '[^0-9]', '', 'g') like '%' || pattern.digits || '%'
    union
    select d.id
    from public.projects p
    join public.cost_documents d on d.project_id = p.id, pattern
    where pattern.needle is not null
      and p.company_id = p_company_id
      and d.company_id = p_company_id
      and public.search_normalize(p.name) like pattern.value
    union
    select d.id
    from public.cost_lines l
    join public.cost_documents d on d.id = l.cost_document_id, pattern
    where pattern.needle is not null
      and d.company_id = p_company_id
      and public.search_normalize(l.description) like pattern.value
  ),
  found as (
    select d.id, d.document_date, d.total_amount
    from public.cost_documents d
    join matches m on m.id = d.id
  )
  select f.id, count(*) over () as total_count
  from found f
  order by
    case when p_sort = 'total' and p_ascending then f.total_amount end asc nulls last,
    case when p_sort = 'total' and not p_ascending then f.total_amount end desc nulls last,
    case when p_sort <> 'total' and p_ascending then f.document_date end asc nulls last,
    case when p_sort <> 'total' and not p_ascending then f.document_date end desc nulls last,
    f.id
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

comment on function public.search_cost_documents(uuid, text, text, boolean, integer, integer) is
  'One page of the company''s cost documents matching a text (folio, type + folio, supplier, RUT, job, line), over the whole history.';

revoke execute on function public.search_cost_documents(uuid, text, text, boolean, integer, integer) from public, anon;
grant execute on function public.search_cost_documents(uuid, text, text, boolean, integer, integer) to authenticated, service_role;

-- p_sort: 'date', 'net' or 'total'.
create or replace function public.search_sales_documents(
  p_company_id uuid,
  p_query text,
  p_sort text default 'date',
  p_ascending boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (id uuid, total_count bigint)
language sql
stable
set search_path to ''
as $function$
  with params as (
    select nullif(public.search_normalize(regexp_replace(btrim(coalesce(p_query, '')), '\s+', ' ', 'g')), '') as needle
  ),
  pattern as (
    select needle,
           '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' as value,
           regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g') as digits
    from params
  ),
  matches as (
    select d.id
    from public.sales_documents d, pattern
    where pattern.needle is not null
      and d.company_id = p_company_id
      and d.document_number is not null
      and public.search_normalize(d.document_number) like pattern.value
    union
    select d.id
    from public.clients c
    join public.sales_documents d on d.client_id = c.id, pattern
    where pattern.needle is not null
      and c.company_id = p_company_id
      and d.company_id = p_company_id
      and public.search_normalize(c.name) like pattern.value
    union
    select d.id
    from public.clients c
    join public.sales_documents d on d.client_id = c.id, pattern
    where pattern.needle is not null
      and c.company_id = p_company_id
      and d.company_id = p_company_id
      and length(pattern.digits) >= 6
      and regexp_replace(coalesce(c.tax_id, ''), '[^0-9]', '', 'g') like '%' || pattern.digits || '%'
    union
    select d.id
    from public.projects p
    join public.sales_documents d on d.project_id = p.id, pattern
    where pattern.needle is not null
      and p.company_id = p_company_id
      and d.company_id = p_company_id
      and public.search_normalize(p.name) like pattern.value
  ),
  found as (
    select d.id, d.document_date, d.net_amount, d.total_amount
    from public.sales_documents d
    join matches m on m.id = d.id
  )
  select f.id, count(*) over () as total_count
  from found f
  order by
    case when p_sort = 'net' and p_ascending then f.net_amount end asc nulls last,
    case when p_sort = 'net' and not p_ascending then f.net_amount end desc nulls last,
    case when p_sort = 'total' and p_ascending then f.total_amount end asc nulls last,
    case when p_sort = 'total' and not p_ascending then f.total_amount end desc nulls last,
    case when p_sort not in ('net', 'total') and p_ascending then f.document_date end asc nulls last,
    case when p_sort not in ('net', 'total') and not p_ascending then f.document_date end desc nulls last,
    f.id
  limit greatest(coalesce(p_limit, 100), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

comment on function public.search_sales_documents(uuid, text, text, boolean, integer, integer) is
  'One page of the company''s sales documents matching a text (folio, client, RUT, job), over the whole history.';

revoke execute on function public.search_sales_documents(uuid, text, text, boolean, integer, integer) from public, anon;
grant execute on function public.search_sales_documents(uuid, text, text, boolean, integer, integer) to authenticated, service_role;
