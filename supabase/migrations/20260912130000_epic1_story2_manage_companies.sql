-- Epic 1, Story 1.2: Manage Companies
-- Extends `companies` with country/tax_id/currency/active, adds an
-- admin-gated UPDATE policy, and adds create_company() so that company
-- creation always happens atomically with the creator's admin
-- membership (never a raw client INSERT).

-- ---------------------------------------------------------------------
-- companies: new fields
-- ---------------------------------------------------------------------
alter table public.companies
  add column country text,
  add column tax_id text,
  add column currency text not null default 'CLP'
    check (currency in ('CLP', 'UYU', 'USD')),
  add column active boolean not null default true;

-- created_by/updated_by are populated from auth.uid() on every write;
-- defaults cover inserts, the shared trigger below covers updates.
alter table public.companies
  alter column created_by set default auth.uid(),
  alter column updated_by set default auth.uid();

-- ---------------------------------------------------------------------
-- Shared trigger: also keep updated_by current on every UPDATE.
-- (company_memberships has the same column, so this benefits it too.)
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- RLS: only a company's admin may update it.
-- ---------------------------------------------------------------------
create policy "Admins can update their companies"
  on public.companies
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = companies.id
        and cm.user_id = auth.uid()
        and cm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = companies.id
        and cm.user_id = auth.uid()
        and cm.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------
-- create_company: the only path to create a company. Inserts the
-- company then an 'admin' membership row for the caller, atomically.
-- security definer because the client has no INSERT policy on either
-- table -- any authenticated user may call this and becomes that
-- company's admin (see Design Notes: 2-person internal tool, no
-- separate "who can create a company" gate).
-- ---------------------------------------------------------------------
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

revoke execute on function public.create_company(text, text, text, text) from public;
grant execute on function public.create_company(text, text, text, text) to authenticated;
