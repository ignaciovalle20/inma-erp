-- Fixes an oversight in 20260922010000: `status` was made NOT NULL
-- with a CHECK but no DEFAULT, so any insert into recurring_services
-- that doesn't explicitly set status (including the existing "new
-- service" create action, before Phase 3 touches it) would violate
-- the NOT NULL constraint. New rows default to 'active', same as the
-- existing `active` boolean's own default.
alter table public.recurring_services
  alter column status set default 'active';
