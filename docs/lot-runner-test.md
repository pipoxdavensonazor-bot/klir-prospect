# Runner Test — connexion à valider, jobs non exécutés

Branche dédiée, empilée sur l’entrée API Test. Rien n’est déployé ni provisionné ici. Le moteur reste éteint. La production reste exclue. Ce n’est pas une recherche opérationnelle.

L’API `search-jobs` déjà déployée n’est pas rebranchée. Le runner est une autre fonction. Il ne réclame, n’expire, n’enregistre ni ne règle aucun job. Le fournisseur est absent : toute action autre que le diagnostic est refusée.

## Fichiers

- `supabase/migrations/20261107233000_search_job_connect_test.sql`
- `supabase/functions/search-job-runner/index.ts`
- `supabase/functions/_shared/search-job-runner-edge.mjs`
- `supabase/functions/_shared/search-job-edge.mjs` (résolution de l’URL Test et de la clé publique, déjà livrée avec l’API)
- `supabase/functions/_shared/search-job-auth.mjs`
- `supabase/config.toml` : `[functions.search-job-runner] verify_jwt = true`

Dépendance npm de la fonction : `postgres@3.4.7` et `@supabase/supabase-js@2.117.2`, chargées par l’import Deno. Aucune des deux n’est une clé.

La migration ne modifie pas les fichiers déjà appliqués. Elle crée `klir_job_connect_test` en `LOGIN NOINHERIT`, sans mot de passe, sans droit superutilisateur, et le rend seulement membre de `klir_job_runner`. Si la base s’appelle `postgres`, elle lui accorde `CONNECT`. Elle retire les droits de table et de facturation au cas où. `private.diagnose_search_job_connection()` lit uniquement `jobs_enabled` et n’est exécutable que par `klir_job_runner`. `public.is_admin()` reste la liste d’opérateurs : elle ne donne aucun droit de table.

## Noms d’environnement

Déjà injectés pour Auth, sans nouveau secret de clé :

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEYS`, sinon `SUPABASE_PUBLISHABLE_KEY`, sinon `SUPABASE_ANON_KEY`

À poser ensuite, séparément, hors du dépôt :

- `KLIR_JOB_DB_HOST` : hôte du pooler partagé, suffixe `.pooler.supabase.com`. L’hôte exact n’est pas encore fixé.
- `KLIR_JOB_DB_PORT` : `6543` seulement. Un autre port est refusé.
- `KLIR_JOB_DB_NAME` : `postgres`
- `KLIR_JOB_DB_USER` : `klir_job_connect_test.pwakjxjjxswdjsapsbxn`
- `KLIR_JOB_DB_PASSWORD`

Le mot de passe n’est pas dans la migration. Il se pose hors git, sur le rôle, puis dans l’environnement de la fonction. La fonction ne journalise pas ces valeurs. Elle n’utilise pas `postgres`, `service_role`, ni `SUPABASE_DB_URL`.

Connexion : TLS exigé, `prepare: false`, une seule connexion. Chaque transaction fait `SET LOCAL ROLE klir_job_runner`. Le mode transaction de Supavisor ne garde pas un `SET ROLE` entre deux transactions ; `SET LOCAL` reste dans la transaction qui l’ouvre.

## Ordre d’installation

1. Appliquer seulement `20261107233000_search_job_connect_test.sql` sur Test. Ne pas réappliquer B, C ni le runtime.
2. Donner un mot de passe au rôle, hors dépôt.
3. Renseigner les cinq noms `KLIR_JOB_DB_*` sur la fonction. Ne pas les mettre dans git.
4. Déployer la fonction `search-job-runner`.

Tant qu’un nom manque, que le port n’est pas 6543, ou que l’hôte n’est pas un pooler, la fonction s’arrête sans ouvrir de session.

## Diagnostic non facturable

Seul un JWT dont `public.is_admin()` est vrai peut demander le diagnostic. Un autre utilisateur reçoit un refus et la base du runner n’est pas ouverte. Il n’y a pas de health public.

`POST` avec le corps `{ "action": "diagnose" }`.

Réponse attendue tant que le moteur est éteint et que le rôle n’a pas les tables : `connected: true`, `role: klir_job_runner`, `jobsEnabled: false`, `billing: refuse`, `provider: absent`, `executed: false`, `scheduler: off`.

Aucune ligne de crédit n’est lue. Si la sonde de facturation réussit, la fonction refuse : le rôle serait trop large. `{ "action": "run" }` ou toute autre action répond `fournisseur_absent` et n’ouvre pas la base.

## Cycle ciblé Test (PR 56, migration non appliquée)

But : exécuter un cycle sur **un seul** job approuvé pour un exercice, sans toucher la file ni les autres comptes.

- La cible vient uniquement de la variable serveur `KLIR_JOB_TEST_JOB_ID` (UUID). Le corps HTTP ne peut jamais la fournir : toute clé de cible (`jobId`, `job_id`, `targetJobId`, `target`, `id`, `job`) répond `cible_refusee`, et en mode ciblé le corps doit être exactement `{ "action": "cycle" }` ou `{ "action": "diagnose" }`.
- `index.ts` transmet `KLIR_ENV` et `KLIR_JOB_TEST_JOB_ID` à la fonction ; sans eux le mode ciblé ne s’active pas.
- Variable absente : cycle normal inchangé (expiration de la file puis `claim_search_jobs(1)`).
- Variable présente : la fonction exige, à l’identique, `KLIR_ENV=preview`, `SUPABASE_URL=https://pwakjxjjxswdjsapsbxn.supabase.co`, l’hôte pooler exact `aws-1-ca-central-1.pooler.supabase.com`, l’utilisateur `klir_job_connect_test.pwakjxjjxswdjsapsbxn`, le port 6543 et la base `postgres`. Toute différence refuse le cycle avant connexion ; il n’y a jamais de repli sur la file globale.
- Dans la transaction, la session doit répondre `current_user = klir_job_runner` et `session_user = klir_job_connect_test`, sinon `role_exploitation_refuse`.
- Le cycle ciblé n’appelle pas `expire_due_search_jobs()`. Si la réservation du job ciblé est échue, la base répond `job_expire` sans rien écrire.
- Côté base, `private.claim_authorized_test_job(uuid)` n’accepte qu’un job présent dans `private.search_test_job_approvals` (job + propriétaire, fenêtre d’au plus 24 h, RLS forcée, aucun droit pour le navigateur, l’API ou le runner). Elle refuse toute session autre que `klir_job_connect_test` (`role_non_autorise`).
- L’approbation se pose par le propriétaire des migrations, hors navigateur, pour un exercice nommé. Rien n’est approuvé par cette PR.
