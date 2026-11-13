# Sauvegarde quotidienne et surveillance — gratuites (plan Supabase Free)

> **Installation des workflows** : le jeton de la machine d'exploitation n'a pas le droit
> `workflow`, les fichiers sont livrés dans `ops/workflows/`. Les copier tels quels dans
> `.github/workflows/` (`backup.yml`, `monitor.yml`) par un compte ayant ce droit.

Objectif : ouvrir sans payer Supabase (pas de PITR). Tout tourne sur GitHub Actions
(dépôt public : minutes gratuites). **Rien n'est actif tant que les variables
`KLIR_BACKUP_ENABLED` / `KLIR_MONITOR_ENABLED` ne valent pas `true`**, et les
planifications GitHub ne tournent que depuis `main`.

## 1. Sauvegarde (`ops/workflows/backup.yml` → `.github/workflows/`)

Chaque jour 02:17 (Toronto, heure normale) et à la demande :

1. `pg_dump` 17 (format SQL) des schémas `public`, `private`, `auth`, via l'URL du
   **pooler de session** (port 5432 ; l'hôte direct `db.<ref>` est IPv6, absent des runners).
2. **Restauration de contrôle** dans un PostgreSQL 17 jetable du runner
   (`restore-preamble.sql` + dump) puis comparaison `fingerprint.sql` source/restauré :
   compteurs de toutes les tables, md5 des comptes, réservations, reçus, jobs, fiches,
   profils, espaces, ids Auth, RLS (on/force) par table, politiques, droits
   `reserve_usage`/`settle_usage`. Si la source change pendant le dump : avertissement, pas d'échec.
3. Chiffrement `age` avec la clé **publique** `ops/backup/age-recipient.txt`, puis
   artefact GitHub conservé **90 jours** (+ `.sha256`). Le clair est effacé (`shred`).
   Le dépôt étant public, l'artefact est téléchargeable par un compte GitHub : il est
   illisible sans la clé privée. Les journaux n'affichent que des compteurs/noms de clés.

La clé **privée** n'est jamais sur GitHub. Celle générée pour la recette est sur la
machine d'exploitation (`/workspace/secrets/klir_backup_age_identity.txt`, mode 600).
À copier dans le gestionnaire de mots de passe (sinon les archives sont perdues avec elle),
ou à remplacer : `age-keygen -o cle.txt`, puis mettre la ligne `age1…` dans
`ops/backup/age-recipient.txt`.

### Restaurer (jamais vers Test ni Prod)

```bash
createdb -h localhost restauration     # base PostgreSQL 17 locale vide
ops/backup/restore.sh klirprospect-<ref>-<date>.sql.gz.age cle-privee-age.txt \
  postgresql://postgres@localhost:5432/restauration
```

`restore.sh` refuse toute cible `*.supabase.co`/`supabase.com`/pooler ou non locale,
refuse une base non vide, restaure en une transaction et imprime l'empreinte JSON.
Comparer avec `compare_fingerprints.py`. Une base PostgreSQL restaurée n'est pas une
pile Supabase complète : voir [restauration-complete-procedure.md](restauration-complete-procedure.md).

## 2. Surveillance (`ops/workflows/monitor.yml` → `.github/workflows/`, toutes les 30 min)

`ops/monitor/check.mjs` (sans dépendance) contrôle :

| Contrôle | Échec si |
|---|---|
| site `/build.json` | HTTP ≠ 200 (défi Cloudflare = avertissement, échec si `KLIR_MONITOR_SITE_STRICT=true` ; jeton de service Access optionnel en secrets `KLIR_MONITOR_ACCESS_CLIENT_ID/SECRET`) |
| API `search-jobs/healthz` | HTTP ≠ 200 |
| runner `search-job-runner` | pas 401/403 à un POST anonyme (5xx, délai) — le diagnostic admin complet exige une session admin et n'est pas automatisé |
| jobs bloqués | `queued` > 15 min ou `running` sans mise à jour > 15 min |
| réservations échues | `ledger_status='open'` et `reserved_until` passé |
| runner via pg_net | réponses non 2xx dans la dernière heure |

Les trois derniers passent par `public.klir_ops_health()` (migration
`20261113100000_ops_health.sql`) : `STABLE`, `security definer`, `search_path=''`,
aucune écriture, uniquement booléens/compteurs/horodatages, exécutable par `anon`.
Échec → issue « Alerte surveillance KlirProspect » (étiquette `surveillance`) créée ou
commentée : GitHub envoie l'e-mail au propriétaire du dépôt. Retour au vert → commentaire
et fermeture. Aucun secret ni donnée personnelle dans l'issue (dépôt public).

## Réglages GitHub (Settings → Secrets and variables → Actions)

| Type | Nom | Valeur |
|---|---|---|
| Secret | `KLIR_BACKUP_DB_URL` | URI « Session pooler » du projet (Connect → Session pooler), mot de passe inclus |
| Variable | `KLIR_BACKUP_PROJECT_REF` | référence du projet (doit figurer dans l'URI) |
| Variable | `KLIR_BACKUP_ENABLED` | `true` |
| Variable | `KLIR_MONITOR_ENABLED` | `true` |
| Variable | `KLIR_MONITOR_SUPABASE_URL` | `https://<ref>.supabase.co` |
| Variable | `KLIR_MONITOR_ANON_KEY` | clé **anon (legacy, JWT)** publique du projet — la passerelle `verify_jwt` refuse `sb_publishable_…` |
| Variable | `KLIR_MONITOR_SITE_URL` | URL du site (ex. `https://klirprospect.klirline.ca`) |
| Variable | `KLIR_MONITOR_LABEL` | `Production` ou `Test` |

Pour la production, appliquer d'abord la migration `20261113100000_ops_health.sql`
(sinon le contrôle base échoue en 404).

## Recette (13 nov. 2026, heure de Toronto)

- Test : migration `ops_health` appliquée (journal `20261113084022`) ; `check.mjs` contre
  Test : 7 contrôles verts (site 200, healthz 200, runner 401, 0 job bloqué, 0 réservation échue).
- Chaîne `backup.sh` → `age` → `restore.sh` → `fingerprint.sql` : rejouée sur une base
  PostgreSQL 17 locale construite avec les 23 migrations + 2 comptes synthétiques et
  2 jobs créés par `enqueue_search_job` : empreintes identiques (25 tables), RLS
  own-only vérifiée dans la base restaurée, refus des cibles distantes/non vides.
- Non prouvé : `pg_dump` direct de Test (port PostgreSQL injoignable depuis la machine
  d'exploitation) et exécution GitHub (aucun secret posé). La première exécution
  manuelle du workflow sur Test ou Prod fait cette preuve automatiquement (étape 2).
- Incident : un export de secours par l'API de gestion (requêtes SQL HTTPS) a été tenté
  sur Test ; la base gratuite a redémarré à 03:43 puis est restée injoignable à partir
  d'environ 03:53, alors qu'un import lourd d'un autre lot tournait en parallèle. Méthode
  abandonnée et non livrée : ne pas extraire de gros volumes par l'API sur le plan Free.
