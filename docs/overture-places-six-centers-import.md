# Import Overture Places — six centres

Document de travail pour charger le catalogue des six centres lu par le fournisseur `overture-places-pilot`. Test uniquement. Aucun appel OpenCage, aucun débit de crédits, aucune production.

## Ce que lit le fournisseur

Le runner Test appelle `private.search_catalog_lookup(ville, secteur, quantité)`, qui lit `private.search_catalog_places` une fiche par ligne, avec un `LIMIT` (plafond 40). Il n'agrège pas le document jsonb. Si la table est vide, la fonction se rabat sur une seule ville de l'instantané sonde `private.search_pilot_snapshot`, toujours avec une limite.

Le fournisseur attend des fiches avec identifiant GERS, nom, `basic_category` / jetons de taxonomie, licences et release épinglée `2026-10-21.0`. Les villes sont `montréal`, `laval`, `québec`, `toronto`, `paris`, `lyon`.

L'outil d'import (`tools/overture-places-import.mjs`) normalise encore un extrait GeoJSON local : il refuse une emprise trop vaste, déduplique par identifiant GERS, et conserve les notices CDLA / Apache / CC0. Ces lignes sont ensuite insérées dans la table, par petits lots, sans réécrire le document jsonb unique.

Un secteur (`industry`) filtre les jetons de taxonomie ; `all` ou l'absence de secteur renvoie les premières fiches, dans la limite de la quantité (plafond 40). L'instantané pilote d'une fiche par centre n'est pas un catalogue de ville. Il ne sert plus que de repli si la table est vide.

## Bornes

Les six centres déjà au contrat, rectangle de travail d'un rayon de 2 200 m. Ce n'est pas la limite administrative. Voir `tools/overture-places-bounds.mjs`.

## Reproduction, sans coût fournisseur

Les données Places sont publiques sur S3 (`s3://overturemaps-us-west-2/release/2026-10-21.0/theme=places/type=place/*`). Le script lit anonymement, via PyArrow, uniquement les row groups dont l'emprise intersecte les six rectangles : il n'y a pas de téléchargement de la planète. (DuckDB httpfs/spatial a été tenté, mais l'installation des extensions a échoué ; PyArrow est le chemin retenu.)

Si le volume dépasse 15 000 fiches dans un rectangle, la troncature garde d'abord un plancher par grand secteur puis complète par confiance. Ce n'est pas une ville entière.

```bash
python3 -m venv /tmp/duckdb-venv
/tmp/duckdb-venv/bin/pip install pyarrow
export DUCKDB_PYTHON=/tmp/duckdb-venv/bin/python
node tools/overture-places-extract.mjs --out /tmp/overture-six-centers.json
node tools/overture-places-simulate.mjs /tmp/overture-six-centers.json
```

Le fichier produit n'est pas versionné (volume). Le script, les tests et cette note le sont.

## Licences

- Places : CDLA Permissive 2.0 selon la source, Apache 2.0 pour Foursquare (conserver la notice et la date de transformation 2026-03-18), CC0 pour AllThePlaces.
- Joindre le texte CDLA lors d'un partage des données. Places ne contient pas d'OpenStreetMap ; ne pas fusionner cet extrait avec le thème Divisions (ODbL).
- Téléphones et courriels éventuellement présents restent des valeurs sources non vérifiées.

Sources : https://docs.overturemaps.org/guides/places/ , https://docs.overturemaps.org/attribution/ , https://cdla.dev/permissive-2-0/ , https://www.apache.org/licenses/LICENSE-2.0

## Chargement Test

Projet autorisé uniquement : `pwakjxjjxswdjsapsbxn` (KlirProspect Test). Interdit : `cbklwmjudobqwbkbxqgy`. Remplir seulement `private.search_catalog_places`, par lots courts (environ 80 fiches). Ne pas réécrire `private.search_pilot_snapshot.document` avec l'extrait complet. Ne pas modifier `jobs_enabled`, les crédits, ni créer de job.

Sauvegarder l'instantané sonde actuel, puis charger uniquement si `KLIR_TEST_DB_URL` (ou un fichier `--credentials` hors git) pointe vers le projet Test, session pooler port 5432 ou `db.pwakjxjjxswdjsapsbxn.supabase.co`. Toute URL contenant le projet de production, le pool 6543, ou `sslmode=disable` est refusée avant connexion.

```bash
node tools/overture-places-load-test.mjs --snapshot /tmp/overture-six-centers.json --backup /tmp/pilot-snapshot-backup.json --dry-run
# KLIR_TEST_DB_URL déjà posée dans le terminal privé, jamais affichée :
node tools/overture-places-load-test.mjs --snapshot /tmp/overture-six-centers.json --backup /tmp/pilot-snapshot-backup.json
```

Ne pas écrire dans `private.overture_places` ni `private.overture_snapshot_places`. Mesurer ensuite `pg_database_size(current_database())` et `pg_total_relation_size('private.search_catalog_places')`. Arrêter si la base approche 450 Mo. La simulation `tools/overture-places-simulate.mjs` relit le JSON local ; après chargement, `private.search_catalog_lookup` vérifie les 18 recherches (6 villes × 3 secteurs, quantité 10). Elle n'appelle pas le runner, ne crée pas de job et ne débite aucun crédit.

Le fichier d'extrait (~60 Mo) n'est pas commis ; rester bien sous 500 Mo de base au total sur le plan gratuit.
