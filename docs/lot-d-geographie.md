# Lot D — géographie utile, géocodage mondial non branché

Empilé sur le lot C. Aucune fusion, aucun déploiement, `jobs_enabled` inchangé. Ce lot ne simule pas une couverture mondiale.

## Ce qui change vraiment

Les six villes déjà servies portent un code pays ISO (`CA` ou `FR`), une localité et une région. Leurs centres passent le contrôle de latitude, de longitude et de rayon (strictement positif, au plus 2 200 m). L’emprise de l’île de Montréal est un anneau fermé valide. Une latitude hors [-90, 90], une longitude hors [-180, 180], un rayon nul, négatif ou trop grand, ou un polygone ouvert est rejeté par `validateSearchScope`. Rien de tout cela n’élargit la recherche.

`Paris, France` reste Paris. `Paris, États-Unis` n’est pas choisi à la place. `province de Québec`, `en France` et `au Canada` ne lancent pas le cercle d’une ville. Un chiffre d’affaires ou un effectif exact demandé reste inconnu : aucune taille n’est inventée.

La taxonomie des secteurs reste celle de `KlirData.INDUSTRIES`, version `sectors-2026-11`. Aucun synonyme nouveau n’a été ajouté pour faire croire à d’autres secteurs.

## Géocodeur

`createGeocoder` ne contacte aucun réseau. Sans `enabled` et `licenseAccepted`, il répond `disabled` et n’appelle pas le fournisseur, même injecté. Avec un mock et une licence explicitement acceptée dans le test, une réponse à deux lieux reste ambiguë et la seconde lecture vient du cache. `readGeocoderConfig` peut noter un nom de fournisseur et reste désactivé. Une clé présente dans l’environnement n’est pas recopiée.

Le parcours de recherche n’appelle pas ce module. Nominatim public n’est pas utilisé pour l’autocomplétion. Aucune liste de villes n’a été allongée.

## Décisions nécessaires avant une recette Test du géocodage

1. Choisir un fournisseur et une licence écrite qui autorise l’usage prévu, le cache et la conservation des résultats.
2. Fixer le contrat : identifiants stables, pays ISO, région, localité, centre, périmètre, et réponse ambiguë non tranchée par le logiciel.
3. Décider où vit le cache serveur, sa durée, et qui peut le lire. Pas dans le navigateur.
4. Seulement ensuite, un changement de code pourra passer `readGeocoderConfig` à `enabled: true`. Ce dépôt ne le fait pas.

Tant que ces décisions manquent, le bénéfice livré est le contrôle des six villes et le refus des périmètres trop larges, pas un moteur mondial.
