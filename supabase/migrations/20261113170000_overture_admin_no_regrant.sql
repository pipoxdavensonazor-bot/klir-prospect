-- overture_admin('disable') ré-accordait reserve_usage / settle_usage à authenticated,
-- ce qui rouvrait le débit direct depuis le navigateur. Désormais enable et disable
-- ne font que basculer le drapeau Overture et referment les quatre RPC de débit direct.
-- Aucune fonction ne les accorde plus à anon, authenticated ou PUBLIC.
-- Rejouable. Ne touche ni jobs_enabled, ni soldes, ni reçus.

create or replace function public.overture_admin(p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare n integer; bytes bigint;
begin
  if p_action='finalize' then
    select count(*) into n from private.overture_places where release='2026-10-21.0';
    if n<>25127 or (select count(distinct city) from private.overture_places)<>3 then raise exception 'import_incomplet'; end if;
    update private.overture_settings set complete=true,imported_at=clock_timestamp() where singleton;
    analyze private.overture_places;
  elsif p_action in ('enable','disable') then
    if p_action='enable' and not (select complete from private.overture_settings where singleton) then raise exception 'import_incomplet'; end if;
    update private.overture_settings set enabled=(p_action='enable') where singleton;
    -- Toute recherche passe par enqueue_search_job : aucun débit direct n'est rouvert.
    revoke execute on function public.reserve_usage(text,integer,text), public.settle_usage(text,text),
      public.overture_begin(text,text,text,integer), public.overture_execute(text) from public, anon, authenticated;
  elsif p_action='clear_cache' then
    delete from private.overture_cache;
  elsif p_action<>'metrics' then raise exception 'action_invalide'; end if;
  return jsonb_build_object('database_bytes',pg_database_size(current_database()),'catalogue_bytes',pg_total_relation_size('private.overture_places'),
    'cache_bytes',pg_total_relation_size('private.overture_cache'),'operations_bytes',pg_total_relation_size('public.overture_operations'),
    'rows',(select count(*) from private.overture_places),'settings',(select to_jsonb(s) from private.overture_settings s));
end $$;

revoke all on function public.overture_admin(text, jsonb) from public, anon, authenticated;
grant execute on function public.overture_admin(text, jsonb) to service_role;

revoke execute on function public.reserve_usage(text, integer, text) from public, anon, authenticated;
revoke execute on function public.settle_usage(text, text) from public, anon, authenticated;
revoke execute on function public.overture_begin(text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.overture_execute(text) from public, anon, authenticated;
