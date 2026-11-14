# Retrait de la fonction héritée `prospects` (lecture « centre »)

## Dépendances vérifiées le 14 nov. 2026 (lecture seule en Prod)

| Lieu | Résultat |
|---|---|
| Dépôt `klir-prospect` (src, supabase/functions, tools, tests, workflows) | aucun appel à `functions/v1/prospects`, aucun `invoke("prospects")`, aucune lecture de `centre_prospect_reader` (test automatique `test/prospects-legacy-retired.test.mjs`) |
| CRM principal (application, `search-jobs`, `search-job-runner`, `search-geocode`, `email-finder`, `delete-account`, `stripe-webhook`) | n'utilise ni la fonction ni la table |
| Klirline Centre (`klirline-control-center`, Worker Cloudflare) | **seul appelant** : `src/prospect-feed.js` (`GET` + secret `PROSPECTS_READ_TOKEN`, cache 60 s, délai 5 s). Toute réponse non 200 donne `status: "unavailable"` et une liste vide : le centre continue de fonctionner |
| Autres Workers Klirline (`klirline`, `klir-ia`, `klirbuild`, `klirline-secure`) | aucune référence |
| Tâches `pg_cron` Prod | `klir-search-scheduler`, `klir-expire-credit-lots` : aucune référence |
| Fonctions SQL / vues Prod | aucune référence à `centre_prospect_reader` |
| Droits sur la table (Prod) | `postgres`, `service_role` seulement ; RLS active, aucune politique ; 1 ligne (hachage du jeton) |
| Journaux Prod (24 h) | 1 appel : `GET 200` le 13 nov. 2026 à 23 h 19 (heure de Toronto) |

## Correctif (cette branche)

Migration `20261115020000_retrait_lecteur_prospects_herite.sql` : retire les droits puis supprime
`public.centre_prospect_reader` (idempotente, sans effet là où la table n'existe pas).
Sans la table, la fonction répond `503` et ne lit plus aucun `workspace_states`.

## Essai sur Test (14 nov. 2026, heure de Toronto)

1. 12 h 18 : table reproduite (même forme qu'en Prod, jeton jetable) + copie exacte de la fonction Prod v4 déployée sur Test.
   `GET` avec le jeton → **200, 100 prospects** lus dans plusieurs espaces (le défaut est reproduit) ; mauvais jeton → 401.
2. 12 h 19 : migration appliquée sur Test → `GET` avec le jeton → **503 « Lecture indisponible. »** ; table absente ;
   `workspace_states`, `search_jobs`, RLS `authenticated` et les 2 tâches cron intacts.
3. Code du centre exécuté contre Test : `{"status":"unavailable","prospects":[]}` (pas de panne).
4. Copie Test remplacée par un bouchon `410 Service retiré.` (aucune lecture).

## Étapes Prod (chacune demande une confirmation distincte)

1. **Migration** : appliquer `20261115020000_retrait_lecteur_prospects_herite.sql` (désactive immédiatement la lecture).
2. **Fonction** : supprimer `prospects` (Dashboard → Edge Functions → prospects → Delete), ou à défaut la remplacer
   par le bouchon 410 ci-dessous.
3. **Centre** : retirer le secret `PROSPECTS_READ_TOKEN` du Worker `klirline-control-center`
   (`wrangler secret delete PROSPECTS_READ_TOKEN`) ; le centre affichera « non configuré ».
4. Vérifier : `GET …/functions/v1/prospects` → 404 (supprimée) ou 410 (bouchon) ; journaux sans `200`.

Bouchon 410 :

```ts
Deno.serve(() => new Response(JSON.stringify({ error: "Service retiré." }), {
  status: 410,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
}));
```

Retour arrière : recréer la table et un nouveau jeton (aucune donnée client n'y est stockée) ; à éviter tant que la
politique de confidentialité ne couvre pas ce partage.
