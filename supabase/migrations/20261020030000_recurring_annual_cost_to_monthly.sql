-- Corrects the copy of expected_cost made by 20261020010000 on databases
-- where that migration already ran (inma-erp-dev): an annual service that
-- is not a domain (hosting, Starlink...) pays its cost monthly, so the
-- yearly expected cost it got becomes a monthly one -- /12, rounded to the
-- currency (CLP no decimals, the rest 2). A domain keeps its annual cost as
-- it is. 20261020010000 itself now makes the copy this way, so on a
-- database where it runs fresh this matches nothing.
--
-- Targets: the services that copy left with cost_periodicity = 'annual'
-- while not being domains (and not pooled). Their cost periods without
-- allocations from January 2026 on are made again, monthly.

create temp table _annual_cost_fix as
select id, company_id
from public.recurring_services
where periodicity = 'annual'
  and service_type is distinct from 'domain'
  and cost_periodicity = 'annual'
  and not uses_cost_pool
  and fixed_cost is not null;

-- updated_at stays as it was (a data fix, not an edit); the periods are
-- made again below instead of by the sync trigger, which only touches the
-- current month and later.
alter table public.recurring_services disable trigger recurring_services_set_updated_at;
alter table public.recurring_services disable trigger recurring_services_sync_cost_periods;

update public.recurring_services rs
set fixed_cost = round(rs.fixed_cost / 12, case when rs.currency = 'CLP' then 0 else 2 end),
    cost_periodicity = 'monthly'
from _annual_cost_fix f
where rs.id = f.id;

alter table public.recurring_services enable trigger recurring_services_sync_cost_periods;
alter table public.recurring_services enable trigger recurring_services_set_updated_at;

delete from public.recurring_service_cost_periods cp
using _annual_cost_fix f
where cp.recurring_service_id = f.id
  and cp.period >= date '2026-01-01'
  and not exists (select 1 from public.cost_service_allocations a where a.cost_period_id = cp.id);

select public.generate_recurring_service_cost_periods(f.company_id, f.id, null)
from _annual_cost_fix f;

drop table _annual_cost_fix;
