# Protection de la branche main : CI obligatoire avant fusion (à appliquer par Philippe)

État lu le 14 nov. 2026 (API GitHub `GET /branches/main`) : `protection.enabled = false`, aucun contrôle requis.
`main` se déploie automatiquement en production (Cloudflare Workers) : une fusion sans CI verte part en Prod.

## Réglages proposés (Settings → Rules → Rulesets → New branch ruleset)

| Réglage | Valeur |
|---|---|
| Nom | `main protégée` |
| Enforcement | Active |
| Cible | Default branch (`main`) |
| Restrict deletions | oui |
| Block force pushes | oui |
| Require a pull request before merging | oui, 0 approbation requise (un seul mainteneur), « Dismiss stale approvals » non |
| Require status checks to pass | oui, « Require branches to be up to date » oui |
| Contrôle requis | `validate` (job du workflow `CI`, GitHub Actions) |
| Bypass list | aucun (ou Philippe seul, pour une urgence documentée) |

Équivalent API (classic branch protection) :

```
PUT /repos/pipoxdavensonazor-bot/klir-prospect/branches/main/protection
{
  "required_status_checks": { "strict": true, "checks": [ { "context": "validate", "app_id": 15368 } ] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
```

Effet : les agents et Philippe passent toujours par une PR ; la fusion est bloquée tant que `npm run check`
(359 tests, build, contenu déployable) n'est pas vert.
