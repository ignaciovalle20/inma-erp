-- user_ai_settings was created without created_by/updated_by, but the
-- shared set_updated_at() trigger unconditionally sets NEW.updated_by
-- on every UPDATE -- so any update (including the upsert's ON CONFLICT
-- DO UPDATE path used to save settings a second time) failed with
-- "record 'new' has no field 'updated_by'". Add the two columns to
-- match every other table set_updated_at() is attached to.
alter table public.user_ai_settings
  add column created_by uuid references auth.users (id) default auth.uid(),
  add column updated_by uuid references auth.users (id) default auth.uid();

update public.user_ai_settings set created_by = user_id, updated_by = user_id;
