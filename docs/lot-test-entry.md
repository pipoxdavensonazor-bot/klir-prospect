# Entrée Test — API sous le JWT utilisateur

Branche `cursor/search-job-test-entry-2f07`, empilée sur le runtime. Rien n’est fusionné ni déployé par cette PR. Le moteur reste éteint dans la base. La production `cbklwmjudobqwbkbxqgy` est refusée. Le runner n’est pas connecté. Aucune collecte et aucun planificateur ne tournent.

La doc d’Edge Functions décrit les variables injectées (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, et encore `SUPABASE_ANON_KEY`) et `auth.getUser(jwt)` avec le JWT de l’appelant. La clé publique ne sert que d’`apikey`. Les lectures passent par le client utilisateur, donc par RLS. Cette entrée ne lit pas `SUPABASE_DB_URL`, `SUPABASE_SECRET_KEYS` ni `SUPABASE_SERVICE_ROLE_KEY`.

## Fichiers à déployer

Fonction `search-jobs` :

- `supabase/functions/search-jobs/index.ts`
- `supabase/functions/_shared/search-job-edge.mjs`
- `supabase/functions/_shared/search-job-http.mjs`
- `supabase/functions/_shared/search-job-auth.mjs`

`supabase/config.toml` fixe `verify_jwt = true` pour cette fonction. Aucune migration nouvelle. `enqueue_search_job` et `cancel_search_job` sont déjà accordées à `authenticated`. La lecture est le `SELECT` de ses propres lignes. `read_search_job` et `search_jobs_enabled` restent à `klir_job_api` et ne sont pas appelées.

## Installation, sans clé postgres ni service_role

Le connecteur déploie la fonction sur le projet Test. Il ne faut pas ajouter de secret. Les noms utilisés sont seulement ceux déjà injectés : `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS` (clé `default`), sinon `SUPABASE_PUBLISHABLE_KEY`, sinon `SUPABASE_ANON_KEY`.

Si l’URL n’est pas `https://pwakjxjjxswdjsapsbxn.supabase.co`, la fonction répond `503` sans appeler Auth. Un jeton `local:<uuid>` est refusé. Le JWT n’est pas décodé dans ce module : `getUser` interroge Auth.

## Vérification, moteur OFF

`GET /healthz` ne touche pas la base. Il annonce `runner: non_connecte`, `provider: absent`, `scheduler: planificateur_non_choisi`, `operational: false`.

`POST` avec le JWT d’un utilisateur de Test appelle `enqueue_search_job`. Tant que `jobs_enabled` est faux, Postgres répond `jobs_disabled` avant toute réservation : HTTP `403`, aucun débit. `GET` d’un identifiant lit `search_jobs` sous RLS. La table vide ou le job d’un autre compte donne `404`.

Ce n’est pas toute la chaîne. Le runner, la collecte et le planificateur restent arrêtés.

## Runner, non connecté

`klir_job_api` et `klir_job_runner` existent et sont `NOLOGIN`. Les brancher demanderait un rôle `LOGIN` distinct, un secret, et une connexion. Ce n’est pas fait ici.

Si ce rôle est créé plus tard, la doc Supavisor demande l’utilisateur `klir_job_connect.pwakjxjjxswdjsapsbxn` sur le pooler transaction (port 6543) et `prepare: false`. Ce mode ne conserve pas un `SET ROLE` d’une transaction à l’autre. Aucun hébergeur n’est choisi pour l’exécuter.
