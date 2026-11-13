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
  `debit_7a32507a64910c7bdbab6e93`, aucun job ni opération Overture associés.
  Il provient du chemin navigateur historique `reserve_usage`/`settle_usage`
  (recherche OpenStreetMap de `src/app.js`), depuis la session Chrome/Windows
  ouverte à 2:57:40. Débit légitime d'une recherche, mais hors file de jobs.
- 18 crédits bloqués (jobs `309fe934…` et `aacb0a8c…`, 9 + 9, 8 nov.) : déjà libérés
  le 13 nov. à 1:53 (`reservation_expired`), solde cohérent (200 − 62 débits complets = 138).
  Cause : `expire_due_search_jobs()` n'est appelée que par le runner, donc jamais
  moteur éteint. Correctif proposé, NON appliqué :
  `supabase/migrations/20261113150000_release_expired_reservations_engine_off.sql`.
