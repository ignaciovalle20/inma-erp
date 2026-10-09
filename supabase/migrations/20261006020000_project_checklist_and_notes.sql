-- Project checklist + notes timeline (Planner/Trello-style log on the job
-- detail page).
--
--   - project_checklist_items: an ordered to-do list per job. Any member
--     of the company may add, tick, rename, reorder and delete items.
--   - project_notes: a timeline of free-text notes (kind 'note', written
--     by a member, editable/deletable only by its author) plus system
--     events (kind 'status_change', author_id null, never editable),
--     inserted by a trigger on projects whenever the status changes.
--
-- RLS mirrors the rest of the per-company tables (project_quotes,
-- 20260918010000): membership in company_id via company_memberships, plus
-- a trigger that checks project_id belongs to that same company.
--
-- Additive: two tables, triggers, one AFTER UPDATE trigger on projects
-- (projects_set_closed_at is untouched) and three functions. Nothing in
-- clients changes.

-- ---------------------------------------------------------------------
-- project_checklist_items
-- ---------------------------------------------------------------------
create table public.project_checklist_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  project_id uuid not null references public.projects (id) on delete cascade,
  text text not null check (btrim(text) <> ''),
  is_done boolean not null default false,
  done_at timestamptz,
  done_by uuid references auth.users (id),
  position integer not null default 0,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

create index project_checklist_items_project_position_idx
  on public.project_checklist_items (project_id, position);
create index project_checklist_items_company_id_idx
  on public.project_checklist_items (company_id);

alter table public.project_checklist_items enable row level security;

create policy "Members can view their company's checklist items"
  on public.project_checklist_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_checklist_items.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can create checklist items for their company"
  on public.project_checklist_items
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_checklist_items.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can update their company's checklist items"
  on public.project_checklist_items
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_checklist_items.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_checklist_items.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Members can delete their company's checklist items"
  on public.project_checklist_items
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_checklist_items.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Same company cross-check as project_quotes_validate_company_refs, plus
-- the bookkeeping columns: done_at/done_by follow is_done, and an item
-- never moves to another job or company.
create or replace function public.project_checklist_items_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_project_company_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id or new.company_id <> old.company_id then
      raise exception 'a checklist item cannot move to another project';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  else
    select company_id into v_project_company_id
    from public.projects
    where id = new.project_id;

    if v_project_company_id is null or v_project_company_id <> new.company_id then
      raise exception 'project_id must belong to the same company as the checklist item';
    end if;
  end if;

  new.text := btrim(new.text);

  if new.is_done and (tg_op = 'INSERT' or not old.is_done) then
    new.done_at := now();
    new.done_by := auth.uid();
  elsif not new.is_done then
    new.done_at := null;
    new.done_by := null;
  else
    new.done_at := old.done_at;
    new.done_by := old.done_by;
  end if;

  return new;
end;
$$;

create trigger project_checklist_items_before_write
  before insert or update on public.project_checklist_items
  for each row
  execute function public.project_checklist_items_before_write();

-- Moves an item one place up (p_direction = -1) or down (+1) by swapping
-- positions with its neighbour, in one statement so two members never
-- leave the list half-swapped. Security invoker: RLS decides whether the
-- caller may update the rows at all. Returns false when there is no
-- neighbour (already first/last) or the item is not visible.
create or replace function public.move_project_checklist_item(
  p_item_id uuid,
  p_direction integer
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_item public.project_checklist_items;
  v_neighbour public.project_checklist_items;
begin
  if p_direction not in (-1, 1) then
    raise exception 'p_direction must be -1 or 1';
  end if;

  select * into v_item
  from public.project_checklist_items
  where id = p_item_id
  for update;

  if not found then
    return false;
  end if;

  select * into v_neighbour
  from public.project_checklist_items i
  where i.project_id = v_item.project_id
    and i.id <> v_item.id
    and (
      case when p_direction < 0
        then (i.position, i.created_at, i.id) < (v_item.position, v_item.created_at, v_item.id)
        else (i.position, i.created_at, i.id) > (v_item.position, v_item.created_at, v_item.id)
      end
    )
  order by
    case when p_direction < 0 then i.position end desc,
    case when p_direction < 0 then i.created_at end desc,
    case when p_direction < 0 then i.id end desc,
    case when p_direction > 0 then i.position end,
    case when p_direction > 0 then i.created_at end,
    case when p_direction > 0 then i.id end
  limit 1
  for update;

  if not found then
    return false;
  end if;

  -- Equal positions (should not happen, but cheap to survive) would make
  -- a plain swap a no-op: renumber the pair around the neighbour instead.
  if v_item.position = v_neighbour.position then
    update public.project_checklist_items
    set position = v_neighbour.position + (case when p_direction < 0 then 0 else 1 end)
    where id = v_item.id;
    update public.project_checklist_items
    set position = v_neighbour.position + (case when p_direction < 0 then 1 else 0 end)
    where id = v_neighbour.id;
  else
    update public.project_checklist_items
    set position = case id
      when v_item.id then v_neighbour.position
      else v_item.position
    end
    where id in (v_item.id, v_neighbour.id);
  end if;

  return true;
end;
$$;

comment on function public.move_project_checklist_item(uuid, integer) is
  'Swaps a checklist item with its previous (-1) or next (+1) sibling. RLS-scoped (security invoker).';

-- Done / total per job for the projects list ("3/5"). Only jobs with at
-- least one item come back. RLS-scoped (security invoker).
create or replace function public.project_checklist_progress(
  p_company_id uuid,
  p_project_ids uuid[]
)
returns table (project_id uuid, done_count bigint, total_count bigint)
language sql
stable
set search_path = ''
as $$
  select i.project_id, count(*) filter (where i.is_done), count(*)
  from public.project_checklist_items i
  where i.company_id = p_company_id
    and i.project_id = any (p_project_ids)
  group by i.project_id;
$$;

comment on function public.project_checklist_progress(uuid, uuid[]) is
  'Checklist done/total per project for the projects list. RLS-scoped (security invoker).';

-- ---------------------------------------------------------------------
-- project_notes
-- ---------------------------------------------------------------------
create table public.project_notes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  project_id uuid not null references public.projects (id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'status_change')),
  body text not null check (btrim(body) <> ''),
  author_id uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  -- A note always has an author; a system event never does.
  constraint project_notes_author_matches_kind check (
    (kind = 'note' and author_id is not null)
    or (kind = 'status_change' and author_id is null)
  )
);

