# Déploiement

## État vérifié le 22 octobre 2026

La CI GitHub de la revue #21 définit `KLIR_ENV=preview` dès l'installation ; `npm ci` et `npm run check` réussissent sans configuration de production. Le commit `1678c43` passe 84 tests, aucun ignoré. La prévisualisation Cloudflare est `https://codex-pilot-readiness.klirprospect.klirline.ca/` ; vérifier son commit sur `#/version` après chaque build.

La base de test documentée `pwakjxjjxswdjsapsbxn` n'est pas accessible depuis le compte Supabase connecté. Aucun état distant de migrations ou de données n'est validé ici. La migration de quota `20261022130000_enforce_reserved_search_quota` est ajoutée et testée localement, mais n'est pas appliquée à distance. La recette avec deux comptes et trois recherches réelles reste bloquée. L'achat reste fermé.

Les notes ci-dessous proviennent des livraisons antérieures. Leurs mentions de migrations déjà appliquées ou de comptes absents doivent être revérifiées dans le projet distant avant toute décision de production.

## Procédure et notes opérationnelles

Ce dépôt ne doit jamais publier sa racine. La seule sortie déployable est `dist/`.

```bash
npm ci
npm run check
```

Configuration Cloudflare Pages :

- commande de build : `npm run build`
- répertoire de sortie : `dist`
- version Node : 22

`wrangler.toml` pointe également sur `dist`. Les en-têtes de sécurité sont fournis par `dist/_headers`.

La CI GitHub valide et archive le build, sans étape de déploiement. Workers Builds, sur une branche autre que la production, exécute `npx wrangler preview`. Cette commande exige le bloc `previews` de `wrangler.toml`. Le build `46aa8ce` a créé `dist`, puis s'est arrêté uniquement parce que ce bloc manquait. La publication de production reste `npx wrangler deploy` sur `main`, après une approbation séparée. Une prévisualisation ne remplace pas le site public.

L'accès au pilote de test se fait par Cloudflare Access sur les adresses de prévisualisation, pas par une liste d'adresses dans le navigateur. Au commit `582efea`, un navigateur qui ouvre `https://cursor-prospect-main-review-c23c.klirprospect.klirline.ca/` arrive sur la page « Log in to klirprospect » de `office-klirline.cloudflareaccess.com`, avec le bouton Cloudflare. Le même parcours sur `https://klirprospect.klirline.ca/` ouvre le site public, sans cette page. Ne pas activer Access sur ce domaine de production, ni choisir la destination API `worker` ou `all_workers`, qui couvrirait aussi la production. La destination de prévisualisation seule est `preview_worker`. Documentation : [prévisualisations et domaines](https://developers.cloudflare.com/workers/previews/custom-domains/) et [Cloudflare Access pour les Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

Un client automatisé peut encore recevoir `403` et `cf-mitigated: challenge` avant cette page, y compris sur le nom d'hôte public. Ce défi n'est pas la page Access. La démonstration et une session sans compte n'appellent pas OpenStreetMap ; ce garde-fou d'interface n'est pas un contrôle de sécurité. Une recherche ou un radar lancé depuis un compte appelle `reserve_usage` avant OpenStreetMap, puis `settle_usage` : `complete` seulement pour une collecte complète avec fiches, `release` sinon. Le solde et le quota mensuel lus à la connexion viennent de `read_credit_account`. Ce registre n'est pas un paiement. Aucun prestataire, aucune taxe et aucun reçu fiscal ne sont branchés. Le canal de support et le responsable de la protection des renseignements personnels restent à publier par Klirline avant d'encaisser.

Le projet de test `KlirProspect Test` (`pwakjxjjxswdjsapsbxn`, `ca-central-1`) est distinct de la production `cbklwmjudobqwbkbxqgy`. Il reçoit les migrations `profiles`, `workspace_states` et `credit_ledger`, avec la RLS, et la fonction `delete-account`. Il ne contient aucun compte. La prévisualisation ne doit pas utiliser le projet de production. Pour la brancher, poser `SUPABASE_URL=https://pwakjxjjxswdjsapsbxn.supabase.co` et `SUPABASE_PUBLISHABLE_KEY` uniquement sur le déclencheur de prévisualisation de Workers Builds, puis ajouter l'origine exacte de la prévisualisation aux URL de redirection Auth et au secret `ALLOWED_ORIGIN`. Ces réglages n'ont pas été écrits d'ici : ce shell n'a pas de jeton Cloudflare capable de modifier les builds. Sans session Cloudflare Access d'un membre du compte, la page `#/version` de la prévisualisation ne peut pas être lue.

`KLIR_ENV` nomme l'environnement écrit dans `dist/build.json`. Les valeurs reconnues sont `production`, `preview`, `ci` et `local`. Cloudflare injecte `WORKERS_CI` pour les builds de production et de prévisualisation ; cette variable ne signifie donc pas production. Si `KLIR_ENV` est absent, `WORKERS_CI_BRANCH` tranche : `main` donne `production`, toute autre branche donne `preview`, et une branche absente donne `inconnu`. Une valeur `KLIR_ENV=production` définie une seule fois pour tous les builds étiquetterait aussi les prévisualisations. Il faut une valeur distincte par build, dans Worker, Settings, Environment variables, lorsque le tableau de bord permet de les séparer. Documentation : [configuration des builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

Une prévisualisation ne copie pas `https://klirprospect.klirline.ca/config.js`. Si `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY` manquent, ou s'ils désignent le projet de production `cbklwmjudobqwbkbxqgy`, la prévisualisation est publiée sans base. Les essais ne peuvent alors pas écrire dans les données réelles. Une base de test séparée n'est branchée que lorsque ces deux variables désignent un autre projet `*.supabase.co`. Le build de production peut encore reprendre la configuration publique si ses variables sont absentes.

`dist/build.json` indique le commit, l'environnement, l'origine de la base et la date de compilation. La page `#/version` les affiche, sans clé. Le journal de build contient une ligne `build-identity environment=… supabase=…`, sans URL ni clé.

Retour arrière : redéployer le commit `main` précédent connu, puis comparer les empreintes de `sources.js`, `engine.js` et `app.js` servis à ce commit. Arrêter les recherches payantes tant que les empreintes divergent.

Toute publication en production reste une action séparée et explicitement approuvée. La migration `20261011221500_credit_ledger` doit être appliquée sur le projet Supabase servi par ce build avant de publier le client qui appelle ces fonctions. Elle est appliquée sur `KlirProspect Test` et sur `KlirProspect`. Sans elle, une recherche de compte s'arrête avant OpenStreetMap. L'achat de crédits reste fermé.
