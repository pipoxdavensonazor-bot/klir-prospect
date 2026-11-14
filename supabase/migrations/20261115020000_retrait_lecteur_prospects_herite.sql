-- Retrait de la lecture « centre » héritée (fonction Edge `prospects`, absente du dépôt).
-- La fonction compare le SHA-256 du jeton à cette table puis lit avec la clé service les
-- workspace_states de TOUS les comptes. Sans la table, elle répond 503 et ne lit plus rien.
-- Le CRM principal (application, search-*, workspace_states sous RLS) n'utilise pas cette table.
-- Idempotent : la table n'existe qu'en Prod (créée hors dépôt, migration 20261009013830).
-- Retour arrière : recréer la table et un nouveau jeton (aucune donnée client n'y est stockée).
do $$
begin
  if to_regclass('public.centre_prospect_reader') is not null then
    execute 'revoke all on table public.centre_prospect_reader from public, anon, authenticated, service_role';
    execute 'drop table public.centre_prospect_reader';
  end if;
end
$$;
