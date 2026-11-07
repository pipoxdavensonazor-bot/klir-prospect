# Plan de correction de la recherche KlirProspect

Ce document fixe le contrat du lot A et le backlog des lots B à H. Il ne décrit pas un moteur mondial livré. La couverture réellement exécutable reste celle du code : six villes OpenStreetMap côté navigateur, et trois cercles Overture seulement sur la prévisualisation accompagnée.

Revue de `main` au commit `207f62d133a8ef75d684a7a79dae70cb36362630`. Aucune pull request n’était ouverte au moment de ce lot. Aucune migration n’est appliquée, aucun compte n’est créé, aucun service n’est acheté, et cette branche ne doit pas être fusionnée ni déployée sans une décision séparée.

## Constats revérifiés

| Constat de l’audit | Vérification sur `207f62d` |
| --- | --- |
| Six villes dans `src/data.js` | Confirmé : Montréal, Laval, Québec, Toronto, Paris, Lyon. Une septième entrée `default` recopait Montréal et servait de repli. |
| `engine.js` envoie un lieu inconnu vers Montréal | Confirmé. `parseQuery` partait de `cityKey="default"` et `normalizeSearchParams` y renvoyait toute clé inconnue. `CITIES.default` avait les coordonnées de Montréal. |
| Rayon 1,5 km / 2,2 km et emprise de l’île | Confirmé dans `src/sources.js` : 1 500 m pour « tous secteurs », 2 200 m sinon, rectangle `45.4102,-73.9744,45.7058,-73.4742` seulement si la ville repliée est Montréal. Laval ne reçoit pas cette emprise. |
| OpenStreetMap exécuté dans le navigateur | Confirmé. `src/sources.js` appelle Overpass par `fetch` depuis la page. Le Worker statique ne proxifie pas ces appels. Le commentaire du fichier le dit déjà. |
| Quatre serveurs Overpass, dont le secours de la PR 33 | Confirmé : `overpass-api.de`, `lz4.overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee`. Délai de requête 18 s, timeout Overpass 15 s, plafond Retry-After 30 s. |
| Overture limité au pilote | Confirmé. La prévisualisation accompagnée ne couvre que les restaurants et cafés dans trois cercles de 2,2 km (Montréal, Laval, Québec). Ce n’est pas le parcours public. |
| Nominatim | Présent seulement pour `KlirSources.osm.lookup`, utilisé lors d’un enrichissement d’adresse déjà collectée. Il n’y a pas d’autocomplétion de recherche. Ce lot n’ajoute aucun appel Nominatim. L’usage public de Nominatim pour une autocomplétion reste interdit. |
| Données synthétiques | `genProspects` existe encore pour des tests de forme. `src/app.js` et `src/sources.js` ne l’appellent pas. Une panne ne complète pas les fiches. |
| Crédits | Une collecte complète avec fiches confirme la réservation. Vide, partiel et erreur la libèrent. Ce lot ajoute le refus avant toute réservation. |
| Rôle admin | `supabase/migrations/20261105014500_admin_role.sql` sépare `private.admins` et `public.is_admin()`. Ce lot ne modifie ni cette migration, ni les grants, ni les politiques RLS. |

## Lot A — livré ici

Une recherche dont le lieu n’est pas pris en charge n’interroge jamais une autre ville. Montréal n’est plus le substitut silencieux.

Le lieu est décidé localement, sans géocodeur réseau :

| État | Sens | Effet |
| --- | --- | --- |
| `supported` | Une des six villes, avec ou sans accent, en français ou en anglais | La recherche peut partir. Le récapitulatif montre la ville, la province ou la région, le pays, le centre et le rayon ou l’emprise. |
| `absent` | La phrase ne nomme aucun lieu | La ville choisie dans la liste est utilisée, et elle est affichée avant le lancement. `default` n’est plus une ville. |
| Contradiction | Le texte nomme une ville prise en charge et la liste ou la relance en nomme une autre | Aucune recherche. Les deux lieux sont proposés. Seule une confirmation explicite de l’un d’eux part. Un troisième lieu n’est pas accepté. |
| `not_found` | Un lieu est écrit mais inconnu du contrat (`北京`, `Blorpland`) | Aucune recherche, aucun crédit réservé. Le texte d’origine est conservé. |
| `unsupported` | Lieu reconnu hors périmètre : Tokyo, Tōkyō, 東京, São Paulo, Sao Paulo, Casablanca, الدار البيضاء, ou un homonyme confirmé comme non couvert | Aucune recherche, aucun crédit réservé. L’écriture Unicode d’origine est conservée. |
| `ambiguous` | Plusieurs villes du catalogue, ou Paris qualifié (Texas, TX, Ontario, et les autres homonymes listés) | Aucune recherche tant qu’un seul candidat pris en charge n’est pas confirmé. Confirmer Paris, Texas n’ouvre pas Paris en France ni Montréal. |
| `empty` | Périmètre pris en charge, réponse complète sans fiche | Réservation libérée, quota inchangé, aucune fiche inventée. |
| `partial` | Remarque Overpass ou collecte incomplète | Réservation libérée, même si des fiches déjà reçues sont montrées. |
| `failure` | 429, 502, délai dépassé, JSON 200 tronqué ou invalide | Réservation libérée, aucune fiche. |

