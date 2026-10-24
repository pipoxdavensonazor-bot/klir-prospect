-- Business conflicts must not trigger PostgREST serialization retries.
create or replace function public.workspace_save(p_expected_revision bigint,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s' as $$
declare uid uuid:=auth.uid(); item public.workspace_states%rowtype; cleaned jsonb;
begin
 if uid is null then raise exception 'session_requise' using errcode='28000'; end if;
 cleaned:=private.strip_secrets(coalesce(p_payload,'{}'::jsonb)-'_workspaceRevision',0);
 if jsonb_typeof(cleaned)<>'object' then raise exception 'invalid_payload' using errcode='22023'; end if;
 if octet_length(cleaned::text)>2097152 then raise exception 'payload_too_large' using errcode='22023'; end if;
 insert into public.workspace_states(user_id,payload) values(uid,'{}') on conflict(user_id) do nothing;
 select * into item from public.workspace_states where user_id=uid for update;
 if item.payload=cleaned then return jsonb_build_object('revision',item.revision,'updated_at',item.updated_at,'replayed',true); end if;
 if p_expected_revision is null or item.revision<>p_expected_revision then
   raise exception 'workspace_conflict' using errcode='PT409',detail='Une autre session a enregistré cet espace. La copie locale doit être conservée et revue.';
 end if;
 update public.workspace_states set payload=cleaned where user_id=uid returning * into item;
 return jsonb_build_object('revision',item.revision,'updated_at',item.updated_at,'bytes',octet_length(item.payload::text));
end $$;
