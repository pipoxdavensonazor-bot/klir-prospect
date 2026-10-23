-- Reject a forged owner before sanitize_workspace can redirect the upsert to
-- the caller's own row. RLS still protects reads and writes independently.
create function private.guard_workspace_owner() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    raise exception 'workspace_owner_mismatch' using errcode='42501';
  end if;
  return new;
end $$;
create trigger workspace_states_owner_guard
before insert or update on public.workspace_states
for each row execute function private.guard_workspace_owner();
