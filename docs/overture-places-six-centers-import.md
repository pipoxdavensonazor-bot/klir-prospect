# Import Overture Places — six centres

Document de travail pour recharger l'instantané lu par le fournisseur `overture-places-pilot`. Test uniquement. Aucun appel OpenCage, aucun débit de crédits, aucune production.

## Ce que lit le fournisseur

Le runner Test appelle `private.pilot_snapshot()`, qui renvoie le document JSON unique de `private.search_pilot_snapshot`. Le fournisseur attend :

- `release` épinglée `2026-10-21.0`
- `cities[]` avec `key` (`montréal`, `laval`, `québec`, `toronto`, `paris`, `lyon`), `kind` (`local-extract` ou `fixture`), `bbox`, `features`
- chaque fiche au format GeoJSON compact : `id` GERS, point WGS84, `names.primary`, `basic_category` / `taxonomy`, `addresses`, `sources` (licence comprise)

`tools/overture-places-import.mjs` normalise, refuse une emprise trop vaste, déduplique par identifiant GERS, et conserve les notices CDLA / Apache / CC0. Un secteur (`industry`) filtre ensuite les jetons de taxonomie ; `all` ou l'absence de secteur renvoie les premières fiches, dans la limite de la quantité (plafond 40).

L'instantané pilote d'une fiche par centre n'est pas un catalogue de ville.

## Bornes

Les six centres déjà au contrat, rectangle de travail d'un rayon de 2 200 m. Ce n'est pas la limite administrative. Voir `tools/overture-places-bounds.mjs`.

## Reproduction, sans coût fournisseur

Les données Places sont publiques sur S3 (`s3://overturemaps-us-west-2/release/2026-10-21.0/theme=places/type=place/*`). DuckDB filtre sur `bbox` : il n'y a pas de téléchargement de la planète.

```bash
python3 -m venv /tmp/duckdb-venv
/tmp/duckdb-venv/bin/pip install duckdb
export DUCKDB_PYTHON=/tmp/duckdb-venv/bin/python
node tools/overture-places-extract.mjs --out /tmp/overture-six-centers.json
```

Le fichier produit n'est pas versionné (volume). Le script, les tests et cette note le sont.

## Licences

- Places : CDLA Permissive 2.0 selon la source, Apache 2.0 pour Foursquare (conserver la notice et la date de transformation 2026-03-18), CC0 pour AllThePlaces.
- Joindre le texte CDLA lors d'un partage des données. Places ne contient pas d'OpenStreetMap ; ne pas fusionner cet extrait avec le thème Divisions (ODbL).
- Téléphones et courriels éventuellement présents restent des valeurs sources non vérifiées.

Sources : https://docs.overturemaps.org/guides/places/ , https://docs.overturemaps.org/attribution/ , https://cdla.dev/permissive-2-0/ , https://www.apache.org/licenses/LICENSE-2.0

## Chargement Test

Projet autorisé uniquement : `pwakjxjjxswdjsapsbxn` (KlirProspect Test). Interdit : `cbklwmjudobqwbkbxqgy`. Remplacer seulement `private.search_pilot_snapshot.document`. Ne pas modifier `jobs_enabled`, les crédits, ni créer de job.
