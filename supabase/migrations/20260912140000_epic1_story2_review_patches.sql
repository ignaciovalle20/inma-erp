-- Epic 1, Story 1.2 review patches:
-- - revoke the default PUBLIC execute grant on create_company (defense
--   in depth; the function already rejects unauthenticated callers)
-- - validate p_currency explicitly so a direct RPC call bypassing the
--   UI gets a clean error instead of a raw constraint violation

revoke execute on function public.create_company(text, text, text, text) from public;

create or replace function public.create_company(
  p_name text,
  p_country text,
  p_tax_id text,
  p_currency text
)
returns public.companies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_company public.companies;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create a company';
  end if;

  if p_currency not in ('CLP', 'UYU', 'USD') then
    raise exception 'Invalid currency: %', p_currency;
  end if;

  insert into public.companies (name, country, tax_id, currency, created_by, updated_by)
  values (p_name, p_country, p_tax_id, coalesce(p_currency, 'CLP'), v_user_id, v_user_id)
  returning * into v_company;

  insert into public.company_memberships (user_id, company_id, role, created_by, updated_by)
  values (v_user_id, v_company.id, 'admin', v_user_id, v_user_id);

  return v_company;
end;
$$;

grant execute on function public.create_company(text, text, text, text) to authenticated;
