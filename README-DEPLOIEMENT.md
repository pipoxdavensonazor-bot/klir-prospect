# Déploiement

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

`KLIR_PILOT_EMAILS` est une liste d'adresses séparées par des virgules, inscrite dans `dist/config.js` au moment de la compilation. Sans cette variable, la liste est vide et l'application refuse toute recherche OpenStreetMap, y compris la démonstration. Cette barrière empêche le bouton anonyme d'interroger OpenStreetMap. Elle ne remplace pas un contrôle serveur : le navigateur connaît encore l'adresse du service. Les crédits affichés dans la session ne constituent pas un paiement.

`dist/build.json` indique le commit, l'environnement et la date de compilation. La page `#/version` les affiche.

Retour arrière : redéployer le commit `main` précédent connu, puis comparer les empreintes de `sources.js`, `engine.js` et `app.js` servis à ce commit. Arrêter les recherches payantes tant que les empreintes divergent.

Toute publication en production reste une action séparée et explicitement approuvée. Les crédits sont encore tenus dans la session du navigateur ; ce n'est pas un encaissement.
