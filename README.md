# Klir Prospect

Client statique avec mode démonstration et intégration progressive Supabase Auth/PostgreSQL.

## Développement

Prérequis : Node.js 22.

```bash
npm ci
npm run check
```

Le build reproductible écrit uniquement les fichiers nécessaires dans `dist/`. Cloudflare sert ce répertoire via `wrangler.toml`; la CI ne déploie rien.

## Configuration Supabase locale

1. Copier `.env.example` vers `.env.local` et renseigner uniquement l’URL et la clé **publishable**.
2. Démarrer Docker, puis `npx supabase start`.
3. Vérifier la base avec `npx supabase db reset`.
4. Construire avec les variables publiques :

```bash
set -a; . ./.env.local; set +a
npm run build
```

La configuration locale impose confirmation e-mail, mots de passe de 12 caractères, rotation des refresh tokens, session maximale de 24 h et inactivité maximale de 8 h.

## Variables

| Variable | Où | Rôle |
|---|---|---|
| `SUPABASE_URL` | build client, voir `.env.example` | URL publique du projet |
| `SUPABASE_PUBLISHABLE_KEY` | build client | clé publishable, seule clé autorisée dans `dist/config.js` |
| `ALLOWED_ORIGIN` | secret de la fonction `delete-account` | origine exacte autorisée à supprimer un compte |
| `SUPABASE_SERVICE_ROLE_KEY` | injectée dans la fonction, jamais dans le build | suppression Auth et révocation des sessions |

Les modèles locaux de confirmation et de récupération envoient un `token_hash`. L’application retire le jeton de l’URL et ne l’échange qu’au clic.

## Liaison distante

Le projet de test est `KlirProspect Test` (`pwakjxjjxswdjsapsbxn`), dans l’organisation Klirline INC, région `ca-central-1`. Son coût mensuel confirmé est 0. Les migrations de comptes et d’historique y sont appliquées, ainsi que la fonction `delete-account`. Il ne contient aucun compte. Le projet de production `cbklwmjudobqwbkbxqgy` ne doit pas servir à la prévisualisation.

La prévisualisation n’est pas encore branchée. Les deux variables publiques du build, `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY`, doivent être posées seulement sur le déclencheur de prévisualisation de Workers Builds. La clé se lit dans le tableau de bord du projet de test et ne doit pas être commitée. Ajouter ensuite l’origine exacte de la prévisualisation (`https://hôte/` et `https://hôte`) dans les URL de redirection Auth, et `ALLOWED_ORIGIN` comme secret de fonction. Ne jamais exposer `SUPABASE_SERVICE_ROLE_KEY` au build client.

Voir [SECURITY.md](SECURITY.md) pour le modèle de sécurité et les limites résiduelles.
