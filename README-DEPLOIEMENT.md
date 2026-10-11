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

La CI GitHub valide et archive le build, sans étape de déploiement. Le Worker Cloudflare `klir-prospect` est publié par Workers Builds, qui ne construit que `main` puis exécute `npx wrangler deploy`. Une pull request vers une autre branche ne change pas le site public.

`dist/build.json` indique le commit, l'environnement et la date de compilation. La page `#/version` les affiche.

Retour arrière : redéployer le commit `main` précédent connu, puis comparer les empreintes de `sources.js`, `engine.js` et `app.js` servis à ce commit. Arrêter les recherches payantes tant que les empreintes divergent.

Toute publication en production reste une action séparée et explicitement approuvée. Les crédits sont encore tenus dans la session du navigateur ; ce n'est pas un encaissement.