Paris sans qualificatif reste Paris, Île-de-France, France, centre 48.8566, 2.3522. Le texte le dit et rappelle que les autres Paris ne sont pas recherchés. Ce n’est pas une résolution mondiale des homonymes : la liste locale est un garde-fou, pas une gazette mondiale.

Le rayon affiché reste 1,5 km pour tous les secteurs et 2,2 km pour un secteur. L’emprise de l’île ne s’applique qu’à Montréal. Le récapitulatif dit « Pas une couverture mondiale ».

Politique de crédits inchangée après le départ de la collecte : on ne débite que si la collecte est complète et contient des fiches. Un refus de validation (`unsupported`, `ambiguous` sans confirmation, `not_found`, clé `default`) n’appelle ni `reserveServerUsage` ni Overpass. Le radar sans ville prise en charge fait de même. Les essais 429, 502, délai et 200 tronqué réservent puis libèrent, sur des fournisseurs simulés. Aucun percentile de performance n’est annoncé : les délais ci-dessus sont des bornes de code, pas des mesures de charge.

Nominatim n’est pas branché sur la saisie. Le nombre d’appels fournisseur d’une recherche prise en charge ne change pas : au plus un essai par serveur Overpass déjà configuré.

## Validation et retour arrière du lot A

Contrôles automatiques : `npm run check` (syntaxe, `node --test`, build). Les tests de lieu sont dans `test/search-contract.test.mjs`. Les pannes fournisseur simulées sont aussi dans `test/osm-reliability.test.mjs`.

Contrôle manuel, sans compte et sans appel Overpass :

1. Ouvrir Nouvelle recherche.
2. Laisser la liste sur Montréal et écrire `10 restaurants à Tokyo`, `à São Paulo`, `à 東京` ou `à الدار البيضاء`. Le récapitulatif doit dire que le lieu n’est pas pris en charge, que la liste n’est pas interrogée, et que le prix réservé est 0.
3. Écrire `10 restaurants à Paris, Texas`. Deux choix apparaissent. Tant qu’on ne confirme pas Paris, Île-de-France, aucun appel ne part. Confirmer Paris, Texas doit rester un refus.
4. Écrire `10 restaurants à Paris`. Le récapitulatif doit nommer Île-de-France et le centre 48.8566, 2.3522.
5. Effacer le lieu et choisir Laval dans la liste. Le récapitulatif doit montrer Laval, pas Montréal.
6. Réécrire `à Montréal` tout en laissant Laval dans la liste. Le récapitulatif doit demander un choix et ne doit pas lancer Laval ni Montréal tant que l’un des deux n’est pas confirmé.
6. Le guide et l’offre doivent continuer à dire que ce n’est pas une couverture mondiale.

Retour arrière : revenir au commit précédent de `main`. Aucune migration à annuler. Les recherches déjà enregistrées avec `cityKey: "default"` ne seront plus relancées vers Montréal ; il faudra choisir une des six villes. Les recherches enregistrées avec une vraie clé (`montréal`, `laval`, etc.) se relancent comme avant.

## Backlog

Les lots suivants sont ordonnés par dépendance. Un lot ne devient pas « fait » parce que son critère est écrit ici. Achat, licence fournisseur, application des migrations sur Test ou Prod, fusion et déploiement restent des décisions séparées. Aucun de ces lots n’est requis pour le correctif P0 déjà livré.

### B — API authentifiée et jobs durables

Priorité suivante. Dépend du contrat de lieu du lot A, pas d’un nouvel achat.

