# Fonction Edge héritée `prospects` (Prod) : constat et retrait proposé

Lu le 14 nov. 2026 (lecture seule) : `prospects` v4, ACTIVE, `verify_jwt = false`, absente du dépôt.

Comportement : `GET` avec `Authorization: Bearer <jeton>` ; le SHA-256 du jeton est comparé à
`public.centre_prospect_reader.token_sha256` (1 ligne, jeton configuré). Si le jeton correspond, la fonction lit avec la
clé **service** les `workspace_states` de **tous les comptes** (20 au maximum) et renvoie jusqu'à 100 prospects
(entreprise, secteur, score, action) issus des espaces non démo.

Journaux : 1 appel en 24 h (14 nov. 04 h 19 UTC = 13 nov. 23 h 19 Toronto), réponse 200.

Risque : dès qu'un client externe existe, ses prospects (données CRM) sortent vers le détenteur du jeton
(Klirline Centre), sans base dans la politique de confidentialité. Contraire au cloisonnement promis.

## Correctif prêt (Prod, à autoriser)

Option A (recommandée) : supprimer la fonction `prospects` (Dashboard → Edge Functions → prospects → Delete) puis
`delete from public.centre_prospect_reader;`.
Option B : la garder pour le seul compte admin : réécrire la requête avec `.eq('user_id', <id admin>)`, la versionner
dans le dépôt et la redéployer.

Vérification après correctif : `GET …/functions/v1/prospects` → 404 (A) ; aucune ligne dans `centre_prospect_reader`.
