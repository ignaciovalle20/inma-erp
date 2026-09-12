-- Epic 1, Story 1.5 review patch: enforce case-insensitive uniqueness of
-- business area names within a company at the DB level. Unlike clients/
-- suppliers, business areas are a controlled internal taxonomy where two
-- entries with the same name (regardless of case) are always a mistake,
-- never a legitimate duplicate -- so this is a hard constraint, not just
-- an app-level friendly check.
create unique index business_areas_company_id_lower_name_key
  on public.business_areas (company_id, lower(name));
