# Décision de vente — 4 novembre 2026

Statut : préparation. Ce document n’ouvre pas la vente, ne déploie rien et ne choisit pas un prix. Achat dans l’application fermé. Aucun paiement réel, aucune restauration, aucune réinitialisation de Supabase Test.

**Décision : NO-GO pour la vente.**

## Fait dans cette livraison

- Le test `performance-assets` accepte un `_headers` en LF ou en CRLF. Preuve locale : `KLIR_ENV=preview npm run check` — lint, **143 tests réussis, 0 échec, 0 ignoré**, build `environment=preview` et `supabase=absent`.
- Sur le parcours Overture (prévisualisation + projet Test `pwakjxjjxswdjsapsbxn` seulement), l’accueil, le formulaire et le récapitulatif disent la même chose que le code : catalogue Overture `2026-10-21.0`, restaurants et cafés, trois cercles de 2,2 km (Montréal, Laval, Québec), maximum 40, pas les villes entières, pas une couverture mondiale. Le plafond affiché reste **10 recherches complètes par mois civil, fuseau America/Toronto**.
- Hors ce parcours, l’accueil continue de dire OpenStreetMap, avec Montréal, Laval, Québec, Toronto, Paris et Lyon. Ce n’est pas une couverture mondiale.
- La page d’offre de prévisualisation indique que **49 $ CA** est le montant technique Stripe de test, imposé par le serveur s’il est activé. Elle dit explicitement que ce n’est pas le prix de vente.

Ce correctif est dans la pull request. Il n’est pas fusionné et il n’est pas publié. La prévisualisation servie aujourd’hui reste l’ancien commit.

## Chemins réellement observés

| Surface | URL | HTTP | Commit servi | Environnement | Base | Source réelle |
|---|---|---|---|---|---|---|
| Site public | `https://klirprospect.klirline.ca/` | 200 | `a57e576a50e7655555d5da5639811bb83987c102` | `production` | `cbklwmjudobqwbkbxqgy` (`build.json`, `supabaseSource=env`) | OpenStreetMap via Overpass quand un compte lance une recherche. `config.*.js` : `stripeTestCheckout` faux. `config.js` nu : 404 (fichier empreinté). |
| Prévisualisation de l’alias | `https://codex-pilot-readiness.klirprospect.klirline.ca/` | 200 | `dae76a7ec1f8708d764d6ce05700353a6fdd5f80` | `preview` | `pwakjxjjxswdjsapsbxn` | Overture seulement si `environment=preview` **et** cette URL Supabase (`src/auth.js`, `overturePreview`). Sinon OpenStreetMap, ou aucune recherche sans compte. |

La prévisualisation actuelle contient encore, dans `app.js` servi, la phrase « recherchez des entreprises dans OpenStreetMap » à l’accueil, alors que `bind()` restreint déjà le formulaire à Montréal, Laval et Québec et que `runSearch` délègue à `runOvertureSearch`. L’accueil et la recherche ne disaient donc pas la même source. Le correctif de cette livraison aligne l’accueil sur Overture **pour le prochain assemblage** de cette branche de code. L’alias `codex/pilot-readiness` n’a pas été modifié : il doit rester en place pour ce nom d’hôte.

`stripeTestCheckout` dans le `config.js` de la prévisualisation est **false**. Les fonctions `stripe-test-checkout`, `stripe-test-confirm` et `stripe-test-webhook` du projet Test répondent **403** `{"outcome":"purchases_closed"}` (OPTIONS checkout/confirm : 204). `delete-account` répond 400 `confirmation_required` sans suppression. Aucune clé n’est recopiée ici.

## Stripe — mode test

Le navigateur n’envoie ni montant, ni crédits, ni réussite : `stripe-test-checkout` est appelé avec `body: {}`. Le serveur compare la session `cs_test_` à la commande et à `STRIPE_TEST_OFFER` (4900, `cad`, 90 crédits, 30 jours techniques). Un second clic ou un second événement ne crée pas une seconde activation. Un impayé, un montant différent, une clé `_live_` ou un remboursement partiel n’ouvrent pas l’accès. Un remboursement intégral reprend le lot seulement s’il est encore entier.

| Cas | Preuve | Niveau |
|---|---|---|
| Second clic / session déjà créée | `test/stripe-test-checkout.test.mjs` | AUTO, fictif, sans réseau Stripe |
| Impayé, session ouverte | `confirmation serveur : impayé, puis un seul accès` | AUTO |
| Webhook en double, paiement refusé ou interrompu, écart de montant | `test/stripe-test-candidate.test.mjs` | AUTO |
| Remboursement intégral une fois, partiel non acquitté, autre compte inchangé | `test/stripe-test-ledger.test.mjs` (PGlite, solde 200 → 290 → 200) | AUTO |
| Carte de test, webhook Stripe réel, activation d’un compte de la prévisualisation | Non exécuté | MANUEL / NOT RUN |

