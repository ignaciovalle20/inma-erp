-- Adjustments to sales allocations (20261016010000,
-- prompt_ajustes_asignaciones.md).
--
-- 1. Suggestions tolerate variable amounts. The rules (exact -> the only
--    period of the month -> proportional split -> quote with balance) now
--    live in the app (web/src/lib/allocationSuggestions.ts, unit tested),
--    which inserts 'suggested' rows with their reason. The SQL suggester
--    is dropped so there is one implementation only.
-- 2. An invoice spread over several periods or jobs: the period summary
--    says how much of what was billed is still unpaid (Deuda, month
--    board), and searching jobs by document number finds every job a
--    document is allocated to, not only the one in sales_documents.
--    project_id.
-- 3. Placeholder quotes ("Sin número") are never matched by the job
--    search.

-- ---------------------------------------------------------------------
-- 1. Why a suggestion was made
-- ---------------------------------------------------------------------
alter table public.sales_allocations
  add column suggestion_reason text
    check (suggestion_reason in ('exact', 'single_period', 'proportional', 'quote'));

comment on column public.sales_allocations.suggestion_reason is
  'How the automatic suggestion was made (exact amount, the only period of the month, proportional split, quote with balance); null for allocations made by hand. Kept after confirming.';

-- Suggestions of the previous version were exact matches.
update public.sales_allocations
set suggestion_reason = 'exact',
    notes = null
where notes like 'Sugerida por monto%';

drop function if exists public.suggest_sales_allocations_for_import_batch(uuid);
drop function if exists public.suggest_sales_allocations(uuid, uuid[]);

-- Kept for the old Nubox import code (deployed apps call it after each
-- batch): the app now suggests on its own, so this does nothing.
create or replace function public.match_recurring_service_occurrences_for_import_batch(p_import_batch_id uuid)
returns table (occurrence_id uuid, sales_document_id uuid, matched_action text)
language sql
stable
set search_path = public
as $$
  select null::uuid, null::uuid, null::text where false;
$$;

-- ---------------------------------------------------------------------
-- 2. Unpaid part of what a period billed
-- ---------------------------------------------------------------------
-- Same view plus unpaid_amount at the end (create or replace can only
-- append columns): confirmed allocations, in the period's currency, of
-- documents not paid yet. A period billed with two invoices, one of them
-- paid, owes only the other one's share.
create or replace view public.recurring_service_period_summary
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
  end as billing_status,
  coalesce(b.unpaid_amount, 0) as unpaid_amount
from public.recurring_service_occurrences o
join public.recurring_services rs on rs.id = o.recurring_service_id
left join lateral (
  select
    sum(a.amount) filter (where a.status = 'confirmed' and sd.currency = o.currency) as billed_amount,
    sum(a.amount) filter (where a.status = 'suggested' and sd.currency = o.currency) as suggested_amount,
    count(*) filter (where a.status = 'confirmed') as confirmed_count,
    count(*) filter (where a.status = 'suggested') as suggested_count,
    count(*) filter (where a.status = 'confirmed' and sd.payment_status <> 'pagado') as unpaid_count,
    sum(a.amount) filter (
      where a.status = 'confirmed' and sd.currency = o.currency and sd.payment_status <> 'pagado'
    ) as unpaid_amount
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  where a.recurring_service_period_id = o.id
) b on true;

-- ---------------------------------------------------------------------
-- 3. Job search: every job a document is allocated to; no placeholders
-- ---------------------------------------------------------------------
create or replace function public.list_projects(
  p_company_id uuid,
  p_scope text default 'activos'::text,
  p_query text default null::text,
  p_year integer default null::integer,
  p_limit integer default null::integer,
  p_offset integer default 0
)
returns table (
  id uuid, company_id uuid, client_id uuid, business_area_id uuid, name text,
  start_date date, end_date date, status text, quoted_amount numeric, cost_budget numeric,
  responsible text, invoiceable boolean, hold_reason text, closed_at timestamp with time zone,
  client_name text, client_monthly boolean, business_area_name text, total_count bigint
)
language sql
stable
set search_path to ''
as $function$
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
    -- Real quote numbers only: a placeholder's "S/C-..." is internal.
    select q.project_id
    from public.project_quotes q, pattern
    where pattern.needle is not null
      and q.company_id = p_company_id
      and not q.placeholder
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
    union
    -- A document allocated to several jobs: each of them.
    select q.project_id
    from public.sales_allocations a
    join public.project_quotes q on q.id = a.project_quote_id
    join public.sales_documents sd on sd.id = a.sales_document_id, pattern
    where pattern.needle is not null
      and a.company_id = p_company_id
      and a.status = 'confirmed'
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
$function$;

revoke execute on function public.list_projects(uuid, text, text, integer, integer, integer) from public, anon;
grant execute on function public.list_projects(uuid, text, text, integer, integer, integer) to authenticated, service_role;

revoke execute on function public.match_recurring_service_occurrences_for_import_batch(uuid) from public, anon;
grant execute on function public.match_recurring_service_occurrences_for_import_batch(uuid) to authenticated, service_role;

grant select on public.recurring_service_period_summary to authenticated, service_role;
