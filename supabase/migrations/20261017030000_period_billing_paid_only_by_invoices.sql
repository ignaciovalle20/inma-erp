-- refresh_recurring_service_occurrence_billing (20261016010000) kept a
-- period 'collected' when a new allocation arrived, to respect a period
-- collected by hand (cash, no invoice). It could not tell that from a
-- period collected because its invoices were paid: a period billed with a
-- paid invoice that then got a second, unpaid one stayed 'collected' and
-- left Deuda, its debt counted nowhere. Now it stays collected only when
-- none of its invoices is paid (so the collection can only have been
-- manual); otherwise it follows the invoices.
create or replace function public.refresh_recurring_service_occurrence_billing(
  p_occurrence_id uuid,
  p_from_payment boolean default false
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_occ record;
  v_count int;
  v_unpaid int;
  v_first_date date;
  v_last_paid date;
  v_main uuid;
  v_status text;
begin
  select o.id, o.status, o.sales_document_id, o.invoiced_at, o.collected_at, rs.requires_invoice
  into v_occ
  from public.recurring_service_occurrences o
  join public.recurring_services rs on rs.id = o.recurring_service_id
  where o.id = p_occurrence_id;

  if v_occ.id is null or v_occ.status = 'void' then
    return;
  end if;

  select
    count(*),
    count(*) filter (where sd.payment_status <> 'pagado'),
    min(sd.document_date),
    max(sd.paid_at)
  into v_count, v_unpaid, v_first_date, v_last_paid
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  where a.recurring_service_period_id = p_occurrence_id
    and a.status = 'confirmed';

  if v_count = 0 then
    if v_occ.sales_document_id is not null then
      update public.recurring_service_occurrences
      set sales_document_id = null,
          status = case when v_occ.requires_invoice then 'pending_invoice' else 'pending_collection' end,
          invoiced_at = null,
          collected_at = null
      where id = p_occurrence_id;
    end if;
    return;
  end if;

  select a.sales_document_id into v_main
  from public.sales_allocations a
  join public.sales_documents sd on sd.id = a.sales_document_id
  where a.recurring_service_period_id = p_occurrence_id
    and a.status = 'confirmed'
  order by a.amount desc, sd.document_date, a.created_at, a.id
  limit 1;

  v_status := case
    when v_unpaid = 0 then 'collected'
    -- Collected by hand and none of its invoices is paid: keep it.
    when v_occ.status = 'collected' and not p_from_payment and v_unpaid = v_count then 'collected'
    else 'invoiced'
  end;

  update public.recurring_service_occurrences
  set sales_document_id = v_main,
      status = v_status,
      invoiced_at = coalesce(invoiced_at, v_first_date),
      collected_at = case
        when v_status = 'collected' then coalesce(collected_at, v_last_paid, v_first_date)
        else null
      end,
      link_review = null
  where id = p_occurrence_id
    and (
      sales_document_id is distinct from v_main
      or status is distinct from v_status
      or invoiced_at is null
      or (v_status = 'collected' and collected_at is null)
      or (v_status <> 'collected' and collected_at is not null)
      or link_review is not null
    );
end;
$$;

revoke execute on function public.refresh_recurring_service_occurrence_billing(uuid, boolean) from public, anon;
grant execute on function public.refresh_recurring_service_occurrence_billing(uuid, boolean) to authenticated, service_role;

-- Periods left 'collected' by the old rule while an invoice of theirs is
-- unpaid and another is paid: re-derived (a no-op for every other period).
select public.refresh_recurring_service_occurrence_billing(o.id, false)
from public.recurring_service_occurrences o
where o.status = 'collected'
  and exists (
    select 1 from public.sales_allocations a
    join public.sales_documents sd on sd.id = a.sales_document_id
    where a.recurring_service_period_id = o.id and a.status = 'confirmed' and sd.payment_status <> 'pagado'
  )
  and exists (
    select 1 from public.sales_allocations a
    join public.sales_documents sd on sd.id = a.sales_document_id
    where a.recurring_service_period_id = o.id and a.status = 'confirmed' and sd.payment_status = 'pagado'
  );
