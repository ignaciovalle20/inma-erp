-- Currency of a payment to an external technician.
--
-- A charge has its own currency since 20261109020000 (Chile CLP, Uruguay USD
-- or UYU), but a payment had none: the cuenta corriente added dollars and
-- pesos together, and a payment could be applied to charges of any currency.
--
-- 1. technician_payments.currency (not null, CLP/UYU/USD), filled with the
--    company's currency for every existing payment. The migration stops if
--    that would leave a payment applied to a charge of another currency.
-- 2. A payment's currency must be one of its company's (Chile: CLP only).
-- 3. A payment is only applied to charges of its own currency
--    (technician_payment_applications_guard).
-- 4. A charge with payments applied cannot change its currency.
-- 5. record_technician_payment takes p_currency (default null = the currency
--    of the charges it is applied to, so callers that do not send it still
--    work). The 6-argument signature is replaced.
--
-- No amount changes.

-- ---------------------------------------------------------------------
-- 1. technician_payments.currency
-- ---------------------------------------------------------------------
alter table public.technician_payments add column if not exists currency text;

update public.technician_payments p
set currency = c.currency
from public.companies c
where c.id = p.company_id and p.currency is null;

do $$
declare
  v_mismatched integer;
begin
  select count(*) into v_mismatched
  from public.technician_payment_applications a
  join public.technician_payments p on p.id = a.payment_id
  join public.technician_charges t on t.id = a.charge_id
  where t.currency <> p.currency;

  if v_mismatched > 0 then
    raise exception 'technician_payment_currency: % existing payment applications cover a charge in a currency other than their company''s; fix them before applying this migration', v_mismatched;
  end if;
end;
$$;

alter table public.technician_payments alter column currency set not null;

alter table public.technician_payments drop constraint if exists technician_payments_currency_check;
alter table public.technician_payments add constraint technician_payments_currency_check
  check (currency in ('CLP', 'UYU', 'USD'));

comment on column public.technician_payments.currency is
  'Currency of the payment: one of the company''s (Chile CLP, Uruguay USD or UYU). It is only applied to charges of this currency.';

