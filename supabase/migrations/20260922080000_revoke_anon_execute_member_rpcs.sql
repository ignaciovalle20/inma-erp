-- Same privilege leak as 20260922070000, on the three other functions
-- that relied on `revoke execute ... from public` + `grant ... to
-- authenticated`: Supabase's default privileges on schema public grant
-- EXECUTE on every new function explicitly to anon (and authenticated,
-- service_role), and revoking PUBLIC doesn't remove those grants. So
-- the anon key alone could call all three over /rest/v1/rpc.
--
-- Only anon is revoked here. Unlike generate_due_recurring_service_
-- occurrences() (a cron-only function), these three are called by the
-- app with the logged-in user's own client -- web/src/app/settings/
-- mcp/actions.ts, .../recurring-services/cost-pools/[costPoolId]/
-- actions.ts and .../sales/import/nubox/actions.ts -- so
-- `authenticated` must keep EXECUTE or those features break. Each one
-- already checks auth.uid() / company membership internally, which is
-- what keeps an authenticated caller scoped.
revoke execute on function public.create_mcp_access_token(text) from anon;
revoke execute on function public.allocate_recurring_service_cost_pool(uuid) from anon;
revoke execute on function public.match_recurring_service_occurrences_for_import_batch(uuid) from anon;
