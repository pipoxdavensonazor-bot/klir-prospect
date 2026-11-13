# Preuve de bout en bout — Supabase Test, 13 nov. 2026

Projet Test `pwakjxjjxswdjsapsbxn` uniquement. Prod non touchée.

## Parcours prouvé (11:21–11:22 heure de Toronto)

1. Compte fictif A (`a1111111-…`, klir-fictif-a@example.com) : vrai jeton utilisateur
   obtenu par Supabase Auth (mot de passe Test régénéré, conservé hors dépôt).
2. Moteur éteint : `POST search-jobs` → `403 jobs_disabled` (garde prouvée).
3. `jobs_enabled=true` sur Test, puis `POST search-jobs` (enqueue, Montréal,
   restauration, 10 fiches) → `200`, job `036ff1e6-f805-4a5a-b030-80a0b429b7f9`,
   réservation 6 crédits (solde 194 → 188). Rejeu même clé → même job, `created:false`.
4. pg_cron (tick 16:22:00 UTC) → `search-job-runner` mode planifié → HTTP 200,
   job `succeeded`, `ledger_status=complete`, `result_count=10`.
   Durée création → fin : 3,3 s.
5. 10 fiches stockées dans `public.search_job_places` pour A, identiques à
   `private.search_catalog_lookup('montréal','restauration',10)` (Overture 2026-10-21.0,
   `contacts_verified=false`).
6. RLS : A voit ses 18 fiches (8 anciennes + 10), aucune d'un autre compte ; aucun
   job d'autrui ; `anon` refusé (42501) ; catalogue privé non exposé (PGRST205).
7. Crédits : reçu `debit_62b03176fdb414792c596240` 6 crédits, hold `complete`,
   solde 188, `searches_used` 1 → 2 ; aucune réservation ouverte.
8. `jobs_enabled=false` remis et relu ; `klir_ops_health` sain.

## Diagnostic crédits (lecture seule)

- Débit de 6 crédits à 3:00 (08:00:02 UTC) sur le compte de Philippe : hold
  `debit_7a32507a64910c7bdbab6e93`, sans job. Correction : il figure dans
  `public.overture_operations` (Laval, restauration, 10, complete). Il vient donc de
  l'ancienne recherche Overture du navigateur (`overture_begin`/`overture_execute`),
  depuis la session Chrome/Windows ouverte à 2:57:40. `reserve_usage`/`settle_usage`
  étaient déjà fermées à authenticated sur Test.
- 18 crédits bloqués (jobs `309fe934…` et `aacb0a8c…`, 9 + 9, 8 nov.) : déjà libérés
  le 13 nov. à 1:53 (`reservation_expired`), solde cohérent (200 − 62 débits complets = 138).
  Cause : `expire_due_search_jobs()` n'est appelée que par le runner, donc jamais
  moteur éteint. Correctif proposé, NON appliqué :
  `supabase/migrations/20261113150000_release_expired_reservations_engine_off.sql`.

## Suite du 13 nov. (11:30–11:45, Toronto) — après accord de Philippe

- Migration `20261113150000` appliquée sur Test : preuve en transaction annulée
  (compte B : 200 → 194 réservé → tick moteur éteint → 200, job `failed/released/reservation_expired`) ;
  aucune donnée persistée ; pg_cron : 20 ticks réussis, 0 échec.
- Migration `20261113160000_revoke_direct_debit_rpcs.sql` appliquée sur Test :
  `reserve_usage`, `settle_usage`, `overture_begin`, `overture_execute` refusées à authenticated.
- `search-jobs` v12 déployée sur Test (CORS de la preview `cursor-search-targeted-claim-2f07`).
- Preview redéployée automatiquement : `build.json` commit `cf86196`.
- Parcours interface réel (Chrome sur la preview, compte fictif A) : moteur éteint → message
  « Le moteur est éteint » (403) ; moteur allumé 25 s → job `730b63a1-aa9a-425c-9304-5381f6898bd5`
  `succeeded`, 10 fiches affichées, solde 188 → 182 affiché et en base, reçu unique.
- Compte fictif B : ne lit aucune fiche, job, crédit, reçu ni espace de A ; toutes les écritures
  croisées et les RPC de débit direct sont refusées (403 / 404).

## Correctifs du 13 nov., après-midi (feu vert « Oui feu vert », Test seulement)

### 1. `overture_admin` ne rouvre plus le débit direct
- Constat : `overture_admin('disable')` exécutait `grant execute … reserve_usage, settle_usage … to authenticated`.
- Recherche : grep du dépôt (seules les migrations historiques 20261011221500, 20261022130000, 20261023010000 accordent ces droits) et lecture de `pg_proc` sur Test : `public.overture_admin` était la seule fonction applicative contenant un `grant` (hors fonctions Supabase `extensions.grant_pg_*`).
- Migration `20261113170000_overture_admin_no_regrant.sql` : enable et disable basculent seulement le drapeau et révoquent les 4 RPC (`reserve_usage`, `settle_usage`, `overture_begin`, `overture_execute`) de PUBLIC, anon, authenticated. Appliquée sur Test.
- Après application sur Test : aucune fonction hors `extensions` ne contient de `grant` ; authenticated/anon = refusé sur les 4 RPC et sur `overture_admin`.
- Preuve sur Test en transaction annulée : `overture_admin('disable')` puis lecture des droits → les 4 RPC restent refusées (authenticated et anon) ; état Overture inchangé après l'annulation.
- Preuve négative (PGlite, sans le correctif) : après `disable`, authenticated retrouvait `reserve_usage` = true.
- Tests : `test/direct-debit-closed.test.mjs` (disable → enable → disable, 4 RPC refusées pour authenticated et anon, `enqueue_search_job` toujours ouvert).
- HTTP compte fictif B : `reserve_usage` et `overture_begin` → 403 permission denied.

### 2. En-tête des résultats de la file serveur
- Avant (preview, compte fictif A, recherche existante 730b63a1) : « Version · révision historique · cache . »
- Après (même page, nouveau app.js) : « Source : catalogue Overture (file serveur) · Version 2026-10-21.0 · Recherche du 11/13/2026. »
- `overtureHeaderFacts` ne garde que les champs réels ; la version est lue sur les fiches pour les anciennes recherches. Test `test/overture-header.test.mjs`.
- Aucune recherche lancée pendant le contrôle visuel (aucune requête search-jobs ni RPC de débit observée).
