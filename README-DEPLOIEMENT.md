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

La CI valide et archive le build, sans étape de déploiement. Toute publication en production doit rester une action séparée et explicitement approuvée après mise en place du backend décrit dans `SECURITY.md`.
