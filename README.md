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

## Liaison distante

Le seul projet Supabase accessible est `KlirlienCORE_database-68347165` (`bhyhcbfmkdpmqivnqwsb`). Ce n’est pas un projet KlirProspect identifiable, et créer un projet peut être facturé. Aucune migration, fonction, configuration ou projet distant n’a donc été créé ou modifié.

Réglage manquant : lier un projet Supabase dédié à KlirProspect, puis fournir au build `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY`, et le secret de fonction `ALLOWED_ORIGIN` (origine exacte du site). Copier aussi les modèles `supabase/templates/` dans les e-mails Auth du projet. Ne jamais exposer `SUPABASE_SERVICE_ROLE_KEY` au build client.

```bash
npx supabase link --project-ref PROJECT_REF
npx supabase db push --dry-run
npx supabase functions deploy delete-account
```

Voir [SECURITY.md](SECURITY.md) pour le modèle de sécurité et les limites résiduelles.
