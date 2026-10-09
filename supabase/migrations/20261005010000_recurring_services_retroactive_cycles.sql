-- Servicios recurrentes: ciclos retroactivos desde el inicio del servicio,
-- vínculo automático con las facturas ya importadas y acciones masivas
-- (docs/servicios-recurrentes-cambios.md, "Generación retroactiva").
--
-- Additive: one new column, one new table, new functions, and the
-- generator recreated with an extra optional parameter. No existing cycle
-- is deleted; the generator only inserts (ON CONFLICT DO NOTHING on
-- unique (recurring_service_id, period)).
--
-- 1. The global floor moves from September 2026 to January 2026: the
--    month generator (and so the cron and the board) generates any month
--    from January 2026 on. Same rules otherwise (vencido bills the month
--    that closed, annual only in its due month, active on any day of the
--    period, day 1 when there's no due day).
-- 2. generate_recurring_service_occurrences_since_start(service, until):
--    every missing cycle of one service from max(its start month,
--    January 2026) through `until` -- run after creating a service or
--    changing its start date, and as the backfill below.
-- 3. match_recurring_service_occurrences_to_invoices(...): for each past
--    cycle with no sales document (Chile, services that require an
--    invoice), look for an invoice of the same client, issued in the
--    month the cycle is due (= the period month for mes adelantado, the
--    month after for mes vencido, the due month for annual), same
--    currency, net amount within 2%, not voided, not credit-noted and
--    not linked to another cycle. Exactly one candidate (that no other
--    cycle also claims) -> linked, and the state follows Nubox's payment
--    status (pagado -> collected, otherwise invoiced). None or several ->
--    the cycle stays as it is, flagged link_review = 'no_match' /
--    'multiple' for a manual decision. Linking is what keeps the
--    profitability report from counting the income twice (it skips
--    cycles with a sales_document_id: the invoice already counts).
-- 4. bulk_mark_recurring_service_occurrences / undo: "Marcar como
--    facturado / cobrado hasta [mes]" with an undo log.
-- 5. Backfill: retroactive generation for every active service, then the
--    matching.

-- ---------------------------------------------------------------------
-- link_review on each cycle
-- ---------------------------------------------------------------------
alter table public.recurring_service_occurrences
  add column link_review text
    check (link_review in ('no_match', 'multiple', 'dismissed'));

comment on column public.recurring_service_occurrences.link_review is
  'Invoice matching: no_match / multiple = needs a manual link; dismissed = reviewed, no invoice to link. Cleared when a sales document is linked.';

create or replace function public.recurring_service_occurrences_clear_link_review()
returns trigger
language plpgsql
as $$
begin
  if new.sales_document_id is not null then
    new.link_review := null;
  end if;
  return new;
end;
$$;

create trigger recurring_service_occurrences_clear_link_review
  before insert or update on public.recurring_service_occurrences
  for each row
  execute function public.recurring_service_occurrences_clear_link_review();

-- ---------------------------------------------------------------------
-- 1. Month generator: floor January 2026, optional single service
-- ---------------------------------------------------------------------
drop function public.generate_recurring_service_occurrences_for_month(date, uuid);

create function public.generate_recurring_service_occurrences_for_month(
  p_month date,
  p_company_id uuid default null,
  p_service_id uuid default null
)
returns table (
  occurrence_id uuid,
  service_id uuid,
  occurrence_period date
)
language plpgsql
set search_path = public
as $$
declare
  c_first_month constant date := date '2026-01-01';
  v_month date := date_trunc('month', p_month)::date;
  v_service record;
  v_period date;
  v_period_end date;
  v_due_month int;
  v_last_day int;
  v_due_date date;
  v_new_id uuid;
begin
  -- The first month managed in the ERP.
  if v_month < c_first_month then
    return;
  end if;

  for v_service in
    select *
    from public.recurring_services
    where status = 'active'
      and (p_company_id is null or company_id = p_company_id)
      and (p_service_id is null or id = p_service_id)
  loop
    if v_service.periodicity = 'monthly' then
      -- Anticipado bills the month itself; vencido the one that closed.
      v_period := v_month;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 month')::date;
      end if;
      v_period_end := (v_period + interval '1 month - 1 day')::date;
      v_due_month := extract(month from v_month)::int;
    else
      -- Annual: only in its due month.
      if v_service.due_month is null
         or v_service.due_month <> extract(month from v_month)::int then
        continue;
      end if;
      v_period := date_trunc('year', v_month)::date;
      if v_service.invoicing_mode = 'arrears' then
        v_period := (v_period - interval '1 year')::date;
      end if;
      v_period_end := (v_period + interval '1 year - 1 day')::date;
      v_due_month := v_service.due_month;
    end if;

    -- Active on any day of the period being generated.
    if v_service.start_date > v_period_end
       or (v_service.end_date is not null and v_service.end_date < v_period) then
      continue;
    end if;

    -- Due within the month being generated; day 1 when not configured.
    v_last_day := extract(
      day from (make_date(extract(year from v_month)::int, v_due_month, 1) + interval '1 month - 1 day')
    )::int;
    v_due_date := make_date(
      extract(year from v_month)::int,
      v_due_month,
      least(coalesce(v_service.due_day, 1), v_last_day)
    );

    v_new_id := null;

    insert into public.recurring_service_occurrences (
      recurring_service_id,
      period,
      invoice_due_date,
      collection_due_date,
      amount,
      currency,
      status
    )
    values (
      v_service.id,
      v_period,
      v_due_date,
      v_due_date,
      v_service.price,
      v_service.currency,
      case when v_service.requires_invoice then 'pending_invoice' else 'pending_collection' end
    )
    on conflict (recurring_service_id, period) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      occurrence_id := v_new_id;
      service_id := v_service.id;
      occurrence_period := v_period;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public.generate_recurring_service_occurrences_for_month(date, uuid, uuid) from public, anon;
grant execute on function public.generate_recurring_service_occurrences_for_month(date, uuid, uuid) to authenticated, service_role;

-- The cron's wrapper is unchanged in behavior; recreated so its body
-- resolves to the new signature explicitly.
create or replace function public.generate_due_recurring_service_occurrences()
returns table (
  occurrence_id uuid,
  service_id uuid,
  occurrence_period date
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select g.occurrence_id, g.service_id, g.occurrence_period
    from public.generate_recurring_service_occurrences_for_month(current_date, null, null) g;
end;
$$;

revoke execute on function public.generate_due_recurring_service_occurrences() from public, anon, authenticated;
grant execute on function public.generate_due_recurring_service_occurrences() to service_role;

-- ---------------------------------------------------------------------
-- 2. Retroactive generation for one service
-- ---------------------------------------------------------------------
create or replace function public.generate_recurring_service_occurrences_since_start(
  p_service_id uuid,
  p_until date default current_date
)
returns table (
  occurrence_id uuid,
  service_id uuid,
  occurrence_period date
)
language plpgsql
set search_path = public
as $$
declare
  v_start date;
  v_month date;
  v_until date := date_trunc('month', coalesce(p_until, current_date))::date;
begin
  select start_date into v_start
  from public.recurring_services
  where id = p_service_id;

  if v_start is null then
    return;
  end if;

  v_month := greatest(date_trunc('month', v_start)::date, date '2026-01-01');

  while v_month <= v_until loop
    return query
      select g.occurrence_id, g.service_id, g.occurrence_period
      from public.generate_recurring_service_occurrences_for_month(v_month, null, p_service_id) g;
    v_month := (v_month + interval '1 month')::date;
  end loop;
end;
$$;

revoke execute on function public.generate_recurring_service_occurrences_since_start(uuid, date) from public, anon;
grant execute on function public.generate_recurring_service_occurrences_since_start(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Linking a cycle to an invoice, and the automatic matching
-- ---------------------------------------------------------------------

-- Links one cycle to one sales document and moves its state the way the
-- invoice says: Nubox "pagado" -> collected (on the payment date, else
-- the invoice date), otherwise invoiced. Never moves a collected cycle
-- back. Used by the matching below and by the manual "vincular" on a
-- cycle flagged for review.
create or replace function public.link_recurring_service_occurrence_to_invoice(
  p_occurrence_id uuid,
  p_sales_document_id uuid
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_doc record;
  v_status text;
  v_new_status text;
begin
  select document_date, payment_status, paid_at
  into v_doc
  from public.sales_documents
  where id = p_sales_document_id;

  if not found then
    raise exception 'Sales document not found';
  end if;

  select status into v_status
  from public.recurring_service_occurrences
  where id = p_occurrence_id;

  if v_status is null then
    raise exception 'Occurrence not found';
  end if;

  if v_status = 'void' then
    raise exception 'A voided cycle cannot be linked';
  end if;

  v_new_status := case
    when v_status = 'collected' or v_doc.payment_status = 'pagado' then 'collected'
    else 'invoiced'
  end;

  update public.recurring_service_occurrences
  set sales_document_id = p_sales_document_id,
      status = v_new_status,
      invoiced_at = coalesce(invoiced_at, v_doc.document_date),
      collected_at = case
        when v_new_status = 'collected' then coalesce(collected_at, v_doc.paid_at, v_doc.document_date)
        else collected_at
      end
  where id = p_occurrence_id;

  return v_new_status;
end;
$$;

revoke execute on function public.link_recurring_service_occurrence_to_invoice(uuid, uuid) from public, anon;
grant execute on function public.link_recurring_service_occurrence_to_invoice(uuid, uuid) to authenticated, service_role;

create or replace function public.match_recurring_service_occurrences_to_invoices(
  p_company_id uuid default null,
  p_service_id uuid default null,
  p_until date default current_date
)
returns table (
  occurrence_id uuid,
  result text,
  sales_document_id uuid
)
language plpgsql
set search_path = public
as $$
declare
  v_row record;
  v_status text;
begin
  for v_row in
    with cycles as (
      select
        o.id,
        o.status,
        o.amount,
        o.currency,
        o.link_review,
        rs.client_id,
        rs.company_id,
        date_trunc('month', coalesce(o.invoice_due_date, o.period))::date as invoice_month
      from public.recurring_service_occurrences o
      join public.recurring_services rs on rs.id = o.recurring_service_id
      join public.companies c on c.id = rs.company_id
      where o.sales_document_id is null
        and o.status in ('pending_invoice', 'invoiced', 'collected')
        and o.link_review is distinct from 'dismissed'
        and rs.requires_invoice
        and upper(coalesce(c.country, '')) = 'CL'
        and (p_company_id is null or rs.company_id = p_company_id)
        and (p_service_id is null or rs.id = p_service_id)
        -- Past cycles only: due up to the end of p_until's month.
        and coalesce(o.invoice_due_date, o.period)
            < (date_trunc('month', coalesce(p_until, current_date)) + interval '1 month')::date
    ),
    candidates as (
      select cy.id as occ_id, sd.id as doc_id
      from cycles cy
      join public.sales_documents sd
        on sd.company_id = cy.company_id
       and sd.client_id = cy.client_id
       and sd.document_type = 'invoice'
       and not sd.voided
       and sd.annulled_by_document_id is null
       and sd.currency = cy.currency
       and date_trunc('month', sd.document_date)::date = cy.invoice_month
       and abs(sd.net_amount - cy.amount) <= 0.02 * abs(cy.amount)
      where not exists (
        select 1 from public.recurring_service_occurrences o2
        where o2.sales_document_id = sd.id
      )
    ),
    per_occ as (
      select occ_id, count(*) as n, min(doc_id::text)::uuid as doc_id
      from candidates
      group by occ_id
    ),
    per_doc as (
      select doc_id, count(*) as n
      from candidates
      group by doc_id
    )
    select
      cy.id,
      cy.status,
      cy.link_review,
      coalesce(po.n, 0) as n,
      po.doc_id,
      coalesce(pd.n, 0) as doc_claims
    from cycles cy
    left join per_occ po on po.occ_id = cy.id
    left join per_doc pd on pd.doc_id = po.doc_id
    order by cy.invoice_month, cy.id
  loop
    if v_row.n = 1 and v_row.doc_claims = 1 then
      v_status := public.link_recurring_service_occurrence_to_invoice(v_row.id, v_row.doc_id);
      occurrence_id := v_row.id;
      result := 'linked_' || v_status;
      sales_document_id := v_row.doc_id;
      return next;
    elsif v_row.n > 1 or v_row.doc_claims > 1 then
      if v_row.link_review is distinct from 'multiple' then
        update public.recurring_service_occurrences set link_review = 'multiple' where id = v_row.id;
      end if;
      occurrence_id := v_row.id;
      result := 'review_multiple';
      sales_document_id := null;
      return next;
    elsif v_row.status = 'pending_invoice' then
      -- Nothing to link. Only a cycle still waiting to be invoiced needs a
      -- decision; one already marked invoiced/collected by hand has no
      -- second income to collide with.
      if v_row.link_review is distinct from 'no_match' then
        update public.recurring_service_occurrences set link_review = 'no_match' where id = v_row.id;
      end if;
      occurrence_id := v_row.id;
      result := 'review_no_match';
      sales_document_id := null;
      return next;
    end if;
  end loop;
end;
$$;

revoke execute on function public.match_recurring_service_occurrences_to_invoices(uuid, uuid, date) from public, anon;
grant execute on function public.match_recurring_service_occurrences_to_invoices(uuid, uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Bulk "facturado / cobrado hasta [mes]" with undo
-- ---------------------------------------------------------------------
create table public.recurring_service_occurrence_bulk_changes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  occurrence_id uuid not null references public.recurring_service_occurrences (id),
  action text not null check (action in ('invoice', 'collect')),
  prev_status text not null,
  prev_invoiced_at date,
  prev_collected_at date,
  new_status text not null,
  undone_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid()
);

create index recurring_service_occurrence_bulk_changes_batch_idx
  on public.recurring_service_occurrence_bulk_changes (batch_id);

alter table public.recurring_service_occurrence_bulk_changes enable row level security;

create policy "Members can view recurring service bulk changes"
  on public.recurring_service_occurrence_bulk_changes
  for select to authenticated
  using (
    exists (
      select 1
      from public.recurring_service_occurrences o
      join public.recurring_services rs on rs.id = o.recurring_service_id
      join public.company_memberships cm on cm.company_id = rs.company_id
      where o.id = recurring_service_occurrence_bulk_changes.occurrence_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create recurring service bulk changes"
  on public.recurring_service_occurrence_bulk_changes
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.recurring_service_occurrences o
      join public.recurring_services rs on rs.id = o.recurring_service_id
      join public.company_memberships cm on cm.company_id = rs.company_id
      where o.id = recurring_service_occurrence_bulk_changes.occurrence_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update recurring service bulk changes"
  on public.recurring_service_occurrence_bulk_changes
  for update to authenticated
  using (
    exists (
      select 1
      from public.recurring_service_occurrences o
      join public.recurring_services rs on rs.id = o.recurring_service_id
      join public.company_memberships cm on cm.company_id = rs.company_id
      where o.id = recurring_service_occurrence_bulk_changes.occurrence_id
        and cm.user_id = auth.uid()
    )
  );

-- Marks every open cycle of one service due up to the end of p_until_month
-- as invoiced ('invoice': pending_invoice only, invoiced on its due date)
-- or collected ('collect': any open state, collected on its due date;
-- one never invoiced also gets its due date as invoiced_at when the
-- service requires an invoice). Logs the previous values under one batch
-- id for the undo.
create or replace function public.bulk_mark_recurring_service_occurrences(
  p_service_id uuid,
  p_until_month date,
  p_action text
)
returns table (batch_id uuid, changed int)
language plpgsql
set search_path = public
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_until date := (date_trunc('month', p_until_month) + interval '1 month')::date;
  v_requires_invoice boolean;
  v_count int;
begin
  if p_action not in ('invoice', 'collect') then
    raise exception 'Unknown bulk action %', p_action;
  end if;

  select requires_invoice into v_requires_invoice
  from public.recurring_services
  where id = p_service_id;

  if v_requires_invoice is null then
    raise exception 'Recurring service not found';
  end if;

  insert into public.recurring_service_occurrence_bulk_changes (
    batch_id, occurrence_id, action, prev_status, prev_invoiced_at, prev_collected_at, new_status
  )
  select
    v_batch,
    o.id,
    p_action,
    o.status,
    o.invoiced_at,
    o.collected_at,
    case when p_action = 'invoice' then 'invoiced' else 'collected' end
  from public.recurring_service_occurrences o
  where o.recurring_service_id = p_service_id
    and coalesce(o.invoice_due_date, o.period) < v_until
    and (
      (p_action = 'invoice' and o.status = 'pending_invoice')
      or (p_action = 'collect' and o.status in ('pending_invoice', 'invoiced', 'pending_collection'))
    );

  get diagnostics v_count = row_count;

  if p_action = 'invoice' then
    update public.recurring_service_occurrences o
    set status = 'invoiced',
        invoiced_at = coalesce(o.invoice_due_date, o.period)
    from public.recurring_service_occurrence_bulk_changes b
    where b.batch_id = v_batch and b.occurrence_id = o.id;
  else
    update public.recurring_service_occurrences o
    set status = 'collected',
        collected_at = coalesce(o.collection_due_date, o.invoice_due_date, o.period),
        invoiced_at = case
          when o.status = 'pending_invoice' and v_requires_invoice
            then coalesce(o.invoiced_at, o.invoice_due_date, o.period)
          else o.invoiced_at
        end
    from public.recurring_service_occurrence_bulk_changes b
    where b.batch_id = v_batch and b.occurrence_id = o.id;
  end if;

  batch_id := v_batch;
  changed := v_count;
  return next;
end;
$$;

-- Restores what one bulk action changed. A cycle that was changed again
-- afterwards (its state is no longer what the bulk action left) is left
-- alone. Returns how many cycles were restored.
create or replace function public.undo_recurring_service_occurrences_bulk(p_batch_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  with restored as (
    update public.recurring_service_occurrences o
    set status = b.prev_status,
        invoiced_at = b.prev_invoiced_at,
        collected_at = b.prev_collected_at
    from public.recurring_service_occurrence_bulk_changes b
    where b.batch_id = p_batch_id
      and b.undone_at is null
      and b.occurrence_id = o.id
      and o.status = b.new_status
    returning o.id
  )
  update public.recurring_service_occurrence_bulk_changes b
  set undone_at = now()
  where b.batch_id = p_batch_id
    and b.undone_at is null
    and b.occurrence_id in (select id from restored);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.bulk_mark_recurring_service_occurrences(uuid, date, text) from public, anon;
grant execute on function public.bulk_mark_recurring_service_occurrences(uuid, date, text) to authenticated, service_role;
revoke execute on function public.undo_recurring_service_occurrences_bulk(uuid) from public, anon;
grant execute on function public.undo_recurring_service_occurrences_bulk(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. Backfill: every active service from its start (floor January 2026)
-- through the current month, then the invoice matching. Runs as the
-- migration owner, so every company.
-- ---------------------------------------------------------------------
select count(*)
from public.recurring_services rs
cross join lateral public.generate_recurring_service_occurrences_since_start(rs.id, current_date) g
where rs.status = 'active';

select count(*) from public.match_recurring_service_occurrences_to_invoices(null, null, current_date);
