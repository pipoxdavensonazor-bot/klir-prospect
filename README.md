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

Réglage manquant : un projet Supabase **vide et dédié** à KlirProspect, puis les deux variables publiques du build.

Le seul projet accessible est `KlirlienCORE_database-68347165` (`bhyhcbfmkdpmqivnqwsb`), dans l’organisation Klirline Inc. Il contient déjà `public.profiles` et le schéma métier Klirline. Soixante-deux tables de ce projet, dont des tables de données, n’ont pas la RLS activée. Aucune migration, fonction ou configuration n’y a été appliquée : ce n’est pas la cible de KlirProspect, et créer un autre projet demanderait une confirmation de coût.

Quand un projet vide est désigné :

```bash
npx supabase link --project-ref PROJECT_REF
npx supabase db push --dry-run
npx supabase functions deploy delete-account
```

Ajouter ensuite l’origine exacte du site (`https://hôte/` et `https://hôte`) dans les URL de redirection Auth, et `ALLOWED_ORIGIN` comme secret de fonction. Ne jamais exposer `SUPABASE_SERVICE_ROLE_KEY` au build client.

Voir [SECURITY.md](SECURITY.md) pour le modèle de sécurité et les limites résiduelles.
