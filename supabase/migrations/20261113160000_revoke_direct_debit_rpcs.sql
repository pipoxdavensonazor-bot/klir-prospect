-- Toute recherche passe par la file serveur (enqueue_search_job + runner).
-- Les RPC qui laissaient un navigateur réserver ou régler un débit directement
-- sont fermées à anon, authenticated et PUBLIC. enqueue_search_job (SECURITY
-- DEFINER) continue d'appeler reserve_usage en tant que propriétaire.
-- Constat Test du 13 nov. : le débit de 6 crédits à 3:00 venait de overture_begin /
-- overture_execute appelés par l'ancienne recherche Overture du navigateur.
-- Rejouable. Ne touche ni jobs_enabled, ni soldes, ni reçus existants.

revoke execute on function public.reserve_usage(text, integer, text) from public, anon, authenticated;
revoke execute on function public.settle_usage(text, text) from public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.overture_begin(text,text,text,integer)') is not null then
    execute 'revoke execute on function public.overture_begin(text, text, text, integer) from public, anon, authenticated';
  end if;
  if to_regprocedure('public.overture_execute(text)') is not null then
    execute 'revoke execute on function public.overture_execute(text) from public, anon, authenticated';
  end if;
end
$$;
