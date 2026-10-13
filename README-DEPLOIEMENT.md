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

Workers Builds lance `npx wrangler preview` sur les branches autres que la production. Ce dépôt déclare un bloc `previews` vide : les assets restent au niveau racine. La commande de build du tableau est vide, donc Wrangler exécute `npm run build` avant l'envoi. L'URL de prévisualisation est publique tant qu'aucun contrôle d'accès Cloudflare n'est ajouté.

La CI valide et archive le build, sans étape de déploiement. Toute publication en production doit rester une action séparée et explicitement approuvée après mise en place du backend décrit dans `SECURITY.md`.
