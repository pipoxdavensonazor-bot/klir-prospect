# Raccord pilote — jobs éteints, sonde Overture locale

Ce lot part du runner qui accepte le refus de facturation (`2aed715`) et de l’extrait réel des six centres. Il ne fusionne pas vers `main`, n’allume pas `jobs_enabled`, et ne déploie rien.

## Ce qui est branché en local

`SEARCH_JOBS_PROVIDER=overture-pilot` et `SEARCH_JOBS_PILOT_SNAPSHOT` pointant vers un fichier local font lire `test/fixtures/overture-places-six-centers.json`. Le fournisseur ne fait aucun appel réseau. Il ne couvre pas une ville : huit lieux autour de chaque centre déjà au contrat, release `2026-10-21.0`. Les contacts restent non vérifiés.

Le cycle local existant enregistre `result_count` par `private.record_search_collection`, puis `reconcile_search_job`. Un second cycle ne réécrit pas la collecte. Sans la variable, le fournisseur simulé reste celui des tests déjà en place.

## Ce qui n’est pas opérationnel

Les lignes de lieux ne sont pas stockées. Il n’y a pas de table d’index. `jobs_enabled` reste faux : `enqueue_search_job` refuse avant `reserve_usage`. Le runner distant reste le diagnostic. OpenCage n’est pas appelé. Aucun repli Photon, PlaceRoot ou Nominatim.

## Paquet à déployer plus tard, par le parent

Fonction `search-jobs` seulement, projet Test `pwakjxjjxswdjsapsbxn`, `verify_jwt` vrai. Fichiers : `supabase/functions/search-jobs/index.ts` et `supabase/functions/_shared/search-job-edge.mjs` avec ses dépendances déjà déployées. Le seul changement est la prévérification pour l’origine `https://cursor-test-server-diagnostic-2f07.klirprospect.klirline.ca`. Aucune migration. Aucun secret nouveau. Ne pas exécuter `update private.search_job_settings set jobs_enabled = true`.

Retour arrière : republier la version précédente de `search-jobs` sur ce projet. Ne pas toucher `search-job-runner` ni la production `cbklwmjudobqwbkbxqgy`.

## Recette locale à deux comptes

La recette déjà exécutée par `test/search-job-runtime.integration.test.mjs` couvre deux utilisateurs, l’isolation, l’annulation et l’absence de second débit avec le fournisseur simulé, sur une base PostgreSQL jetable dont le drapeau part éteint. `test/overture-pilot-provider.test.mjs` ajoute la sonde réelle : Laval produit 8 fiches, un second cycle n’appelle plus `record_search_collection`, et ni `reserve_usage` ni `settle_usage` ne sont appelés par ce cycle.
