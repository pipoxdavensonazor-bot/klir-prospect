# Audit KlirProspect

Date de lecture : 8 novembre 2026. Aucune modification de `main`, aucune migration de production, aucun paiement, aucune recherche débitée.

Verdict commercial : **BLOCKED**. La commercialisation reste interdite.

## État confirmé

| Élément | État confirmé | Preuve | Risque | Action |
| --- | --- | --- | --- | --- |
| `main` | `4f4f076789d772cd17c9222d1f1c813286d35bfa`, fusion de la PR 34 | `git rev-parse origin/main` | La file de jobs n'est pas dans le site public | Ne pas y fusionner cette pile |
| Pull requests ouvertes | Aucune au moment de la lecture | `gh pr list --state open` | Les correctifs restent hors revue tant qu'une PR n'est pas ouverte | Ouvrir les PR de supervision, sans les fusionner |
| Pile hors de `main` | Tête `9dd1b569505a338d5bd03a06299446ee219f522f` sur `cursor/runner-cors-preview-2f07` | `git rev-parse` | Cette pile n'est pas le site public | La garder comme base de travail |
| CI de la PR 53 | FAIL : 204 réussites, 2 échecs, 7 ignorés | [run 42502277112](https://github.com/pipoxdavensonazor-bot/klir-prospect/actions/runs/42502277112), commit `e3d183f766c262002e2f8e1afd993b470f95f933` | Le cycle de sonde était enregistré `failed` | Corrigé dans le test, commit `6b8a554ba484038d1567b5801f1cd92212e87bd1` |
| Second échec de ce run | « Chrome affiche le site de 390 px » : `port Chrome absent` | Même run | Le runner GitHub n'avait pas Chrome | PASS en local le 8 novembre 2026, durée 3919 ms |
| Suite locale après correctif | 210 réussites, 0 échec, 4 ignorés | `npm test` sur `cursor/search-probe-cycle-2f07` | Les quatre ignorés n'interrogent pas le réseau | Ne pas les compter comme une preuve distante |
| Prévisualisation pilote | Sert `c2a369a059648d85767e676e3e26bbf102e16b2a`, construit le 8 novembre 2026 à 21:15:23 UTC | `GET /build.json` sur `https://cursor-search-pilot-ui-2f07.klirprospect.klirline.ca` | Le fichier servi correspond au commit d'écran attendu | Aucun redéploiement |
| Projet Test | `pwakjxjjxswdjsapsbxn`. 22 migrations, dont jobs, grand livre, runner, sonde et fiches | `list_migrations` | Le drapeau `jobs_enabled` est déjà vrai | Ne pas l'allumer davantage et ne pas le copier en production |
| Moteur Test | `jobs_enabled = true`, 0 job, 0 fiche | SQL de lecture sur Test | Le prochain clic connecté peut réserver un crédit | Aucune recherche lancée dans cette supervision |
| Fonctions Test | `search-jobs` v5, `search-job-runner` v7, `search-geocode` v2, `verify_jwt` vrai. Trois fonctions Stripe Test avec `verify_jwt` faux | `list_edge_functions` | La passerelle n'exige pas de JWT avant ces trois fonctions | Voir la section Stripe. Ce n'est pas, à soi seul, une vulnérabilité |
| Production Supabase | Non lue | Aucune requête vers `cbklwmjudobqwbkbxqgy` | L'écart de données n'est pas mesuré | Ne pas s'y connecter |
| Migrations absentes de `main` | Six fichiers de jobs, grand livre, rôle, connexion Test, sonde et fiches | `git ls-tree` | Les appliquer en production publierait un moteur incomplet | Les garder hors du projet de production |
| Sauvegarde chiffrée | Non prouvée | Aucun contrôle du disque, du swap ni du support | Une restauration réelle est interdite | Rester sur des données fictives |

## Cause du cycle `failed`

Le défaut est dans le **test**, pas dans le worker ni dans le moteur de collecte.

`runWorkerCycle` (`supabase/functions/_shared/search-job-worker.mjs`) écrit d'abord `private.record_search_places` quand la sonde rend des fiches, puis `private.record_search_collection` avec `complete`. Le double SQL du test, dans `test/overture-pilot-provider.test.mjs` au commit `e3d183f`, lançait `throw new Error(sql)` pour toute requête inconnue. Cette exception était rattrapée par le worker, qui enregistre alors `failed` et un compte de 0. L'assertion attendait `complete`. Le run CI montre `+ 'failed'` et `- 'complete'`.

Le worker a le bon réflexe : une écriture de fiches refusée ne doit pas être facturée. Ce comportement est maintenant verrouillé par le test « une écriture de fiches refusée clôt la sonde en failed sans débit direct ». La logique métier n'a pas été changée.

## Transitions

Fonction `private.record_search_collection`, migration `20261107201000_search_job_ledger.sql` :

| Issue | Compte exigé | Effet |
| --- | --- | --- |
| `complete` | au moins 1 | Issue enregistrée, statut laissé `running`, progrès 80 |
| `empty`, `partial`, `failed` | exactement 0 | Même enregistrement, sans débit à cette étape |
| Même issue et même compte déjà écrits | inchangé | Retour `recorded: false` |
| Grand livre déjà `complete` | — | `deja_regle` |
| Grand livre non ouvert, ou statut hors `queued` / `running` | — | `job_clos` |
| Issue déjà différente | — | `collection_figee` |

Fonction `private.reconcile_search_job` :

| État avant règlement | Statut du job | Grand livre |
| --- | --- | --- |
| Déjà `complete` ou `released` | inchangé | `replayed: true` |
| `queued`, sans issue, réservation échue | `failed` | `released` |
| Sans issue, réservation encore valide | inchangé | `waiting: true` |
| `complete` et compte supérieur à 0 | `succeeded` | débit confirmé |
| `empty`, `partial` ou `failed` | `failed` | réservation libérée |

Le worker local n'émet que `complete`, `empty`, ou `failed` après une exception. `partial` est accepté par SQL et n'est pas produit par ce fournisseur de sonde. `queued` et `running` sont les seuls statuts qui acceptent une issue. Une seconde réclamation du même cycle de test ne reprend aucun job.

`private.record_search_places` ignore un second appel pour le même job (`replayed: true`) et n'est exécutable que par `klir_job_runner`. Le client authentifié n'a que `SELECT` sur ses propres lignes.

Le worker n'appelle ni `reserve_usage` ni `settle_usage`. Le débit passe par `reconcile_search_job`, qui appelle `private.apply_usage_outcome`. Un second règlement d'un reçu déjà clos est rejoué. Les tests PGlite « expiration, collecte et annulation ne règlent qu'une fois » et « un reçu de débit ne s'applique qu'une fois » ont réussi.

## Prévisualisation

`https://cursor-search-pilot-ui-2f07.klirprospect.klirline.ca/build.json` annonce le commit `c2a369a059648d85767e676e3e26bbf102e16b2a`, l'environnement `preview` et l'hôte Test `pwakjxjjxswdjsapsbxn.supabase.co`.

- `auth.js` servi contient `search_job_places`, `action: "cycle"` et les six clés `montréal`, `laval`, `québec`, `toronto`, `paris`, `lyon`.
- `app.js` servi contient `pilotCityKey` et la liste des six villes dans `#aCity`.
- `config.js` annonce `environment: "preview"` et `stripeTestCheckout: false`. La clé publiable n'est pas recopiée ici.

Aucun déploiement n'a été lancé. L'écart de commit est nul pour cet écran.

## Stripe Test

Les trois fonctions déployées `stripe-test-checkout`, `stripe-test-confirm` et `stripe-test-webhook` ont `verify_jwt = false` sur le projet Test. Le fichier `supabase/config.toml` de la pile ne désactive pas ce contrôle : il ne déclare que `search-jobs` et `search-job-runner`, tous deux avec `verify_jwt = true`.

La sécurité observée dans le code ne repose pas sur la passerelle :

- Checkout et confirmation exigent un jeton `Bearer`, puis `auth.getUser`. Sans jeton, la fonction répond `authentication_required`.
- L'origine doit être celle du runtime. Une origine différente répond `origin_not_allowed`.
- `readStripeTestRuntime` refuse une clé, un webhook ou un prix contenant `_live_`.
- Le webhook exige `stripe-signature`, vérifie la signature, refuse `livemode !== false`, n'accepte que `cs_test_` et `pi_test_`, relit la session, puis applique le paiement dans une fonction atomique qui distingue `applied` et `duplicate`.

`verify_jwt = false` n'est donc pas classé comme vulnérabilité. Le risque résiduel est qu'un oubli dans le contrôle applicatif serait atteignable sans rejet préalable de la passerelle. Les tests locaux « le navigateur ne peut pas imposer le prix », « confirmation serveur : impayé, puis un seul accès » et « registre Stripe fictif » ont réussi. Aucun paiement réel n'a été ouvert.

## OpenCage

Un `POST` sans session vers `search-geocode` sur Test a répondu HTTP 401. Le corps ne contient ni `configured` ni le nom du secret. La présence de la clé sur le projet n'a pas été lue. Les tests locaux prouvent que le statut admin renvoie un booléen et le nom `OPENCAGE_API_KEY`, et qu'une réponse ponctuelle masque la valeur. Aucun achat, aucun appel vers `api.opencagedata.com` avec le secret du projet.

## Données fictives exécutées

Toutes ces preuves viennent de `npm test` et de PGlite ou d'un PostgreSQL local, pas du projet distant :

- Deux comptes jobs : « anon est refusé, A et B sont isolés, et l'admin ne lit pas le job d'autrui ».
- Deux comptes du grand livre : « deux comptes, l'admin et anon restent isolés, et le reçu v2 n'est pas réglé par le client ».
- Deux connexions PostgreSQL : « PostgreSQL local, deux connexions : HTTP, file, collecte, grand livre ».
- Conflit CRM : « deux sessions : conflit explicite, reprise identique, 2 Mo et isolation » refuse `workspace_conflict` et ne duplique pas une réponse perdue.
- CSV : formules neutralisées, import cité, téléphone à zéro initial conservé comme texte.
- Crédits : réservation, vide, partiel, échec, expiration et second règlement ne débitent qu'une fois.

La restauration distante n'a pas été exécutée. Le chiffrement du support n'est pas prouvé.
