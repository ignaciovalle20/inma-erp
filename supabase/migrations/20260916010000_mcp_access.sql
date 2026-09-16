-- MCP (Model Context Protocol) access: lets a trusted external client
-- (a Claude Code session, for the user who owns the token) call a
-- narrow set of the app's own actions, following the exact same
-- propose-then-confirm pattern the in-app AI assistant already uses
-- (see web/src/lib/ai/tools.ts, /api/assistant/{chat,confirm}) --
-- writes never happen from a single call, only after the token owner
-- has seen the draft and asked for it to be confirmed.
--
-- The MCP route (web/src/app/api/mcp/route.ts) authenticates by this
-- token instead of a browser session cookie, so it has no Supabase
-- session/JWT to hand to a normal client for RLS to key off. It
-- connects with the service_role key instead and re-checks company
-- membership itself before every action -- same precedent as
-- update_import_batch_counts's own security-definer membership
-- re-check (Story epic6/story6.6, period_recognition migration). That
-- makes this token table's own RLS below a courtesy for the settings
-- UI, not the real enforcement boundary -- the real boundary is the
-- application code in the MCP route, which must re-check membership
-- on every call.
create extension if not exists pgcrypto;

create table public.mcp_access_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) default auth.uid(),
  token_hash text not null unique,
  label text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index mcp_access_tokens_user_id_idx on public.mcp_access_tokens (user_id);
create index mcp_access_tokens_token_hash_idx on public.mcp_access_tokens (token_hash);

alter table public.mcp_access_tokens enable row level security;

create policy "Users can view their own MCP tokens"
  on public.mcp_access_tokens
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can revoke their own MCP tokens"
  on public.mcp_access_tokens
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- create_mcp_access_token: the only supported way to mint a token --
-- generates it server-side and returns the plaintext exactly once
-- (only its sha-256 hash is ever stored). No plain INSERT policy
-- exists on the table, so this security-definer function is the sole
-- path in.
-- ---------------------------------------------------------------------
create or replace function public.create_mcp_access_token(p_label text)
returns table (id uuid, token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_token text;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required to create an MCP access token';
  end if;

  if p_label is null or btrim(p_label) = '' then
    raise exception 'A label is required';
  end if;

  -- 32 random bytes, hex-encoded, prefixed so a leaked token is
  -- recognizable at a glance (same idea as GitHub's ghp_/gho_ prefixes).
  -- pgcrypto's functions live in the `extensions` schema on Supabase
  -- projects, not `public` -- explicitly qualified since this function
  -- pins `search_path = public` (see header note on why).
  v_token := 'imcp_' || encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.mcp_access_tokens (user_id, token_hash, label)
  values (v_user_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), btrim(p_label))
  returning mcp_access_tokens.id into v_id;

  return query select v_id, v_token;
end;
$$;

revoke execute on function public.create_mcp_access_token(text) from public;
grant execute on function public.create_mcp_access_token(text) to authenticated;

-- ---------------------------------------------------------------------
-- mcp_pending_drafts: a "propose" call's draft, persisted instead of
-- kept in memory -- the propose and confirm calls are two separate
-- HTTP requests that may land on two different serverless invocations
-- (Vercel), unlike the in-app assistant's chat loop, which keeps the
-- pending draft in the browser's own component state within one
-- session. No end-user RLS policies -- only the MCP route (connected
-- as service_role, which bypasses RLS entirely) ever reads or writes
-- this table, and it re-checks company membership itself for every
-- draft it touches (see header note above).
-- ---------------------------------------------------------------------
create table public.mcp_pending_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  company_id uuid not null references public.companies (id),
  kind text not null check (kind in ('expense', 'sale', 'project')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  consumed_at timestamptz
);

create index mcp_pending_drafts_user_id_idx on public.mcp_pending_drafts (user_id);

alter table public.mcp_pending_drafts enable row level security;

grant select, insert, update, delete on
  public.mcp_access_tokens,
  public.mcp_pending_drafts
to authenticated, service_role;