create index project_notes_project_created_at_idx
  on public.project_notes (project_id, created_at);
create index project_notes_company_id_idx
  on public.project_notes (company_id);

alter table public.project_notes enable row level security;

create policy "Members can view their company's project notes"
  on public.project_notes
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_notes.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Members write only their own notes; status_change rows come from the
-- projects trigger below (security definer), never from the app.
create policy "Members can add their own notes for their company"
  on public.project_notes
  for insert
  to authenticated
  with check (
    kind = 'note'
    and author_id = auth.uid()
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_notes.company_id
        and cm.user_id = auth.uid()
    )
  );

create policy "Authors can edit their own notes"
  on public.project_notes
  for update
  to authenticated
  using (
    kind = 'note'
    and author_id = auth.uid()
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_notes.company_id
        and cm.user_id = auth.uid()
    )
  )
  with check (
    kind = 'note'
    and author_id = auth.uid()
  );

create policy "Authors can delete their own notes"
  on public.project_notes
  for delete
  to authenticated
  using (
    kind = 'note'
    and author_id = auth.uid()
    and exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = project_notes.company_id
        and cm.user_id = auth.uid()
    )
  );

-- Company cross-check on insert; on update only the body may change, and
-- a changed body stamps edited_at.
create or replace function public.project_notes_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_project_company_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id
      or new.company_id <> old.company_id
      or new.kind <> old.kind
      or new.author_id is distinct from old.author_id
      or new.created_at <> old.created_at then
      raise exception 'only the body of a note can be edited';
    end if;

    if new.body is distinct from old.body then
      new.edited_at := now();
    else
      new.edited_at := old.edited_at;
    end if;
  else
    select company_id into v_project_company_id
    from public.projects
    where id = new.project_id;

    if v_project_company_id is null or v_project_company_id <> new.company_id then
      raise exception 'project_id must belong to the same company as the note';
    end if;

    new.edited_at := null;
  end if;

  return new;
end;
$$;

create trigger project_notes_before_write
  before insert or update on public.project_notes
  for each row
  execute function public.project_notes_before_write();

-- ---------------------------------------------------------------------
-- projects: log every status change in the notes timeline
-- ---------------------------------------------------------------------
-- A separate AFTER trigger (projects_set_closed_at stays as it is). The
-- body is '<old> -> <new>' with the raw status codes; the app maps them to
-- labels. Security definer because project_notes' insert policy only lets
-- members write their own kind='note' rows.
create or replace function public.projects_log_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_notes (company_id, project_id, kind, body, author_id)
  values (new.company_id, new.id, 'status_change', old.status || ' -> ' || new.status, null);

  return null;
end;
$$;

revoke execute on function public.projects_log_status_change() from public, anon, authenticated;

drop trigger if exists projects_log_status_change on public.projects;
create trigger projects_log_status_change
  after update of status on public.projects
  for each row
  when (old.status is distinct from new.status)
  execute function public.projects_log_status_change();

-- ---------------------------------------------------------------------
-- company_member_names: who wrote each note
-- ---------------------------------------------------------------------
-- There is no profiles table and company_memberships only shows a user
-- their own row, so the timeline cannot see its co-members' names. This
-- returns one row per member of p_company_id (name from the auth user
-- metadata, falling back to the e-mail), and nothing at all unless the
-- caller is a member of that company. The row count doubles as "how many
-- members does the company have" (names are hidden when it is one).
create or replace function public.company_member_names(p_company_id uuid)
returns table (user_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select
    u.id,
    coalesce(
      nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
      u.email::text
    )
  from public.company_memberships cm
  join auth.users u on u.id = cm.user_id
  where cm.company_id = p_company_id
    and exists (
      select 1
      from public.company_memberships me
      where me.company_id = p_company_id
        and me.user_id = auth.uid()
    );
$$;

comment on function public.company_member_names(uuid) is
  'Members of a company with a display name (auth metadata full_name/name, else e-mail). Empty unless the caller is a member.';

-- Supabase grants EXECUTE on new functions to anon explicitly; revoking
-- PUBLIC alone does not remove it (see 20260922080000).
revoke execute on function public.move_project_checklist_item(uuid, integer) from public, anon;
grant execute on function public.move_project_checklist_item(uuid, integer) to authenticated, service_role;
revoke execute on function public.project_checklist_progress(uuid, uuid[]) from public, anon;
grant execute on function public.project_checklist_progress(uuid, uuid[]) to authenticated, service_role;
revoke execute on function public.company_member_names(uuid) from public, anon;
grant execute on function public.company_member_names(uuid) to authenticated, service_role;
