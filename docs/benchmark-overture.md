# Benchmark Overture — pilote du 22 octobre 2026

**Verdict : essais supplémentaires nécessaires.** Overture fournit des candidats et mérite un essai complémentaire isolé. Ces mesures ne démontrent ni une recherche fiable ni un gain d'entreprises utiles par rapport à OSM. Aucune nouvelle source n'est intégrée au parcours de production. L'achat reste fermé.

## Protocole et traçabilité

Version téléchargée et figée : **2026-10-21.0**, CLI `overturemaps 1.0.2`, Python 3.12.10 sous Windows. Les catalogues STAC, états de téléchargement, journaux, fichiers originaux et leurs SHA-256 sont conservés dans `../verification/overture-benchmark/` hors dépôt. Les preuves compactes sont dans [benchmark-overture/](benchmark-overture/manifest.json). Il ne s'agit pas d'extractions des municipalités entières.

Trois cercles de **2 200 m**, identiques pour les trois secteurs, centrés sur Montréal (45.5017, -73.5673), Laval (45.6066, -73.7124), Québec (46.8139, -71.208). Acquisition par rectangle englobant de 2 210 m, puis filtrage par distance géodésique. Maximum **40**, tri distance puis identifiant. Secteurs issus des profils de prospection de l'application : restauration, construction et santé. Les catégories exactes sont figées dans le manifeste ; leur correspondance avec les catégories OSM n'est pas une équivalence sémantique démontrée. Construction reste large ; pharmacies, chaînes et grandes entreprises ne sont pas automatiquement des clients visés qualifiés.

Schéma réellement lu dans les fichiers GeoJSON : `Feature.id`, géométrie Point, `properties.names.primary`, `taxonomy.primary/hierarchy`, `basic_category`, `confidence`, `operating_status`, `addresses`, tableaux `websites`, `phones`, `emails`, et `sources`. Les objets sélectionnés gardent **tous les champs originaux**, notamment licences, identifiants source, `record_id`, version et dates disponibles. Aucun champ n'est généré ou complété. Les fermetures explicitement déclarées, confiance nulle et noms absents sont exclus ; absence de statut ne prouve pas l'ouverture actuelle.

