-- Client aliases: remember a CSV import's client-name -> client_id
-- resolution so future imports of the same source data (e.g. a fresh
-- export from the same accounting system) auto-match without asking
-- again.
--
-- external_name is stored normalized (trimmed + lowercased) so lookups
-- are a plain equality match against the same normalization the import
-- flow applies to a CSV row's client column, and so the unique index
-- can be a plain column-list index usable by `upsert(..., {onConflict})`.
create table public.client_aliases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  external_name text not null,
  client_id uuid not null references public.clients (id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) default auth.uid()
);

create unique index client_aliases_company_name_key
  on public.client_aliases (company_id, external_name);
create index client_aliases_client_id_idx on public.client_aliases (client_id);

create trigger client_aliases_set_updated_at
  before update on public.client_aliases
  for each row
  execute function public.set_updated_at();

alter table public.client_aliases enable row level security;

-- RLS mirrors clients (Story 1.3): any member of the company may
-- select/insert/update. No DELETE policy -- re-pointing an alias to a
-- different client is an update, not a delete+insert.
create policy "Members can view their company's client aliases"
  on public.client_aliases
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = client_aliases.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create client aliases for their company"
  on public.client_aliases
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = client_aliases.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's client aliases"
  on public.client_aliases
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = client_aliases.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = client_aliases.company_id
        and cm.user_id = auth.uid()
    )
  );
