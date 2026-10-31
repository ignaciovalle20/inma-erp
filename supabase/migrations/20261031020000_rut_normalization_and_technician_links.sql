-- One normalization of a RUT, and a technician's suppliers linked from both sides.
--
-- The bug: suppliers_link_technician ran only AFTER INSERT on suppliers. A
-- technician whose RUT was typed in the ficha after their supplier existed
-- (the usual order: the purchases import creates the supplier first) was never
-- linked, although both RUTs were identical, and so nothing of theirs was
-- recognized or suggested. A supplier that got its RUT later had the same
-- problem. On prod: EXEQUIAS CATRIN and CARLOS GUTIERREZ.
--
-- What changes (Chilean companies only: a Uruguayan RUC stays as typed):
--   * normalize_tax_id is now the app's normalizeRut (web/src/lib/rut.ts): no
--     dots or spaces, hyphen before the check digit, upper case, no leading
--     zeros. Text that is not a RUT is compared by its alphanumeric characters,
--     as before.
--   * Before saving, personnel.tax_id and suppliers.tax_id are stored normalized.
--   * Links are made when a supplier is created or gets a RUT, and when a
--     technician is created or gets a RUT. A technician may have several RUTs
--     (personal for boletas, the company's for facturas): the ficha's RUT and
--     every supplier already linked count. A RUT in two technicians' fichas
--     stays unlinked: that is for a person to decide.
--   * Existing RUTs are normalized and the missing links are made below.
--
-- Idempotent: running the update and the insert again changes nothing.

create or replace function public.normalize_tax_id(p_tax_id text)
returns text
language sql
immutable
as $$
  with compact as (
    select nullif(upper(regexp_replace(coalesce(p_tax_id, ''), '[^0-9A-Za-z]', '', 'g')), '') as value
  ),
  parts as (
    select value, regexp_replace(left(value, -1), '^0+', '') as body, right(value, 1) as check_digit
    from compact
  )
  select case
    when value ~ '^[0-9]+[0-9K]$' and length(body) between 6 and 9 then body || '-' || check_digit
    else value
  end
  from parts;
$$;

comment on function public.normalize_tax_id(text) is
  'A RUT as 12345678-K (same as normalizeRut in web/src/lib/rut.ts); anything else, its alphanumeric characters in upper case.';

-- What is stored: the normalized RUT, or the trimmed text when it is not a RUT
-- (same as taxIdForStorage). A company that is not Chilean keeps what was typed.
create or replace function public.tax_id_for_storage(p_company_id uuid, p_tax_id text)
returns text
language plpgsql
stable
as $$
declare
  v_normalized text := public.normalize_tax_id(p_tax_id);
begin
  if v_normalized is null then
    return null;
  end if;
  if public.company_is_chile(p_company_id) and v_normalized ~ '^[0-9]{6,9}-[0-9K]$' then
    return v_normalized;
  end if;
  return btrim(p_tax_id);
end;
$$;

revoke execute on function public.tax_id_for_storage(uuid, text) from public, anon;
grant execute on function public.tax_id_for_storage(uuid, text) to authenticated, service_role;

create or replace function public.normalize_tax_id_before_save()
returns trigger
language plpgsql
as $$
begin
  new.tax_id := public.tax_id_for_storage(new.company_id, new.tax_id);
  return new;
end;
$$;

revoke execute on function public.normalize_tax_id_before_save() from public, anon;

create trigger suppliers_normalize_tax_id
  before insert or update of tax_id on public.suppliers
  for each row
  execute function public.normalize_tax_id_before_save();

create trigger personnel_normalize_tax_id
  before insert or update of tax_id on public.personnel
  for each row
  execute function public.normalize_tax_id_before_save();

-- A supplier created with a technician's RUT, or that gets one later.
drop trigger suppliers_link_technician on public.suppliers;

create trigger suppliers_link_technician
  after insert or update of tax_id on public.suppliers
  for each row
  execute function public.suppliers_link_technician();

-- A technician created with a RUT, or that gets one later (or becomes a
-- contractor): the suppliers with that RUT that belong to nobody become theirs.
create or replace function public.personnel_link_suppliers()
returns trigger
language plpgsql
as $$
declare
  v_tax_id text := public.normalize_tax_id(new.tax_id);
begin
  if v_tax_id is null or new.type <> 'contractor' or not public.company_is_chile(new.company_id) then
    return null;
  end if;

  if exists (
    select 1 from public.personnel p
    where p.company_id = new.company_id
      and p.id <> new.id
      and p.type = 'contractor'
      and public.normalize_tax_id(p.tax_id) = v_tax_id
  ) then
    return null;
  end if;

  insert into public.technician_suppliers (company_id, personnel_id, supplier_id)
  select new.company_id, new.id, s.id
  from public.suppliers s
  where s.company_id = new.company_id
    and public.normalize_tax_id(s.tax_id) = v_tax_id
  on conflict (supplier_id) do nothing;

  return null;
end;
$$;

revoke execute on function public.personnel_link_suppliers() from public, anon;

create trigger personnel_link_suppliers
  after insert or update of tax_id, type on public.personnel
  for each row
  execute function public.personnel_link_suppliers();

-- ---------------------------------------------------------------------
-- What is already stored. The triggers above make the links of the technicians
-- touched here; the insert below covers those whose RUT already was normalized.
-- ---------------------------------------------------------------------
alter table public.suppliers disable trigger suppliers_set_updated_at;
alter table public.personnel disable trigger personnel_set_updated_at;

update public.suppliers s
set tax_id = public.tax_id_for_storage(s.company_id, s.tax_id)
where s.tax_id is distinct from public.tax_id_for_storage(s.company_id, s.tax_id);

update public.personnel p
set tax_id = public.tax_id_for_storage(p.company_id, p.tax_id)
where p.tax_id is distinct from public.tax_id_for_storage(p.company_id, p.tax_id);

alter table public.suppliers enable trigger suppliers_set_updated_at;
alter table public.personnel enable trigger personnel_set_updated_at;

insert into public.technician_suppliers (company_id, personnel_id, supplier_id)
select s.company_id, min(p.id::text)::uuid, s.id
from public.suppliers s
join public.personnel p
  on p.company_id = s.company_id
  and p.type = 'contractor'
  and public.normalize_tax_id(p.tax_id) = public.normalize_tax_id(s.tax_id)
where public.normalize_tax_id(s.tax_id) is not null
  and public.company_is_chile(s.company_id)
group by s.company_id, s.id
having count(distinct p.id) = 1
on conflict (supplier_id) do nothing;
