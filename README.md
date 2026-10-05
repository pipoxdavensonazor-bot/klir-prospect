# Klir Prospect

Client statique de démonstration restauré depuis la dernière archive source vérifiée (`(3)` et `(4)` ont le même SHA-256).

## Développement

Prérequis : Node.js 22.

```bash
npm ci
npm run check
```

Le build reproductible écrit uniquement les fichiers nécessaires dans `dist/`. Cloudflare sert ce répertoire via `wrangler.toml`; la CI ne déploie rien.

## Limites de sécurité

Cette version est volontairement limitée à une session de démonstration dans `sessionStorage`. L’authentification, les rôles, la synchronisation cloud, la récupération de compte, les clés API et le mode LIVE sont désactivés jusqu’à disponibilité d’un backend de confiance. Voir [SECURITY.md](SECURITY.md).