Déduplication conservatrice par nom normalisé + adresse + code postal, sinon identifiant. Un domaine commun ne fusionne pas des succursales. Les licences observées sont Apache-2.0, CDLA-Permissive-2.0 et CC0-1.0. Les occurrences de licences concernent les entrées de provenance, pas un décompte exclusif d'entreprises. Le dossier local `licenses/` conserve l'attribution Overture, Apache, CDLA et la notice Foursquare ; le téléchargement de la copie CC0 a échoué HTTP 403, ce que `license-downloads.json` conserve. Son identifiant et son [texte canonique](https://creativecommons.org/publicdomain/zero/1.0/) restent référencés. Ne pas supprimer les notices lors d'une éventuelle redistribution. Références : [sources cloud](https://docs.overturemaps.org/getting-data/cloud-sources/), [CLI](https://docs.overturemaps.org/getting-data/overturemaps-py/), [schéma](https://docs.overturemaps.org/schema/reference/places/place/), [attribution](https://docs.overturemaps.org/attribution/).

## Résultats mesurés

Les chiffres sites/téléphones/courriels indiquent un **champ publié non vide**, sans garantie d'actualité, de site officiel ou de délivrabilité. Les temps sont ceux du filtrage local de données déjà chargées : cinq répétitions par cas, médiane et étendue en millisecondes. Ce ne sont pas des temps serveur ni des temps de recherche bout en bout.

| Ville | Secteur | Candidats avant plafond* | Retenus | Sites | Tél. | Courriels | Médiane ms | Min–max ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Montréal | Restauration | 2 314 | 40 | 35 | 34 | 16 | 68,97 | 46,13–128,99 |
| Montréal | Construction | 139 | 40 | 36 | 39 | 13 | 25,66 | 23,19–31,06 |
| Montréal | Santé | 597 | 40 | 38 | 39 | 22 | 27,96 | 27,30–29,77 |
| Laval | Restauration | 81 | 40 | 38 | 39 | 19 | 4,96 | 2,31–8,16 |
| Laval | Construction | 30 | 30 | 29 | 29 | 15 | 2,05 | 1,48–2,59 |
| Laval | Santé | 57 | 40 | 37 | 40 | 20 | 2,29 | 1,71–2,80 |
| Québec | Restauration | 546 | 40 | 34 | 36 | 20 | 15,12 | 12,68–16,89 |
| Québec | Construction | 42 | 40 | 37 | 39 | 19 | 8,57 | 6,19–11,79 |
| Québec | Santé | 108 | 40 | 37 | 34 | 18 | 9,76 | 7,52–11,27 |
| **Total** | | | **350** | **321** | **329** | **162** | | |

*Voir `candidate_count` et `duplicate_candidates` dans les mesures : **16 doublons exacts** ont été écartés dans l'ensemble des pools avant plafond (13 Montréal restauration, 1 Montréal santé, 2 Québec restauration). Ce n'est pas un taux de 16/350. Les doublons approximatifs résiduels ne sont pas mesurés. Les identifiants des 25 127 objets bruts des trois extractions sont uniques.

Trois acquisitions répétées par ville, dans des processus distincts : Montréal **6,56 s** (6,15–7,12), Laval **5,15 s** (4,65–5,24), Québec **5,47 s** (5,36–5,83). Lecture/parsing local initial : 448,27 / 24,37 / 85,71 ms respectivement. Les caches réseau ne sont pas contrôlés. Les neuf téléchargements et 45 filtrages locaux ne permettent pas d'annoncer un **p95 robuste** ; aucun p95 n'est publié, aucune charge concurrente n'est validée.

### États de collecte et comparaison OSM

| Source | Collecte complète avec candidats | Vide valide | Partielle | Erreur technique |
|---|---:|---:|---:|---:|
| Overture | 9 | 0 | 0 | 0 |
| OSM, tentative de référence | 0 | 0 | 0 | 9 |

Une collecte complète n'est pas une preuve que tous ses candidats sont pertinents. Un vide valide exige une réponse correctement reçue et décodée sans avertissement ; une réponse avec `remark` est partielle ; délai dépassé, HTTP non réussi ou fichier incomplet sont des erreurs, jamais des vides. Aucun vide ni cas partiel réel n'a été observé ici : leur qualité de gestion reste à exercer davantage.

La référence OSM utilise le générateur de requêtes actuel, mêmes centres, rayon et plafond, sur `overpass-api.de`, avec une tentative bornée à 18 s par cas et espacement de 5 s. **Six délais dépassés et trois HTTP 502.** Elle n'emploie pas les deux tentatives du parcours de production : cette expérience ne démontre pas que la production échoue toujours. OSM ne constitue pas ici une référence exploitable. **Entreprises utiles nouvelles par rapport à OSM : indéterminable (`null`), ni zéro ni 350.** Les requêtes et erreurs sont conservées. Aucun appel au compte Supabase ni règlement de crédits pendant ce benchmark.

### Contrôle manuel réel

Échantillon volontaire : première fiche, la plus proche, de chacun des neuf cas. Consultation de pages officielles, sans téléphone ni envoi de courriel. Ce choix est biaisé et ne permet pas d'estimer une précision générale.

| Cas | Fiche | Résultat du contrôle |
|---|---|---|
| Montréal restauration | Vargas | Nom, adresse et téléphone concordent sur le site officiel |
| Montréal construction | PCL | Bureau, adresse et téléphone concordent ; site officiel existant malgré champ source vide |
| Montréal santé | Pharmaprix Place Ville Marie | Nom et adresse concordent ; numéros multiples non départagés |
| Laval restauration | Tim Hortons | Adresse et téléphone retrouvés dans les pages officielles de succursales |
| Laval construction | Paquette F & Fils | Non résolu : site inaccessible ; mention secondaire de fermeture non confirmée |
| Laval santé | Physio N Go | Non résolu : autre marque à la même adresse et au même téléphone |
| Québec restauration | Café ASSÉTAR | Nom et adresse confirmés par l'Université Laval ; ancien lien source non validé |
| Québec construction | Construction Immobilex | Conflit : point dans Québec mais adresse publiée à Gatineau ; à exclure localement tant que non résolu |
| Québec santé | Familiprix Clinique | Adresse et téléphone confirmés sur la page officielle actuelle |

Les URL et identifiants exacts sont dans [manual-review.json](benchmark-overture/manual-review.json). Bilan : **6 concordances documentaires, 2 non résolus, 1 conflit géographique**. Quatre téléphones sont confirmés indépendamment sur les pages officielles. Aucun courriel n'a été confirmé comme délivrable. Les six concordances ne sont pas six opportunités commerciales prouvées : besoin, taille et volonté d'achat restent inconnus. Aucun renseignement manquant n'a été ajouté aux données originales.

167/350 fiches ont une confiance source inférieure à 0,8 (signal exploratoire, pas seuil de vérité). Le conflit Immobilex porte pourtant une confiance de 0,95 : un seuil seul ne suffit pas. Une URL de répertoire apparaît aussi parmi les sites. Les divergences de libellé de ville ne sont pas toutes des erreurs : Vimont est un secteur de Laval, « Ville de Québec » peut être un alias. Ne pas convertir les drapeaux automatiques de `quality-flags.json` en erreurs confirmées.

## Ressources et budget

Mesures locales du périmètre uniquement : **25 127 fiches**, GeoJSON **31 557 165 octets**, gzip **3 681 814 octets**, prototype SQLite avec objets originaux et index **39 723 008 octets**, sélections des neuf cas **738 620 octets**. Import + gzip + index : **4,324 s**, mémoire maximale du processus **235 692 032 octets** (~224,8 Mio). L'index pouvait être réutilisé lors de ce passage. SQLite local ne mesure ni Postgres, ni D1, ni Workers. Les octets réseau réellement transférés par lectures distantes n'ont pas été instrumentés.

Estimation, pas mesure : prévoir 80–120 Mo par catalogue Postgres indexé (facteur de précaution 2–3 sur le prototype) et 160–240 Mo pour deux versions, à vérifier par import d'essai. Une actualisation de ces trois zones nécessite environ 16 s de téléchargements séquentiels médians, plus 4,3 s de préparation locale ; ne pas extrapoler au Québec entier. Rafraîchir seulement après nouvelle version, contrôler les volumes et erreurs, puis remplacer atomiquement le catalogue validé. Conserver la dernière version saine et supprimer l'ancienne après validation selon rétention définie.

Le [gratuit Supabase](https://supabase.com/pricing) annonce 500 Mo de base et 5 Go de sortie ; le catalogue limité peut tenir **si la marge réelle du projet suffit**, marge qui n'a pas été mesurée ici. Exemple hypothétique : 100 recherches/jour × 40 fiches × 2 ko ≈ 240 Mo/mois hors autres usages. L'hébergement existant, les historiques, journaux et sorties du reste de l'application consomment aussi ces quotas. Pro démarre à 25 USD/mois ; aucun abonnement n'a été activé.

**Ce traitement local dépasse le profil d'une invocation Workers gratuite** : [10 ms CPU, 128 Mo de mémoire](https://developers.cloudflare.com/workers/platform/limits/), contre plusieurs secondes et 225 Mio ici. Une réécriture cloud doit être remesurée ; ne pas déployer ce script tel quel dans un Worker. [Workers payant](https://developers.cloudflare.com/workers/platform/pricing/) démarre à 5 USD/mois ; ce prix ne garantit pas à lui seul l'exécution de ce prototype. Le pilote peut préparer les imports hors ligne sur l'ordinateur existant. Le coût cloud de l'import/actualisation et le coût total hébergé restent **non validés à zéro**. Au-delà des trois zones ou des quotas partagés, le budget gratuit n'est pas garanti. Aucun service additionnel payant n'est provisionné.

## Intégration minimale proposée, conditionnelle aux essais

1. **Source candidate unique : Overture**, sans ajout simultané de Wikidata, annuaires ou autres agrégateurs. Garder l'adaptateur OSM actuel isolé pendant l'évaluation ; ne pas fusionner ses échecs avec des succès Overture.
2. Importer hors ligne un catalogue régional privé dans le Supabase existant, après vérification de taille réelle et droits. Recherche authentifiée côté serveur : villes et secteurs autorisés, rayon maximal 2 200 m, maximum 40, coordonnées et catégories indexées, délai SQL et délai de réponse bornés. Ne pas charger ou parcourir le GeoJSON complet dans le navigateur ou un Worker. Tester les limites, dépassements et accès avant activation.
3. Retourner identifiant stable, version de release, date de collecte, sources/licences et coordonnées originales. Montrer « non renseigné » sans inférence. Réconcilier les contradictions de localisation avant affichage comme prospect local ; distinguer candidats et fiches vérifiées.
4. Cache serveur daté, clé incluant release, centre, rayon, secteur, plafond et version des filtres. Définir et afficher l'âge (proposition : 30 jours maximum), invalider au changement de catalogue. Un cache ancien ne devient jamais silencieusement une collecte actuelle.
5. États explicites `complete`, `valid_empty`, `partial`, `error`. Une panne conserve l'erreur et la dernière version saine ; aucun basculement facturé opaque. Déterminer les règles de résultat partiel avant toute vente ; pour le pilote proposé, partiel, vide et erreur libèrent la réservation.
6. **Crédits exclusivement côté serveur** : calcul du coût depuis les paramètres normalisés, utilisateur issu du jeton, clé d'idempotence, réservation transactionnelle, puis règlement atomique seulement après réponse complète exploitable. Le navigateur ne doit décider ni du montant ni de l'issue. Libérer la réservation sur délai dépassé, exception, résultat vide, partiel ou échec ; un nouvel essai réutilise la même opération sans second débit. Réconciliation des réservations expirées, tests de concurrence et d'échec après réservation obligatoires. Préserver les libérations déjà présentes ; le benchmark n'a pas modifié ce mécanisme. Cette architecture est une proposition, pas un règlement serveur déjà livré.

Avant intégration : obtenir une référence OSM réussie répétée sur les mêmes cas pour compter les nouveautés utiles ; vérifier un échantillon plus large couvrant indépendants, liens et conflits ; resserrer les secteurs sur les vrais clients visés ; mesurer l'import Postgres et la recherche serveur sous charge ; exercer vide/partiel/panne et crédits idempotents. L'absence de ces preuves motive le verdict actuel, sans rejeter définitivement Overture.

## Correction applicative et reproduction

`wRecommend` demande désormais une analyse si le site est actif sans courriel, sans signaux ou sans HTTPS détecté. Un audit limité ou de complétude inconnue ne suffit plus à REBUILD ; un score numérique d'audit explicitement non limité conserve son rôle. Test de régression ajouté pour ces cas, notamment site actif sans courriel. Aucun manque de coordonnées n'est transformé en besoin de refonte.

Depuis le dépôt, utiliser un environnement Python isolé avec `tools/benchmark-requirements.txt`, puis :

```powershell
python tools/benchmark-overture.py download --out ../verification/overture-benchmark --repeats 3
python tools/benchmark-overture.py measure --out ../verification/overture-benchmark --repeats 5
node tools/benchmark-osm-baseline.mjs ../verification/overture-benchmark
python tools/benchmark-resources.py --out ../verification/overture-benchmark
python -m unittest discover -s tools -p test_benchmark_overture.py
```

Les commandes de mesure réécrivent leurs fichiers de sortie : utiliser un autre dossier pour une nouvelle campagne afin de préserver ces preuves. Le contrôle manuel et ses citations se conservent séparément, sans extrapolation ni enrichissement généré. Les versions de dépendances, hashes, temps bruts, états et limites permettent de distinguer reproduction du calcul et nouvelle observation du réseau.
