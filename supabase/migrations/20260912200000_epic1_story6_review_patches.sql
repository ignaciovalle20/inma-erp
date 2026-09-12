-- Epic 1, Story 1.6 review patch: enforce at the DB level that a
-- project's client_id and business_area_id belong to the same company as
-- the project itself. The Server Actions already check this, but that is
-- app-layer only -- a raw REST/SQL insert (or a future caller) could
-- otherwise create a project whose client or business area belongs to a
-- different company, since a plain FK can't cross-check company_id
-- equality and the RLS policies only verify membership in the submitted
-- company_id, not that the referenced rows belong to it.
create or replace function public.projects_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  client_company_id uuid;
  area_company_id uuid;
begin
  select company_id into client_company_id
  from public.clients
  where id = new.client_id;

  if client_company_id is null or client_company_id <> new.company_id then
    raise exception 'client_id must belong to the same company as the project';
  end if;

  select company_id into area_company_id
  from public.business_areas
  where id = new.business_area_id;

  if area_company_id is null or area_company_id <> new.company_id then
    raise exception 'business_area_id must belong to the same company as the project';
  end if;

  return new;
end;
$$;

create trigger projects_validate_company_refs
  before insert or update on public.projects
  for each row
  execute function public.projects_validate_company_refs();
