# Tests et validation

Environnement : dépôt local, branche `cursor/search-probe-cycle-2f07`, commit `6b8a554ba484038d1567b5801f1cd92212e87bd1`. Commande : `npm test`. Aucune variable `SEARCH_TEST_LIVE` ni `OPENCAGE_SKILL_LIVE`.

## Résultat global

| Mesure | Résultat |
| --- | --- |
| Tests | 214 |
| PASS | 210 |
| FAIL | 0 |
| Ignorés | 4 |
| Durée | 12,1 s |

Les quatre ignorés, par construction du fichier de test :

- « la clé publique de démonstration OpenCage répond sans utiliser notre secret » — exige `OPENCAGE_SKILL_LIVE=1`.
- Trois exigences publiées du projet Test — exigent `SEARCH_TEST_LIVE=1`.

Ils ne sont pas des PASS.

## Cycle de sonde

| Scénario | Résultat | Preuve |
| --- | --- | --- |
| Sonde locale des six centres, sans `fetch` | PASS | `test/overture-pilot-provider.test.mjs` |
| Un cycle enregistre huit fiches de Laval puis `complete` une seule fois | PASS | Même fichier, après le correctif |
| Second cycle sans nouveau job | PASS | `second.results.length === 0` |
| Écriture de fiches refusée | PASS | Issue `failed`, compte 0, grand livre `released` |
| Débit direct depuis le worker | PASS | Aucun appel `reserve_usage` ni `settle_usage` |
| CI GitHub du commit `e3d183f` | FAIL historique | Run `42502277112`, attendu `complete`, obtenu `failed` |
| Chrome 390 px sur ce poste | PASS | 3919 ms. Le run GitHub était `port Chrome absent` |

## Sécurité et données fictives

| Scénario | Résultat | Preuve |
| --- | --- | --- |
| RLS de deux comptes jobs, anon refusé, admin sans lecture du job d'autrui | PASS | `test/search-jobs-rls.test.mjs` |
| Isolation du grand livre et reçu v2 non réglable par le client | PASS | `test/search-job-ledger.test.mjs` |
| Deux connexions PostgreSQL, file, collecte, grand livre | PASS | `test/search-job-runtime.integration.test.mjs` |
| Conflit de révision CRM, rejeu, plafond 2 Mo, autre compte invisible | PASS | `test/workspace-concurrency.test.mjs` |
| Import CSV cité et ligne incomplète refusée | PASS | `test/security.test.mjs` |
| Export CSV, formules neutralisées, zéro initial | PASS | `test/commercial-validation.test.mjs` |
| Réservation, vide, partiel, échec, expiration, idempotence | PASS | `test/search-job-ledger.test.mjs`, `test/migrations.test.mjs`, `test/precommercial.test.mjs` |
| XSS d'un nom hostile | PASS | `test/xss-render.test.mjs` |
| Stripe fictif : prix imposé refusé, un seul accès, signature, remboursement | PASS | `test/stripe-test-checkout.test.mjs`, `test/stripe-test-ledger.test.mjs`, `test/stripe-test-sdk-adapter.test.mjs` |
| Géocodeur : sans admin rien ne part, la clé n'est pas renvoyée | PASS | `test/search-geocode.test.mjs` |

## Lectures distantes, sans débit

| Scénario | Résultat | Preuve |
| --- | --- | --- |
| Prévisualisation sert `c2a369a`, six villes, `search_job_places` | PASS | `GET /build.json`, `GET /app.js`, `GET /auth.js` |
| `search-geocode` sans session | PASS pour le refus | HTTP 401, corps sans secret ni `configured` |
| Clé OpenCage réellement posée | BLOCKED | Non lue |
| Recherche connectée jusqu'à un nom affiché | BLOCKED | 0 job en base, aucun débit autorisé |
| Restauration | BLOCKED | Chiffrement du support non prouvé |
| Production Supabase | BLOCKED | Non lue |
