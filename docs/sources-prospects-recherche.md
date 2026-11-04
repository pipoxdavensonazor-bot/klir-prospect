# Sources gratuites pour KlirProspect

Recherche du 22 octobre 2026. Les offres sont susceptibles de changer. « Données gratuites » ne signifie pas hébergement, calcul, support ou disponibilité garantis. Aucune nouvelle source ci-dessous n’est encore intégrée ou mesurée sur le parcours KlirProspect.

## Sélection

| Source | Apport et accès | Gratuité et contraintes | Décision proposée |
|---|---|---|---|
| [Overture Places](https://docs.overturemaps.org/guides/places/) | Lieux et entreprises, adresses, catégories, sites, téléphones et parfois courriels. Téléchargements régionaux plutôt qu’API instantanée. | Données ouvertes ; licences selon le fournisseur. Qualité et complétude variables, doublons possibles. Indexation et stockage à prévoir. | Premier complément indépendant d’OSM à évaluer au Québec. |
| [Geoapify Places](https://apidocs.geoapify.com/docs/places/) | Recherche par catégorie et zone ; clé de projet nécessaire. | 3 000 crédits/jour ; 1 crédit par tranche de 20 lieux selon la documentation Places. [Usage commercial gratuit autorisé](https://www.geoapify.com/pricing/) dans les limites, avec attribution Geoapify et sources. | Bon candidat de continuité API ; mesurer le recouvrement avec OSM avant de compter un gain de couverture. |
| [Foursquare OS Places](https://opensource.foursquare.com/os-places/) | Jeu mondial de points d’intérêt à importer. Distinct de l’API commerciale Foursquare. | [Apache 2.0, licence et NOTICE à conserver](https://opensource.foursquare.com/places-notice-txt/). Traitement et hébergement nécessaires. | Deuxième jeu indépendant à comparer à Overture, qui contient déjà une contribution Foursquare. |
| [AllThePlaces](https://github.com/alltheplaces/alltheplaces) | Données de localisateurs de marques publiées périodiquement ; utile pour succursales et enseignes. | Données CC0 ; télécharger les résultats publiés, sans relancer tous les robots. Couverture dépendante des enseignes. | Complément ciblé, surtout réseaux de points de vente ; peu adapté comme unique source de petites entreprises. |
| [Wikidata](https://www.wikidata.org/wiki/Help:Data_access) | Identités, sites officiels et liens entre entités ; données CC0. | Service public soumis à des [limites](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual), dont concurrence et délais. Couverture non exhaustive des PME. | Enrichissement d’identité ciblé, pas moteur principal de prospection. |
| [Base ouverte d’entreprises de Statistique Canada](https://www150.statcan.gc.ca/n1/en/catalogue/21260003) | Noms, adresses et caractéristiques selon les fournisseurs. | Licence du gouvernement ouvert – Canada ; catalogue consulté montrant une édition 2023. Fraîcheur et couverture locales à mesurer. | Source auxiliaire pour comparaison, jamais preuve automatique d’activité actuelle. |
| [Overpass Private.coffee](https://overpass.private.coffee/) | Même base OpenStreetMap derrière une autre instance publique. | Opérateur annonçant accès gratuit, usage commercial et absence de garantie de service. Notre requête a dépassé 18 secondes. | Secours potentiel après validation ; n’ajoute pas une source indépendante. |
| [Foursquare Places API](https://foursquare.com/pricing/) | Recherche de lieux avec API hébergée. | Page tarifaire : 500 appels Pro gratuits, puis facturation ; les champs Premium ont un tarif distinct. La page produit annonce encore un autre seuil : retenir le tarif contractuel de la console, pas une promesse de gratuité illimitée. | Option secondaire, pas socle gratuit. Stockage/export à vérifier dans les conditions applicables. |

## Source québécoise écartée pour cette intégration commerciale

Le [Registre des entreprises sur Données Québec](https://www.donneesquebec.ca/recherche/dataset/registre-des-entreprises) affiche CC BY-NC-SA 4.0, avec exclusion de l’utilisation commerciale. Sa disponibilité publique ne suffit pas à autoriser son intégration dans un produit payant. Ne pas l’importer dans KlirProspect sans autorisation compatible.

## Combinaison recommandée — hypothèse à mesurer

1. Extraire un petit périmètre Overture autour de Montréal, Laval et Québec avec le [client officiel](https://docs.overturemaps.org/getting-data/overturemaps-py/). Fixer la version de données et conserver les licences par origine.
2. Indexer les données côté serveur et servir des recherches bornées. Comparer les trois mêmes secteurs et villes avec OSM. Ne pas télécharger le monde entier dans le navigateur.
3. Ajouter Geoapify comme adaptateur optionnel avec plafond quotidien strict, après création d’un compte par le propriétaire et acceptation des conditions applicables. Aucun abonnement ni carte bancaire nécessairement supposé.
4. Ajouter AllThePlaces ou Foursquare OS seulement si le nombre de fiches utiles nouvelles justifie leur entretien.

Deux interfaces sur OSM ne constituent pas deux confirmations indépendantes. Overture et Foursquare se recouvrent aussi partiellement. La qualité doit être mesurée sur les lieux réellement recherchés, pas sur un nombre mondial annoncé.

## Fusion et performance

Conserver pour chaque champ la valeur publiée, l’identifiant source, le fournisseur, la date de collecte et la licence. Rapprocher les établissements par identifiants et combinaison adresse/téléphone/site/position. Un même domaine peut appartenir à plusieurs succursales : il ne suffit pas à fusionner. Le nom seul n’est pas une preuve. Garder les contradictions visibles, sans coordonnées inventées.

La recherche serveur doit limiter le temps total, le nombre d’appels et la concurrence ; respecter Retry-After, interrompre les fournisseurs en panne et mettre en cache des résultats dont la date est visible. La fusion avec OSM nécessite une vérification des obligations ODbL avant redistribution. Le règlement des crédits doit être décidé côté serveur à partir du résultat constaté.

## Critères de choix

Benchmark : trois villes × trois secteurs × maximum 40. Relever durée médiane et p95, taux d’échec, fiches réellement pertinentes, doublons, disponibilité des sites/téléphones/courriels, fraîcheur et provenance. Vérifier à la main un échantillon. Une couverture documentaire ou un quota gratuit n’est pas une preuve de performance. Ne pas promettre un nombre garanti de prospects ni des contacts vérifiés.

## Diagnostic déjà réalisé

Les trois essais KlirProspect sur Overpass ont échoué (deux 502, un délai dépassé). Le registre a libéré les trois réservations : solde 200, quota 0, aucune réservation ouverte. Une petite requête POST hors application obtient aussi 502 sur overpass-api.de ; Private.coffee dépasse 18 secondes. Les essais GET sur les deux hôtes dépassent aussi le délai. Un simple changement d’URL n’est donc pas déclaré comme correction réussie.
