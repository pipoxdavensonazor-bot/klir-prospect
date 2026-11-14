# Répétition de restauration complète — 14 novembre 2026

Environnement isolé : PostgreSQL 17.11 portable lancé sur la machine d'exploitation, socket Unix local
uniquement (`listen_addresses=''`, port 55777), aucune connexion à Test ni à Prod, aucune ressource payante.

## Base de données (mesuré)

| Étape | Résultat |
|---|---|
| Archive | `klirprospect-cbklwmjudobqwbkbxqgy-20261114T140604Z.sql.gz.age` (run GitHub 43602985495, 14 nov. 09 h 06 Toronto) |
| Intégrité | `sha256sum -c` : OK |
| Restauration | `ops/backup/restore.sh` (déchiffrement en flux, aucun fichier en clair sur disque), `--single-transaction`, ON_ERROR_STOP |
| Durée | environ 2 s pour 117 Mo restaurés (archive de 10 Mo) |
| Contenu | schéma auth : 27 tables ; private : 25 ; public : 9 ; 70 fonctions SQL public/private ; 80 872 lieux de catalogue ; 16 offres Stripe ; 12 événements Stripe |
| Contrôle | empreinte `ops/backup/fingerprint.sql` produite sur la base restaurée ; écart attendu avec Prod : le compte réviseur Google créé à 10 h 07, après l'archive |
| Cycle Stripe | `private.stripe_handle_event` rejoué sur la base restaurée (13 cas, voir `docs/stripe-cycle-et-remboursement.md`) |

La base restaurée a été supprimée après la répétition (copie déchiffrée de données Prod).

## Ce que la sauvegarde NE contient pas (inventaire à reconstruire)

| Élément | Source de reconstruction |
|---|---|
| 7 fonctions Edge (search-jobs, search-job-runner, search-geocode, email-finder, stripe-webhook, delete-account, prospects héritée) | dépôt `supabase/functions/` (sauf `prospects`, absente du dépôt, à ne pas recréer) |
| Secrets Edge (noms seulement) | `OPENCAGE_API_KEY`, `KLIR_JOB_DB_HOST`, `KLIR_JOB_DB_PORT`, `KLIR_JOB_DB_NAME`, `KLIR_JOB_DB_USER`, `KLIR_JOB_DB_PASSWORD`, `KLIR_ENV`, `KLIR_JOB_TEST_JOB_ID`, `KLIR_JOB_SCHEDULER_SECRET`, `ALLOWED_ORIGIN` (facultatif depuis delete-account v1 Prod) |
| Secrets Vault (noms) | `klir_job_scheduler_secret`, `klirprospect_stripe_webhook_live`, `klirprospect_stripe_webhook_test` : non sauvegardés (le dump couvre seulement public, private et auth), à recréer |
| Tâches pg_cron | `klir-search-scheduler` (chaque minute), `klir-expire-credit-lots` (09:17 UTC) : à recréer (schéma cron non sauvegardé) |
| Réglages Auth | URL du site, liste de redirection, SMTP Cloudflare (noreply@klirline.ca), modèles de courriel, longueur minimale du mot de passe (12) |
| Rôles de connexion | `klir_job_runner`, `klir_backup_reader` : recréés NOLOGIN par le préambule ; mots de passe à régénérer |
| Stripe | webhook `we_1Ubgqv…` à repointer vers le nouveau projet + nouveau secret dans Vault |
| Site | `config.js` (URL + clé publiable du nouveau projet), redéploiement Cloudflare Workers |

## RTO estimé (perte totale du projet Prod)

| Bloc | Durée estimée |
|---|---|
| Nouveau projet Supabase (Free) + rôles | 5 à 10 min |
| Restauration base (mesurée ~2 s, transfert réseau en plus) | 5 min |
| Vault, pg_cron, rôles de connexion | 10 min |
| 7 fonctions Edge + secrets | 15 min |
| Réglages Auth + SMTP + modèles | 10 min |
| Webhook Stripe + config site + déploiement | 15 min |
| Vérification (connexion, recherche, webhook) | 15 min |
| **Total** | **environ 1 h 15 à 1 h 30** ; RPO : jusqu'à 24 h (sauvegarde quotidienne, pas de PITR en plan Free) |

## Limites

- Répétition faite sur PostgreSQL local, pas sur un nouveau projet Supabase (création non autorisée : coût potentiel).
- Les secrets, Vault, pg_cron et la configuration Auth ne sont pas couverts par la sauvegarde : la liste ci-dessus est l'inventaire à tenir à jour.
