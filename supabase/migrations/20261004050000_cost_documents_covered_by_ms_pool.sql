-- The Microsoft licenses invoice of a month that already has an MS licenses
-- pool must not be counted twice (docs/verificacion-contable-2026-10-04.md,
-- P08 -> point 5). Since recurring costs are in the monthly result (C01),
-- the pool carries that invoice's cost; if the same invoice is also loaded
-- as a cost document, it used to be added a second time.
--
-- A cost document is "cubierto por pool" when, in its effective month
-- (recognized_period, else the month of document_date), its company has an
-- ms_licenses pool and either
--   - the pool has a supplier and it is the document's supplier, or
--   - the document belongs to the MS licenses area: its job's area, or the
--     area (or a job's area) of one of its cost_allocations;
-- and the document is NOT attributed to a job or area outside the MS
-- licenses area. That last condition is a conservative reading of "same
-- supplier": a supplier can bill other things too (in DEV, the supplier of
-- Demo Chile SpA's September pool also billed "Discos y memoria" to an IT
-- Support job), and leaving a real cost out would overstate the result.
-- The MS licenses area is an area named "Microsoft 365" / "Licencias MS" or
-- the area of any ms_licenses recurring service of the company.
--
-- covered_by_cost_pool_id(cost_documents) is a computed column (PostgREST
-- exposes it as cost_documents.covered_by_cost_pool_id): always up to date
-- whether the pool or the document came first, and nothing is stored. The
-- reports leave these documents out; the costs list shows them marked.
--
-- Additive: three new functions, no table or data change.

create or replace function public.is_ms_licenses_area(p_area_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.business_areas a
    where a.id = p_area_id
      and (
        lower(btrim(a.name)) in ('microsoft 365', 'licencias ms', 'licencias microsoft')
        or exists (
          select 1
          from public.recurring_services s
          where s.business_area_id = a.id
            and s.company_id = a.company_id
            and s.service_type = 'ms_licenses'
        )
      )
  );
$$;

comment on function public.is_ms_licenses_area(uuid) is
  'True for the MS licenses area of a company: named Microsoft 365 / Licencias MS, or used by an ms_licenses recurring service.';

create or replace function public.ms_licenses_area_ids(p_company_id uuid)
returns setof uuid
language sql
stable
as $$
  select a.id
  from public.business_areas a
  where a.company_id = p_company_id
    and public.is_ms_licenses_area(a.id);
$$;

comment on function public.ms_licenses_area_ids(uuid) is
  'The MS licenses areas of a company (see is_ms_licenses_area), for the cost form''s warning.';

create or replace function public.covered_by_cost_pool_id(public.cost_documents)
returns uuid
language sql
stable
as $$
  select p.id
  from public.recurring_service_cost_pools p
  where p.company_id = $1.company_id
    and p.service_type = 'ms_licenses'
    and p.period = coalesce($1.recognized_period, date_trunc('month', $1.document_date)::date)
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
$$;

comment on function public.covered_by_cost_pool_id(public.cost_documents) is
  'The ms_licenses pool that already carries this cost document (same month and the pool''s supplier or the MS licenses area): reports leave the document out. Null when none.';

revoke execute on function public.is_ms_licenses_area(uuid) from public, anon;
revoke execute on function public.ms_licenses_area_ids(uuid) from public, anon;
revoke execute on function public.covered_by_cost_pool_id(public.cost_documents) from public, anon;
grant execute on function public.is_ms_licenses_area(uuid) to authenticated, service_role;
grant execute on function public.ms_licenses_area_ids(uuid) to authenticated, service_role;
grant execute on function public.covered_by_cost_pool_id(public.cost_documents) to authenticated, service_role;

notify pgrst, 'reload schema';
