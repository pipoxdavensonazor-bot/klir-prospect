# Surveillance externe et alertes (proposition)

Constat (14 nov. 2026) : le workflow GitHub `Surveillance (toutes les 30 min)` ne s'est exécuté que 4 fois ;
les tâches planifiées GitHub ne sont pas garanties. Le site est derrière un défi anti-robot Cloudflare : une sonde
externe sur `klirprospect.klirline.ca` reçoit 403, ce qui ne prouve pas que l'application fonctionne.

## Sondes proposées (service gratuit au choix de Philippe : UptimeRobot, Better Stack ou Cloudflare Health Checks)

| Sonde | URL | Attendu | Fréquence |
|---|---|---|---|
| API recherche | `https://cbklwmjudobqwbkbxqgy.supabase.co/functions/v1/search-jobs/healthz` (en-têtes `apikey` + `Authorization: Bearer <clé publiable>`) | HTTP 200 | 5 min |
| Santé jobs/crédits | `POST https://cbklwmjudobqwbkbxqgy.supabase.co/rest/v1/rpc/klir_ops_health` (clé publiable) | 200, corps sans `"ok":false` | 15 min |
| Suppression de compte | `OPTIONS …/functions/v1/delete-account` avec `Origin: https://klirprospect.klirline.ca` | 204 | 30 min |
| Webhook Stripe | `GET …/functions/v1/stripe-webhook` | 405 (fonction vivante) | 30 min |
| Site | `https://klirprospect.klirline.ca/build.json` avec une règle Cloudflare « Skip » pour l'agent de la sonde, ou un jeton de service Cloudflare Access | 200 | 5 min |

Alerte : courriel à contact@klirline.ca (+ SMS si disponible). La clé publiable est publique par conception ; aucune
clé secrète dans une sonde.

À garder : le workflow GitHub (issue « Alerte surveillance ») comme second filet.
Stripe : activer dans le tableau de bord les courriels d'échec de webhook (Developers → Webhooks → endpoint KlirProspect).
