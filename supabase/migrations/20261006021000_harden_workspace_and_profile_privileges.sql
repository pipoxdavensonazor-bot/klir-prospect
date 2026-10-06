-- Privileges and triggers that keep demo migration and profile fields
-- under database control. Security definer functions stay in private,
-- which is not exposed through the Data API.

revoke update on table public.profiles from authenticated;
grant update (display_name) on table public.profiles to authenticated;

create or replace function private.strip_secrets(input jsonb, depth integer default 0)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  object_key text;
  item jsonb;
  result jsonb;
  seen integer := 0;
begin
  if input is null or depth > 12 then
    return 'null'::jsonb;
  end if;

  if jsonb_typeof(input) = 'array' then
    result := '[]'::jsonb;
    for item in select jsonb_array_elements(input) loop
      exit when seen >= 10000;
      result := result || jsonb_build_array(private.strip_secrets(item, depth + 1));
      seen := seen + 1;
    end loop;
    return result;
  end if;

  if jsonb_typeof(input) = 'object' then
    result := '{}'::jsonb;
    for object_key, item in select entry.key, entry.value from jsonb_each(input) as entry loop
      exit when seen >= 500;
      seen := seen + 1;
      if object_key ~* '^(password|pass|token|apikey|api_key|key|secret|refresh_token|access_token|service_role)$' then
        continue;
      end if;
      result := result || jsonb_build_object(object_key, private.strip_secrets(item, depth + 1));
    end loop;
    return result;
  end if;

  if jsonb_typeof(input) = 'string' then
    return to_jsonb(left(input #>> '{}', 5000));
  end if;

  return input;
end;
$$;

create or replace function private.sanitize_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is distinct from (select auth.uid()) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  new.schema_version := 1;
  new.payload := private.strip_secrets(new.payload);
  if new.payload is null or jsonb_typeof(new.payload) <> 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
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
  update public.profiles
    set demo_migrated_at = coalesce(public.profiles.demo_migrated_at, now())
  where public.profiles.id = new.user_id
    and public.profiles.id = (select auth.uid());
  return new;
end;
$$;

drop trigger if exists workspace_states_sanitize on public.workspace_states;
create trigger workspace_states_sanitize
before insert or update on public.workspace_states
for each row execute function private.sanitize_workspace();

drop trigger if exists workspace_states_mark_migrated on public.workspace_states;
create trigger workspace_states_mark_migrated
after insert or update on public.workspace_states
for each row execute function private.mark_demo_migrated();

revoke all on function private.strip_secrets(jsonb, integer) from public, anon, authenticated;
revoke all on function private.sanitize_workspace() from public, anon, authenticated;
revoke all on function private.mark_demo_migrated() from public, anon, authenticated;