- Recherche authentifiée, hors du navigateur. Le Worker statique ne doit plus être le client Overpass.
- Job persistant : file, reprise, annulation, progression, tentatives bornées, circuit breaker.
- Les états du lot A (`supported`, `not_found`, `unsupported`, `ambiguous`, `empty`, `partial`, `failure`) restent ceux du job. Un lieu refusé ne crée pas de job.
- Délais bornés côté serveur, identifiants de corrélation, journal sans coordonnées personnelles.
- Critère d’acceptation : un 429, un 502, un délai et une réponse tronquée sont rejoués ou arrêtés selon la politique, sans doubler une collecte déjà complète, et l’UI montre l’état réel. Aucune promesse de débit.

Frontière de PR proposée : une PR B ne contient que le contrat de job, la persistance et les tests de cycle de vie avec un fournisseur simulé. Elle ne déplace pas encore le règlement des crédits (lot C) et n’ingère pas Overture (lot E).

### C — Grand livre, réservation et règlement côté serveur

Dépend de B pour l’identité du job. Le registre actuel (`20261011221500_credit_ledger.sql`, quota réservé) reste la base. Ne pas le réécrire.

- Réserver au début du job, confirmer seulement si l’état est `supported` puis collecte complète avec fiches, libérer pour `empty`, `partial` et `failure`.
- Idempotence par reçu de job. Reprise et double clic ne débitent pas deux fois.
- RLS inchangée dans son principe : le navigateur ne met pas à jour le solde directement. `private.admins` et `public.is_admin()` restent distincts. Migration additive, essayée d’abord sur une base locale ou de test, jamais appliquée à Test/Prod dans la PR.
- Critère d’acceptation : les tests de grand livre couvrent rejet de validation (zéro réservation), succès, vide, partiel, panne, reprise du même reçu. Aucun secret dans le client.

Frontière de PR proposée : PR C après B, ou empilée sur B. Elle ne change pas le géocodage ni le catalogue.

### D — Géocodage contractuel

Dépend de A pour les états, et de B si l’appel sort du navigateur. Pas de Nominatim public. Pas d’autocomplétion tant qu’un fournisseur sous licence n’est pas choisi.

- Identifiants de lieu, pays ISO, noms Unicode, hiérarchie administrative, homonymes explicites.
- Une réponse ambiguë reste `ambiguous`. Une réponse hors taxonomie supportée reste `unsupported`. Aucun défaut géographique.
- Critère d’acceptation : Paris (France, Texas, Ontario), Tokyo, São Paulo et Casablanca passent par le contrat, avec les écritures d’origine. Zéro appel si la validation échoue.

Décision séparée avant tout branchement : fournisseur, licence, quota, attribution.

### E — Ingestion Overture

Dépend de D pour le lieu et de C pour ne pas facturer une ingestion. Le pilote actuel reste trois villes, release figée, prévisualisation seulement.

- Partitions et instantanés sous licence, provenance conservée, pas de chargement du monde dans le navigateur.
- Critère d’acceptation : une release identifiée, un périmètre déclaré, une restauration testée, aucun élargissement silencieux aux six villes OSM ni au monde.

Décision séparée : droit de redistribution, volume, coût de stockage.

### F — Qualité, normalisation, provenance, dédoublonnage

Dépend de E pour de nouvelles sources, mais les règles OSM actuelles restent valables.

- Champ publié ou vide. Provenance par champ. Les homonymes d’entreprises restent distincts tant qu’un téléphone, un courriel, un domaine ou une adresse concordent, comme aujourd’hui.
- Critère d’acceptation : aucun champ inventé, Unicode conservé à l’export CSV, contradictions visibles.

### G — Contacts sous licence et opt-out

Hors de ce lot. Pas d’extraction LinkedIn. Pas d’API de contacts payante sans accord écrit et licence compatible avec la revente ou l’usage prévu.

- Critère d’acceptation : source, licence, date, et suppression ou opt-out testés avant toute exposition. Sinon le champ reste vide.

### H — Charge, marchés, retour arrière

Dépend de B, C et E. Ne pas publier de p95 tant que la charge n’a pas été exécutée et archivée.

- Marchés explicitement ouverts, drapeaux serveur, plan de retour arrière par release de données.
- Critère d’acceptation : un marché désactivé n’est pas interrogé ; une release peut être retirée sans effacer les notes CRM ; les mesures publiées correspondent à une exécution nommée.

## Hors contrat

- Ne pas déclarer la recherche mondiale terminée.
- Ne pas activer de ville absente des six, ni un quatrième cercle Overture, par un simple texte d’interface.
- Ne pas scraper LinkedIn ni acheter un flux de contacts pour « débloquer » le lot A.
- Ne pas appliquer les migrations admin ou ledger sur Test ou Prod depuis cette branche.
