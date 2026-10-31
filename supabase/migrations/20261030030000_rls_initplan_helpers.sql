-- RLS performance (audit §4): same rules, evaluated once per query instead of
-- once per row.
-- - public.is_company_member / is_company_admin: STABLE helpers for the two
--   policy shapes used everywhere ("the caller is a member / an admin of this
--   company"). SECURITY DEFINER so the lookup does not re-apply
--   company_memberships' own RLS for every row; that policy is
--   `user_id = auth.uid()`, which the helper's own filter already implies, so
--   the result is the same row-for-row.
-- - Every other auth.uid() in a policy becomes (select auth.uid()), which
--   Postgres evaluates once per statement (an initPlan).
-- Generated from pg_policies (2026-10-30): 119 policies altered, roles and
-- commands untouched; the 2 policies that are just `true` are not touched.
-- company_id already has an index on every company-scoped table, and
-- company_memberships (user_id, company_id) is unique, so no index is added.
-- Behaviour check: src/lib/__tests__/integration/rlsIsolation.integration.test.ts
-- and the per-user visible-row counts in docs/DEPLOY_hardening.md.

create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships cm
    where cm.company_id = p_company_id
      and cm.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_company_admin(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships cm
    where cm.company_id = p_company_id
      and cm.user_id = (select auth.uid())
      and cm.role = 'admin'
  );
$$;

-- Every policy is `to authenticated`: only that role needs them.
revoke execute on function public.is_company_member(uuid) from public, anon;
revoke execute on function public.is_company_admin(uuid) from public, anon;
grant execute on function public.is_company_member(uuid) to authenticated, service_role;
grant execute on function public.is_company_admin(uuid) to authenticated, service_role;

alter policy "Admins can create business areas for their company" on public.business_areas
  with check (public.is_company_admin(business_areas.company_id));

alter policy "Admins can update their company's business areas" on public.business_areas
  using (public.is_company_admin(business_areas.company_id))
  with check (public.is_company_admin(business_areas.company_id));

alter policy "Members can view their company's business areas" on public.business_areas
  using (public.is_company_member(business_areas.company_id));

alter policy "Members can create client aliases for their company" on public.client_aliases
  with check (public.is_company_member(client_aliases.company_id));

alter policy "Members can update their company's client aliases" on public.client_aliases
  using (public.is_company_member(client_aliases.company_id))
  with check (public.is_company_member(client_aliases.company_id));

alter policy "Members can view their company's client aliases" on public.client_aliases
  using (public.is_company_member(client_aliases.company_id));

alter policy "Members can create clients for their company" on public.clients
  with check (public.is_company_member(clients.company_id));

alter policy "Members can update their company's clients" on public.clients
  using (public.is_company_member(clients.company_id))
  with check (public.is_company_member(clients.company_id));

alter policy "Members can view their company's clients" on public.clients
  using (public.is_company_member(clients.company_id));

alter policy "Admins can update their companies" on public.companies
  using (public.is_company_admin(companies.id))
  with check (public.is_company_admin(companies.id));

alter policy "Members can view companies they belong to" on public.companies
  using (public.is_company_member(companies.id));

alter policy "Members can view their own membership rows" on public.company_memberships
  using ((user_id = (select auth.uid())));

alter policy "Members can create cost allocations for their company" on public.cost_allocations
  with check ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_allocations.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can delete their company's cost allocations" on public.cost_allocations
  using ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_allocations.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's cost allocations" on public.cost_allocations
  using ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_allocations.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create cost document attachments for their company" on public.cost_document_attachments
  with check ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_document_attachments.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can delete their company's cost document attachments" on public.cost_document_attachments
  using ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_document_attachments.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's cost document attachments" on public.cost_document_attachments
  using ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_document_attachments.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create cost documents for their company" on public.cost_documents
  with check (public.is_company_member(cost_documents.company_id));

alter policy "Members can delete their company's cost documents" on public.cost_documents
  using (public.is_company_member(cost_documents.company_id));

alter policy "Members can update their company's cost documents" on public.cost_documents
  using (public.is_company_member(cost_documents.company_id))
  with check (public.is_company_member(cost_documents.company_id));

alter policy "Members can view their company's cost documents" on public.cost_documents
  using (public.is_company_member(cost_documents.company_id));

alter policy "Members can create cost import batches for their company" on public.cost_import_batches
  with check (public.is_company_member(cost_import_batches.company_id));

alter policy "Members can view their company's cost import batches" on public.cost_import_batches
  using (public.is_company_member(cost_import_batches.company_id));

alter policy "Members can create cost import rows for their company" on public.cost_import_rows
  with check ((EXISTS ( SELECT 1 FROM (cost_import_batches cib JOIN company_memberships cm ON ((cm.company_id = cib.company_id))) WHERE ((cib.id = cost_import_rows.import_batch_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's cost import rows" on public.cost_import_rows
  using ((EXISTS ( SELECT 1 FROM (cost_import_batches cib JOIN company_memberships cm ON ((cm.company_id = cib.company_id))) WHERE ((cib.id = cost_import_rows.import_batch_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create cost lines for their company" on public.cost_lines
  with check ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_lines.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can delete their company's cost lines" on public.cost_lines
  using ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_lines.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's cost lines" on public.cost_lines
  using ((EXISTS ( SELECT 1 FROM (cost_documents cd JOIN company_memberships cm ON ((cm.company_id = cd.company_id))) WHERE ((cd.id = cost_lines.cost_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create cost service allocations for their company" on public.cost_service_allocations
  with check (public.is_company_member(cost_service_allocations.company_id));

alter policy "Members can delete their company's cost service allocations" on public.cost_service_allocations
  using (public.is_company_member(cost_service_allocations.company_id));

alter policy "Members can update their company's cost service allocations" on public.cost_service_allocations
  using (public.is_company_member(cost_service_allocations.company_id))
  with check (public.is_company_member(cost_service_allocations.company_id));

alter policy "Members can view their company's cost service allocations" on public.cost_service_allocations
  using (public.is_company_member(cost_service_allocations.company_id));

alter policy "Members can create import batches for their company" on public.import_batches
  with check (public.is_company_member(import_batches.company_id));

alter policy "Members can view their company's import batches" on public.import_batches
  using (public.is_company_member(import_batches.company_id));

alter policy "Members can create import rows for their company" on public.import_rows
  with check ((EXISTS ( SELECT 1 FROM (import_batches ib JOIN company_memberships cm ON ((cm.company_id = ib.company_id))) WHERE ((ib.id = import_rows.import_batch_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's import rows" on public.import_rows
  using ((EXISTS ( SELECT 1 FROM (import_batches ib JOIN company_memberships cm ON ((cm.company_id = ib.company_id))) WHERE ((ib.id = import_rows.import_batch_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Users can revoke their own MCP tokens" on public.mcp_access_tokens
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));

alter policy "Users can view their own MCP tokens" on public.mcp_access_tokens
  using ((user_id = (select auth.uid())));

alter policy "Members can create personnel for their company" on public.personnel
  with check (public.is_company_member(personnel.company_id));

alter policy "Members can update their company's personnel" on public.personnel
  using (public.is_company_member(personnel.company_id))
  with check (public.is_company_member(personnel.company_id));

alter policy "Members can view their company's personnel" on public.personnel
  using (public.is_company_member(personnel.company_id));

alter policy "Members can create personnel costs for their company" on public.personnel_costs
  with check ((EXISTS ( SELECT 1 FROM (personnel p JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((p.id = personnel_costs.personnel_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can update their company's personnel costs" on public.personnel_costs
  using ((EXISTS ( SELECT 1 FROM (personnel p JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((p.id = personnel_costs.personnel_id) AND (cm.user_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1 FROM (personnel p JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((p.id = personnel_costs.personnel_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's personnel costs" on public.personnel_costs
  using ((EXISTS ( SELECT 1 FROM (personnel p JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((p.id = personnel_costs.personnel_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create checklist items for their company" on public.project_checklist_items
  with check (public.is_company_member(project_checklist_items.company_id));

alter policy "Members can delete their company's checklist items" on public.project_checklist_items
  using (public.is_company_member(project_checklist_items.company_id));

alter policy "Members can update their company's checklist items" on public.project_checklist_items
  using (public.is_company_member(project_checklist_items.company_id))
  with check (public.is_company_member(project_checklist_items.company_id));

alter policy "Members can view their company's checklist items" on public.project_checklist_items
  using (public.is_company_member(project_checklist_items.company_id));

alter policy "Members can create cost confirmations for their company" on public.project_cost_confirmations
  with check ((EXISTS ( SELECT 1 FROM (projects p JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((p.id = project_cost_confirmations.project_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can delete their company's cost confirmations" on public.project_cost_confirmations
  using ((EXISTS ( SELECT 1 FROM (projects p JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((p.id = project_cost_confirmations.project_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's cost confirmations" on public.project_cost_confirmations
  using ((EXISTS ( SELECT 1 FROM (projects p JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((p.id = project_cost_confirmations.project_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Authors can delete their own notes" on public.project_notes
  using (((kind = 'note'::text) AND (author_id = (select auth.uid())) AND public.is_company_member(project_notes.company_id)));

alter policy "Authors can edit their own notes" on public.project_notes
  using (((kind = 'note'::text) AND (author_id = (select auth.uid())) AND public.is_company_member(project_notes.company_id)))
  with check (((kind = 'note'::text) AND (author_id = (select auth.uid()))));

alter policy "Members can add their own notes for their company" on public.project_notes
  with check (((kind = 'note'::text) AND (author_id = (select auth.uid())) AND public.is_company_member(project_notes.company_id)));

alter policy "Members can view their company's project notes" on public.project_notes
  using (public.is_company_member(project_notes.company_id));

alter policy "Members can create project quotes for their company" on public.project_quotes
  with check (public.is_company_member(project_quotes.company_id));

alter policy "Members can update their company's project quotes" on public.project_quotes
  using (public.is_company_member(project_quotes.company_id))
  with check (public.is_company_member(project_quotes.company_id));

alter policy "Members can view their company's project quotes" on public.project_quotes
  using (public.is_company_member(project_quotes.company_id));

alter policy "Members can create projects for their company" on public.projects
  with check (public.is_company_member(projects.company_id));

alter policy "Members can update their company's projects" on public.projects
  using (public.is_company_member(projects.company_id))
  with check (public.is_company_member(projects.company_id));

alter policy "Members can view their company's projects" on public.projects
  using (public.is_company_member(projects.company_id));

alter policy "Members can create recurring service cost allocations" on public.recurring_service_cost_allocations
  with check ((EXISTS ( SELECT 1 FROM (recurring_service_cost_pools cp JOIN company_memberships cm ON ((cm.company_id = cp.company_id))) WHERE ((cp.id = recurring_service_cost_allocations.cost_pool_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view recurring service cost allocations" on public.recurring_service_cost_allocations
  using ((EXISTS ( SELECT 1 FROM (recurring_service_cost_pools cp JOIN company_memberships cm ON ((cm.company_id = cp.company_id))) WHERE ((cp.id = recurring_service_cost_allocations.cost_pool_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create recurring service cost periods" on public.recurring_service_cost_periods
  with check (public.is_company_member(recurring_service_cost_periods.company_id));

alter policy "Members can delete recurring service cost periods" on public.recurring_service_cost_periods
  using (public.is_company_member(recurring_service_cost_periods.company_id));

alter policy "Members can update recurring service cost periods" on public.recurring_service_cost_periods
  using (public.is_company_member(recurring_service_cost_periods.company_id))
  with check (public.is_company_member(recurring_service_cost_periods.company_id));

alter policy "Members can view recurring service cost periods" on public.recurring_service_cost_periods
  using (public.is_company_member(recurring_service_cost_periods.company_id));

alter policy "Members can create recurring service cost pools" on public.recurring_service_cost_pools
  with check (public.is_company_member(recurring_service_cost_pools.company_id));

alter policy "Members can update recurring service cost pools" on public.recurring_service_cost_pools
  using (public.is_company_member(recurring_service_cost_pools.company_id))
  with check (public.is_company_member(recurring_service_cost_pools.company_id));

alter policy "Members can view recurring service cost pools" on public.recurring_service_cost_pools
  using (public.is_company_member(recurring_service_cost_pools.company_id));

alter policy "Members can create recurring service bulk changes" on public.recurring_service_occurrence_bulk_changes
  with check ((EXISTS ( SELECT 1 FROM ((recurring_service_occurrences o JOIN recurring_services rs ON ((rs.id = o.recurring_service_id))) JOIN company_memberships cm ON ((cm.company_id = rs.company_id))) WHERE ((o.id = recurring_service_occurrence_bulk_changes.occurrence_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can update recurring service bulk changes" on public.recurring_service_occurrence_bulk_changes
  using ((EXISTS ( SELECT 1 FROM ((recurring_service_occurrences o JOIN recurring_services rs ON ((rs.id = o.recurring_service_id))) JOIN company_memberships cm ON ((cm.company_id = rs.company_id))) WHERE ((o.id = recurring_service_occurrence_bulk_changes.occurrence_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view recurring service bulk changes" on public.recurring_service_occurrence_bulk_changes
  using ((EXISTS ( SELECT 1 FROM ((recurring_service_occurrences o JOIN recurring_services rs ON ((rs.id = o.recurring_service_id))) JOIN company_memberships cm ON ((cm.company_id = rs.company_id))) WHERE ((o.id = recurring_service_occurrence_bulk_changes.occurrence_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create recurring service occurrences" on public.recurring_service_occurrences
  with check ((EXISTS ( SELECT 1 FROM (recurring_services rs JOIN company_memberships cm ON ((cm.company_id = rs.company_id))) WHERE ((rs.id = recurring_service_occurrences.recurring_service_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can update recurring service occurrences" on public.recurring_service_occurrences
  using ((EXISTS ( SELECT 1 FROM (recurring_services rs JOIN company_memberships cm ON ((cm.company_id = rs.company_id))) WHERE ((rs.id = recurring_service_occurrences.recurring_service_id) AND (cm.user_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1 FROM (recurring_services rs JOIN company_memberships cm ON ((cm.company_id = rs.company_id))) WHERE ((rs.id = recurring_service_occurrences.recurring_service_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view recurring service occurrences" on public.recurring_service_occurrences
  using ((EXISTS ( SELECT 1 FROM (recurring_services rs JOIN company_memberships cm ON ((cm.company_id = rs.company_id))) WHERE ((rs.id = recurring_service_occurrences.recurring_service_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create recurring services for their company" on public.recurring_services
  with check (public.is_company_member(recurring_services.company_id));

alter policy "Members can update their company's recurring services" on public.recurring_services
  using (public.is_company_member(recurring_services.company_id))
  with check (public.is_company_member(recurring_services.company_id));

alter policy "Members can view their company's recurring services" on public.recurring_services
  using (public.is_company_member(recurring_services.company_id));

alter policy "Members can create sales allocations for their company" on public.sales_allocations
  with check (public.is_company_member(sales_allocations.company_id));

alter policy "Members can delete their company's sales allocations" on public.sales_allocations
  using (public.is_company_member(sales_allocations.company_id));

alter policy "Members can update their company's sales allocations" on public.sales_allocations
  using (public.is_company_member(sales_allocations.company_id))
  with check (public.is_company_member(sales_allocations.company_id));

alter policy "Members can view their company's sales allocations" on public.sales_allocations
  using (public.is_company_member(sales_allocations.company_id));

alter policy "Members can create sales documents for their company" on public.sales_documents
  with check (public.is_company_member(sales_documents.company_id));

alter policy "Members can update their company's sales documents" on public.sales_documents
  using (public.is_company_member(sales_documents.company_id))
  with check (public.is_company_member(sales_documents.company_id));

alter policy "Members can view their company's sales documents" on public.sales_documents
  using (public.is_company_member(sales_documents.company_id));

alter policy "Members can create sales lines for their company" on public.sales_lines
  with check ((EXISTS ( SELECT 1 FROM (sales_documents sd JOIN company_memberships cm ON ((cm.company_id = sd.company_id))) WHERE ((sd.id = sales_lines.sales_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can delete their company's sales lines" on public.sales_lines
  using ((EXISTS ( SELECT 1 FROM (sales_documents sd JOIN company_memberships cm ON ((cm.company_id = sd.company_id))) WHERE ((sd.id = sales_lines.sales_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can update their company's sales lines" on public.sales_lines
  using ((EXISTS ( SELECT 1 FROM (sales_documents sd JOIN company_memberships cm ON ((cm.company_id = sd.company_id))) WHERE ((sd.id = sales_lines.sales_document_id) AND (cm.user_id = (select auth.uid()))))))
  with check ((EXISTS ( SELECT 1 FROM (sales_documents sd JOIN company_memberships cm ON ((cm.company_id = sd.company_id))) WHERE ((sd.id = sales_lines.sales_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's sales lines" on public.sales_lines
  using ((EXISTS ( SELECT 1 FROM (sales_documents sd JOIN company_memberships cm ON ((cm.company_id = sd.company_id))) WHERE ((sd.id = sales_lines.sales_document_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can create suppliers for their company" on public.suppliers
  with check (public.is_company_member(suppliers.company_id));

alter policy "Members can update their company's suppliers" on public.suppliers
  using (public.is_company_member(suppliers.company_id))
  with check (public.is_company_member(suppliers.company_id));

alter policy "Members can view their company's suppliers" on public.suppliers
  using (public.is_company_member(suppliers.company_id));

alter policy "Members can link technician charge documents for their company" on public.technician_charge_documents
  with check (public.is_company_member(technician_charge_documents.company_id));

alter policy "Members can unlink their company's technician charge documents" on public.technician_charge_documents
  using (public.is_company_member(technician_charge_documents.company_id));

alter policy "Members can view their company's technician charge documents" on public.technician_charge_documents
  using (public.is_company_member(technician_charge_documents.company_id));

alter policy "Members can create technician charges for their company" on public.technician_charges
  with check (public.is_company_member(technician_charges.company_id));

alter policy "Members can update their company's technician charges" on public.technician_charges
  using (public.is_company_member(technician_charges.company_id))
  with check (public.is_company_member(technician_charges.company_id));

alter policy "Members can view their company's technician charges" on public.technician_charges
  using (public.is_company_member(technician_charges.company_id));

alter policy "Members can create technician document suggestions for their co" on public.technician_document_suggestions
  with check (public.is_company_member(technician_document_suggestions.company_id));

alter policy "Members can delete their company's technician document suggesti" on public.technician_document_suggestions
  using (public.is_company_member(technician_document_suggestions.company_id));

alter policy "Members can update their company's technician document suggesti" on public.technician_document_suggestions
  using (public.is_company_member(technician_document_suggestions.company_id))
  with check (public.is_company_member(technician_document_suggestions.company_id));

alter policy "Members can view their company's technician document suggestion" on public.technician_document_suggestions
  using (public.is_company_member(technician_document_suggestions.company_id));

alter policy "Members can create technician payment applications for their co" on public.technician_payment_applications
  with check (public.is_company_member(technician_payment_applications.company_id));

alter policy "Members can view their company's technician payment application" on public.technician_payment_applications
  using (public.is_company_member(technician_payment_applications.company_id));

alter policy "Members can create technician payments for their company" on public.technician_payments
  with check (public.is_company_member(technician_payments.company_id));

alter policy "Members can delete their company's technician payments" on public.technician_payments
  using (public.is_company_member(technician_payments.company_id));

alter policy "Members can view their company's technician payments" on public.technician_payments
  using (public.is_company_member(technician_payments.company_id));

alter policy "Members can link suppliers to their company's technicians" on public.technician_suppliers
  with check (public.is_company_member(technician_suppliers.company_id));

alter policy "Members can unlink suppliers from their company's technicians" on public.technician_suppliers
  using (public.is_company_member(technician_suppliers.company_id));

alter policy "Members can view their company's technician suppliers" on public.technician_suppliers
  using (public.is_company_member(technician_suppliers.company_id));

alter policy "Users can create their own AI settings" on public.user_ai_settings
  with check ((user_id = (select auth.uid())));

alter policy "Users can delete their own AI settings" on public.user_ai_settings
  using ((user_id = (select auth.uid())));

alter policy "Users can update their own AI settings" on public.user_ai_settings
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));

alter policy "Users can view their own AI settings" on public.user_ai_settings
  using ((user_id = (select auth.uid())));

alter policy "Members can create work allocations for their company" on public.work_allocations
  with check ((EXISTS ( SELECT 1 FROM ((personnel_costs pc JOIN personnel p ON ((p.id = pc.personnel_id))) JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((pc.id = work_allocations.personnel_cost_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can delete their company's work allocations" on public.work_allocations
  using ((EXISTS ( SELECT 1 FROM ((personnel_costs pc JOIN personnel p ON ((p.id = pc.personnel_id))) JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((pc.id = work_allocations.personnel_cost_id) AND (cm.user_id = (select auth.uid()))))));

alter policy "Members can view their company's work allocations" on public.work_allocations
  using ((EXISTS ( SELECT 1 FROM ((personnel_costs pc JOIN personnel p ON ((p.id = pc.personnel_id))) JOIN company_memberships cm ON ((cm.company_id = p.company_id))) WHERE ((pc.id = work_allocations.personnel_cost_id) AND (cm.user_id = (select auth.uid()))))));
