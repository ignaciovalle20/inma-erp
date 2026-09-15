-- No migration so far has ever granted table-level privileges to the
-- `authenticated` role -- every table's RLS policies were written and
-- tested against a hosted Supabase project, whose dashboard/provisioning
-- step grants ALL on every public table to anon/authenticated/service_role
-- by default, outside of any migration. A project rebuilt purely from
-- these migrations (a fresh `supabase db reset`, a new environment, a
-- disaster-recovery restore) never gets that implicit grant: every query
-- fails with "permission denied for table ..." before RLS is even
-- evaluated, regardless of how correct the RLS policies are.
--
-- Table privileges are the outer gate; RLS (already enabled on every one
-- of these tables) remains the inner, per-row gate -- granting the
-- statement types here does not by itself expose any row a policy
-- wouldn't already allow. `anon` is deliberately left out: nothing in
-- this schema is meant to be readable before login, and every DAL/report
-- function already requires a session before querying. Sequences aren't
-- listed because every table uses `gen_random_uuid()` primary keys, not
-- serial/identity columns.
--
-- `alter default privileges` only covers objects created *after* this
-- runs (as this project's own owning role, `postgres`), so it's included
-- to keep a future `create table` from silently reintroducing this gap,
-- not as a substitute for the explicit grant below.
grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on
  public.companies,
  public.company_memberships,
  public.clients,
  public.client_aliases,
  public.suppliers,
  public.business_areas,
  public.projects,
  public.sales_documents,
  public.sales_lines,
  public.cost_documents,
  public.cost_lines,
  public.cost_allocations,
  public.project_cost_confirmations,
  public.import_batches,
  public.import_rows,
  public.recurring_services,
  public.personnel,
  public.personnel_costs,
  public.work_allocations,
  public.exchange_rate_snapshots,
  public.user_ai_settings
to authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
