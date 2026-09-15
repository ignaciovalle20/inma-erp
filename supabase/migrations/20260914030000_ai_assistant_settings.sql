-- AI assistant settings: one row per user (not per company) holding
-- which provider/model/API key the floating chat assistant should use
-- on their behalf. Scoped to the user because the chat is a personal
-- tool that follows the person across every company they belong to,
-- not a company-level configuration like clients/suppliers.
--
-- api_key is stored in plaintext, protected only by RLS (owner-only
-- read/write) -- there's no encryption-at-rest/KMS infrastructure in
-- this repo yet. It must never be selected by a Server Component that
-- passes data to a Client Component; only the assistant's route
-- handler (server-only) may read it.
create table public.user_ai_settings (
  user_id uuid primary key references auth.users (id) default auth.uid(),
  provider text not null check (provider in ('anthropic', 'openai', 'gemini')),
  model text not null,
  api_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_ai_settings_set_updated_at
  before update on public.user_ai_settings
  for each row
  execute function public.set_updated_at();

alter table public.user_ai_settings enable row level security;

-- Owner-only in every direction -- there is no "company member" concept
-- here, just the row's own user_id.
create policy "Users can view their own AI settings"
  on public.user_ai_settings
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can create their own AI settings"
  on public.user_ai_settings
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update their own AI settings"
  on public.user_ai_settings
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete their own AI settings"
  on public.user_ai_settings
  for delete
  to authenticated
  using (user_id = auth.uid());
