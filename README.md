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

La documentation historique identifie `KlirProspect Test` (`pwakjxjjxswdjsapsbxn`) et la production `cbklwmjudobqwbkbxqgy`. Le 22 octobre 2026, le compte Supabase connecté ne voit aucun de ces deux projets : leur accès, leurs migrations, leur contenu et leur coût ne sont donc pas confirmés par cette livraison. Ne pas réutiliser les autres projets KlirlineCore pour les essais. Une connexion au compte propriétaire ou un nouveau projet de test distinct est nécessaire.

La branche `codex/pilot-readiness` est publiée sur `https://codex-pilot-readiness.klirprospect.klirline.ca/`. Le build reste volontairement sans base. Les deux variables publiques du build, `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY`, doivent être posées uniquement sur le déclencheur de prévisualisation de Workers Builds pour la base de test. Ajouter l'origine exacte aux redirections Auth et au secret de la fonction `delete-account`. Ne jamais exposer `SUPABASE_SERVICE_ROLE_KEY` au build client. Appliquer et vérifier toutes les migrations sur la base de test avant la recette réelle, dont `20261022130000_enforce_reserved_search_quota`.

Voir [SECURITY.md](SECURITY.md) pour le modèle de sécurité et les limites résiduelles.
