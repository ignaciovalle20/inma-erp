-- MCP drafts can now also be a job status change (propose_project_status),
-- the same tool set as the in-app assistant (web/src/lib/ai/tools.ts).
-- The original check was declared inline, so Postgres named it
-- mcp_pending_drafts_kind_check.

alter table public.mcp_pending_drafts
  drop constraint if exists mcp_pending_drafts_kind_check;

alter table public.mcp_pending_drafts
  add constraint mcp_pending_drafts_kind_check
  check (kind in ('expense', 'sale', 'project', 'project_status'));
