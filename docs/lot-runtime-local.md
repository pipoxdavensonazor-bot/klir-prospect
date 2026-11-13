# Runtime local des jobs — non activé

Cette branche part du lot C (`cursor/search-job-ledger-lot-c-2f07`). Elle ne fusionne rien, n’applique aucune migration sur Test ou Prod, ne provisionne rien et n’achète rien. Le géocodeur n’est pas dans cette branche : il reste absent. Les lots E à H ne sont pas commencés. L’interface n’appelle pas cette voie.

## Ce qui est exécutable

`node tools/search-job-runtime.mjs` ouvre une entrée HTTP locale. Elle vérifie un jeton par `createGetUserVerifier(getUser)`. Sans `SEARCH_JOBS_AUTH=supabase`, `getUser` n’accepte que `local:<uuid>` : c’est simulé, pas une signature. Avec `SEARCH_JOBS_AUTH=supabase`, le processus appelle le vrai `supabase.auth.getUser` vers une URL de boucle locale seulement. Le détail est dans `docs/lot-auth-getuser.md`. L’entrée déployable `supabase/functions/search-jobs/index.ts` reste fermée : `jobsEnabled` vaut `false` et `verifyJwt` rend `null`.

Le processus se connecte en `klir_job_connect`, puis chaque ordre passe par `set role` :

| Rôle | Droits |
| --- | --- |
| `klir_job_api` | Lire le drapeau, enfiler, lire son job, annuler. |
| `klir_job_runner` | Réclamer, enregistrer la collecte, réconcilier, libérer un bail, expirer les réservations dues. |

Ni l’un ni l’autre n’est le propriétaire des migrations. Ils sont `NOLOGIN`, sans secret, sans droit d’écriture directe sur les tables, et sans `EXECUTE` sur `private.apply_usage_outcome`, `reserve_usage` ou `settle_usage`. Le règlement passe par `private.reconcile_search_job`, qui est `SECURITY DEFINER`. `anon`, `authenticated` et `PUBLIC` n’ont pas ces fonctions, y compris un compte `is_admin()`.

Le fournisseur est simulé dans le processus. Il ne fait aucun appel réseau. `jobs_enabled` n’est pas allumé par le runtime ni par la migration. Le script de schéma refuse de continuer si le drapeau est déjà vrai, et ne l’allume pas.

La boucle `SEARCH_JOBS_WORKER=auto` reprend la file. `manual` attend `POST /internal/step`, utile pour un ordre déterministe. Les deux sont le même processus.

PGlite reste une seule session. Il ne prouve pas deux connexions. La preuve est `test/search-job-runtime.integration.test.mjs` contre PostgreSQL local : deux sockets, `FOR UPDATE` qui bloque, `SKIP LOCKED` qui ne livre le job qu’une fois, annulation ou expiration face au règlement, même clé, panne puis reprise, deux comptes, refus anonyme et refus d’un admin sur le job d’un autre.

## Commande locale

Une fois, sur la machine, sans secret et sans hôte distant :

```sh
sudo -u postgres createuser --superuser "$USER"
```

Dans `pg_hba.conf`, avant les autres règles, socket seulement :

```
local all klir_job_connect trust
```

Puis recharger PostgreSQL. `trust` ne concerne pas TCP. Le rôle n’a pas de secret ; une connexion distante reste refusée par l’authentification de l’hôte.

Préparer un catalogue jetable, drapeau laissé à `false` :

```sh
createdb klir_jobs_local
SEARCH_JOBS_DB_NAME=klir_jobs_local node tools/search-job-local-db.mjs
```

Ce script applique le socle local `auth.uid()` et les migrations jusqu’au rôle. Il ne faut pas l’envoyer vers Supabase : le schéma `auth` y existe déjà. Allumer le drapeau, seulement dans cette base locale et seulement pour un essai, reste une commande séparée :

```sh
psql -d klir_jobs_local -c "update private.search_job_settings set jobs_enabled = true"
```

Lancer le runtime :

```sh
SEARCH_JOBS_LOCAL=1 \
SEARCH_JOBS_DB_HOST=/var/run/postgresql \
SEARCH_JOBS_DB_NAME=klir_jobs_local \
SEARCH_JOBS_DB_USER=klir_job_connect \
SEARCH_JOBS_WORKER=auto \
node tools/search-job-runtime.mjs
```

Le processus refuse `SEARCH_JOBS_DB_PASSWORD`, `PGPASSWORD`, `DATABASE_URL`, une clé de service, un hôte autre que le socket, et un utilisateur autre que `klir_job_connect`. Il écrit le port sur la sortie standard et n’écrit pas la chaîne de connexion. Sans `SEARCH_JOBS_LOCAL=1`, il s’arrête : la voie v2 reste éteinte.

Jeton local, quantité 10 à 40, lieu `supported` :

```sh
curl -s -X POST http://127.0.0.1:8787/search-jobs \
  -H 'authorization: Bearer local:11111111-1111-4111-8111-111111111111' \
  -H 'content-type: application/json' \
  -d '{"action":"enqueue","idempotencyKey":"essai-local-0001","payload":{"place_status":"supported","cityKey":"laval","quantity":10,"simulateCount":1}}'
```

Santé : `GET /healthz` rend les rôles effectifs, pas un secret.

La preuve automatisée, y compris l’ordre manual puis la boucle auto :

```sh
npm run test:jobs-runtime
```

`npm test` lance le même fichier. Si le socket local ou un rôle propriétaire manque, ce test est sauté et le message le dit. Ce saut n’est pas une preuve de concurrence. Les tests PGlite du lot C restent des preuves de fonctions et de verrous sur une seule session.

## Dépendances encore ouvertes pour une recette Test

1. Décider d’appliquer, sur une base non productive, les migrations B, C, puis `20261107220000_search_job_runner_role.sql`. Cette PR ne le fait pas. Le script local ne vise pas Supabase.
2. Créer là-bas un rôle de connexion qui n’est pas le propriétaire des migrations, membre de `klir_job_api` et `klir_job_runner`, secret hors dépôt. Le rôle `klir_job_connect` et la ligne `trust` sont locaux. Ils ne sont pas dans la migration.
3. Remplacer le `getUser` local par `supabase.auth.getUser` dans un processus serveur, et brancher l’entrée Deno aujourd’hui fermée. Ne pas le faire en renversant seulement le booléen.
4. Laisser `jobs_enabled` à `false` jusqu’à une décision séparée. L’interface ne doit pas appeler `/search-jobs`.
5. Choisir un fournisseur et une licence avant tout appel réel. Le simulateur ne les remplace pas. Le géocodeur reste absent.
6. Lots E à H : non commencés.
