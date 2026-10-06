-- Durcit les sessions applicatives : RLS forcée, nom affiché borné,
-- horodatage de migration hors démo écrit uniquement par trigger,
-- et retrait des clés sensibles du payload.

alter table public.profiles force row level security;
alter table public.workspace_states force row level security;

alter table public.profiles
  drop constraint if exists profiles_display_name_safe;
alter table public.profiles
  add constraint profiles_display_name_safe check (display_name !~ '[[:cntrl:]<>]');

revoke update on table public.profiles from authenticated;
grant update (display_name) on table public.profiles to authenticated;

create or replace function private.strip_secrets(value jsonb, depth integer)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  key text;
  item jsonb;
  result jsonb;
  index integer := 0;
begin
  if value is null or depth > 12 then
    return 'null'::jsonb;
  end if;
  if jsonb_typeof(value) = 'object' then
    result := '{}'::jsonb;
    for key in select jsonb_object_keys(value) loop
      if lower(key) in (
        'password', 'pass', 'token', 'apikey', 'api_key', 'key', 'secret',
        'service_role', 'user', 'authorization'
      ) then
        continue;
      end if;
      result := result || jsonb_build_object(key, private.strip_secrets(value -> key, depth + 1));
    end loop;
    return result;
  end if;
  if jsonb_typeof(value) = 'array' then
    result := '[]'::jsonb;
    for item in select jsonb_array_elements(value) loop
      exit when index >= 10000;
      result := result || jsonb_build_array(private.strip_secrets(item, depth + 1));
      index := index + 1;
    end loop;
    return result;
  end if;
  if jsonb_typeof(value) = 'string' then
    return to_jsonb(left(regexp_replace(value #>> '{}', '[[:cntrl:]]', '', 'g'), 5000));
  end if;
  return value;
end;
$$;

create or replace function private.sanitize_profile()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.display_name := left(
    regexp_replace(coalesce(new.display_name, ''), '[[:cntrl:]<>]', '', 'g'),
    120
  );
  return new;
end;
$$;

create or replace function private.sanitize_workspace()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  new.user_id := (select auth.uid());
  new.payload := private.strip_secrets(coalesce(new.payload, '{}'::jsonb), 0);
  if jsonb_typeof(new.payload) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if octet_length(new.payload::text) > 2097152 then
    raise exception 'payload_too_large' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function private.mark_demo_migrated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is distinct from new.user_id then
    raise exception 'authentication_required' using errcode = '28000';
  end if;
  update public.profiles
    set demo_migrated_at = coalesce(public.profiles.demo_migrated_at, now())
    where id = new.user_id;
  return new;
end;
$$;

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
    left(regexp_replace(coalesce(new.raw_user_meta_data ->> 'display_name', ''), '[[:cntrl:]<>]', '', 'g'), 120)
  );
  return new;
end;
$$;

drop trigger if exists profiles_sanitize on public.profiles;
create trigger profiles_sanitize
before insert or update on public.profiles
for each row execute function private.sanitize_profile();

drop trigger if exists workspace_states_sanitize on public.workspace_states;
create trigger workspace_states_sanitize
before insert or update on public.workspace_states
for each row execute function private.sanitize_workspace();

drop trigger if exists workspace_states_mark_migrated on public.workspace_states;
create trigger workspace_states_mark_migrated
after insert or update on public.workspace_states
for each row execute function private.mark_demo_migrated();

revoke all on function private.strip_secrets(jsonb, integer) from public, anon, authenticated;
revoke all on function private.sanitize_profile() from public, anon, authenticated;
revoke all on function private.sanitize_workspace() from public, anon, authenticated;
revoke all on function private.mark_demo_migrated() from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon;

grant usage on schema private to authenticated;
grant execute on function private.set_updated_at() to authenticated;
grant execute on function private.strip_secrets(jsonb, integer) to authenticated;
grant execute on function private.sanitize_profile() to authenticated;
grant execute on function private.sanitize_workspace() to authenticated;
grant execute on function private.mark_demo_migrated() to authenticated;
