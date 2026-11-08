# Sources — OpenCage ponctuel et extrait Overture Places

Branche à part du lot catalogue. Elle ne fusionne rien, n’allume pas `jobs_enabled`, ne débite rien, et ne déploie ni le runner ni une migration. Le bouton de diagnostic Test (PR 43, `f6ec6bc`) n’est pas dans cette branche.

## OpenCage

`tools/opencage-geocode.mjs` est un module serveur. Le navigateur ne l’importe pas. Le secret attendu est `OPENCAGE_API_KEY`. Sans cette variable, `lookup` répond `cle_absente` et n’appelle pas le réseau. La clé n’est pas recopiée dans le résultat, le cache portable, ni le message d’erreur.

Seul `usage: "ponctuel"` est accepté. Un géocodage de catalogue ou systématique est refusé avant l’appel : ce n’est pas le même volume, et agréger les résultats en base substantielle relèverait d’un autre examen ODbL. L’API ne fournit pas d’identifiant permanent ; le module n’en invente pas. Le rectangle `bounds` n’est pas converti en contour administratif. Une réponse unique reste `a_confirmer` tant que le pays, le libellé et la langue ne sont pas renvoyés tels quels. Deux pays restent `ambigu`.

Plafonds locaux, indépendants du palier réel du compte : 5 résultats, délai 4 s, au plus une nouvelle tentative sur 429 ou 5xx, écart minimal 1 s entre deux appels réseau, budget de 8 appels par instance. Le palier d’essai publié par OpenCage est 2 500 requêtes par jour et 1 requête par seconde ; ce dépôt ne sait pas quel palier sera acheté. Les résultats peuvent être conservés, avec l’attribution `Geodata copyright OpenStreetMap contributors`. Aucune clé n’a été utilisée ici.

## Overture Places

Release épinglée : `2026-10-21.0`, qui est aussi `latest` du catalogue STAC lu le 8 novembre 2026. Le schéma de cette collection n’a pas de colonne `categories`. Il a `basic_category` et `taxonomy`. Une fiche qui n’aurait encore que `categories` est marquée `unexpectedLegacy`, pas convertie en silence.

Le catalogue STAC annonce 88 418 121 lignes et 16 fichiers. La partition qui contient le centre de Montréal déjà utilisé fait 755 632 071 octets. Elle n’est pas stockée. La sonde gardée dans `test/fixtures/overture-places-public.json` fait 11 933 octets et 8 points, dans le rectangle ouest -73.5695, sud 45.5008, est -73.5651, nord 45.5027. Ce rectangle n’est pas la ville.

Une seconde sonde, `test/fixtures/overture-places-six-centers.json`, lit 8 lieux autour de chacun des six centres déjà au contrat (Montréal, Laval, Québec, Toronto, Paris, Lyon). Le rectangle fait 0,005 degré de côté. DuckDB filtre la partition STAC qui contient le centre. Aucun géocodeur n’est appelé. Le fichier fait 84 988 octets. Les partitions entières restent sur S3. L’import refuse plus de 40 fiches, plus de 1 Mio, ou une emprise de plus de 0,02 degré. `operational` et `indexReady` restent faux. Les téléphones et courriels présents sont recopiés comme publiés, avec `contactsVerified: false`. Une adresse sur un webmail public n’a pas été recopiée dans le dépôt.

Les notices suivent la page d’attribution Overture : CDLA Permissive 2.0 pour les sources listées (Meta, Microsoft, et les autres fournisseurs nommés), Apache 2.0 avec `Copyright 2024 Foursquare Labs, Inc. All rights reserved.` et la date de transformation `2026-03-18` pour Foursquare, CC0 1.0 pour AllThePlaces. Une source inconnue ne reçoit pas une licence devinée. GERS est l’identifiant de fiche, pas un numéro d’entreprise.

## Raccord au job

`prepareJobPayload` n'appelle pas `enqueue_search_job`. Le payload ne porte `place_status: "supported"` que si le point confirmé tombe dans l’un des six cercles de 2 200 m déjà au contrat, avec le pays ISO correspondant. Sinon la raison est `lieu_hors_contrat`. `enqueue`, le moteur, la facturation, le fournisseur de collecte et le planificateur restent fermés.

## Ce qui manque avant une recette Test

1. Créer `OPENCAGE_API_KEY` hors du dépôt, seulement après autorisation d’un compte OpenCage. Aucun compte n’a été ouvert ici.
2. Décider l’hébergement de l’index. Une partition fait environ 721 Mio ; le thème entier est annoncé à 88,4 millions de lignes. Le plafond de 1 Mio de cette préparation ne suffit pas à un catalogue de ville.
3. Brancher le runner sur cet import sans ouvrir `jobs_enabled`, et prouver un appel admin. Le diagnostic de connexion réel n’est pas fait.
4. Ne pas traiter un téléphone ou un courriel publié comme un contact vérifié.
