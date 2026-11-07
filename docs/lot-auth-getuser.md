# Auth getUser réelle, service non activé

Cette branche part du runtime local (`cursor/search-job-runtime-2f07`). Elle ne fusionne pas les PR ouvertes, n’applique aucune migration, et ne contacte aucun projet Supabase.

## Ce qui est réel

`createSupabaseGetUser` construit un client `@supabase/supabase-js` et appelle `auth.getUser(jwt)`. Le module ne décode pas le jeton. L’identifiant retenu est celui que le service d’auth renvoie. `createGetUserVerifier` reste le seul passage vers l’entrée HTTP.

Le test lance un service GoTrue local sur `127.0.0.1` et vérifie la requête réelle du client : `GET /auth/v1/user`, en-tête `apikey` égal à la clé de fixture, `Authorization` égal au jeton de l’utilisateur et non à la clé. Un jeton refusé par ce service, même s’il ressemble à un JWT portant un autre `sub`, ne crée pas de session. La même entrée, quand PostgreSQL local est là, enfile, reprend, annule et règle avec ce vérificateur.

## Ce qui reste simulé

- Le service d’auth du test n’est pas Supabase. Il ne signe rien et ne parle à aucun nuage.
- La clé acceptée est uniquement `sb_publishable_local_…`, une fixture publique. Une clé `service_role`, `sb_secret_` ou un JWT anon est refusée avant tout appel.
- `SEARCH_JOBS_AUTH` absent reste le vérificateur `local:<uuid>`, qui est simulé. Le mode `supabase` est explicite.
- Le fournisseur de collecte reste simulé. `jobs_enabled` n’est pas allumé par le code.
- L’entrée Deno `supabase/functions/search-jobs/index.ts` reste fermée.

Les projets `pwakjxjjxswdjsapsbxn` et `cbklwmjudobqwbkbxqgy`, ainsi que tout hôte `supabase.co`, sont refusés avant la construction du client.

## Commande locale

Le schéma et le socket sont ceux de `docs/lot-runtime-local.md`. Pour le vérificateur réel, ajouter :

```sh
SEARCH_JOBS_LOCAL=1 \
SEARCH_JOBS_AUTH=supabase \
SEARCH_JOBS_AUTH_URL=http://127.0.0.1:9999 \
SEARCH_JOBS_AUTH_KEY=sb_publishable_local_runtime \
SEARCH_JOBS_DB_HOST=/var/run/postgresql \
SEARCH_JOBS_DB_NAME=klir_jobs_local \
SEARCH_JOBS_DB_USER=klir_job_connect \
SEARCH_JOBS_WORKER=manual \
node tools/search-job-runtime.mjs
```

`9999` doit être un GoTrue que vous exécutez vous-même sur la machine. Cette PR n’en démarre pas un vers un projet distant. Le test `test/search-job-supabase-auth.test.mjs` en démarre un sur un port éphémère.

Les rôles d’exploitation restent `klir_job_api` et `klir_job_runner`, `NOLOGIN`, distincts du propriétaire des migrations. La clé d’auth n’est pas un rôle de base.

## Compatibilité avec le lot D

Les fichiers du lot D et ceux de ce runtime ne se recouvrent pas assez pour un conflit. `git merge-tree` entre les deux branches produit une fusion automatique. Les PR existantes ne sont pas fusionnées.

## Encore bloqué

Brancher l’entrée Deno et un projet Supabase réel, y compris Test. Décision séparée, hors de cette PR. Le géocodeur et l’ingestion mondiale restent non branchés.
