# Planificateur des recherches — projet Test

Objectif : traiter les recherches des comptes standard sans clic admin et sans crédits bloqués, sur le projet Test `pwakjxjjxswdjsapsbxn` uniquement. Production `cbklwmjudobqwbkbxqgy` : non appliqué.

## Choix

Le traitement reste dans `search-job-runner` (fournisseur Overture pilote, filtres `importPlaces`). Le recopier en SQL créerait une deuxième implémentation à maintenir. On retient donc `pg_cron` + `pg_net` appelant le runner avec un secret serveur dédié, chaque étape fermée par défaut.

| Élément | Borne |
| --- | --- |
| `pg_cron` | Job `klir-search-scheduler`, `* * * * *`, exécute `select private.search_scheduler_tick()`. |
| `private.search_scheduler_tick()` | `security definer`, aucun droit pour `anon`, `authenticated`, `klir_job_api`, `klir_job_runner`. Retourne `inactif` / `moteur_off` / `debit` / `file_vide` / `secret_absent` / `production_refusee` / `appel`. |
| Activation | `private.search_scheduler_settings.enabled` vaut `false` à la migration. URL limitée par contrainte à `https://<ref>.supabase.co/functions/v1/search-job-runner`. URL contenant la référence de production : refusée. |
| Garde moteur | Aucun appel si `jobs_enabled` n'est pas vrai. Le runner relit `jobs_enabled` dans sa propre transaction et ne fait ni expiration ni réclamation s'il est faux. |
| Débit | Au plus un appel par `min_interval_seconds` (55 s par défaut, borné 30–3600). Le runner réclame `claim_search_jobs(1)` : une recherche par appel, soit au plus ~1/min. |
| File vide | Aucun appel si aucune recherche `open` en `queued`/`running`. |
| Expiration | Chaque appel exécute `private.expire_due_search_jobs()` avant de réclamer : les réservations échues libèrent leurs crédits. |
| Secret | `klir_job_scheduler_secret` (≥ 32 caractères) dans Vault et `KLIR_JOB_SCHEDULER_SECRET` dans les secrets Edge. Jamais dans la migration, le dépôt ou un journal. En-tête `x-klir-scheduler`, comparaison à temps constant. |
| Passerelle | `verify_jwt` reste vrai : l'appel porte la clé anon publique (`gateway_key`), qui n'ouvre aucun droit côté runner. |
| Runner, chemin `scheduled` | Corps exactement `{ "action": "scheduled" }`. Refusé hors `KLIR_ENV=preview`, hors URL/hôte/utilisateur/port/base Test exacts, ou si `KLIR_JOB_TEST_JOB_ID` est posé (`cible_active`). Session vérifiée `klir_job_runner` / `klir_job_connect_test`. L'en-tête planificateur sur le chemin admin est refusé. |
| Journal | `private.search_scheduler_runs` : seulement les appels et refus notables, purgé après 7 jours. Réponses HTTP : `net._http_response` (rétention pg_net). |

## Configuration Test (hors migration)

1. Générer le secret sur la machine d'exploitation, sans l'afficher.
2. Le poser en secret Edge `KLIR_JOB_SCHEDULER_SECRET` et dans Vault : `select vault.create_secret('<secret>', 'klir_job_scheduler_secret')`.
3. `update private.search_scheduler_settings set enabled = true, runner_url = 'https://pwakjxjjxswdjsapsbxn.supabase.co/functions/v1/search-job-runner', gateway_key = '<clé anon publique>'`.
4. Le planificateur ne travaille que si `jobs_enabled = true`.

## Arrêt

- Pause : `update private.search_job_settings set jobs_enabled = false` (aucun appel, aucune réclamation).
- Désactivation : `update private.search_scheduler_settings set enabled = false`.
- Retrait : `select cron.unschedule('klir-search-scheduler')`, supprimer le secret Vault et `KLIR_JOB_SCHEDULER_SECRET`.

## Tests

`test/search-job-scheduler.test.mjs` : inactif par défaut, garde moteur, file vide, secret absent ou court, un appel par intervalle, URL de production refusée, URL arbitraire rejetée, droits refusés aux rôles client et runner, chemin Edge planifié (secret, identité Test, cible active, corps strict, moteur éteint, ordre expiration → réclamation, session inattendue).

## Recette Test du 13 nov. 2026 (heure de Toronto)

- Fonction `search-job-runner` v16 (bundle du commit `cda020a`), secret Edge `KLIR_JOB_SCHEDULER_SECRET` et secret Vault posés sans affichage, migration `search_job_scheduler` appliquée, configuration activée.
- `jobs_enabled=true` à 03:15, recherche Laval 10 créée par `enqueue_search_job` pour `pipoxdavensonazor@gmail.com` (`db23d8f6-…`, réservation 6 crédits, 144 → 138) à 03:15:46.
- Tick cron de 03:16:00 : `appel` → réponse 200 `{"mode":"planifie","executed":true,"expired":0,"jobs":[{"status":"succeeded","ledger_status":"complete"}]}` ; job `succeeded`/`complete`, 1 fiche, un seul reçu `debit_…` de 6 crédits.
- `jobs_enabled=false` à 03:17:48 ; ticks de 03:18 et 03:19 : aucun appel HTTP.
- Comptes A, B et `contact@klirline.ca` : soldes inchangés (194/1, 200/0, 200/0).
