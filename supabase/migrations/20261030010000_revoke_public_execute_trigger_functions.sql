-- Follow-up of 20261029010000_audit_hardening (docs/deploy-prod-2026-10-29-auditoria.md §3).
-- Revoking EXECUTE from anon was not enough for these three trigger
-- functions: like every new function they kept the default EXECUTE granted
-- to PUBLIC, so has_function_privilege('anon', ...) still said true. They
-- return `trigger` (not callable directly, not exposed by PostgREST), so
-- nothing changes for anyone; this only makes the "anon without EXECUTE"
-- check clean. Triggers do not check EXECUTE when they fire.
revoke execute on function public.seed_default_business_areas() from public, anon;
revoke execute on function public.technician_payment_check_balanced_on_delete() from public, anon;
revoke execute on function public.client_aliases_validate_company_refs() from public, anon;
