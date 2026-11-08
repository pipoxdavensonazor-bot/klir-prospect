# Décision commerciale

Date : 8 novembre 2026.

**Recommandation : NO-GO. Le verdict BLOCKED est maintenu.**

Le produit n'est pas commercialisable. Cette supervision n'autorise ni la fusion dans `main`, ni une publication, ni un paiement.

| Critère obligatoire | Résultat | Pourquoi |
| --- | --- | --- |
| Opérations sensibles contrôlées côté serveur | PASS local, FAIL commercial | Le worker et le SQL réservent, règlent et libèrent hors du navigateur. Le site public de `main` (`4f4f076`) n'a pas cette pile. |
| Quotas et crédits cohérents | PASS local, BLOCKED distant | Les tests fictifs débitent une collecte complète une seule fois et libèrent vide, partiel et échec. Aucun débit réel n'a été relu. `jobs_enabled` est vrai sur Test avec 0 job. |
| Restauration sécurisée démontrée | BLOCKED | Chiffrement du disque, du swap et du support non prouvé. Aucune restauration lancée. |
| Comptes isolés | PASS local | Deux comptes PGlite et deux connexions PostgreSQL. Non rejoué sur le projet distant. |
| Parcours essentiels | PASS pour l'écran servi, BLOCKED pour une recherche complète | La prévisualisation sert `c2a369a`, les six villes et `search_job_places`. Aucun nom n'a été ramené d'un job, parce qu'aucune recherche n'a été débitée. |
| Coûts et conditions approuvés | BLOCKED | Offre non approuvée. OpenCage non acheté. Paiements réels fermés. `stripeTestCheckout` est faux sur la prévisualisation. |
| CI et tests nécessaires | PASS local, CI GitHub historique FAIL | `npm test` : 210 PASS, 0 FAIL, 4 SKIP. Le run `42502277112` échouait avant le commit `6b8a554`. Cette CI n'a pas été relancée ici. |
| Autorisation explicite de commercialiser | Absente | La consigne maintient l'interdiction. |

## Ce qui a changé depuis le premier audit

Le cycle de sonde qui retournait `failed` avait pour cause un double de test, pas le moteur. Le correctif est sur `cursor/search-probe-cycle-2f07` et attend une revue. Il ne lève aucun critère commercial à lui seul.

## Arrêt

Aucun déploiement, aucune migration, aucune fusion. La prochaine action est une validation humaine des deux pull requests.
