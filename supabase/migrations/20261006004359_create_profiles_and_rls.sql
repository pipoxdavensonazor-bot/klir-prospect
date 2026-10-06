create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  demo_migrated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) <= 120)
);

create table public.workspace_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  schema_version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_states_schema_version_positive check (schema_version > 0),
  constraint workspace_states_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint workspace_states_payload_size check (octet_length(payload::text) <= 2097152)
);

alter table public.profiles enable row level security;
alter table public.workspace_states enable row level security;

revoke all on table public.profiles, public.workspace_states from anon;
revoke all on table public.profiles, public.workspace_states from authenticated;
grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.workspace_states to authenticated;

create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "workspace_states_select_own"
on public.workspace_states
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "workspace_states_insert_own"
on public.workspace_states
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "workspace_states_update_own"
on public.workspace_states
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "workspace_states_delete_own"
on public.workspace_states
for delete
to authenticated
using ((select auth.uid()) = user_id);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger workspace_states_set_updated_at
before update on public.workspace_states
for each row execute function private.set_updated_at();

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 120)
  );
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();
