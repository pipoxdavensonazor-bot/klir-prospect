# Lot C — jobs et grand livre, non activé

Cette branche est empilée sur le lot B (`cursor/search-jobs-lot-b-2f07`). Elle ne fusionne rien, n’applique aucune migration sur Test ou Prod, et ne passe pas `jobs_enabled` à `true`.

## Statut de B, rappelé

B est un socle simulé plus des contrats injectables (`auth.getUser`, port SQL, consommateur). Ce n’est pas une file durable opérationnelle. C ajoute le lien transactionnel avec le grand livre existant. La route HTTP reste fermée. Aucun worker n’est lancé.

## Ce que C fait

Dans une seule transaction SQL, `public.enqueue_search_job` calcule le montant (`5 + ceil(quantité / 10)`, quantité 10 à 40) et appelle `public.reserve_usage`. Le reçu est dérivé du compte et de la clé. Une seconde demande avec la même clé ne réserve pas une deuxième fois.

Le client peut annuler son propre job : la réservation est alors libérée. Il ne peut pas marquer le job réussi, ni appeler `public.settle_usage` sur le reçu du job (`reglement_serveur_requis`). `private.record_search_collection` et `private.reconcile_search_job` ne sont accordées à personne : seul le rôle du serveur les exécute.

`reconcile_search_job` est idempotent.

| Constat enregistré | Règlement |
| --- | --- |
| `complete` avec au moins une fiche | Le débit déjà réservé est confirmé et le quota augmente de 1. |
| `empty`, `partial`, `failed` | Le débit est rendu, le quota n’augmente pas. |
| Annulation client | Le débit est rendu. |
| `reserved_until` dépassé sans collecte | Libération, erreur `reservation_expired`. |
| Rejeu du même règlement | Aucun second débit, aucun solde négatif. |

L’ancien parcours, un reçu `debit_` ou `radar_` qui n’appartient pas à un job, continue d’utiliser `reserve_usage` et `settle_usage`.

## Revue des courses

`FOR UPDATE` sérialise le job. Les deux ordres sont testés, sur une session PGlite : ce n’est pas deux sockets concurrents.

- Collecte enregistrée avant l’expiration : le règlement suit la collecte, une seule fois.
- Expiration commitée d’abord : la collecte suivante est refusée (`job_clos`), pas de second mouvement.
- Annulation d’abord : même refus, solde rendu une seule fois.
- Le même constat rejoué après succès ne change rien. Un constat différent est refusé.
- L’expiration ne vise que `queued` sans collecte. Une collecte déjà écrite n’est pas annulée par la date.

`PUBLIC`, `anon` et `authenticated` n’ont pas `EXECUTE` sur les fonctions `private`, y compris un compte `is_admin()`. Le propriétaire de la migration (rôle serveur) les exécute. Aucun secret n’est dans le dépôt.

`createSearchJobLedger(query)` est la frontière que le serveur appellera. Le test branche `query` sur PGlite, donc sur les vraies fonctions et les vrais verrous, pas sur un solde en mémoire.

## Ce qui manque pour une recette Test

1. Décision d’appliquer, sur une base non productive, les migrations B puis C. Cette PR ne le fait pas.
2. Un rôle serveur (hors navigateur) autorisé à exécuter les fonctions `private`. Pas de clé dans ce dépôt.
3. Brancher l’entrée HTTP, aujourd’hui forcée à `jobsEnabled: false`, sur `createGetUserVerifier` et sur ce rôle. Ne pas le faire avant la recette.
4. Un processus qui reprend les jobs ouverts, appelle l’adaptateur simulé, enregistre la collecte, puis réconcilie. Il n’est pas démarré.
5. Laisser `jobs_enabled` à `false` jusqu’à une décision d’activation séparée. L’allumage n’est pas dans la migration.

Ce lot ne rend pas la recherche mondiale, ni le produit, prêt pour la production.

La reprise exécutable, le rôle d’exploitation distinct du propriétaire des migrations, et l’essai PostgreSQL à deux connexions sont dans `docs/lot-runtime-local.md`. Cette page-ci ne les déclarait pas faites.