-- ---------------------------------------------------------------------
-- 2. The payment's currency is one of the company's
-- ---------------------------------------------------------------------
-- Same as 20260921020000, plus the currency (not given: the company's).
create or replace function public.technician_payments_validate_company_refs()
returns trigger
language plpgsql
as $$
declare
  v_personnel_company_id uuid;
  v_personnel_type text;
begin
  select company_id, type into v_personnel_company_id, v_personnel_type
  from public.personnel
  where id = new.personnel_id;

  if v_personnel_company_id is null or v_personnel_company_id <> new.company_id then
    raise exception 'personnel_id must belong to the same company as the technician payment';
  end if;
  if v_personnel_type <> 'contractor' then
    raise exception 'Only external technicians can receive technician payments';
  end if;

  if new.currency is null then
    select currency into new.currency from public.companies where id = new.company_id;
  end if;
  if not (new.currency = any (coalesce(public.company_document_currencies(new.company_id), array[]::text[]))) then
    raise exception 'La moneda % no es una de las de la empresa', new.currency;
  end if;

  return new;
end;
$$;

-- A payment never changes its currency: its applications were checked against it.
create or replace function public.technician_payments_keep_currency()
returns trigger
language plpgsql
as $$
begin
  if new.currency is distinct from old.currency then
    raise exception 'Un pago no puede cambiar de moneda: borralo y registralo de nuevo';
  end if;
  return new;
end;
$$;

revoke execute on function public.technician_payments_keep_currency() from public, anon;

drop trigger if exists technician_payments_keep_currency on public.technician_payments;
create trigger technician_payments_keep_currency
  before update on public.technician_payments
  for each row
  execute function public.technician_payments_keep_currency();

-- ---------------------------------------------------------------------
-- 3. A payment is only applied to charges of its own currency
-- ---------------------------------------------------------------------
-- Same as 20260921020000, plus the currency check.
create or replace function public.technician_payment_applications_guard()
returns trigger
language plpgsql
as $$
declare
  v_payment public.technician_payments;
  v_charge public.technician_charges;
  v_applied numeric;
begin
  select * into v_charge from public.technician_charges where id = new.charge_id for update;
  select * into v_payment from public.technician_payments where id = new.payment_id;

  if v_charge.id is null or v_payment.id is null then
    raise exception 'The payment or the charge was not found';
  end if;

  if v_charge.company_id <> new.company_id or v_payment.company_id <> new.company_id then
    raise exception 'A payment application must belong to the same company as its payment and charge';
  end if;

  if v_charge.personnel_id <> v_payment.personnel_id then
    raise exception 'A payment can only be applied to charges of the same technician';
  end if;

  if v_charge.currency <> v_payment.currency then
    raise exception 'Un pago en % solo puede aplicarse a cargos en %: este cargo está en %',
      v_payment.currency, v_payment.currency, v_charge.currency;
  end if;

  select coalesce(sum(amount), 0) into v_applied
  from public.technician_payment_applications
  where charge_id = new.charge_id;

  if v_applied + new.amount > v_charge.amount then
    raise exception 'The payment applied to a charge (%) cannot exceed its amount (%)',
      v_applied + new.amount, v_charge.amount;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. A charge with payments cannot change its currency
-- ---------------------------------------------------------------------
create or replace function public.technician_charges_keep_paid_currency()
returns trigger
language plpgsql
as $$
begin
  if new.currency is distinct from old.currency
    and exists (select 1 from public.technician_payment_applications a where a.charge_id = old.id)
  then
    raise exception 'This charge already has payments applied: delete those payments first';
  end if;
  return new;
end;
$$;

revoke execute on function public.technician_charges_keep_paid_currency() from public, anon;

drop trigger if exists technician_charges_keep_paid_currency on public.technician_charges;
create trigger technician_charges_keep_paid_currency
  before update of currency on public.technician_charges
  for each row
  execute function public.technician_charges_keep_paid_currency();

-- ---------------------------------------------------------------------
-- 5. record_technician_payment takes p_currency
-- ---------------------------------------------------------------------
-- Same as 20260921020000. p_currency null: the currency of the charges the
-- payment is applied to (they must all share one).
drop function if exists public.record_technician_payment(uuid, date, numeric, text, text, jsonb);

create or replace function public.record_technician_payment(
  p_personnel_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_method text,
  p_notes text,
  p_applications jsonb,
  p_currency text default null
)
returns public.technician_payments
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_payment public.technician_payments;
  v_application jsonb;
  v_applied numeric := 0;
  v_charge_ids uuid[] := '{}';
  v_charge_id uuid;
  v_application_amount numeric;
  v_currency text := nullif(btrim(coalesce(p_currency, '')), '');
  v_charge_currencies text[];
begin
  if v_user_id is null then
    raise exception 'Authentication required to record a technician payment';
  end if;

  if p_payment_date is null then
    raise exception 'A payment date is required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'The payment amount must be greater than zero';
  end if;
  if p_applications is null or jsonb_typeof(p_applications) <> 'array' or jsonb_array_length(p_applications) = 0 then
    raise exception 'A payment must be applied to at least one charge';
  end if;

  select company_id into v_company_id from public.personnel where id = p_personnel_id;
  if v_company_id is null then
    raise exception 'Technician not found';
  end if;

  for v_application in select * from jsonb_array_elements(p_applications)
  loop
    if jsonb_typeof(v_application -> 'amount') is distinct from 'number' then
      raise exception 'Each application needs a numeric amount';
    end if;

    v_application_amount := (v_application ->> 'amount')::numeric;
    if v_application_amount <= 0 then
      raise exception 'Each application amount must be greater than zero';
    end if;

    v_charge_id := (v_application ->> 'charge_id')::uuid;
    if v_charge_id is null then
      raise exception 'Each application needs a charge_id';
    end if;
    if v_charge_id = any (v_charge_ids) then
      raise exception 'A charge can appear only once in a payment';
    end if;

    v_charge_ids := v_charge_ids || v_charge_id;
    v_applied := v_applied + v_application_amount;
  end loop;

  if v_applied <> p_amount then
    raise exception 'The applications (%) must add up to the payment amount (%)', v_applied, p_amount;
  end if;

  if v_currency is null then
    select array_agg(distinct t.currency order by t.currency) into v_charge_currencies
    from public.technician_charges t
    where t.id = any (v_charge_ids);

    if coalesce(array_length(v_charge_currencies, 1), 0) > 1 then
      raise exception 'Un pago solo puede aplicarse a cargos de una misma moneda: estos están en %',
        array_to_string(v_charge_currencies, ' y ');
    end if;
    -- No charge found: the application guard says so below.
    v_currency := v_charge_currencies[1];
  end if;

  insert into public.technician_payments (company_id, personnel_id, payment_date, amount, currency, method, notes, created_by)
  values (
    v_company_id,
    p_personnel_id,
    p_payment_date,
    p_amount,
    v_currency,
    nullif(btrim(coalesce(p_method, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_user_id
  )
  returning * into v_payment;

  -- In id order, so two payments over the same charges lock them in the same
  -- order and cannot deadlock.
  for v_application in
    select t.elem
    from jsonb_array_elements(p_applications) as t (elem)
    order by (t.elem ->> 'charge_id')::uuid
  loop
    insert into public.technician_payment_applications (company_id, payment_id, charge_id, amount, created_by)
    values (
      v_company_id,
      v_payment.id,
      (v_application ->> 'charge_id')::uuid,
      (v_application ->> 'amount')::numeric,
      v_user_id
    );
  end loop;

  return v_payment;
end;
$$;

revoke execute on function public.record_technician_payment(uuid, date, numeric, text, text, jsonb, text) from public, anon;
grant execute on function public.record_technician_payment(uuid, date, numeric, text, text, jsonb, text) to authenticated;
