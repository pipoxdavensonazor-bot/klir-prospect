# Lots E et F — ingestion locale, pas un catalogue mondial

Cette branche part du lot D. Elle ne fusionne aucune PR, n’applique aucune migration, et ne télécharge rien.

## Ce qui est exécuté

`tools/catalog-ingest.mjs` lit un instantané déjà présent : en mémoire, ou dans un fichier local. Il refuse une URL. Il ne contient pas d’appel réseau, ni Nominatim, ni LinkedIn.

Le périmètre accepté est celui du pilote déjà mesuré : release datée `AAAA-MM-JJ.N`, au plus les trois cercles de 2 200 m (Montréal, Laval, Québec). Une ville absente, un rayon plus grand, ou `monde` est refusé. Une fiche dont la localité ou le point sort du cercle déclaré est écartée, pas reclassée.

Chaque champ publié vient de la fiche. Un tableau vide reste vide. Deux téléphones, courriels ou sites ne sont pas réduits à une valeur inventée : la valeur unique reste vide et la contradiction est listée. La licence est celle des `sources`, ou aucune. L’Unicode du nom et de la ville est conservé. Le rapprochement ignore les accents seulement pour comparer.

Le dédoublonnage reprend la règle déjà documentée : même identifiant, ou même nom et même adresse et même code postal, ou même téléphone, ou même courriel. Le même domaine avec deux adresses reste deux établissements. Le nom seul ne fusionne pas. Aucun champ du doublon n’est recopié sur la fiche gardée.

`overtureLiveSource()` reste `enabled: false`. Le résultat porte `operational: false`. `kind: "fixture"` et `kind: "local-snapshot"` disent d’où viennent les octets. Ni l’un ni l’autre n’est une collecte auprès d’Overture.

L’interface n’appelle pas ce module. Le géocodeur du lot D reste désactivé.

## Ce qui n’est pas décidé

Droit de redistribution, volume, coût de stockage, et branchement au parcours de recherche. Tant que ces décisions manquent, aucun instantané réel n’est livré ici : les tests n’utilisent que des fiches écrites pour l’essai. Les mesures du 22 octobre 2026 restent dans `docs/benchmark-overture/` et ne sont pas réimportées comme un catalogue opérationnel.