Prérequis absents de cet environnement (noms seulement, aucune valeur) : `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `STRIPE_TEST_CHECKOUT_ENABLED`, `ALLOWED_ORIGIN`, `KLIR_ENV`. Même si ces secrets étaient fournis, l’achat ne doit pas être ouvert en production. La migration `20261103010000_stripe_test_preview.sql` n’a pas été vérifiée sur le projet Test dans cette exécution : pas d’accès PostgreSQL.

## Sauvegarde et restauration

Une restauration complète n’a jamais été démontrée dans ce dépôt. La procédure vise une cible isolée : [restauration-complete-procedure.md](restauration-complete-procedure.md) et `tools/recovery/backup_restore.py`. Le script refuse Test et la production comme cible, refuse `db reset`, et exige une pile locale vide.

Exécuté ici :

- `python3 tools/recovery/test_recovery.py` : 3 tests, OK (garde-fous, pas un dump).
- `python3 tools/recovery/backup_restore.py preflight --directory /tmp/klir-backup-preflight-audit` : `supabase`, `docker`, `psql` et `age` absents ; `KLIR_TEST_DB_URL`, `KLIR_RECOVERY_DB_URL` et `KLIR_BACKUP_AGE_RECIPIENT` absents ; `backup_performed=false`, `restore_performed=false`.
- Syntaxe Python du script : `ast.parse` réussi.

Aucune donnée réelle n’a été exportée ni restaurée. Supabase Test n’a pas été réinitialisé.

Prérequis avant une répétition, hors dépôt : CLI Supabase, Docker, psql, age ; URL PostgreSQL de session du **seul** projet Test (port 5432, TLS) ; destinataire age indépendant ; pile Supabase locale vide sur `127.0.0.1` ; fenêtre sans écriture confirmée par le propriétaire. Objectif : deux comptes, notes, actions, reçus, absence de second débit. Aucun RPO/RTO chiffré tant que cet exercice n’est pas fait.

## Parcours client

Build visé pour la vente : la prévisualisation ci-dessus, pas le site public. Le code de `main` (`a57e576`) n’y est pas servi. Parcours réel avec compte : **non exécuté** (pas d’identifiants, pas de boîte de messagerie, navigateur MCP indisponible).

| Étape | AUTO (tests locaux, sans le site servi) | MANUEL / NOT RUN |
|---|---|---|
| Récupération du mot de passe | `test/password-recovery-routing.test.mjs`, `test/auth-callback-error.test.mjs` (jeton fictif, même onglet, lien à usage unique) | Envoi réel et clic dans la messagerie |
| Connexion | Politique de mot de passe et session dans `test/auth-policy.test.mjs`, `test/store-session.test.mjs` | Compte de la prévisualisation |
| Recherche | OSM simulé `test/search-parameters.test.mjs`, `test/osm-*.test.mjs` ; garde Overture dans `src/app.js` (`runOvertureSearch` refuse un autre secteur, une autre ville, l’île, un filtre de taille ou de site) | `overture_begin` / Overpass sur le site servi |
| Sélection, CRM, note, prochaine action | `test/commercial-validation.test.mjs`, `test/store-session.test.mjs` | Fiche réelle de la prévisualisation |
| Export CSV | `test/commercial-validation.test.mjs` (UTF-8, formule, licence, téléphone texte) | Fichier téléchargé depuis le site |
| Reconnexion | « le même compte recharge les recherches distantes » dans `test/store-session.test.mjs` (PGlite) | Deuxième navigateur sur la prévisualisation |

## Décisions encore ouvertes — le propriétaire choisit

| Sujet | Textes déjà dans le dépôt | Ce que le code fait aujourd’hui |
|---|---|---|
| Prix | Page externe évoquée : essai 0 $, 10 recherches / 30 jours. Essai Stripe : 49 $ CA (`4900`, offre `klirprospect-pilot-demo`). Brouillon [offre-premier-pilote.md](offre-premier-pilote.md) : proposition **490 $ CA hors taxes**, non retenue comme prix affiché. | Aucun encaissement. 49 $ CA n’est pas présenté comme le prix de vente dans le correctif. |
| Quota | « 10 recherches / 30 jours » dans l’offre brouillon et sur la page externe. | Registre : 10 recherches **complètes** par **mois civil America/Toronto**, plus le solde de crédits. Les 30 jours du reçu Stripe de test ne changent pas ce compteur. 90 crédits = 10 × 9, plafond technique, pas une promesse commerciale. |

## Pourquoi NO-GO

1. Le prix, les taxes, le remboursement, le support et le contact de confidentialité ne sont pas retenus par Klirline.
2. Le quota vendu (30 jours glissants ou mois civil) n’est pas tranché. Afficher les deux comme équivalents serait faux.
3. Le paiement de test n’a pas été vu de bout en bout : le serveur de test répond `purchases_closed`, et les secrets de test ne sont pas dans cet environnement.
4. Aucune sauvegarde indépendante ni restauration sur une cible vide n’a été exécutée.
5. Le parcours client n’a pas été refait sur l’URL de prévisualisation avec un compte.
6. L’alias servi (`dae76a7`) ne contient pas encore l’alignement d’accueil. Le publier demanderait une mise à jour séparée de `codex/pilot-readiness`, hors de cette livraison.

La vente pourra être réexaminée quand ces six points auront une preuve, et seulement après une décision explicite du propriétaire. Cette note n’est pas cette décision.
