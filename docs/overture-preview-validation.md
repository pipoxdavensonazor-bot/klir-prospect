# Validation Overture hébergée — prévisualisation seulement

Campagne du 22–23 octobre 2026. Branche `codex/pilot-readiness`, PR #21. **Achat fermé, aucune fusion, aucune activation en production.**

**Verdict : parcours technique hébergé démontré sur le périmètre testé ; essais supplémentaires nécessaires avant commercialisation.** Les critères de ciblage restent trop larges et plusieurs coordonnées ne sont pas résolues. Ce rapport complète le [benchmark hors ligne](benchmark-overture.md) ; il ne transforme pas ses candidats en prospects commercialement qualifiés.

## Environnement et architecture retenue pour cet essai

La base existante **KlirProspect Test**, `pwakjxjjxswdjsapsbxn`, est saine, sur le plan gratuit, distincte de la production `cbklwmjudobqwbkbxqgy`. Le badge Supabase « main PRODUCTION » désigne la branche principale de ce projet **Test**, pas la base de production KlirProspect. Aucun service payant n'a été créé.

Prévisualisation : [codex-pilot-readiness.klirprospect.klirline.ca](https://codex-pilot-readiness.klirprospect.klirline.ca). L'adaptateur n'est actif que si l'environnement publié est `preview` **et** si l'URL Supabase est celle du projet Test. La migration reste désactivée par défaut ; activation explicite uniquement sur ce projet. La CI Supabase Branch est ignorée car le projet de test indépendant n'est pas une branche Supabase liée à la PR ; les essais hébergés ci-dessous ont été réalisés directement sur ce projet indépendant.

Le catalogue est dans le schéma privé, avec RLS forcée, sans accès `anon`/`authenticated`. Index par version/ville, secteurs et coordonnées. La recherche authentifiée passe par des fonctions serveur à droits contrôlés ; les tables du catalogue et les fonctions d'import/admin ne sont pas exposées au navigateur. Celui-ci reçoit seulement les fiches sélectionnées, au plus 40, jamais les 25 127 objets.

Périmètres fixes : les trois centres et cercles de 2 200 m du benchmark initial, restauration/construction/santé, quantité de 1 à 40 côté serveur (10 à 40 dans le formulaire). Ville, secteur, quantité et reçu sont validés ; aucun rayon ou SQL libre n'est accepté. Le texte sert à régler ces paramètres, ce n'est pas une recherche sémantique générale du catalogue. Les filtres de taille et de site ne sont pas disponibles dans ce pilote.

## Import et coûts effectivement observés

Release **2026-10-21.0**, mêmes fichiers et SHA-256 que le manifeste initial. Import hors ligne par lots de 200 avec `tools/import-overture-preview.py`. Conservation du `Feature` complet, identifiant, version et `sources`/licences ; pas de coordonnées complétées. Contrôle exact de deux objets originaux après leur passage recherche → sauvegarde Supabase → CRM, plus test local du nettoyage et des caractères spéciaux. Ce contrôle de deux objets n'est pas une comparaison exhaustive de chaque champ des 25 127 lignes.

| Mesure | Valeur réelle |
|---|---:|
| Lignes importées | 25 127 |
| Import Montréal, transferts des lots compris | 42,379 s |
| Import Laval | 2,967 s |
| Import Québec | 10,773 s |
| Préparation + import + finalisation | 62,532 s |
| Catalogue avec index immédiatement après import | 50 176 000 octets |
| Base entière avant import | 11 908 787 octets |
| Base entière après import | 62 060 211 octets |
| Base entière après campagnes concurrentes | 63 608 499 octets |
| Catalogue après campagnes | 50 405 376 octets |
| Cache après campagnes | 262 144 octets |
| Opérations et résultats conservés après campagnes | 770 048 octets |

Les tailles proviennent de `pg_database_size` et `pg_total_relation_size`, pas d'une estimation SQLite. Les durées d'import incluent réseau, sérialisation et préparation ; ce n'est pas du CPU Postgres mesuré. Les mesures initiales locales de mémoire ne décrivent pas la mémoire de Supabase.

Le catalogue régional tient dans la marge observée du [plan gratuit Supabase, plafond 500 Mo de base](https://supabase.com/pricing). Aucun dépassement du gratuit n'a été observé pour cet essai et aucun supplément payant n'a été provisionné. Il ne s'agit pas d'un coût monétaire audité par facture : les octets de sortie facturables, le CPU consommé et le coût marginal par recherche n'ont pas été instrumentés. Les 27 réponses du test de couverture sont mesurées en taille JSON sérialisée dans les preuves, sans les confondre avec les octets HTTPS transférés.

Préparation locale maintenue ; pas de traitement GeoJSON massif dans un Worker. Une actualisation du même périmètre devrait nécessiter un import du même ordre, à **remesurer sur une nouvelle release**, avec place pour deux catalogues avant bascule. Deux catalogues de taille similaire représenteraient environ 101 Mo hors autres données, mais aucune bascule de version réelle n'a été testée. L'extension au Québec entier, la rétention illimitée des résultats et une hausse du trafic ne sont pas validées dans le gratuit. Il faudra limiter les historiques et surveiller base/egress avant extension.

## Crédits, concurrence, échecs et isolation

`overture_begin` calcule **5 + plafond(quantité / 10)**, réserve sous verrou du compte et lie le reçu à des paramètres immuables. `overture_execute` lit le catalogue et décide seul de l'issue. Une transaction confirme le reçu et le quota, ou rend la réservation. Le client ne transmet ni montant ni réussite.

| Essai hébergé | Preuve observée |
|---|---|
| Deux réservations simultanées, même reçu | Une réservation de 9 crédits |
| Trois exécutions simultanées, puis reprise | Un seul débit, un seul compteur de recherche, résultat récupérable |
| Paramètres/coût/issue falsifiés | Signature non acceptée ; ancien registre client refusé HTTP 403 |
| Modification directe d'opération | Refus HTTP 403 |
| Lecture du catalogue privé | Endpoint indisponible au rôle utilisateur |
| Reçu de l'autre compte | Refus ; aucune fiche de l'autre compte retournée |
| Interruption après réservation, avant exécution | Réservation expirée réellement observée à 122,884 s ; solde 128 → 137, remboursement de 9 |
| Catalogue partiel contrôlé | 0 crédit facturé |
| Catalogue indisponible après réservation | État `error`, 0 crédit facturé |
| Réponse vide valide contrôlée | État `valid_empty`, 0 crédit facturé |
| Lecture directe d'espace de l'autre compte | Aucune ligne retournée |
| Upsert avec propriétaire falsifié, après correctif | Refus HTTP 403 |

Les cas vide/partiel/erreur sont des **fixtures contrôlées sur Test**, pas des absences naturelles constatées dans le catalogue : drapeau d'intégrité désactivé, indisponibilité après réservation, et retrait temporaire réversible de l'indexation sectorielle Laval construction. Les secteurs ont été restaurés depuis une copie privée avant les mesures finales ; aucune géométrie ni objet original n'a été modifié.

Le test d'upsert a découvert un défaut préexistant : le trigger remplaçait un propriétaire falsifié par celui de l'appelant, ce qui autorisait l'écrasement de sa propre ligne QA au lieu d'un refus explicite. L'autre compte restait inchangé. Ajout d'un garde serveur rejetant cette incohérence avant nettoyage, puis nouveau test réellement interdit par RLS/garde. Le premier refus HTTP 409 ne prouvait qu'un conflit de clé primaire ; il n'est pas retenu comme preuve d'isolation d'un upsert. La fixture A affectée a été restaurée depuis son reçu serveur et la note/action documentées ; ce rétablissement est tracé dans `qa-recovery.json`. Aucun espace utilisateur de production n'a été touché.

Expiration après 60 s : la libération est réconciliée à la prochaine lecture du compte, réservation ou exécution. **Pas de tâche de nettoyage en arrière-plan** à ce stade. Une exécution qui a effectivement terminé malgré une réponse réseau perdue reste facturée une fois et récupérable avec le même reçu ; une interruption avant exécution est libérée à expiration. Un rechargement du formulaire conserve le reçu en attente dans la même session. Les anciennes opérations de crédits pilotées par le client sont interdites sur le projet Test lorsque ce pilote est activé ; Radar et les autres actions à débit client sont désactivés pour ce parcours.

Délais configurés : SQL 3 s, attente de verrou 2 s, attente de réponse navigateur 10 s. Voir les [réglages de délais Supabase](https://supabase.com/docs/guides/database/postgres/timeouts). Les mesures concurrentes observées ci-dessous restent sous ces bornes ; un test de saturation prolongée et une panne réelle du service restent à réaliser.

## Contradictions, doublons et contrôle manuel de 30 fiches

Les conflits confirmés **Construction Immobilex** (point Québec / adresse Gatineau) et **Construction Matteau** (point Laval / adresse officielle Sainte-Anne-des-Plaines) sont exclus par identifiant dans la requête serveur, avant constitution du cache. Vérification directe : aucun de ces deux identifiants dans les 27 réponses de la campagne finale.

Les cas ambigus restent dans le catalogue, avec annotations séparées de revue : changement d'identité Huot & Huot/Tris Coffin, anciennes coordonnées Montoni, code postal suspect Toitures JMS, identité Physio N Go, etc. Aucune correction arbitraire de coordonnées ou fusion de succursales. Les exports conservent l'annotation. Les suggestions de fusion par téléphone partagé et les opportunités commerciales présumées sont désactivées pour les candidats Overture. Un nom de société commun ne regroupe plus automatiquement les succursales Overture dans Companies.

Échantillon raisonné de **30**, dix par ville et dix par secteur : les trois premières fiches de chaque cas, plus la quatrième pour Montréal restauration, Laval construction et Québec santé. Réseaux, grandes entreprises, institutions et pratiques/opérateurs locaux sont représentés. **L'indépendance juridique des opérateurs locaux n'a pas été établie.** Recherche documentaire sur pages officielles ou pages de réservation du praticien ; les preuves secondaires et les pages inaccessibles restent explicitement non résolues. Aucun courriel ou appel envoyé. Les sources et notes individuelles figurent dans [manual-review-30.json](benchmark-overture/manual-review-30.json).

| Résultat documentaire | Nombre |
|---|---:|
| Concordance documentaire locale | 11 |
| Non résolu | 11 |
| Conflit de localisation | 2 |
| Identité seule, lieu non confirmé | 1 |
| Changement d'identité | 1 |
| Inadéquation au segment visé | 3 |
| Anciennes coordonnées/contact contradictoire | 1 |

Ces catégories ne sont **pas une précision générale** et les onze concordances ne sont pas onze opportunités qualifiées. Un hôpital, une grande firme d'ingénierie, un ordre professionnel ou un laboratoire universitaire ne répond pas nécessairement au ciblage petites agences/artisans/cliniques indépendantes. Les doublons approximatifs restent possibles : par exemple variantes de nom de pharmacie. Le dédoublonnage conservateur ne les règle pas tous. Aucun courriel n'a été testé pour délivrabilité, aucun site inaccessible n'a été déclaré fermé sur cette seule base.

## Mesures serveur et temps utilisateur séparés

Trois vagues de **neuf recherches API simultanées**, une par ville × secteur, maximum 40 : une vague cache applicatif vidé, deux vagues cache chaud. Les soldes/quotas des deux comptes **QA jetables uniquement** ont été réinitialisés entre ces vagues pour ne pas confondre le plafond mensuel et la capacité technique. Les comptes existants du pilote n'ont pas été réinitialisés. Cache froid désigne ici le cache applicatif, **pas** un redémarrage Postgres ou un cache système froid.

| Vague, n=9 | Serveur médiane [min–max], ms* | RPC HTTP médiane [min–max], ms | Réservation + recherche API médiane [min–max], ms |
|---|---|---|---|
| Froid | 990,632 [253,894–1 716,604] | 1 106,695 [401,537–1 927,350] | 1 328,659 [620,532–2 248,107] |
| Chaud | 3,921 [1,995–24,219] | 122,317 [110,647–129,892] | 330,166 [218,571–337,247] |
| Chaud répété | 12,988 [1,597–464,812] | 213,053 [197,965–619,169] | 425,822 [413,944–833,475] |

*Temps interne mesuré par l'horloge serveur, attentes de verrou comprises, pas du CPU. Les médianes agrègent des secteurs différents ; les valeurs brutes par cas sont conservées. Le maximum chaud à 464,812 ms empêche de promettre un temps constant. Une campagne antérieure à quatre recherches simultanées est également conservée, mais pas mélangée à cette table.

Chaque vague finale retourne **349 candidats** (Laval construction : 29, les huit autres cas : 40), avec 320 sites, 328 téléphones et 161 courriels présents dans les tableaux de la source ; 17 fiches portent une annotation de revue. Champs publiés ≠ coordonnées actuelles vérifiées. Toutes les réponses sont `complete`, aucun vide naturel observé. Ces comptes sont une couverture technique, pas un décompte d'entreprises utiles nouvelles.

Temps utilisateur observés dans le navigateur de prévisualisation : **2 632 ms** pour A (double clic, 10 restaurants à Montréal), **1 992 ms** pour B (10 fiches santé à Laval), du clic à l'affichage des résultats après sauvegarde du compte. Ils incluent le surcoût de l'automatisation, avec seulement deux observations. Aucun p95 robuste, aucune garantie de disponibilité, aucune amélioration annoncée par rapport à OSM : sa référence précédente comporte neuf erreurs techniques.

## Parcours avec deux comptes

Pour A et B : connexion → recherche hébergée → sélection d'une fiche → CRM → note distincte → responsable/prochaine action/date → export CSV → vraie déconnexion/reconnexion → lecture dans un nouvel onglet connecté séparément. Chacun retrouve seulement son suivi et ses notes. Vérification complémentaire par appels directs : une ligne d'espace propre, zéro ligne de l'autre compte et écriture d'un propriétaire falsifié refusée après correctif.

Deux CSV réellement téléchargés et lus : une ligne, **45 colonnes**, note, prochaine action, date, valeur zéro, identifiant original, release et licences présents. L'objet original de chaque fiche sélectionnée est identique au fichier source après passage par le stockage du compte. Les identifiants et tableaux de provenance ne sont pas reconstruits par génération. Les noms et contenus des deux notes QA sont volontairement distincts ; aucune entreprise n'a été contactée.

Environnement visuel : navigateur intégré, bureau 1265 × 716. Page non vide, contrôles exercés, pas d'erreur applicative pertinente dans les journaux collectés. La suite Chrome existante couvre aussi plusieurs dimensions d'écran ; ce n'est pas une validation manuelle complète du parcours Overture mobile. Les captures et CSV sont conservés hors dépôt dans `../verification/overture-benchmark/`.

## Défauts et limites avant lancement

- Ciblage trop large et données anciennes/ambiguës ; indépendance juridique, taille, besoin commercial et délivrabilité non vérifiés. Des doublons approximatifs persistent.
- Charge limitée à neuf appels simultanés et trois vagues ; pas de campagne longue, de panne régionale réelle ou de réseau mobile représentatif.
- Cache daté 10 minutes, lié à la version/date d'import ; aucun rafraîchissement automatique ni bascule réelle vers une nouvelle release testé. Le catalogue reste une photographie du 21 octobre 2026.
- Expiration réconciliée à l'activité du compte, sans balayage périodique. Rétention des opérations/résultats et croissance des historiques à encadrer avant ouverture.
- Le stockage des espaces garde une enveloppe de 2 Mo ; les sessions concurrentes du même compte fusionnent les historiques, sans résolution générale des modifications contradictoires simultanées d'une même note. L'essai démontre la reconnexion et la seconde lecture, pas un éditeur collaboratif sans conflits.
- Pas de comparaison OSM valide, ni de coût CPU/egress facturé par recherche. Les neuf cas sont trois petits cercles, pas une couverture municipale/provinciale exhaustive.

**Décision : conserver l'essai hébergé en prévisualisation, achat fermé.** La taille réelle justifie ce prototype régional dans Supabase Test ; elle ne justifie pas encore un lancement commercial ou une activation en production.

## Reproduction et preuves

Migrations additives : `20261023010000_overture_preview.sql`, `20261023020000_overture_review.sql`, `20261023030000_workspace_owner_guard.sql`, `20261023040000_overture_manual_review_30.sql`. Appliquées manuellement uniquement dans Supabase Test. Pour une autre base, laisser le drapeau désactivé ; ne pas rejouer l'import ou les fixtures sur la production.

Outils : `import-overture-preview.py` pour préparation/import ; `verify-overture-preview.mjs` pour les deux comptes jetables, concurrence, expiration, couverture et accès directs. Ils refusent toute URL autre que celle du projet Test. La clé de service existante a été utilisée après autorisation explicite, hors dépôt et hors code navigateur ; aucune nouvelle clé ou permission publique n'a été créée.

Preuves compactes : [import](benchmark-overture/hosted-import.json), [tests directs](benchmark-overture/hosted-tests.json), [27 mesures concurrentes](benchmark-overture/hosted-coverage.json), [parcours navigateur](benchmark-overture/browser-checks.json), [exports](benchmark-overture/exports-check.json), [revue de 30 fiches](benchmark-overture/manual-review-30.json). Les fichiers originaux, journaux d'acquisition et notices de licences restent dans le dossier de vérification local décrit par le premier rapport.

Validation locale finale : npm run check réussi, 90 tests, aucun échec ni test ignoré, contrôles de syntaxe et construction de prévisualisation inclus.
