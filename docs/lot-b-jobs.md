# Lot B — jobs de recherche, socle non activé

Cette branche dépend du lot A (PR 34, branche `cursor/search-contract-lot-a-2f07`). Elle n’ajoute pas le backend à cette PR. Elle ne fusionne rien, n’applique aucune migration sur Test ou Prod, ne provisionne aucun service payant et n’appelle aucun fournisseur.

## Ce qui est livré

- File en mémoire testée : idempotence par compte et clé, trois tentatives au plus, annulation avant ou pendant l’essai, progression bornée à 100, disjoncteur après trois pannes simulées, réouverture après 30 s de temps simulé. L’adaptateur est injecté. Il n’y a pas d’appel Overpass, Nominatim ou autre réseau.
- Migration additive `supabase/migrations/20261107190000_search_jobs.sql`, fichier seulement. `private.search_job_settings.jobs_enabled` vaut `false`. Un lieu qui n’est pas `supported` est refusé. La même clé renvoie le même job. Le plafond est de 6 créations par minute et par compte. `anon` n’a aucun droit. Un compte lit les siens. Il ne peut pas marquer un job réussi. `public.is_admin()` ne donne pas la lecture des jobs d’un autre compte. Aucune fonction de crédit n’est appelée.
- Contrôle HTTP `handleSearchJob` : JWT obligatoire, drapeau serveur, rejet du lieu non pris en charge, plafond, lecture et annulation limitées au propriétaire. L’entrée `supabase/functions/search-jobs/index.ts` fixe `jobsEnabled` à `false` et ne branche ni JWT réel ni base. `src/app.js` ne l’appelle pas.

## Statut honnête

Ce lot n’est pas une file durable opérationnelle. La reprise, l’annulation et le disjoncteur sont prouvés sur un adaptateur simulé et sur les fonctions SQL d’enqueue/cancel, testées dans PGlite. Aucun processus ne reprend les jobs. Aucun crédit n’est réservé ni réglé par un job. `jobs_enabled` reste `false`. L’entrée HTTP déployable refuse tout appel. Ce n’est pas une recette Test, ni une activation.

Les adaptateurs ajoutés ici sont des contrats injectables, pas un branchement :

- `createGetUserVerifier(getUser)` attend la forme `supabase.auth.getUser(jwt)`. Aucune clé n’est lue.
- `createSearchJobStore(query)` parle aux fonctions SQL déjà écrites. Le test PGlite fournit `query`. Aucun projet Supabase distant n’est contacté.
- `consumeSearchJob` rend un constat (`complete`, `empty`, `failed`, `cancelled`). Il ne marque pas un succès de crédit et n’écrit pas `succeeded` dans la base.

## Ce qui n’est pas activé

La voie v2 ne consomme pas de crédit et ne doit pas servir avant le lot C. Le worker qui reprendrait la file n’est pas déployé. Aucune variable secrète n’est ajoutée au client. Activer la fonction en renversant seulement le booléen du fichier, sans le règlement du lot C, ouvrirait une collecte hors grand livre : ne pas le faire.

## Dépendances encore absentes

1. Décision d’appliquer la migration sur une base non productive. Cette PR ne le fait pas. Test et Prod restent inchangés.
2. Lot C : réserver et régler le crédit dans la même transaction que le passage du job à `succeeded`, avec la même clé idempotente. Tant que ce lien n’existe pas, le drapeau reste `false`.
3. Brancher `createGetUserVerifier` sur un `auth.getUser` réel dans l’entrée Deno, et lire `private.search_job_settings`. Le contrat est testé par injection. L’entrée déployable renvoie toujours un drapeau éteint et un vérificateur null. Aucune clé n’est présente dans le dépôt.
4. Processus worker, distinct du navigateur, avec le rôle de service hors du client, le disjoncteur et l’adaptateur simulé puis, plus tard, un fournisseur sous licence. Aucun processus n’est lancé ici.
5. Aucun achat de file, base ou licence n’est requis pour les tests locaux. Un hébergement du worker et un droit fournisseur le seront avant toute activation.

## Essai local

`npm run check` exécute les tests Node et PGlite. Ils ne contactent pas Supabase distant.

Retour arrière : ne pas fusionner la branche. Si la migration avait été appliquée à la main, la retirer avant toute donnée de production ; elle n’a pas de débit de crédit à compenser.

## Frontière du lot C

La PR C peut s’appuyer sur cette branche. Elle ajoute le règlement serveur au moment où un job passe à `succeeded`, libère la réservation pour `failed`, `cancelled`, vide ou partiel, et refuse toujours un lieu non `supported`. Elle ne doit pas allumer `jobs_enabled` dans la migration. L’allumage reste une commande séparée, après essai du grand livre.
