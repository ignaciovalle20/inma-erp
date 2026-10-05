-- Recurring Services redesign, Phase 7: automatic matching of
-- recurring_service_occurrences against the Nubox import.
-- plan-servicios-recurrentes.md: "al llegar el import mensual el
-- sistema puede matchear automáticamente una factura nueva (mismo
-- cliente, monto similar) con una occurrence pendiente_facturar y
-- pasarla sola a facturado; si esa factura después figura pagada en
-- Nubox, pasarla sola a cobrado." Uruguay and no-invoice clients keep
-- the manual Facturar/Cobrar taps from Phase 5 -- this only ever runs
-- from the Nubox import, which is already Chile-only
-- (requireChileMembership in sales/import/nubox/actions.ts).
--
-- Deliberately a *separate* function, called as a follow-up step from
-- commitNuboxImport right after import_nubox_documents_batch, the
-- same way that action already calls update_import_batch_counts as
-- its own follow-up RPC -- rather than editing
-- import_nubox_documents_batch itself, which is large, already
-- covered by its own Nubox test suite, and has no reason to know
-- about recurring services at all. Scoped to the rows THIS batch
-- touched via import_rows.sales_document_id (every 'imported' /
-- 'updated' row is linked there), so re-running an import never
-- reprocesses documents from earlier batches.
--
-- "Monto similar" is implemented as an *exact* match on
-- (client, net_amount, currency) -- every other automated match in
-- this importer (suggestAdoptions, suggestCreditNotePairs) is exact
-- too, never a fuzzy tolerance window; an ambiguous or inexact case
-- is simply left unmatched, for the manual Facturar/Cobrar tap on the
-- Pendientes screen (Phase 5) instead of risking a wrong auto-link.
--
-- Plain function (not security definer) -- same reasoning as every
-- other RPC in this module: the caller (an authenticated company
-- member, already RLS-authorized to write sales_documents and
-- recurring_service_occurrences through the normal Nubox import flow)
-- carries its own permissions; this function's job is just doing the
-- two-phase matching atomically in one call.
create or replace function public.match_recurring_service_occurrences_for_import_batch(
  p_import_batch_id uuid
)
returns table (
  occurrence_id uuid,
  sales_document_id uuid,
  matched_action text
)
language plpgsql
as $$
declare
  v_invoice record;
  v_paid record;
  v_occurrence_id uuid;
begin
  -- Phase 1: an invoice this batch imported or updated, not yet linked
  -- to any occurrence, claims the one pending_invoice occurrence for
  -- the same client/amount/currency (oldest period first, a stable
  -- tie-break if more than one candidate exists).
  for v_invoice in
    select sd.id, sd.client_id, sd.net_amount, sd.currency
    from public.sales_documents sd
    join public.import_rows ir on ir.sales_document_id = sd.id
    where ir.import_batch_id = p_import_batch_id
      and sd.document_type = 'invoice'
      and not sd.voided
      and sd.client_id is not null
      and not exists (
        select 1 from public.recurring_service_occurrences o
        where o.sales_document_id = sd.id
      )
    order by sd.document_number
  loop
    select o.id into v_occurrence_id
    from public.recurring_service_occurrences o
    join public.recurring_services rs on rs.id = o.recurring_service_id
    where rs.client_id = v_invoice.client_id
      and o.status = 'pending_invoice'
      and o.amount = v_invoice.net_amount
      and o.currency = v_invoice.currency
    order by o.period
    limit 1;

    if v_occurrence_id is not null then
      update public.recurring_service_occurrences
      set status = 'invoiced',
          invoiced_at = current_date,
          sales_document_id = v_invoice.id
      where id = v_occurrence_id;

      occurrence_id := v_occurrence_id;
      sales_document_id := v_invoice.id;
      matched_action := 'invoiced';
      return next;
    end if;
  end loop;

  -- Phase 2: any occurrence linked to a document this batch just
  -- marked paid -> collected. Not limited to documents Phase 1 just
  -- linked above -- an occurrence linked by an earlier import often
  -- gets its "paid" update from a later one, since Nubox reports
  -- payment status days or weeks after the invoice itself appears.
  -- Runs after Phase 1 within the same function call, so an invoice
  -- that arrives already marked paid goes straight from
  -- pending_invoice to collected in one import.
  for v_paid in
    select o.id as occ_id, o.sales_document_id as doc_id, sd.paid_at
    from public.recurring_service_occurrences o
    join public.sales_documents sd on sd.id = o.sales_document_id
    join public.import_rows ir on ir.sales_document_id = sd.id
    where ir.import_batch_id = p_import_batch_id
      and o.status = 'invoiced'
      and sd.payment_status = 'pagado'
  loop
    update public.recurring_service_occurrences
    set status = 'collected',
        collected_at = coalesce(v_paid.paid_at, current_date)
    where id = v_paid.occ_id;

    occurrence_id := v_paid.occ_id;
    sales_document_id := v_paid.doc_id;
    matched_action := 'collected';
    return next;
  end loop;
end;
$$;

revoke execute on function public.match_recurring_service_occurrences_for_import_batch(uuid) from public;
grant execute on function public.match_recurring_service_occurrences_for_import_batch(uuid) to authenticated;
