"""Extrait Overture Places borné aux six centres, depuis le S3 public.

Aucun téléchargement de la planète, aucun secret, aucun appel OpenCage.
La release est épinglée. Les rectangles couvrent un rayon de 2 200 m autour
des centres déjà au contrat ; ce ne sont pas les limites administratives.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

RELEASE_PIN = "2026-10-21.0"
EXTRACT_RADIUS_M = 2200
EARTH_M_PER_DEGREE = 111320
MAX_FEATURES = 15_000
S3_PATH = f"s3://overturemaps-us-west-2/release/{RELEASE_PIN}/theme=places/type=place/*"

CITY_CENTERS = [
    {"key": "montréal", "countryCode": "CA", "latitude": 45.5017, "longitude": -73.5673},
    {"key": "laval", "countryCode": "CA", "latitude": 45.6066, "longitude": -73.7124},
    {"key": "québec", "countryCode": "CA", "latitude": 46.8139, "longitude": -71.208},
    {"key": "toronto", "countryCode": "CA", "latitude": 43.6532, "longitude": -79.3832},
    {"key": "paris", "countryCode": "FR", "latitude": 48.8566, "longitude": 2.3522},
    {"key": "lyon", "countryCode": "FR", "latitude": 45.764, "longitude": 4.8357},
]

ATTRIBUTION = {
    "cdla": "Community Data License Agreement – Permissive, Version 2.0. Le partage des données exige de joindre le texte de cet accord. https://cdla.dev/permissive-2-0/",
    "apache": "Apache License 2.0. Fournir une copie de la licence, conserver les mentions, signaler les fichiers modifiés et la date. https://www.apache.org/licenses/LICENSE-2.0",
    "foursquare": "Copyright 2024 Foursquare Labs, Inc. All rights reserved. Données Foursquare transformées vers le schéma Overture. Changed: 2026-03-18.",
    "cc0": "AllThePlaces, CC0 1.0.",
    "placesNote": "Overture Places (thème places) ne contient pas de données OpenStreetMap et n'est pas publié sous ODbL. Cet extrait n'est pas fusionné avec le thème Divisions.",
    "sources": [
        "https://docs.overturemaps.org/guides/places/",
        "https://docs.overturemaps.org/attribution/",
        "https://cdla.dev/permissive-2-0/",
        "https://www.apache.org/licenses/LICENSE-2.0",
    ],
}


def round6(value: float) -> float:
    return round(value * 1_000_000) / 1_000_000


def radius_bbox(city: dict, radius_m: int = EXTRACT_RADIUS_M) -> dict:
    dlat = radius_m / EARTH_M_PER_DEGREE
    dlon = radius_m / (EARTH_M_PER_DEGREE * math.cos(math.radians(city["latitude"])))
    return {
        "name": f"{city['key']}-rayon-{radius_m}m",
        "west": round6(city["longitude"] - dlon),
        "south": round6(city["latitude"] - dlat),
        "east": round6(city["longitude"] + dlon),
        "north": round6(city["latitude"] + dlat),
        "radiusM": radius_m,
        "note": (
            f"Rectangle de travail d'un rayon de {radius_m} m autour du centre "
            f"déjà utilisé pour {city['key']}. Ce n'est pas la limite administrative de la ville."
        ),
    }


def compact_feature(row: dict) -> dict:
    names = row.get("names") or {}
    taxonomy = row.get("taxonomy") or {}
    addresses = row.get("addresses") or []
    address = addresses[0] if isinstance(addresses, list) and addresses else {}
    compact_address = {}
    if isinstance(address, dict):
        for key in ("freeform", "locality", "region", "postcode", "country"):
            value = address.get(key)
            if isinstance(value, str) and value.strip():
                compact_address[key] = value.strip()
    sources = []
    for source in row.get("sources") or []:
        if not isinstance(source, dict):
            continue
        item = {}
        for key in ("dataset", "property", "record_id", "update_time", "license"):
            value = source.get(key)
            if isinstance(value, str) and value:
                item[key] = value
        if item:
            sources.append(item)
    properties = {
        "names": {"primary": (names.get("primary") if isinstance(names, dict) else "") or ""},
        "basic_category": row.get("basic_category") or "",
        "taxonomy": {
            "primary": taxonomy.get("primary") if isinstance(taxonomy, dict) else "",
            "hierarchy": [item for item in (taxonomy.get("hierarchy") or []) if isinstance(item, str)] if isinstance(taxonomy, dict) else [],
            "alternates": [item for item in (taxonomy.get("alternates") or []) if isinstance(item, str)] if isinstance(taxonomy, dict) else [],
        },
        "addresses": [compact_address] if compact_address else [],
        "sources": sources,
        "contactsVerified": False,
    }
    for key in ("phones", "emails", "websites"):
        values = [item.strip() for item in (row.get(key) or []) if isinstance(item, str) and item.strip()]
        if values:
            properties[key] = values
    if row.get("confidence") is not None:
        properties["confidence"] = row["confidence"]
    if row.get("operating_status"):
        properties["operating_status"] = row["operating_status"]
    return {
        "id": row["id"],
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
        "properties": properties,
    }


def extract_city(connection, city: dict, radius_m: int) -> dict:
    bbox = radius_bbox(city, radius_m)
    sql = f"""
        select
          id,
          names,
          basic_category,
          taxonomy,
          addresses,
          phones,
          emails,
          websites,
          sources,
          confidence,
          operating_status,
          st_x(geometry) as lon,
          st_y(geometry) as lat
        from read_parquet('{S3_PATH}', filename=true, hive_partitioning=1)
        where bbox.xmin between {bbox['west']} and {bbox['east']}
          and bbox.ymin between {bbox['south']} and {bbox['north']}
          and st_x(geometry) between {bbox['west']} and {bbox['east']}
          and st_y(geometry) between {bbox['south']} and {bbox['north']}
    """
    result = connection.execute(sql).fetchall()
    columns = [item[0] for item in connection.description]
    kept = []
    skipped = {"nom_absent": 0, "ferme": 0, "confidence_nulle": 0, "geometrie": 0}
    for raw in result:
        row = dict(zip(columns, raw))
        if not row.get("id") or row.get("lon") is None or row.get("lat") is None:
            skipped["geometrie"] += 1
            continue
        names = row.get("names") or {}
        primary = names.get("primary") if isinstance(names, dict) else ""
        if not isinstance(primary, str) or not primary.strip():
            skipped["nom_absent"] += 1
            continue
        if row.get("operating_status") == "permanently_closed":
            skipped["ferme"] += 1
            continue
        if row.get("confidence") == 0:
            skipped["confidence_nulle"] += 1
            continue
        kept.append(row)
    kept.sort(key=lambda item: (-(item.get("confidence") or 0), item["id"]))
    truncated = 0
    if len(kept) > MAX_FEATURES:
        truncated = len(kept) - MAX_FEATURES
        kept = kept[:MAX_FEATURES]
    features = [compact_feature(row) for row in kept]
    payload = {
        "key": city["key"],
        "kind": "local-extract",
        "release": RELEASE_PIN,
        "countryCode": city["countryCode"],
        "bbox": bbox,
        "features": features,
        "truncated": truncated,
        "skipped": skipped,
    }
    payload["bytes"] = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extrait borné Overture Places pour les six centres.")
    parser.add_argument("--out", type=Path, required=True, help="Fichier JSON de l'instantané compact.")
    parser.add_argument("--radius-m", type=int, default=EXTRACT_RADIUS_M)
    parser.add_argument("--python-check-only", action="store_true")
    args = parser.parse_args(argv)
    if args.radius_m <= 0 or args.radius_m > EXTRACT_RADIUS_M:
        raise SystemExit("emprise_refusee")
    if args.python_check_only:
        print(json.dumps({"ok": True, "release": RELEASE_PIN, "radiusM": args.radius_m}))
        return 0
    try:
        import duckdb
    except ImportError:
        raise SystemExit("duckdb_absent: installer DuckDB dans un venv (pip install duckdb), sans le commettre.")
    connection = duckdb.connect()
    connection.execute("install spatial; load spatial; install httpfs; load httpfs;")
    connection.execute("set s3_region='us-west-2'; set s3_url_style='path';")
    cities = [extract_city(connection, city, args.radius_m) for city in CITY_CENTERS]
    snapshot = {
        "release": RELEASE_PIN,
        "operational": False,
        "network": False,
        "geocoder": "none",
        "coverage": "rayon_2200m_six_centres" if args.radius_m == 2200 else f"rayon_{args.radius_m}m_six_centres",
        "categoriesColumn": "taxonomy_basic_category",
        "attribution": ATTRIBUTION,
        "cities": cities,
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    snapshot["bytes"] = len(encoded)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    summary = {
        "release": RELEASE_PIN,
        "path": str(args.out),
        "bytes": snapshot["bytes"],
        "cities": [
            {
                "key": city["key"],
                "features": len(city["features"]),
                "bytes": city["bytes"],
                "truncated": city["truncated"],
                "skipped": city["skipped"],
                "bbox": city["bbox"],
            }
            for city in cities
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
